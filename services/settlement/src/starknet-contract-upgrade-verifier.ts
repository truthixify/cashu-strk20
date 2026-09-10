import type { StarknetNetwork } from "@cashu-strk20/strk20-method";
import { type BlockIdentifier, constants, type EventFilter, hash } from "starknet";

import {
  STARKNET_TRANSACTION_FINALITY_POLICIES,
  type StarknetTransactionFinalityPolicy,
} from "./starknet-transaction-observer.js";

export const STARKNET_CONTRACT_UPGRADE_VERIFIER_VERSION =
  "starknet@10.5.0:replace-to-transition-consensus-v1";
export const STARKNET_CONTRACT_UPGRADE_LINEAGE_VERIFIER_VERSION =
  "starknet@10.5.0:replace-to-lineage-inventory-consensus-v1";
export const STARKNET_REPLACE_TO_SELECTOR =
  "0xc30ffbeb949d3447fd4acd61251803e8ab9c8a777318abb5bd5fbf28015eb";
export const STARKNET_IMPLEMENTATION_REPLACED_SELECTOR =
  "0x34bb683f971572e1b0f230f3dd40f3dbcee94e0b3e3261dd0a91229a1adc4b7";

export interface StarknetContractUpgradeClaim {
  readonly network: StarknetNetwork;
  readonly contractAddress: string;
  readonly previousClassHash: string;
  readonly classHash: string;
  readonly transactionHash: string;
  readonly senderAddress: string;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly parentBlockHash: string;
  readonly finalityPolicy: StarknetTransactionFinalityPolicy;
}

export interface StarknetContractUpgradeRpc {
  getChainId(): Promise<string>;
  getTransactionByHash(transactionHash: string): Promise<unknown>;
  getTransactionReceipt(transactionHash: string): Promise<unknown>;
  getBlockWithTxHashes(blockIdentifier?: BlockIdentifier): Promise<unknown>;
  getClassHashAt(contractAddress: string, blockIdentifier?: BlockIdentifier): Promise<string>;
}

export interface StarknetContractUpgradeLineageRpc extends StarknetContractUpgradeRpc {
  getEvents(eventFilter: EventFilter): Promise<unknown>;
}

export interface NamedStarknetContractUpgradeProvider {
  readonly id: string;
  readonly provider: StarknetContractUpgradeRpc;
}

export interface NamedStarknetContractUpgradeLineageProvider {
  readonly id: string;
  readonly provider: StarknetContractUpgradeLineageRpc;
}

export interface StarknetContractUpgradeVerification {
  readonly network: "SN_SEPOLIA";
  readonly contractAddress: string;
  readonly previousClassHash: string;
  readonly classHash: string;
  readonly transactionHash: string;
  readonly senderAddress: string;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly parentBlockHash: string;
  readonly finalityPolicy: StarknetTransactionFinalityPolicy;
  readonly finalityStatus: "ACCEPTED_ON_L1" | "ACCEPTED_ON_L2";
  readonly entrypoint: "replace_to";
  readonly entrypointSelector: typeof STARKNET_REPLACE_TO_SELECTOR;
  readonly event: "ImplementationReplaced";
  readonly eventSelector: typeof STARKNET_IMPLEMENTATION_REPLACED_SELECTOR;
  readonly externalInitializerData: "NONE";
  readonly finalImplementation: false;
  readonly providerIds: readonly string[];
  readonly verifierVersion: typeof STARKNET_CONTRACT_UPGRADE_VERIFIER_VERSION;
}

export interface StarknetContractUpgradeLineageVerification {
  readonly network: "SN_SEPOLIA";
  readonly contractAddress: string;
  readonly initialClassHash: string;
  readonly inventoryFromBlockNumber: number;
  readonly inventoryThroughBlockHash: string;
  readonly upgrades: readonly StarknetContractUpgradeVerification[];
  readonly eventInventoryComplete: true;
  readonly providerIds: readonly string[];
  readonly verifierVersion: typeof STARKNET_CONTRACT_UPGRADE_LINEAGE_VERIFIER_VERSION;
}

export type StarknetContractUpgradeVerifierErrorCode =
  | "finality_not_satisfied"
  | "invalid_response"
  | "provider_disagreement"
  | "provider_failure"
  | "upgrade_mismatch";

export class StarknetContractUpgradeVerifierConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StarknetContractUpgradeVerifierConfigurationError";
  }
}

export class StarknetContractUpgradeVerifierError extends Error {
  readonly code: StarknetContractUpgradeVerifierErrorCode;

  constructor(code: StarknetContractUpgradeVerifierErrorCode, message: string) {
    super(message);
    this.name = "StarknetContractUpgradeVerifierError";
    this.code = code;
  }
}

interface ProviderObservation {
  readonly providerId: string;
  readonly chainId: string;
  readonly transactionHash: string;
  readonly transactionType: "INVOKE";
  readonly transactionVersion: string;
  readonly senderAddress: string;
  readonly calldata: readonly string[];
  readonly receiptTransactionHash: string;
  readonly receiptBlockHash: string;
  readonly receiptBlockNumber: number;
  readonly receiptFinality: "ACCEPTED_ON_L1" | "ACCEPTED_ON_L2";
  readonly receiptExecution: "REVERTED" | "SUCCEEDED";
  readonly matchingUpgradeEvents: number;
  readonly contractEventCount: number;
  readonly blockHash: string;
  readonly blockNumber: number;
  readonly parentBlockHash: string;
  readonly blockFinality: "ACCEPTED_ON_L1" | "ACCEPTED_ON_L2";
  readonly transactionOccurrences: number;
  readonly previousClassHash: string;
  readonly classHash: string;
}

interface ValidatedConfig {
  readonly claim: StarknetContractUpgradeClaim & { readonly network: "SN_SEPOLIA" };
  readonly providers: readonly NamedStarknetContractUpgradeProvider[];
  readonly requestTimeoutMilliseconds: number;
}

interface ValidatedLineageConfig {
  readonly network: "SN_SEPOLIA";
  readonly contractAddress: string;
  readonly initialClassHash: string;
  readonly inventoryFromBlockNumber: number;
  readonly inventoryThroughBlockHash: string;
  readonly upgrades: readonly ValidatedConfig["claim"][];
  readonly providers: readonly NamedStarknetContractUpgradeLineageProvider[];
  readonly requestTimeoutMilliseconds: number;
}

export class StarknetContractUpgradeVerifier {
  readonly #claim: ValidatedConfig["claim"];
  readonly #providers: readonly NamedStarknetContractUpgradeProvider[];
  readonly #requestTimeoutMilliseconds: number;

  readonly verifierVersion = STARKNET_CONTRACT_UPGRADE_VERIFIER_VERSION;

  constructor(config: {
    readonly claim: StarknetContractUpgradeClaim;
    readonly providers: readonly NamedStarknetContractUpgradeProvider[];
    readonly requestTimeoutMilliseconds: number;
  }) {
    const validated = validateConfig(config);
    this.#claim = validated.claim;
    this.#providers = validated.providers;
    this.#requestTimeoutMilliseconds = validated.requestTimeoutMilliseconds;
  }

  async verify(): Promise<StarknetContractUpgradeVerification> {
    const observations = await Promise.all(
      this.#providers.map((provider) => this.#observeProvider(provider)),
    );
    assertProviderAgreement(observations);
    const observation = requiredObservation(observations);
    assertExpectedTransition(observation, this.#claim);

    return {
      network: this.#claim.network,
      contractAddress: this.#claim.contractAddress,
      previousClassHash: this.#claim.previousClassHash,
      classHash: this.#claim.classHash,
      transactionHash: this.#claim.transactionHash,
      senderAddress: this.#claim.senderAddress,
      blockNumber: this.#claim.blockNumber,
      blockHash: this.#claim.blockHash,
      parentBlockHash: this.#claim.parentBlockHash,
      finalityPolicy: this.#claim.finalityPolicy,
      finalityStatus: observation.receiptFinality,
      entrypoint: "replace_to",
      entrypointSelector: STARKNET_REPLACE_TO_SELECTOR,
      event: "ImplementationReplaced",
      eventSelector: STARKNET_IMPLEMENTATION_REPLACED_SELECTOR,
      externalInitializerData: "NONE",
      finalImplementation: false,
      providerIds: Object.freeze(this.#providers.map(({ id }) => id)),
      verifierVersion: this.verifierVersion,
    };
  }

  async #observeProvider(
    namedProvider: NamedStarknetContractUpgradeProvider,
  ): Promise<ProviderObservation> {
    const { provider, id } = namedProvider;
    let values: readonly [unknown, unknown, unknown, unknown, string, string];
    try {
      values = await withTimeout(
        Promise.resolve().then(() =>
          Promise.all([
            provider.getChainId(),
            provider.getTransactionByHash(this.#claim.transactionHash),
            provider.getTransactionReceipt(this.#claim.transactionHash),
            provider.getBlockWithTxHashes(this.#claim.blockNumber),
            provider.getClassHashAt(this.#claim.contractAddress, this.#claim.parentBlockHash),
            provider.getClassHashAt(this.#claim.contractAddress, this.#claim.blockHash),
          ]),
        ),
        this.#requestTimeoutMilliseconds,
      );
    } catch {
      throw providerFailure(id);
    }

    const [chainIdValue, transactionValue, receiptValue, blockValue, previousClass, currentClass] =
      values;
    return {
      providerId: id,
      chainId: providerNonzeroFelt(chainIdValue, id, "chain ID"),
      ...providerTransaction(transactionValue, id),
      ...providerReceipt(receiptValue, id, this.#claim),
      ...providerBlock(blockValue, id, this.#claim.transactionHash),
      previousClassHash: providerNonzeroFelt(previousClass, id, "previous class hash"),
      classHash: providerNonzeroFelt(currentClass, id, "replacement class hash"),
    };
  }
}

export class StarknetContractUpgradeLineageVerifier {
  readonly #network: "SN_SEPOLIA";
  readonly #contractAddress: string;
  readonly #initialClassHash: string;
  readonly #inventoryFromBlockNumber: number;
  readonly #inventoryThroughBlockHash: string;
  readonly #upgrades: readonly ValidatedConfig["claim"][];
  readonly #providers: readonly NamedStarknetContractUpgradeLineageProvider[];
  readonly #requestTimeoutMilliseconds: number;

  readonly verifierVersion = STARKNET_CONTRACT_UPGRADE_LINEAGE_VERIFIER_VERSION;

  constructor(config: {
    readonly network: StarknetNetwork;
    readonly contractAddress: string;
    readonly initialClassHash: string;
    readonly inventoryFromBlockNumber: number;
    readonly inventoryThroughBlockHash: string;
    readonly upgrades: readonly StarknetContractUpgradeClaim[];
    readonly providers: readonly NamedStarknetContractUpgradeLineageProvider[];
    readonly requestTimeoutMilliseconds: number;
  }) {
    const validated = validateLineageConfig(config);
    this.#network = validated.network;
    this.#contractAddress = validated.contractAddress;
    this.#initialClassHash = validated.initialClassHash;
    this.#inventoryFromBlockNumber = validated.inventoryFromBlockNumber;
    this.#inventoryThroughBlockHash = validated.inventoryThroughBlockHash;
    this.#upgrades = validated.upgrades;
    this.#providers = validated.providers;
    this.#requestTimeoutMilliseconds = validated.requestTimeoutMilliseconds;
  }

  async verify(): Promise<StarknetContractUpgradeLineageVerification> {
    const upgradeProviders = this.#providers.map(({ id, provider }) => ({ id, provider }));
    const inventories = await Promise.all(
      this.#providers.map((provider) =>
        observeUpgradeInventory(provider, {
          contractAddress: this.#contractAddress,
          fromBlockNumber: this.#inventoryFromBlockNumber,
          throughBlockHash: this.#inventoryThroughBlockHash,
          requestTimeoutMilliseconds: this.#requestTimeoutMilliseconds,
        }),
      ),
    );
    assertUpgradeInventoryAgreement(inventories);
    assertExpectedUpgradeInventory(requiredUpgradeInventory(inventories), this.#upgrades);
    const upgrades: StarknetContractUpgradeVerification[] = [];
    for (const claim of this.#upgrades) {
      upgrades.push(
        await new StarknetContractUpgradeVerifier({
          claim,
          providers: upgradeProviders,
          requestTimeoutMilliseconds: this.#requestTimeoutMilliseconds,
        }).verify(),
      );
    }

    return {
      network: this.#network,
      contractAddress: this.#contractAddress,
      initialClassHash: this.#initialClassHash,
      inventoryFromBlockNumber: this.#inventoryFromBlockNumber,
      inventoryThroughBlockHash: this.#inventoryThroughBlockHash,
      upgrades: Object.freeze(upgrades),
      eventInventoryComplete: true,
      providerIds: Object.freeze(this.#providers.map(({ id }) => id)),
      verifierVersion: this.verifierVersion,
    };
  }
}

function validateLineageConfig(value: unknown): ValidatedLineageConfig {
  if (typeof value !== "object" || value === null) {
    throw configurationInvalid("upgrade lineage verifier");
  }
  const config = value as {
    readonly network?: unknown;
    readonly contractAddress?: unknown;
    readonly initialClassHash?: unknown;
    readonly inventoryFromBlockNumber?: unknown;
    readonly inventoryThroughBlockHash?: unknown;
    readonly upgrades?: unknown;
    readonly providers?: unknown;
    readonly requestTimeoutMilliseconds?: unknown;
  };
  if (config.network !== "SN_SEPOLIA") {
    throw configurationInvalid("upgrade lineage network");
  }
  const contractAddress = configuredAddress(config.contractAddress, "upgrade lineage contract");
  const initialClassHash = configuredNonzeroFelt(
    config.initialClassHash,
    "upgrade lineage initial class",
  );
  const upgrades = validatedLineageClaims(config.upgrades, contractAddress, initialClassHash);
  const inventoryFromBlockNumber = configuredBlockNumber(config.inventoryFromBlockNumber);
  if (inventoryFromBlockNumber > requiredUpgradeClaim(upgrades, 0).blockNumber) {
    throw configurationInvalid("upgrade lineage inventory range");
  }
  return {
    network: config.network,
    contractAddress,
    initialClassHash,
    inventoryFromBlockNumber,
    inventoryThroughBlockHash: configuredNonzeroFelt(
      config.inventoryThroughBlockHash,
      "upgrade lineage head block hash",
    ),
    upgrades,
    providers: validatedLineageProviders(config.providers),
    requestTimeoutMilliseconds: configuredPositiveInteger(
      config.requestTimeoutMilliseconds,
      "request timeout",
    ),
  };
}

function validatedLineageClaims(
  value: unknown,
  contractAddress: string,
  initialClassHash: string,
): readonly ValidatedConfig["claim"][] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAXIMUM_LINEAGE_UPGRADES) {
    throw configurationInvalid("upgrade lineage claims");
  }
  const claims = Object.freeze(
    denseArray(value, MAXIMUM_LINEAGE_UPGRADES, () =>
      configurationInvalid("upgrade lineage claims"),
    ).map((claim) => validatedClaim(claim)),
  );
  let expectedPreviousClassHash = initialClassHash;
  let previousBlockNumber = 0;
  for (const claim of claims) {
    if (
      claim.contractAddress !== contractAddress ||
      claim.previousClassHash !== expectedPreviousClassHash ||
      claim.blockNumber <= previousBlockNumber
    ) {
      throw configurationInvalid("upgrade lineage continuity");
    }
    expectedPreviousClassHash = claim.classHash;
    previousBlockNumber = claim.blockNumber;
  }
  return claims;
}

function validatedLineageProviders(
  value: unknown,
): readonly NamedStarknetContractUpgradeLineageProvider[] {
  const providers = validatedProviders(value);
  for (const { provider } of providers) {
    if (typeof (provider as Partial<StarknetContractUpgradeLineageRpc>).getEvents !== "function") {
      throw configurationInvalid("upgrade lineage providers");
    }
  }
  return providers as readonly NamedStarknetContractUpgradeLineageProvider[];
}

interface UpgradeInventoryEvent {
  readonly blockHash: string;
  readonly blockNumber: number;
  readonly transactionHash: string;
  readonly fromAddress: string;
  readonly keys: readonly string[];
  readonly data: readonly string[];
}

interface UpgradeInventoryObservation {
  readonly providerId: string;
  readonly events: readonly UpgradeInventoryEvent[];
}

async function observeUpgradeInventory(
  namedProvider: NamedStarknetContractUpgradeLineageProvider,
  input: {
    readonly contractAddress: string;
    readonly fromBlockNumber: number;
    readonly throughBlockHash: string;
    readonly requestTimeoutMilliseconds: number;
  },
): Promise<UpgradeInventoryObservation> {
  try {
    return await withTimeout(
      collectUpgradeInventory(namedProvider, input),
      input.requestTimeoutMilliseconds,
    );
  } catch (error) {
    if (error instanceof StarknetContractUpgradeVerifierError) {
      throw error;
    }
    throw providerFailure(namedProvider.id);
  }
}

async function collectUpgradeInventory(
  namedProvider: NamedStarknetContractUpgradeLineageProvider,
  input: {
    readonly contractAddress: string;
    readonly fromBlockNumber: number;
    readonly throughBlockHash: string;
  },
): Promise<UpgradeInventoryObservation> {
  const events: UpgradeInventoryEvent[] = [];
  const continuationTokens = new Set<string>();
  let continuationToken: string | undefined;
  for (let page = 0; page < MAXIMUM_UPGRADE_EVENT_PAGES; page += 1) {
    const value = await namedProvider.provider.getEvents({
      from_block: { block_number: input.fromBlockNumber },
      to_block: { block_hash: input.throughBlockHash },
      address: input.contractAddress,
      keys: [[STARKNET_IMPLEMENTATION_REPLACED_SELECTOR]],
      chunk_size: MAXIMUM_UPGRADE_EVENTS_PER_PAGE,
      ...(continuationToken === undefined ? {} : { continuation_token: continuationToken }),
    });
    const parsed = providerUpgradeInventoryPage(value, namedProvider.id);
    events.push(...parsed.events);
    if (events.length > MAXIMUM_TOTAL_UPGRADE_EVENTS) {
      throw new StarknetContractUpgradeVerifierError(
        "upgrade_mismatch",
        "The contract upgrade event inventory exceeds the declared lineage limit",
      );
    }
    if (parsed.continuationToken === undefined) {
      return { providerId: namedProvider.id, events: Object.freeze(events) };
    }
    if (continuationTokens.has(parsed.continuationToken)) {
      throw invalidResponse(namedProvider.id, "upgrade event pagination");
    }
    continuationTokens.add(parsed.continuationToken);
    continuationToken = parsed.continuationToken;
  }
  throw invalidResponse(namedProvider.id, "upgrade event pagination");
}

function providerUpgradeInventoryPage(
  value: unknown,
  providerId: string,
): {
  readonly events: readonly UpgradeInventoryEvent[];
  readonly continuationToken?: string;
} {
  const chunk = plainProviderRecord(value, providerId, "upgrade event inventory") as {
    readonly events?: unknown;
    readonly continuation_token?: unknown;
  };
  if (!Array.isArray(chunk.events)) {
    throw invalidResponse(providerId, "upgrade event inventory");
  }
  const events = Object.freeze(
    denseArray(chunk.events, MAXIMUM_UPGRADE_EVENTS_PER_PAGE, () =>
      invalidResponse(providerId, "upgrade event inventory"),
    ).map((event) => providerInventoryEvent(event, providerId)),
  );
  const hasContinuation = Object.hasOwn(chunk, "continuation_token");
  if (
    hasContinuation &&
    (typeof chunk.continuation_token !== "string" ||
      chunk.continuation_token.length === 0 ||
      chunk.continuation_token.length > MAXIMUM_CONTINUATION_TOKEN_LENGTH)
  ) {
    throw invalidResponse(providerId, "upgrade event inventory");
  }
  return {
    events,
    ...(hasContinuation ? { continuationToken: chunk.continuation_token as string } : {}),
  };
}

function providerInventoryEvent(value: unknown, providerId: string): UpgradeInventoryEvent {
  const event = plainProviderRecord(value, providerId, "upgrade inventory event") as {
    readonly block_hash?: unknown;
    readonly block_number?: unknown;
    readonly transaction_hash?: unknown;
    readonly from_address?: unknown;
    readonly keys?: unknown;
    readonly data?: unknown;
  };
  if (!Array.isArray(event.keys) || !Array.isArray(event.data)) {
    throw invalidResponse(providerId, "upgrade inventory event");
  }
  return {
    blockHash: providerNonzeroFelt(event.block_hash, providerId, "event block hash"),
    blockNumber: providerBlockNumber(event.block_number, providerId, "event block number"),
    transactionHash: providerNonzeroFelt(
      event.transaction_hash,
      providerId,
      "event transaction hash",
    ),
    fromAddress: providerAddress(event.from_address, providerId, "event address"),
    keys: providerFeltArray(event.keys, MAXIMUM_EVENT_VALUES, providerId, "event keys"),
    data: providerFeltArray(event.data, MAXIMUM_EVENT_VALUES, providerId, "event data"),
  };
}

function assertUpgradeInventoryAgreement(
  observations: readonly UpgradeInventoryObservation[],
): void {
  const first = requiredUpgradeInventory(observations);
  if (observations.some((observation) => !sameUpgradeInventory(first, observation))) {
    throw new StarknetContractUpgradeVerifierError(
      "provider_disagreement",
      "Starknet providers disagreed on the contract upgrade event inventory",
    );
  }
}

function sameUpgradeInventory(
  left: UpgradeInventoryObservation,
  right: UpgradeInventoryObservation,
): boolean {
  return (
    left.events.length === right.events.length &&
    left.events.every((event, index) => {
      const other = right.events[index];
      return (
        other !== undefined &&
        event.blockHash === other.blockHash &&
        event.blockNumber === other.blockNumber &&
        event.transactionHash === other.transactionHash &&
        event.fromAddress === other.fromAddress &&
        arraysEqual(event.keys, other.keys) &&
        arraysEqual(event.data, other.data)
      );
    })
  );
}

function assertExpectedUpgradeInventory(
  observation: UpgradeInventoryObservation,
  claims: readonly ValidatedConfig["claim"][],
): void {
  if (
    observation.events.length !== claims.length ||
    observation.events.some((event, index) => {
      const claim = claims[index];
      return (
        claim === undefined ||
        event.blockHash !== claim.blockHash ||
        event.blockNumber !== claim.blockNumber ||
        event.transactionHash !== claim.transactionHash ||
        event.fromAddress !== claim.contractAddress ||
        !arraysEqual(event.keys, [STARKNET_IMPLEMENTATION_REPLACED_SELECTOR]) ||
        !arraysEqual(event.data, [claim.classHash, "0x1", "0x0"])
      );
    })
  ) {
    throw new StarknetContractUpgradeVerifierError(
      "upgrade_mismatch",
      "The contract upgrade event inventory does not match the declared lineage",
    );
  }
}

function requiredUpgradeInventory(
  observations: readonly UpgradeInventoryObservation[],
): UpgradeInventoryObservation {
  const observation = observations[0];
  if (observation === undefined) {
    throw new StarknetContractUpgradeVerifierError(
      "invalid_response",
      "The contract upgrade lineage has no provider evidence",
    );
  }
  return observation;
}

function requiredUpgradeClaim(
  claims: readonly ValidatedConfig["claim"][],
  index: number,
): ValidatedConfig["claim"] {
  const claim = claims[index];
  if (claim === undefined) {
    throw configurationInvalid("upgrade lineage claims");
  }
  return claim;
}

function validateConfig(value: unknown): ValidatedConfig {
  if (typeof value !== "object" || value === null) {
    throw configurationInvalid("upgrade verifier");
  }
  const config = value as {
    readonly claim?: unknown;
    readonly providers?: unknown;
    readonly requestTimeoutMilliseconds?: unknown;
  };
  return {
    claim: validatedClaim(config.claim),
    providers: validatedProviders(config.providers),
    requestTimeoutMilliseconds: configuredPositiveInteger(
      config.requestTimeoutMilliseconds,
      "request timeout",
    ),
  };
}

function validatedClaim(value: unknown): ValidatedConfig["claim"] {
  if (typeof value !== "object" || value === null) {
    throw configurationInvalid("upgrade claim");
  }
  const claim = value as Partial<StarknetContractUpgradeClaim>;
  if (claim.network !== "SN_SEPOLIA") {
    throw configurationInvalid("upgrade network");
  }
  if (
    claim.finalityPolicy !== STARKNET_TRANSACTION_FINALITY_POLICIES.L1 &&
    claim.finalityPolicy !== STARKNET_TRANSACTION_FINALITY_POLICIES.L2
  ) {
    throw configurationInvalid("upgrade finality policy");
  }
  const previousClassHash = configuredNonzeroFelt(claim.previousClassHash, "previous class hash");
  const classHash = configuredNonzeroFelt(claim.classHash, "replacement class hash");
  if (previousClassHash === classHash) {
    throw configurationInvalid("upgrade class transition");
  }
  return {
    network: claim.network,
    contractAddress: configuredAddress(claim.contractAddress, "upgrade contract address"),
    previousClassHash,
    classHash,
    transactionHash: configuredNonzeroFelt(claim.transactionHash, "upgrade transaction hash"),
    senderAddress: configuredAddress(claim.senderAddress, "upgrade sender address"),
    blockNumber: configuredBlockNumber(claim.blockNumber),
    blockHash: configuredNonzeroFelt(claim.blockHash, "upgrade block hash"),
    parentBlockHash: configuredNonzeroFelt(claim.parentBlockHash, "upgrade parent block hash"),
    finalityPolicy: claim.finalityPolicy,
  };
}

function validatedProviders(value: unknown): readonly NamedStarknetContractUpgradeProvider[] {
  if (
    !Array.isArray(value) ||
    value.length < MINIMUM_PROVIDER_COUNT ||
    value.length > MAXIMUM_PROVIDER_COUNT
  ) {
    throw configurationInvalid("upgrade providers");
  }
  const ids = new Set<string>();
  const instances = new Set<StarknetContractUpgradeRpc>();
  return Object.freeze(
    Array.from(value, (named) => {
      if (
        typeof named !== "object" ||
        named === null ||
        typeof named.id !== "string" ||
        !PROVIDER_ID_PATTERN.test(named.id) ||
        typeof named.provider !== "object" ||
        named.provider === null ||
        typeof named.provider.getChainId !== "function" ||
        typeof named.provider.getTransactionByHash !== "function" ||
        typeof named.provider.getTransactionReceipt !== "function" ||
        typeof named.provider.getBlockWithTxHashes !== "function" ||
        typeof named.provider.getClassHashAt !== "function" ||
        ids.has(named.id) ||
        instances.has(named.provider)
      ) {
        throw configurationInvalid("upgrade providers");
      }
      ids.add(named.id);
      instances.add(named.provider);
      return { id: named.id, provider: named.provider };
    }),
  );
}

function providerTransaction(
  value: unknown,
  providerId: string,
): Pick<
  ProviderObservation,
  "calldata" | "senderAddress" | "transactionHash" | "transactionType" | "transactionVersion"
> {
  const transaction = plainProviderRecord(value, providerId, "upgrade transaction") as {
    readonly transaction_hash?: unknown;
    readonly type?: unknown;
    readonly version?: unknown;
    readonly sender_address?: unknown;
    readonly calldata?: unknown;
  };
  if (transaction.type !== "INVOKE" || !Array.isArray(transaction.calldata)) {
    throw invalidResponse(providerId, "upgrade transaction");
  }
  return {
    transactionHash: providerNonzeroFelt(
      transaction.transaction_hash,
      providerId,
      "transaction hash",
    ),
    transactionType: transaction.type,
    transactionVersion: providerNonzeroFelt(transaction.version, providerId, "transaction version"),
    senderAddress: providerAddress(transaction.sender_address, providerId, "transaction sender"),
    calldata: providerFeltArray(
      transaction.calldata,
      MAXIMUM_TRANSACTION_CALLDATA,
      providerId,
      "transaction calldata",
    ),
  };
}

function providerReceipt(
  value: unknown,
  providerId: string,
  claim: ValidatedConfig["claim"],
): Pick<
  ProviderObservation,
  | "contractEventCount"
  | "matchingUpgradeEvents"
  | "receiptBlockHash"
  | "receiptBlockNumber"
  | "receiptExecution"
  | "receiptFinality"
  | "receiptTransactionHash"
> {
  const receipt = plainProviderRecord(value, providerId, "upgrade receipt") as {
    readonly type?: unknown;
    readonly transaction_hash?: unknown;
    readonly block_hash?: unknown;
    readonly block_number?: unknown;
    readonly finality_status?: unknown;
    readonly execution_status?: unknown;
    readonly events?: unknown;
  };
  if (
    receipt.type !== "INVOKE" ||
    (receipt.execution_status !== "SUCCEEDED" && receipt.execution_status !== "REVERTED") ||
    (receipt.finality_status !== "ACCEPTED_ON_L1" && receipt.finality_status !== "ACCEPTED_ON_L2")
  ) {
    throw invalidResponse(providerId, "upgrade receipt");
  }
  const events = providerEvents(receipt.events, providerId);
  const contractEvents = events.filter(({ fromAddress }) => fromAddress === claim.contractAddress);
  return {
    receiptTransactionHash: providerNonzeroFelt(
      receipt.transaction_hash,
      providerId,
      "receipt transaction hash",
    ),
    receiptBlockHash: providerNonzeroFelt(receipt.block_hash, providerId, "receipt block hash"),
    receiptBlockNumber: providerBlockNumber(
      receipt.block_number,
      providerId,
      "receipt block number",
    ),
    receiptFinality: receipt.finality_status,
    receiptExecution: receipt.execution_status,
    matchingUpgradeEvents: contractEvents.filter((event) => upgradeEventMatches(event, claim))
      .length,
    contractEventCount: contractEvents.length,
  };
}

function providerBlock(
  value: unknown,
  providerId: string,
  transactionHash: string,
): Pick<
  ProviderObservation,
  "blockFinality" | "blockHash" | "blockNumber" | "parentBlockHash" | "transactionOccurrences"
> {
  const block = plainProviderRecord(value, providerId, "upgrade block") as {
    readonly status?: unknown;
    readonly block_hash?: unknown;
    readonly block_number?: unknown;
    readonly parent_hash?: unknown;
    readonly transactions?: unknown;
  };
  if (
    (block.status !== "ACCEPTED_ON_L1" && block.status !== "ACCEPTED_ON_L2") ||
    !Array.isArray(block.transactions)
  ) {
    throw invalidResponse(providerId, "upgrade block");
  }
  const transactions = providerFeltArray(
    block.transactions,
    MAXIMUM_TRANSACTIONS_PER_BLOCK,
    providerId,
    "block transactions",
  );
  if (new Set(transactions).size !== transactions.length) {
    throw invalidResponse(providerId, "upgrade block");
  }
  return {
    blockHash: providerNonzeroFelt(block.block_hash, providerId, "upgrade block hash"),
    blockNumber: providerBlockNumber(block.block_number, providerId, "upgrade block number"),
    parentBlockHash: providerNonzeroFelt(
      block.parent_hash,
      providerId,
      "upgrade parent block hash",
    ),
    blockFinality: block.status,
    transactionOccurrences: transactions.filter((item) => item === transactionHash).length,
  };
}

interface ProviderEvent {
  readonly fromAddress: string;
  readonly keys: readonly string[];
  readonly data: readonly string[];
}

function providerEvents(value: unknown, providerId: string): readonly ProviderEvent[] {
  if (!Array.isArray(value)) {
    throw invalidResponse(providerId, "upgrade receipt events");
  }
  return denseArray(value, MAXIMUM_EVENTS_PER_RECEIPT, () =>
    invalidResponse(providerId, "upgrade receipt events"),
  ).map((candidate) => {
    const event = plainProviderRecord(candidate, providerId, "upgrade receipt event") as {
      readonly from_address?: unknown;
      readonly keys?: unknown;
      readonly data?: unknown;
    };
    if (!Array.isArray(event.keys) || !Array.isArray(event.data)) {
      throw invalidResponse(providerId, "upgrade receipt event");
    }
    return {
      fromAddress: providerAddress(event.from_address, providerId, "event address"),
      keys: providerFeltArray(event.keys, MAXIMUM_EVENT_VALUES, providerId, "event keys"),
      data: providerFeltArray(event.data, MAXIMUM_EVENT_VALUES, providerId, "event data"),
    };
  });
}

function upgradeEventMatches(event: ProviderEvent, claim: ValidatedConfig["claim"]): boolean {
  const expectedData = [claim.classHash, "0x1", "0x0"];
  return (
    event.keys.length === 1 &&
    event.keys[0] === STARKNET_IMPLEMENTATION_REPLACED_SELECTOR &&
    event.data.length === expectedData.length &&
    event.data.every((item, index) => item === expectedData[index])
  );
}

function assertProviderAgreement(observations: readonly ProviderObservation[]): void {
  const first = requiredObservation(observations);
  if (observations.some((observation) => !sameObservation(first, observation))) {
    throw new StarknetContractUpgradeVerifierError(
      "provider_disagreement",
      "Starknet providers disagreed on the contract upgrade transition",
    );
  }
}

function requiredObservation(observations: readonly ProviderObservation[]): ProviderObservation {
  const observation = observations[0];
  if (observation === undefined) {
    throw new StarknetContractUpgradeVerifierError(
      "invalid_response",
      "The contract upgrade has no provider evidence",
    );
  }
  return observation;
}

function sameObservation(left: ProviderObservation, right: ProviderObservation): boolean {
  return (
    left.chainId === right.chainId &&
    left.transactionHash === right.transactionHash &&
    left.transactionType === right.transactionType &&
    left.transactionVersion === right.transactionVersion &&
    left.senderAddress === right.senderAddress &&
    arraysEqual(left.calldata, right.calldata) &&
    left.receiptTransactionHash === right.receiptTransactionHash &&
    left.receiptBlockHash === right.receiptBlockHash &&
    left.receiptBlockNumber === right.receiptBlockNumber &&
    left.receiptFinality === right.receiptFinality &&
    left.receiptExecution === right.receiptExecution &&
    left.matchingUpgradeEvents === right.matchingUpgradeEvents &&
    left.contractEventCount === right.contractEventCount &&
    left.blockHash === right.blockHash &&
    left.blockNumber === right.blockNumber &&
    left.parentBlockHash === right.parentBlockHash &&
    left.blockFinality === right.blockFinality &&
    left.transactionOccurrences === right.transactionOccurrences &&
    left.previousClassHash === right.previousClassHash &&
    left.classHash === right.classHash
  );
}

function assertExpectedTransition(
  observation: ProviderObservation,
  claim: ValidatedConfig["claim"],
): void {
  if (
    !satisfiesFinality(observation.receiptFinality, claim.finalityPolicy) ||
    !satisfiesFinality(observation.blockFinality, claim.finalityPolicy)
  ) {
    throw new StarknetContractUpgradeVerifierError(
      "finality_not_satisfied",
      "The contract upgrade does not satisfy the configured finality policy",
    );
  }
  const expectedCalldata = [
    "0x1",
    claim.contractAddress,
    STARKNET_REPLACE_TO_SELECTOR,
    "0x3",
    claim.classHash,
    "0x1",
    "0x0",
  ];
  if (
    observation.chainId !== STARKNET_SEPOLIA_CHAIN_ID ||
    observation.transactionHash !== claim.transactionHash ||
    observation.transactionVersion !== "0x3" ||
    observation.senderAddress !== claim.senderAddress ||
    !arraysEqual(observation.calldata, expectedCalldata) ||
    observation.receiptTransactionHash !== claim.transactionHash ||
    observation.receiptBlockHash !== claim.blockHash ||
    observation.receiptBlockNumber !== claim.blockNumber ||
    observation.receiptExecution !== "SUCCEEDED" ||
    observation.matchingUpgradeEvents !== 1 ||
    observation.contractEventCount !== 1 ||
    observation.blockHash !== claim.blockHash ||
    observation.blockNumber !== claim.blockNumber ||
    observation.parentBlockHash !== claim.parentBlockHash ||
    observation.transactionOccurrences !== 1 ||
    observation.previousClassHash !== claim.previousClassHash ||
    observation.classHash !== claim.classHash
  ) {
    throw new StarknetContractUpgradeVerifierError(
      "upgrade_mismatch",
      "The transaction does not prove the declared contract upgrade",
    );
  }
}

function plainProviderRecord(value: unknown, providerId: string, label: string): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidResponse(providerId, label);
  }
  return value;
}

function providerFeltArray(
  value: readonly unknown[],
  maximum: number,
  providerId: string,
  label: string,
): readonly string[] {
  return Object.freeze(
    denseArray(value, maximum, () => invalidResponse(providerId, label)).map((item) =>
      providerFelt(item, providerId, label),
    ),
  );
}

function providerAddress(value: unknown, providerId: string, label: string): string {
  const address = providerNonzeroFelt(value, providerId, label);
  if (BigInt(address) >= STARKNET_ADDRESS_BOUND) {
    throw invalidResponse(providerId, label);
  }
  return address;
}

function providerNonzeroFelt(value: unknown, providerId: string, label: string): string {
  const felt = providerFelt(value, providerId, label);
  if (felt === "0x0") {
    throw invalidResponse(providerId, label);
  }
  return felt;
}

function providerFelt(value: unknown, providerId: string, label: string): string {
  try {
    return canonicalFelt(value);
  } catch {
    throw invalidResponse(providerId, label);
  }
}

function providerBlockNumber(value: unknown, providerId: string, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw invalidResponse(providerId, label);
  }
  return value as number;
}

function configuredAddress(value: unknown, label: string): string {
  const address = configuredNonzeroFelt(value, label);
  if (BigInt(address) >= STARKNET_ADDRESS_BOUND) {
    throw configurationInvalid(label);
  }
  return address;
}

function configuredNonzeroFelt(value: unknown, label: string): string {
  let felt: string;
  try {
    felt = canonicalFelt(value);
  } catch {
    throw configurationInvalid(label);
  }
  if (felt === "0x0") {
    throw configurationInvalid(label);
  }
  return felt;
}

function configuredBlockNumber(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw configurationInvalid("upgrade block number");
  }
  return value as number;
}

function canonicalFelt(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > MAXIMUM_FELT_TEXT_LENGTH ||
    !FELT_PATTERN.test(value)
  ) {
    throw new Error("Invalid Starknet felt");
  }
  const felt = BigInt(value);
  if (felt >= STARK_FIELD_PRIME) {
    throw new Error("Invalid Starknet felt");
  }
  return `0x${felt.toString(16)}`;
}

function denseArray(
  value: readonly unknown[],
  maximum: number,
  error: () => Error,
): readonly unknown[] {
  if (value.length > maximum) {
    throw error();
  }
  return Array.from(value, (item, index) => {
    if (!Object.hasOwn(value, index)) {
      throw error();
    }
    return item;
  });
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function satisfiesFinality(
  status: "ACCEPTED_ON_L1" | "ACCEPTED_ON_L2",
  policy: StarknetTransactionFinalityPolicy,
): boolean {
  return policy === STARKNET_TRANSACTION_FINALITY_POLICIES.L2 || status === "ACCEPTED_ON_L1";
}

function configuredPositiveInteger(value: unknown, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAXIMUM_REQUEST_TIMEOUT_MILLISECONDS
  ) {
    throw configurationInvalid(label);
  }
  return value as number;
}

function configurationInvalid(label: string): StarknetContractUpgradeVerifierConfigurationError {
  return new StarknetContractUpgradeVerifierConfigurationError(`Configured ${label} is invalid`);
}

function invalidResponse(providerId: string, label: string): StarknetContractUpgradeVerifierError {
  return new StarknetContractUpgradeVerifierError(
    "invalid_response",
    `Starknet provider ${providerId} returned an invalid ${label}`,
  );
}

function providerFailure(providerId: string): StarknetContractUpgradeVerifierError {
  return new StarknetContractUpgradeVerifierError(
    "provider_failure",
    `Starknet provider ${providerId} could not read the contract upgrade`,
  );
}

function withTimeout<Value>(
  operation: Promise<Value>,
  timeoutMilliseconds: number,
): Promise<Value> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Starknet contract-upgrade request timed out")),
      timeoutMilliseconds,
    );
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

const MINIMUM_PROVIDER_COUNT = 2;
const MAXIMUM_PROVIDER_COUNT = 16;
const MAXIMUM_REQUEST_TIMEOUT_MILLISECONDS = 120_000;
const MAXIMUM_TRANSACTION_CALLDATA = 1_024;
const MAXIMUM_TRANSACTIONS_PER_BLOCK = 100_000;
const MAXIMUM_EVENTS_PER_RECEIPT = 10_000;
const MAXIMUM_LINEAGE_UPGRADES = 32;
const MAXIMUM_UPGRADE_EVENTS_PER_PAGE = 100;
const MAXIMUM_TOTAL_UPGRADE_EVENTS = 100;
const MAXIMUM_UPGRADE_EVENT_PAGES = 256;
const MAXIMUM_CONTINUATION_TOKEN_LENGTH = 1_024;
const MAXIMUM_EVENT_VALUES = 256;
const MAXIMUM_FELT_TEXT_LENGTH = 66;
const STARKNET_ADDRESS_BOUND = (1n << 251n) - 256n;
const STARK_FIELD_PRIME = (1n << 251n) + (17n << 192n) + 1n;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const FELT_PATTERN = /^0x[0-9a-fA-F]+$/u;
const STARKNET_SEPOLIA_CHAIN_ID = canonicalFelt(constants.StarknetChainId.SN_SEPOLIA);

if (
  hash.getSelectorFromName("replace_to") !== STARKNET_REPLACE_TO_SELECTOR ||
  hash.getSelectorFromName("ImplementationReplaced") !== STARKNET_IMPLEMENTATION_REPLACED_SELECTOR
) {
  throw new Error("starknet@10.5.0 selectors do not match the contract-upgrade verifier");
}
