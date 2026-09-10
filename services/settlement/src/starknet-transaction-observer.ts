import type { StarknetNetwork } from "@cashu-strk20/strk20-method";
import { type BlockIdentifier, constants, hash, RpcError } from "starknet";

import type {
  PrivacyTransactionInclusion,
  PrivacyTransactionNoteExpectation,
  PrivacyTransactionObservation,
  PrivacyTransactionObserver,
} from "./privacy-evidence.js";

export const STARKNET_TRANSACTION_FINALITY_POLICIES = {
  L1: "starknet_l1_final_v1",
  L2: "starknet_l2_final_v1",
} as const;

export type StarknetTransactionFinalityPolicy =
  (typeof STARKNET_TRANSACTION_FINALITY_POLICIES)[keyof typeof STARKNET_TRANSACTION_FINALITY_POLICIES];

export const STARKNET_TRANSACTION_OBSERVER_VERSION =
  "starknet@10.5.0:receipt-block-note-value-sender-reversion-unanimous-v2";
export const STARKNET_ENC_NOTE_CREATED_SELECTOR = hash.getSelectorFromName("EncNoteCreated");

export type StarknetPayoutTransactionStatus =
  | "CONFLICTED"
  | "FINAL"
  | "PENDING"
  | "REORGED"
  | "REVERTED";

export interface StarknetPayoutTransactionObservation {
  readonly transactionReference: string;
  readonly blockHash: string;
  readonly blockNumber: bigint;
  readonly status: StarknetPayoutTransactionStatus;
}

export interface StarknetPayoutTransactionObservationInput {
  readonly network: StarknetNetwork;
  readonly transactionReferences: readonly string[];
  readonly finalityPolicy: string;
  readonly knownInclusions?: readonly PrivacyTransactionInclusion[];
}

export interface StarknetPayoutTransactionObserver {
  observePayoutTransactions(
    input: StarknetPayoutTransactionObservationInput,
  ): Promise<readonly StarknetPayoutTransactionObservation[]>;
}

export interface StarknetTransactionRpc {
  getChainId(): Promise<string>;
  getTransactionByHash(transactionHash: string): Promise<unknown>;
  getTransactionReceipt(transactionHash: string): Promise<unknown>;
  getBlockWithTxHashes(blockIdentifier?: BlockIdentifier): Promise<unknown>;
}

export interface NamedStarknetTransactionProvider {
  readonly id: string;
  readonly provider: StarknetTransactionRpc;
}

export interface StarknetTransactionObserverConfig {
  readonly network: StarknetNetwork;
  readonly finalityPolicy: StarknetTransactionFinalityPolicy;
  readonly providers: readonly NamedStarknetTransactionProvider[];
  readonly maximumTransactionsPerRequest: number;
  readonly maximumConcurrentTransactions: number;
  readonly requestTimeoutMilliseconds: number;
}

export type StarknetTransactionObserverErrorCode =
  | "invalid_input"
  | "invalid_response"
  | "provider_disagreement"
  | "provider_failure"
  | "transaction_pending";

export class StarknetTransactionObserverConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StarknetTransactionObserverConfigurationError";
  }
}

export class StarknetTransactionObserverError extends Error {
  readonly code: StarknetTransactionObserverErrorCode;

  constructor(code: StarknetTransactionObserverErrorCode, message: string) {
    super(message);
    this.name = "StarknetTransactionObserverError";
    this.code = code;
  }
}

interface AcceptedReceipt {
  readonly kind: "ACCEPTED";
  readonly transactionHash: string;
  readonly blockHash: string;
  readonly blockNumber: bigint;
  readonly finality: "ACCEPTED_ON_L1" | "ACCEPTED_ON_L2";
  readonly execution: "REVERTED" | "SUCCEEDED";
  readonly events?: readonly AcceptedReceiptEvent[];
}

interface AcceptedReceiptEvent {
  readonly fromAddress: string;
  readonly keys: readonly string[];
  readonly data: readonly string[];
}

interface PendingReceipt {
  readonly kind: "NOT_FOUND" | "PRE_CONFIRMED";
}

type ObservedReceipt = AcceptedReceipt | PendingReceipt;

interface AcceptedBlock {
  readonly hash: string;
  readonly number: bigint;
  readonly status: "ACCEPTED_ON_L1" | "ACCEPTED_ON_L2";
  readonly transactions: ReadonlySet<string>;
}

interface ProviderReceipt {
  readonly namedProvider: NamedStarknetTransactionProvider;
  readonly receipt: ObservedReceipt;
}

interface TransactionObservationResult {
  readonly observation: PrivacyTransactionObservation;
  readonly execution?: "CONFLICTED" | "REVERTED" | "SUCCEEDED";
  readonly finalitySatisfied?: boolean;
}

export class StarknetTransactionObserver
  implements PrivacyTransactionObserver, StarknetPayoutTransactionObserver
{
  readonly #network: "SN_SEPOLIA";
  readonly #finalityPolicy: StarknetTransactionFinalityPolicy;
  readonly #providers: readonly NamedStarknetTransactionProvider[];
  readonly #maximumTransactionsPerRequest: number;
  readonly #maximumConcurrentTransactions: number;
  readonly #requestTimeoutMilliseconds: number;

  readonly observerVersion = STARKNET_TRANSACTION_OBSERVER_VERSION;

  constructor(config: StarknetTransactionObserverConfig) {
    if (config.network !== "SN_SEPOLIA") {
      throw new StarknetTransactionObserverConfigurationError(
        "Only Starknet Sepolia transaction observation is enabled",
      );
    }
    if (!Object.values(STARKNET_TRANSACTION_FINALITY_POLICIES).includes(config.finalityPolicy)) {
      throw new StarknetTransactionObserverConfigurationError(
        "Configured Starknet finality policy is invalid",
      );
    }
    this.#network = config.network;
    this.#finalityPolicy = config.finalityPolicy;
    this.#providers = validateProviders(config.providers);
    this.#maximumTransactionsPerRequest = boundedPositiveInteger(
      config.maximumTransactionsPerRequest,
      MAXIMUM_TRANSACTION_BATCH,
      "maximum transactions per request",
    );
    this.#maximumConcurrentTransactions = boundedPositiveInteger(
      config.maximumConcurrentTransactions,
      MAXIMUM_TRANSACTION_CONCURRENCY,
      "maximum concurrent transactions",
    );
    if (this.#maximumConcurrentTransactions > this.#maximumTransactionsPerRequest) {
      throw new StarknetTransactionObserverConfigurationError(
        "Transaction concurrency cannot exceed the request batch limit",
      );
    }
    this.#requestTimeoutMilliseconds = boundedPositiveInteger(
      config.requestTimeoutMilliseconds,
      MAXIMUM_REQUEST_TIMEOUT_MILLISECONDS,
      "request timeout",
    );
  }

  async observeTransactions(input: {
    readonly network: StarknetNetwork;
    readonly transactionReferences: readonly string[];
    readonly finalityPolicy: string;
    readonly knownInclusions?: readonly PrivacyTransactionInclusion[];
    readonly expectedNoteEvents?: readonly PrivacyTransactionNoteExpectation[];
  }): Promise<readonly PrivacyTransactionObservation[]> {
    return (await this.#observeTransactionResults(input)).map(({ observation }) => observation);
  }

  async observePayoutTransactions(
    input: StarknetPayoutTransactionObservationInput,
  ): Promise<readonly StarknetPayoutTransactionObservation[]> {
    return (await this.#observeTransactionResults(input)).map(payoutTransactionObservation);
  }

  async #observeTransactionResults(
    input: Parameters<PrivacyTransactionObserver["observeTransactions"]>[0],
  ): Promise<readonly TransactionObservationResult[]> {
    if (input.network !== this.#network || input.finalityPolicy !== this.#finalityPolicy) {
      throw new StarknetTransactionObserverError(
        "invalid_input",
        "Transaction observation does not match its configured network and finality policy",
      );
    }
    const transactionReferences = inputTransactionReferences(
      input.transactionReferences,
      this.#maximumTransactionsPerRequest,
    );
    const knownInclusions = inputKnownInclusions(input.knownInclusions, transactionReferences);
    const expectedNoteEvents = inputExpectedNoteEvents(
      input.expectedNoteEvents,
      transactionReferences,
      knownInclusions === undefined,
    );
    if (transactionReferences.length === 0) {
      return [];
    }

    await Promise.all(this.#providers.map((provider) => this.#verifyProviderChain(provider)));
    const blockCache = new Map<string, Promise<AcceptedBlock>>();
    return mapWithConcurrency(
      transactionReferences,
      this.#maximumConcurrentTransactions,
      (transactionReference) => {
        const knownInclusion = knownInclusions?.get(transactionReference);
        const expectedEvents = expectedNoteEvents?.get(transactionReference);
        return knownInclusion === undefined
          ? this.#observeNewTransaction(transactionReference, expectedEvents, blockCache)
          : this.#reobserveKnownTransaction(knownInclusion, expectedEvents, blockCache);
      },
    );
  }

  async #verifyProviderChain(namedProvider: NamedStarknetTransactionProvider): Promise<void> {
    let chainId: string;
    try {
      chainId = await withTimeout(
        namedProvider.provider.getChainId(),
        this.#requestTimeoutMilliseconds,
      );
    } catch {
      throw new StarknetTransactionObserverError(
        "provider_failure",
        `Starknet provider ${namedProvider.id} could not report its chain ID`,
      );
    }
    if (providerFelt(chainId, `${namedProvider.id} chain ID`) !== STARKNET_SEPOLIA_CHAIN_ID) {
      throw new StarknetTransactionObserverError(
        "provider_disagreement",
        `Starknet provider ${namedProvider.id} returned the wrong chain ID`,
      );
    }
  }

  async #observeNewTransaction(
    transactionReference: string,
    expectedNoteEvents: PrivacyTransactionNoteExpectation | undefined,
    blockCache: Map<string, Promise<AcceptedBlock>>,
  ): Promise<TransactionObservationResult> {
    const receipts = await this.#readReceipts(
      transactionReference,
      expectedNoteEvents !== undefined,
    );
    if (receipts.some(({ receipt }) => receipt.kind !== "ACCEPTED")) {
      throw new StarknetTransactionObserverError(
        "transaction_pending",
        "A Starknet transaction has no accepted block identity yet",
      );
    }
    const acceptedReceipts = receipts as readonly (ProviderReceipt & {
      readonly receipt: AcceptedReceipt;
    })[];
    const agreedReceipt = agreedNewInclusion(acceptedReceipts);
    const blocks = await Promise.all(
      acceptedReceipts.map(({ namedProvider, receipt }) =>
        this.#readBlock(namedProvider, receipt.blockNumber, blockCache),
      ),
    );
    for (const [index, block] of blocks.entries()) {
      const receipt = acceptedReceipts[index]?.receipt;
      if (
        receipt === undefined ||
        block.hash !== receipt.blockHash ||
        block.number !== receipt.blockNumber ||
        !block.transactions.has(transactionReference)
      ) {
        throw new StarknetTransactionObserverError(
          "invalid_response",
          "A Starknet provider returned inconsistent receipt and block evidence",
        );
      }
    }

    if (
      expectedNoteEvents !== undefined &&
      !acceptedReceipts.every(({ receipt }) =>
        receiptContainsExpectedNotes(receipt, expectedNoteEvents),
      )
    ) {
      return observationResult({
        transactionReference,
        blockHash: agreedReceipt.blockHash,
        blockNumber: agreedReceipt.blockNumber,
        status: "CONFLICTED",
      });
    }
    if (
      expectedNoteEvents?.senderAddress !== undefined &&
      !(await this.#hasExpectedSender(transactionReference, expectedNoteEvents.senderAddress))
    ) {
      return observationResult({
        transactionReference,
        blockHash: agreedReceipt.blockHash,
        blockNumber: agreedReceipt.blockNumber,
        status: "CONFLICTED",
      });
    }

    return executionObservationResult(
      {
        transactionReference,
        blockHash: agreedReceipt.blockHash,
        blockNumber: agreedReceipt.blockNumber,
        status: transactionStatus(acceptedReceipts, blocks, this.#finalityPolicy),
      },
      acceptedReceipts,
      blocks,
      this.#finalityPolicy,
    );
  }

  async #reobserveKnownTransaction(
    inclusion: PrivacyTransactionInclusion,
    expectedNoteEvents: PrivacyTransactionNoteExpectation | undefined,
    blockCache: Map<string, Promise<AcceptedBlock>>,
  ): Promise<TransactionObservationResult> {
    const blocks = await Promise.all(
      this.#providers.map((provider) =>
        this.#readBlock(provider, inclusion.blockNumber, blockCache),
      ),
    );
    const canonicalHashes = new Set(blocks.map((block) => block.hash));
    if (canonicalHashes.size !== 1) {
      return observationResult(knownObservation(inclusion, "CONFLICTED"));
    }
    const canonicalHash = blocks[0]?.hash;
    if (canonicalHash === undefined) {
      throw new StarknetTransactionObserverError(
        "invalid_response",
        "Transaction observation has no canonical block result",
      );
    }
    if (canonicalHash !== inclusion.blockHash) {
      return observationResult(knownObservation(inclusion, "REORGED"));
    }
    if (blocks.some((block) => !block.transactions.has(inclusion.transactionReference))) {
      return observationResult(knownObservation(inclusion, "CONFLICTED"));
    }

    const receipts = await this.#readReceipts(
      inclusion.transactionReference,
      expectedNoteEvents !== undefined,
    );
    if (receipts.some(({ receipt }) => receipt.kind !== "ACCEPTED")) {
      throw new StarknetTransactionObserverError(
        "provider_disagreement",
        "A provider omitted the receipt for a transaction in the canonical block",
      );
    }
    const acceptedReceipts = receipts as readonly (ProviderReceipt & {
      readonly receipt: AcceptedReceipt;
    })[];
    if (
      acceptedReceipts.some(
        ({ receipt }) =>
          receipt.blockHash !== inclusion.blockHash ||
          receipt.blockNumber !== inclusion.blockNumber,
      )
    ) {
      return observationResult(knownObservation(inclusion, "CONFLICTED"));
    }
    if (
      expectedNoteEvents !== undefined &&
      !acceptedReceipts.every(({ receipt }) =>
        receiptContainsExpectedNotes(receipt, expectedNoteEvents),
      )
    ) {
      return observationResult(knownObservation(inclusion, "CONFLICTED"));
    }
    if (
      expectedNoteEvents?.senderAddress !== undefined &&
      !(await this.#hasExpectedSender(
        inclusion.transactionReference,
        expectedNoteEvents.senderAddress,
      ))
    ) {
      return observationResult(knownObservation(inclusion, "CONFLICTED"));
    }
    return executionObservationResult(
      knownObservation(
        inclusion,
        transactionStatus(acceptedReceipts, blocks, this.#finalityPolicy),
      ),
      acceptedReceipts,
      blocks,
      this.#finalityPolicy,
    );
  }

  async #readReceipts(
    transactionReference: string,
    requireEvents: boolean,
  ): Promise<readonly ProviderReceipt[]> {
    return Promise.all(
      this.#providers.map(async (namedProvider) => ({
        namedProvider,
        receipt: await this.#readReceipt(namedProvider, transactionReference, requireEvents),
      })),
    );
  }

  async #readReceipt(
    namedProvider: NamedStarknetTransactionProvider,
    transactionReference: string,
    requireEvents: boolean,
  ): Promise<ObservedReceipt> {
    let value: unknown;
    try {
      value = await withTimeout(
        namedProvider.provider.getTransactionReceipt(transactionReference),
        this.#requestTimeoutMilliseconds,
      );
    } catch (error) {
      if (isTransactionNotFound(error)) {
        return { kind: "NOT_FOUND" };
      }
      throw new StarknetTransactionObserverError(
        "provider_failure",
        `Starknet provider ${namedProvider.id} could not read a transaction receipt`,
      );
    }
    return providerReceipt(value, transactionReference, namedProvider.id, requireEvents);
  }

  async #hasExpectedSender(
    transactionReference: string,
    expectedSenderAddress: string,
  ): Promise<boolean> {
    const senders = await Promise.all(
      this.#providers.map((provider) =>
        this.#readTransactionSender(provider, transactionReference),
      ),
    );
    return senders.every((sender) => sender === expectedSenderAddress);
  }

  async #readTransactionSender(
    namedProvider: NamedStarknetTransactionProvider,
    transactionReference: string,
  ): Promise<string> {
    let value: unknown;
    try {
      value = await withTimeout(
        namedProvider.provider.getTransactionByHash(transactionReference),
        this.#requestTimeoutMilliseconds,
      );
    } catch (error) {
      if (isTransactionNotFound(error)) {
        throw new StarknetTransactionObserverError(
          "provider_disagreement",
          `Starknet provider ${namedProvider.id} omitted a transaction from an accepted block`,
        );
      }
      throw new StarknetTransactionObserverError(
        "provider_failure",
        `Starknet provider ${namedProvider.id} could not read an accepted transaction`,
      );
    }
    return providerTransactionSender(value, transactionReference, namedProvider.id);
  }

  #readBlock(
    namedProvider: NamedStarknetTransactionProvider,
    blockNumber: bigint,
    cache: Map<string, Promise<AcceptedBlock>>,
  ): Promise<AcceptedBlock> {
    const key = `${namedProvider.id}:${blockNumber}`;
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const requested = this.#requestBlock(namedProvider, blockNumber);
    cache.set(key, requested);
    return requested;
  }

  async #requestBlock(
    namedProvider: NamedStarknetTransactionProvider,
    blockNumber: bigint,
  ): Promise<AcceptedBlock> {
    let value: unknown;
    try {
      value = await withTimeout(
        namedProvider.provider.getBlockWithTxHashes(blockNumber),
        this.#requestTimeoutMilliseconds,
      );
    } catch {
      throw new StarknetTransactionObserverError(
        "provider_failure",
        `Starknet provider ${namedProvider.id} could not read a transaction block`,
      );
    }
    return providerBlock(value, blockNumber, namedProvider.id);
  }
}

function validateProviders(
  value: readonly NamedStarknetTransactionProvider[],
): readonly NamedStarknetTransactionProvider[] {
  if (
    !Array.isArray(value) ||
    value.length < MINIMUM_PROVIDER_COUNT ||
    value.length > MAXIMUM_PROVIDER_COUNT
  ) {
    throw new StarknetTransactionObserverConfigurationError(
      "Between two and sixteen independent Starknet providers are required",
    );
  }
  const ids = new Set<string>();
  const instances = new Set<StarknetTransactionRpc>();
  const providers = Array.from(value, (namedProvider) => {
    if (
      typeof namedProvider !== "object" ||
      namedProvider === null ||
      typeof namedProvider.id !== "string" ||
      !PROVIDER_ID_PATTERN.test(namedProvider.id) ||
      typeof namedProvider.provider !== "object" ||
      namedProvider.provider === null ||
      typeof namedProvider.provider.getChainId !== "function" ||
      typeof namedProvider.provider.getTransactionByHash !== "function" ||
      typeof namedProvider.provider.getTransactionReceipt !== "function" ||
      typeof namedProvider.provider.getBlockWithTxHashes !== "function"
    ) {
      throw new StarknetTransactionObserverConfigurationError(
        "Configured Starknet transaction provider is invalid",
      );
    }
    if (ids.has(namedProvider.id) || instances.has(namedProvider.provider)) {
      throw new StarknetTransactionObserverConfigurationError(
        "Configured Starknet transaction providers and IDs must be unique",
      );
    }
    ids.add(namedProvider.id);
    instances.add(namedProvider.provider);
    return { id: namedProvider.id, provider: namedProvider.provider };
  });
  return Object.freeze(providers);
}

function inputTransactionReferences(value: readonly string[], maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new StarknetTransactionObserverError(
      "invalid_input",
      "Transaction observation request has an invalid batch",
    );
  }
  const seen = new Set<string>();
  return Array.from(value, (candidate) => {
    const transactionReference = inputNonzeroFelt(candidate, "transaction reference");
    if (seen.has(transactionReference)) {
      throw new StarknetTransactionObserverError(
        "invalid_input",
        "Transaction observation request contains a duplicate transaction",
      );
    }
    seen.add(transactionReference);
    return transactionReference;
  });
}

function inputKnownInclusions(
  value: readonly PrivacyTransactionInclusion[] | undefined,
  transactionReferences: readonly string[],
): ReadonlyMap<string, PrivacyTransactionInclusion> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length !== transactionReferences.length) {
    throw new StarknetTransactionObserverError(
      "invalid_input",
      "Known transaction inclusions do not match the observation request",
    );
  }
  const requested = new Set(transactionReferences);
  const inclusions = new Map<string, PrivacyTransactionInclusion>();
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null) {
      throw invalidKnownInclusion();
    }
    const transactionReference = inputNonzeroFelt(
      candidate.transactionReference,
      "known transaction reference",
    );
    const blockHash = inputNonzeroFelt(candidate.blockHash, "known block hash");
    const blockNumber = inputBlockNumber(candidate.blockNumber);
    if (!requested.has(transactionReference) || inclusions.has(transactionReference)) {
      throw invalidKnownInclusion();
    }
    inclusions.set(transactionReference, { transactionReference, blockHash, blockNumber });
  }
  return inclusions;
}

function inputExpectedNoteEvents(
  value: readonly PrivacyTransactionNoteExpectation[] | undefined,
  transactionReferences: readonly string[],
  requireFullBinding: boolean,
): ReadonlyMap<string, PrivacyTransactionNoteExpectation> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length !== transactionReferences.length) {
    throw invalidExpectedNoteEvents();
  }
  const requested = new Set(transactionReferences);
  const expectations = new Map<string, PrivacyTransactionNoteExpectation>();
  const expectedNotes = new Set<string>();
  let totalNotes = 0;
  for (const candidate of value) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !Array.isArray(candidate.noteReferences) ||
      candidate.noteReferences.length === 0
    ) {
      throw invalidExpectedNoteEvents();
    }
    const transactionReference = inputNonzeroFelt(
      candidate.transactionReference,
      "expected-event transaction reference",
    );
    const poolContract = inputAddress(candidate.poolContract, "expected-event pool contract");
    if (!requested.has(transactionReference) || expectations.has(transactionReference)) {
      throw invalidExpectedNoteEvents();
    }
    totalNotes += candidate.noteReferences.length;
    if (totalNotes > MAXIMUM_EXPECTED_NOTES) {
      throw invalidExpectedNoteEvents();
    }
    const localNotes = new Set<string>();
    const noteReferences = Array.from(candidate.noteReferences, (reference: unknown) => {
      const noteReference = inputFelt(reference, "expected note reference");
      const scopedReference = `${poolContract}:${noteReference}`;
      if (localNotes.has(noteReference) || expectedNotes.has(scopedReference)) {
        throw invalidExpectedNoteEvents();
      }
      localNotes.add(noteReference);
      expectedNotes.add(scopedReference);
      return noteReference;
    });
    noteReferences.sort();
    let senderAddress: string | undefined;
    if (candidate.senderAddress !== undefined) {
      senderAddress = inputAddress(candidate.senderAddress, "expected-event transaction sender");
    }
    let noteEventValues:
      | { readonly noteReference: string; readonly eventValue: string }[]
      | undefined;
    if (candidate.noteEventValues !== undefined) {
      if (
        !Array.isArray(candidate.noteEventValues) ||
        candidate.noteEventValues.length !== noteReferences.length
      ) {
        throw invalidExpectedNoteEvents();
      }
      const requestedNotes = new Set(noteReferences);
      const valuesByNote = new Map<string, string>();
      for (const expectedValue of candidate.noteEventValues) {
        if (typeof expectedValue !== "object" || expectedValue === null) {
          throw invalidExpectedNoteEvents();
        }
        const noteReference = inputFelt(
          expectedValue.noteReference,
          "expected-value note reference",
        );
        const eventValue = inputNonzeroFelt(expectedValue.eventValue, "expected note event value");
        if (!requestedNotes.has(noteReference) || valuesByNote.has(noteReference)) {
          throw invalidExpectedNoteEvents();
        }
        valuesByNote.set(noteReference, eventValue);
      }
      if (valuesByNote.size !== requestedNotes.size) {
        throw invalidExpectedNoteEvents();
      }
      noteEventValues = [...valuesByNote]
        .map(([noteReference, eventValue]) => ({ noteReference, eventValue }))
        .sort((left, right) => left.noteReference.localeCompare(right.noteReference));
    }
    if (
      (senderAddress === undefined) !== (noteEventValues === undefined) ||
      (requireFullBinding && senderAddress === undefined)
    ) {
      throw invalidExpectedNoteEvents();
    }
    expectations.set(transactionReference, {
      transactionReference,
      poolContract,
      noteReferences,
      ...(senderAddress === undefined ? {} : { senderAddress }),
      ...(noteEventValues === undefined ? {} : { noteEventValues }),
    });
  }
  if (expectations.size !== requested.size) {
    throw invalidExpectedNoteEvents();
  }
  return expectations;
}

function providerReceipt(
  value: unknown,
  expectedTransactionHash: string,
  providerId: string,
  requireEvents: boolean,
): ObservedReceipt {
  if (typeof value !== "object" || value === null) {
    throw invalidReceipt(providerId);
  }
  const receipt = value as {
    readonly transaction_hash?: unknown;
    readonly block_hash?: unknown;
    readonly block_number?: unknown;
    readonly finality_status?: unknown;
    readonly execution_status?: unknown;
    readonly events?: unknown;
  };
  if (
    providerNonzeroFelt(receipt.transaction_hash, `${providerId} transaction hash`) !==
    expectedTransactionHash
  ) {
    throw invalidReceipt(providerId);
  }
  if (receipt.execution_status !== "SUCCEEDED" && receipt.execution_status !== "REVERTED") {
    throw invalidReceipt(providerId);
  }
  if (receipt.finality_status === "PRE_CONFIRMED") {
    if (receipt.block_hash !== undefined) {
      throw invalidReceipt(providerId);
    }
    providerBlockNumber(receipt.block_number, `${providerId} receipt block number`);
    return { kind: "PRE_CONFIRMED" };
  }
  if (
    receipt.finality_status !== "ACCEPTED_ON_L1" &&
    receipt.finality_status !== "ACCEPTED_ON_L2"
  ) {
    throw invalidReceipt(providerId);
  }
  return {
    kind: "ACCEPTED",
    transactionHash: expectedTransactionHash,
    blockHash: providerNonzeroFelt(receipt.block_hash, `${providerId} receipt block hash`),
    blockNumber: providerBlockNumber(receipt.block_number, `${providerId} receipt block number`),
    finality: receipt.finality_status,
    execution: receipt.execution_status,
    ...(requireEvents ? { events: providerReceiptEvents(receipt.events, providerId) } : {}),
  };
}

function providerReceiptEvents(
  value: unknown,
  providerId: string,
): readonly AcceptedReceiptEvent[] {
  if (!Array.isArray(value) || value.length > MAXIMUM_EVENTS_PER_RECEIPT) {
    throw invalidReceipt(providerId);
  }
  return Array.from(value, (candidate) => {
    if (typeof candidate !== "object" || candidate === null) {
      throw invalidReceipt(providerId);
    }
    const event = candidate as {
      readonly from_address?: unknown;
      readonly keys?: unknown;
      readonly data?: unknown;
    };
    if (
      !Array.isArray(event.keys) ||
      event.keys.length > MAXIMUM_EVENT_VALUES ||
      !Array.isArray(event.data) ||
      event.data.length > MAXIMUM_EVENT_VALUES
    ) {
      throw invalidReceipt(providerId);
    }
    return {
      fromAddress: providerAddress(event.from_address, `${providerId} receipt event address`),
      keys: Array.from(event.keys, (key) => providerFelt(key, `${providerId} receipt event key`)),
      data: Array.from(event.data, (item) =>
        providerFelt(item, `${providerId} receipt event data`),
      ),
    };
  });
}

function receiptContainsExpectedNotes(
  receipt: AcceptedReceipt,
  expectation: PrivacyTransactionNoteExpectation,
): boolean {
  if (receipt.events === undefined) {
    return false;
  }
  const expected = new Set(expectation.noteReferences);
  const expectedValues = new Map(
    expectation.noteEventValues?.map(({ noteReference, eventValue }) => [
      noteReference,
      eventValue,
    ]),
  );
  const found = new Set<string>();
  for (const event of receipt.events) {
    if (
      event.fromAddress !== expectation.poolContract ||
      event.keys[0] !== STARKNET_ENC_NOTE_CREATED_SELECTOR
    ) {
      continue;
    }
    if (event.keys.length !== 2 || event.data.length !== 1) {
      return false;
    }
    const noteReference = event.keys[1];
    if (noteReference !== undefined && expected.has(noteReference)) {
      const expectedValue = expectedValues.get(noteReference);
      if (
        found.has(noteReference) ||
        (expectedValue !== undefined && event.data[0] !== expectedValue)
      ) {
        return false;
      }
      found.add(noteReference);
    }
  }
  return found.size === expected.size;
}

function providerTransactionSender(
  value: unknown,
  expectedTransactionHash: string,
  providerId: string,
): string {
  if (typeof value !== "object" || value === null) {
    throw invalidTransaction(providerId);
  }
  const transaction = value as {
    readonly type?: unknown;
    readonly transaction_hash?: unknown;
    readonly sender_address?: unknown;
  };
  try {
    if (
      transaction.type !== "INVOKE" ||
      providerNonzeroFelt(transaction.transaction_hash, `${providerId} transaction hash`) !==
        expectedTransactionHash
    ) {
      throw invalidTransaction(providerId);
    }
    return providerAddress(transaction.sender_address, `${providerId} transaction sender`);
  } catch {
    throw invalidTransaction(providerId);
  }
}

function providerBlock(
  value: unknown,
  expectedBlockNumber: bigint,
  providerId: string,
): AcceptedBlock {
  if (typeof value !== "object" || value === null) {
    throw invalidBlock(providerId);
  }
  const block = value as {
    readonly status?: unknown;
    readonly block_hash?: unknown;
    readonly block_number?: unknown;
    readonly transactions?: unknown;
  };
  if (block.status !== "ACCEPTED_ON_L1" && block.status !== "ACCEPTED_ON_L2") {
    throw invalidBlock(providerId);
  }
  const number = providerBlockNumber(block.block_number, `${providerId} block number`);
  if (number !== expectedBlockNumber || !Array.isArray(block.transactions)) {
    throw invalidBlock(providerId);
  }
  if (block.transactions.length > MAXIMUM_TRANSACTIONS_PER_BLOCK) {
    throw invalidBlock(providerId);
  }
  const transactions = new Set<string>();
  for (const transaction of block.transactions) {
    const hash = providerNonzeroFelt(transaction, `${providerId} block transaction`);
    if (transactions.has(hash)) {
      throw invalidBlock(providerId);
    }
    transactions.add(hash);
  }
  return {
    hash: providerNonzeroFelt(block.block_hash, `${providerId} block hash`),
    number,
    status: block.status,
    transactions,
  };
}

function agreedNewInclusion(
  receipts: readonly (ProviderReceipt & { readonly receipt: AcceptedReceipt })[],
): AcceptedReceipt {
  const first = receipts[0]?.receipt;
  if (first === undefined) {
    throw new StarknetTransactionObserverError(
      "invalid_response",
      "Transaction observation has no accepted provider receipt",
    );
  }
  if (
    receipts.some(
      ({ receipt }) =>
        receipt.blockHash !== first.blockHash || receipt.blockNumber !== first.blockNumber,
    )
  ) {
    throw new StarknetTransactionObserverError(
      "provider_disagreement",
      "Starknet providers disagreed on the transaction inclusion",
    );
  }
  return first;
}

function transactionStatus(
  receipts: readonly (ProviderReceipt & { readonly receipt: AcceptedReceipt })[],
  blocks: readonly AcceptedBlock[],
  policy: StarknetTransactionFinalityPolicy,
): "CONFLICTED" | "FINAL" | "PENDING" {
  if (receipts.some(({ receipt }) => receipt.execution !== "SUCCEEDED")) {
    return "CONFLICTED";
  }
  return transactionFinalitySatisfied(receipts, blocks, policy) ? "FINAL" : "PENDING";
}

function transactionFinalitySatisfied(
  receipts: readonly (ProviderReceipt & { readonly receipt: AcceptedReceipt })[],
  blocks: readonly AcceptedBlock[],
  policy: StarknetTransactionFinalityPolicy,
): boolean {
  return (
    policy === STARKNET_TRANSACTION_FINALITY_POLICIES.L2 ||
    (receipts.every(({ receipt }) => receipt.finality === "ACCEPTED_ON_L1") &&
      blocks.every((block) => block.status === "ACCEPTED_ON_L1"))
  );
}

function transactionExecution(
  receipts: readonly (ProviderReceipt & { readonly receipt: AcceptedReceipt })[],
): NonNullable<TransactionObservationResult["execution"]> {
  const executions = new Set(receipts.map(({ receipt }) => receipt.execution));
  if (executions.size !== 1) {
    return "CONFLICTED";
  }
  const first = receipts[0];
  if (first === undefined) {
    throw new StarknetTransactionObserverError(
      "invalid_response",
      "Transaction observation has no accepted receipt result",
    );
  }
  return first.receipt.execution;
}

function executionObservationResult(
  observation: PrivacyTransactionObservation,
  receipts: readonly (ProviderReceipt & { readonly receipt: AcceptedReceipt })[],
  blocks: readonly AcceptedBlock[],
  policy: StarknetTransactionFinalityPolicy,
): TransactionObservationResult {
  return {
    observation,
    execution: transactionExecution(receipts),
    finalitySatisfied: transactionFinalitySatisfied(receipts, blocks, policy),
  };
}

function observationResult(
  observation: PrivacyTransactionObservation,
): TransactionObservationResult {
  return { observation };
}

function payoutTransactionObservation(
  result: TransactionObservationResult,
): StarknetPayoutTransactionObservation {
  const status =
    result.execution === "REVERTED"
      ? result.finalitySatisfied === true
        ? "REVERTED"
        : "PENDING"
      : result.observation.status;
  return {
    transactionReference: result.observation.transactionReference,
    blockHash: result.observation.blockHash,
    blockNumber: result.observation.blockNumber,
    status,
  };
}

function knownObservation(
  inclusion: PrivacyTransactionInclusion,
  status: PrivacyTransactionObservation["status"],
): PrivacyTransactionObservation {
  return {
    transactionReference: inclusion.transactionReference,
    blockHash: inclusion.blockHash,
    blockNumber: inclusion.blockNumber,
    status,
  };
}

function inputNonzeroFelt(value: unknown, label: string): string {
  let felt: bigint;
  try {
    felt = parseHex(value);
  } catch {
    throw new StarknetTransactionObserverError("invalid_input", `Invalid ${label}`);
  }
  if (felt === 0n || felt >= STARK_FIELD_PRIME) {
    throw new StarknetTransactionObserverError("invalid_input", `Invalid ${label}`);
  }
  return `0x${felt.toString(16)}`;
}

function inputFelt(value: unknown, label: string): string {
  let felt: bigint;
  try {
    felt = parseHex(value);
  } catch {
    throw new StarknetTransactionObserverError("invalid_input", `Invalid ${label}`);
  }
  if (felt >= STARK_FIELD_PRIME) {
    throw new StarknetTransactionObserverError("invalid_input", `Invalid ${label}`);
  }
  return `0x${felt.toString(16)}`;
}

function inputAddress(value: unknown, label: string): string {
  const address = inputNonzeroFelt(value, label);
  if (BigInt(address) >= STARKNET_ADDRESS_BOUND) {
    throw new StarknetTransactionObserverError("invalid_input", `Invalid ${label}`);
  }
  return address;
}

function providerNonzeroFelt(value: unknown, label: string): string {
  let felt: bigint;
  try {
    felt = parseHex(value);
  } catch {
    throw new StarknetTransactionObserverError("invalid_response", `${label} is invalid`);
  }
  if (felt === 0n || felt >= STARK_FIELD_PRIME) {
    throw new StarknetTransactionObserverError("invalid_response", `${label} is invalid`);
  }
  return `0x${felt.toString(16)}`;
}

function providerFelt(value: unknown, label: string): string {
  let felt: bigint;
  try {
    felt = parseHex(value);
  } catch {
    throw new StarknetTransactionObserverError("invalid_response", `${label} is invalid`);
  }
  if (felt >= STARK_FIELD_PRIME) {
    throw new StarknetTransactionObserverError("invalid_response", `${label} is invalid`);
  }
  return `0x${felt.toString(16)}`;
}

function providerAddress(value: unknown, label: string): string {
  const address = providerNonzeroFelt(value, label);
  if (BigInt(address) >= STARKNET_ADDRESS_BOUND) {
    throw new StarknetTransactionObserverError("invalid_response", `${label} is invalid`);
  }
  return address;
}

function parseHex(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    value.length > MAXIMUM_FELT_TEXT_LENGTH ||
    !/^0x[0-9a-fA-F]+$/.test(value)
  ) {
    throw new Error("Value is not a hexadecimal felt");
  }
  return BigInt(value);
}

function inputBlockNumber(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAXIMUM_BLOCK_NUMBER) {
    throw invalidKnownInclusion();
  }
  return value;
}

function providerBlockNumber(value: unknown, label: string): bigint {
  const blockNumber =
    typeof value === "bigint"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? BigInt(value)
        : -1n;
  if (blockNumber < 0n || blockNumber > MAXIMUM_BLOCK_NUMBER) {
    throw new StarknetTransactionObserverError("invalid_response", `${label} is invalid`);
  }
  return blockNumber;
}

function invalidKnownInclusion(): StarknetTransactionObserverError {
  return new StarknetTransactionObserverError(
    "invalid_input",
    "Known transaction inclusions do not match the observation request",
  );
}

function invalidExpectedNoteEvents(): StarknetTransactionObserverError {
  return new StarknetTransactionObserverError(
    "invalid_input",
    "Expected privacy note events do not match the observation request",
  );
}

function invalidReceipt(providerId: string): StarknetTransactionObserverError {
  return new StarknetTransactionObserverError(
    "invalid_response",
    `Starknet provider ${providerId} returned a malformed transaction receipt`,
  );
}

function invalidTransaction(providerId: string): StarknetTransactionObserverError {
  return new StarknetTransactionObserverError(
    "invalid_response",
    `Starknet provider ${providerId} returned a malformed accepted transaction`,
  );
}

function invalidBlock(providerId: string): StarknetTransactionObserverError {
  return new StarknetTransactionObserverError(
    "invalid_response",
    `Starknet provider ${providerId} returned a malformed transaction block`,
  );
}

function isTransactionNotFound(value: unknown): boolean {
  return value instanceof RpcError && value.isType("TXN_HASH_NOT_FOUND");
}

function boundedPositiveInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new StarknetTransactionObserverConfigurationError(`Configured ${label} is invalid`);
  }
  return value;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<readonly R[]> {
  const results: R[] = [];
  let nextIndex = 0;
  let stopped = false;
  const worker = async (): Promise<void> => {
    while (!stopped && nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) {
        try {
          results[index] = await mapper(value);
        } catch (error) {
          stopped = true;
          throw error;
        }
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => worker()),
  );
  return results;
}

function withTimeout<T>(promise: Promise<T>, timeoutMilliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Starknet provider request timed out")),
      timeoutMilliseconds,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const MINIMUM_PROVIDER_COUNT = 2;
const MAXIMUM_PROVIDER_COUNT = 16;
const MAXIMUM_TRANSACTION_BATCH = 10_000;
const MAXIMUM_TRANSACTION_CONCURRENCY = 64;
const MAXIMUM_REQUEST_TIMEOUT_MILLISECONDS = 120_000;
const MAXIMUM_TRANSACTIONS_PER_BLOCK = 100_000;
const MAXIMUM_EXPECTED_NOTES = 10_000;
const MAXIMUM_EVENTS_PER_RECEIPT = 10_000;
const MAXIMUM_EVENT_VALUES = 256;
const MAXIMUM_FELT_TEXT_LENGTH = 66;
const MAXIMUM_BLOCK_NUMBER = (1n << 64n) - 1n;
const STARKNET_ADDRESS_BOUND = (1n << 251n) - 256n;
const STARK_FIELD_PRIME = (1n << 251n) + (17n << 192n) + 1n;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const STARKNET_SEPOLIA_CHAIN_ID = `0x${BigInt(constants.StarknetChainId.SN_SEPOLIA).toString(16)}`;
