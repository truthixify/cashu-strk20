import { createHash, randomBytes } from "node:crypto";

import { cashuUsdcToBaseUnits, type MeltPaymentEnvelope } from "@cashu-strk20/strk20-method";
import {
  type Account,
  type CairoVersion,
  type Call,
  constants,
  EDAMode,
  EDataAvailabilityMode,
  ETransactionVersion,
  hash,
  type ResourceBoundsBN,
  transaction,
} from "starknet";

import type { PayoutAttempt, PayoutPreparationInput, PrivatePayoutGateway } from "./gateway.js";
import type {
  FinalPayoutCanonicalitySource,
  FinalPayoutCanonicalObservation,
} from "./payout-finality.js";
import type { PreparedPayoutCipher } from "./prepared-payout-cipher.js";
import {
  assertPreparedPayoutRecord,
  clonePreparedPayoutRecord,
  MAXIMUM_PREPARED_PAYOUT_SUBMISSION_LEASE_MILLISECONDS,
  PREPARED_PAYOUT_PAYLOAD_VERSION,
  type PreparedPayoutCandidate,
  PreparedPayoutConflictError,
  type PreparedPayoutInclusion,
  PreparedPayoutIntegrityError,
  type PreparedPayoutPayloadContext,
  type PreparedPayoutRecord,
  type PreparedPayoutStore,
  preparedPayoutPayloadContext,
} from "./prepared-payouts.js";
import type {
  StarknetPrivacySdkPayoutExecuteResult,
  StarknetPrivacySdkPayoutTransfers,
} from "./starknet-privacy-sdk-ports.js";

export type {
  StarknetPrivacySdkPayoutBuilder,
  StarknetPrivacySdkPayoutExecuteResult,
  StarknetPrivacySdkPayoutTokenBuilder,
  StarknetPrivacySdkPayoutTransfers,
} from "./starknet-privacy-sdk-ports.js";

export const STARKNET_PRIVACY_SDK_PAYOUT_ADAPTER_VERSION =
  "starknet-privacy-sdk@0.14.3-rc.6+starknet@10.5.0:signed-invoke-v1";

type StarknetAccountSignedInvokeTransaction = Awaited<ReturnType<Account["getSignedTransaction"]>>;

export type StarknetSignedInvokeTransaction = Omit<
  StarknetAccountSignedInvokeTransaction,
  "proof_facts"
> & {
  readonly proof_facts: string[];
  readonly proof: string;
};

export interface StarknetPayoutSigningAccount {
  readonly address: unknown;
  getCairoVersion(): Promise<CairoVersion>;
  getSignedTransaction(
    call: Call,
    details: {
      readonly blockIdentifier: string;
      readonly proofFacts: string[];
      readonly proof: string;
    },
  ): Promise<unknown>;
}

export interface StarknetPayoutRpc {
  getChainId(): Promise<string>;
  invokeSignedTx(transaction: StarknetSignedInvokeTransaction): Promise<unknown>;
}

export type StarknetPreparedPayoutChainStatus =
  | "CONFLICTED"
  | "FINAL"
  | "NOT_FOUND"
  | "PENDING"
  | "REORGED"
  | "REVERTED"
  | "UNKNOWN";

export interface StarknetPreparedPayoutStatusSource {
  /** `REVERTED` is valid only after canonical finality proves this exact transaction cannot execute. */
  observePayoutTransaction(input: {
    readonly network: "SN_SEPOLIA";
    readonly transactionReference: string;
    readonly finalityPolicy: string;
    readonly knownInclusion?: PreparedPayoutInclusion;
  }): Promise<{
    readonly transactionReference: string;
    readonly status: StarknetPreparedPayoutChainStatus;
    readonly blockHash?: string;
    readonly blockNumber?: bigint;
  }>;
}

export interface StarknetPayoutDestination {
  readonly poolContract: string;
  readonly recipientAddress: string;
}

export interface StarknetPayoutProvingBlock {
  readonly blockHash: string;
  readonly blockNumber: bigint;
}

export interface StarknetPrivacySdkPayoutLimits {
  readonly maximumCallCalldataFelts: number;
  readonly maximumProofBytes: number;
  readonly maximumProofFacts: number;
  readonly maximumProofOutputFelts: number;
  readonly maximumSignatureFelts: number;
  readonly maximumTransactionCalldataFelts: number;
  readonly maximumResourceFeeFri: bigint;
  readonly maximumTipFri: bigint;
  readonly requestTimeoutMilliseconds: number;
  readonly submissionLeaseMilliseconds: number;
}

export interface StarknetPrivacySdkPayoutConfig {
  readonly network: "SN_SEPOLIA";
  readonly poolContract: string;
  readonly tokenContract: string;
  readonly finalityPolicy: string;
  readonly privateTransfers: StarknetPrivacySdkPayoutTransfers;
  readonly account: StarknetPayoutSigningAccount;
  readonly rpc: StarknetPayoutRpc;
  readonly statusSource: StarknetPreparedPayoutStatusSource;
  readonly store: PreparedPayoutStore;
  readonly cipher: PreparedPayoutCipher;
  readonly resolveDestination: (
    destination: Readonly<Record<string, unknown>>,
  ) => StarknetPayoutDestination;
  readonly selectProvingBlock: () => Promise<StarknetPayoutProvingBlock>;
  readonly createSubmissionId?: () => string;
  readonly now?: () => Date;
  readonly limits: StarknetPrivacySdkPayoutLimits;
}

export type StarknetPrivacySdkPayoutErrorCode =
  | "invalid_input"
  | "invalid_response"
  | "payload_unavailable"
  | "preparation_rejected"
  | "provider_failure"
  | "store_conflict"
  | "store_failure";

export class StarknetPrivacySdkPayoutConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StarknetPrivacySdkPayoutConfigurationError";
  }
}

export class StarknetPrivacySdkPayoutError extends Error {
  readonly code: StarknetPrivacySdkPayoutErrorCode;

  constructor(code: StarknetPrivacySdkPayoutErrorCode, message: string) {
    super(message);
    this.name = "StarknetPrivacySdkPayoutError";
    this.code = code;
  }
}

interface NormalizedPayoutRequest {
  readonly requestDigest: string;
  readonly amountBaseUnits: bigint;
  readonly recipientAddress: string;
}

interface ValidatedSdkCallAndProof {
  readonly call: Call;
  readonly proof: string;
  readonly proofFacts: string[];
}

interface ValidatedPreparedPayoutObservation {
  readonly transactionReference: string;
  readonly status: StarknetPreparedPayoutChainStatus;
  readonly blockHash?: string;
  readonly blockNumber?: bigint;
}

interface PayoutLimits {
  readonly maximumCallCalldataFelts: number;
  readonly maximumProofBytes: number;
  readonly maximumProofFacts: number;
  readonly maximumProofOutputFelts: number;
  readonly maximumSignatureFelts: number;
  readonly maximumTransactionCalldataFelts: number;
  readonly maximumResourceFeeFri: bigint;
  readonly maximumTipFri: bigint;
  readonly requestTimeoutMilliseconds: number;
  readonly submissionLeaseMilliseconds: number;
}

export class StarknetPrivacySdkPayoutAdapter
  implements PrivatePayoutGateway, FinalPayoutCanonicalitySource
{
  readonly #poolContract: string;
  readonly #tokenContract: string;
  readonly #senderAddress: string;
  readonly #privateTransfers: StarknetPrivacySdkPayoutTransfers;
  readonly #account: StarknetPayoutSigningAccount;
  readonly #rpc: StarknetPayoutRpc;
  readonly #statusSource: StarknetPreparedPayoutStatusSource;
  readonly #store: PreparedPayoutStore;
  readonly #cipher: PreparedPayoutCipher;
  readonly #resolveDestination: StarknetPrivacySdkPayoutConfig["resolveDestination"];
  readonly #selectProvingBlock: () => Promise<StarknetPayoutProvingBlock>;
  readonly #createSubmissionId: () => string;
  readonly #now: () => Date;
  readonly #finalityPolicy: string;
  readonly #limits: PayoutLimits;

  readonly adapterVersion = STARKNET_PRIVACY_SDK_PAYOUT_ADAPTER_VERSION;

  constructor(config: StarknetPrivacySdkPayoutConfig) {
    if (typeof config !== "object" || config === null || config.network !== "SN_SEPOLIA") {
      throw configurationError("Only Starknet Sepolia private payouts are enabled");
    }
    this.#poolContract = configuredAddress(config.poolContract, "pool contract");
    this.#tokenContract = configuredAddress(config.tokenContract, "token contract");
    this.#finalityPolicy = configuredIdentifier(config.finalityPolicy, "finality policy");
    assertConfiguredObject(
      config.privateTransfers,
      ["build"],
      "Privacy SDK private-transfer instance",
    );
    assertConfiguredObject(
      config.account,
      ["getCairoVersion", "getSignedTransaction"],
      "Starknet signing account",
    );
    assertConfiguredObject(config.rpc, ["getChainId", "invokeSignedTx"], "Starknet payout RPC");
    assertConfiguredObject(
      config.statusSource,
      ["observePayoutTransaction"],
      "Starknet payout status source",
    );
    assertConfiguredObject(
      config.store,
      [
        "getByIntentId",
        "getBySubmissionId",
        "createOrGet",
        "claimSubmission",
        "recordInclusion",
        "recordFinalityIncident",
      ],
      "prepared payout store",
    );
    assertConfiguredObject(config.cipher, ["seal", "open"], "prepared payout cipher");
    if (
      typeof config.resolveDestination !== "function" ||
      typeof config.selectProvingBlock !== "function" ||
      (config.createSubmissionId !== undefined &&
        typeof config.createSubmissionId !== "function") ||
      (config.now !== undefined && typeof config.now !== "function")
    ) {
      throw configurationError("Prepared payout callbacks are invalid");
    }
    this.#senderAddress = configuredAddress(config.account.address, "signing account");
    if (
      configuredAddress(config.privateTransfers.user, "Privacy SDK user") !== this.#senderAddress
    ) {
      throw configurationError("Privacy SDK user and Starknet signing account do not match");
    }
    this.#limits = configuredLimits(config.limits);
    this.#privateTransfers = config.privateTransfers;
    this.#account = config.account;
    this.#rpc = config.rpc;
    this.#statusSource = config.statusSource;
    this.#store = config.store;
    this.#cipher = config.cipher;
    this.#resolveDestination = config.resolveDestination;
    this.#selectProvingBlock = config.selectProvingBlock;
    this.#createSubmissionId =
      config.createSubmissionId ?? (() => randomBytes(SUBMISSION_ID_BYTES).toString("base64url"));
    this.#now = config.now ?? (() => new Date());
  }

  async preparePayout(input: PayoutPreparationInput): Promise<PayoutAttempt> {
    const intentId = inputIdentifier(input?.intentId, "intent ID");
    const normalized = this.#validateRequest(input?.request);
    const existing = await this.#loadByIntentId(intentId);
    if (existing !== null) {
      this.#assertStoredRequest(existing, normalized.requestDigest);
      return payoutAttempt(existing, "PREPARED");
    }

    this.#assertUnexpired(input.request);
    await this.#verifyChain();
    const provingBlockValue = await this.#externalValue(
      () => this.#selectProvingBlock(),
      "A proving block could not be selected",
    );
    const provingBlock = inputProvingBlock(provingBlockValue);
    const sdkResult = await this.#externalValue(
      () =>
        this.#privateTransfers
          .build({
            autoRegister: false,
            autoDiscover: { notes: "refresh", channels: "refresh" },
            autoSetup: false,
            autoSelectNotes: "naive",
            registryConst: true,
            provingBlockId: provingBlock.blockHash,
          })
          .with(BigInt(this.#tokenContract))
          .transfer({
            recipient: BigInt(normalized.recipientAddress),
            amount: normalized.amountBaseUnits,
          })
          .surplusTo(BigInt(this.#senderAddress), false)
          .execute(),
      "The Privacy SDK could not prepare the private payout",
    );
    const callAndProof = validateSdkResult(
      sdkResult,
      this.#poolContract,
      provingBlock,
      this.#limits,
    );
    const cairoVersion = await this.#externalValue(
      () => this.#account.getCairoVersion(),
      "The Starknet account Cairo version could not be resolved",
    );
    const expectedCalldata = expectedSignedCalldata(callAndProof.call, cairoVersion, this.#limits);
    const signedValue = await this.#externalValue(
      () =>
        this.#account.getSignedTransaction(callAndProof.call, {
          blockIdentifier: provingBlock.blockHash,
          proofFacts: [...callAndProof.proofFacts],
          proof: callAndProof.proof,
        }),
      "The Starknet account could not sign the prepared payout",
    );
    const signedTransaction = normalizeSignedTransaction(signedValue, this.#limits);
    if (
      signedTransaction.sender_address !== this.#senderAddress ||
      !sameStringArray(signedTransaction.calldata, expectedCalldata) ||
      signedTransaction.proof !== callAndProof.proof ||
      !sameStringArray(signedTransaction.proof_facts ?? [], callAndProof.proofFacts)
    ) {
      throw new StarknetPrivacySdkPayoutError(
        "invalid_response",
        "The signed Starknet transaction does not contain the prepared payout proof",
      );
    }
    const transactionReference = calculateSignedTransactionHash(signedTransaction);
    const submissionId = inputIdentifier(this.#createSubmissionId(), "generated submission ID");
    if (submissionId === intentId) {
      throw new StarknetPrivacySdkPayoutError(
        "invalid_response",
        "Submission IDs must be independent from payout intent IDs",
      );
    }
    const context: PreparedPayoutPayloadContext = {
      payloadVersion: PREPARED_PAYOUT_PAYLOAD_VERSION,
      submissionId,
      intentId,
      requestDigest: normalized.requestDigest,
      adapterVersion: this.adapterVersion,
      senderAddress: this.#senderAddress,
      nonce: signedTransaction.nonce,
      transactionReference,
    };
    const encryptedTransaction = await this.#seal(signedTransaction, context);
    const candidate: PreparedPayoutCandidate = { ...context, encryptedTransaction };
    const stored = await this.#createOrGet(candidate);
    this.#assertStoredRequest(stored, normalized.requestDigest);
    return payoutAttempt(stored, "PREPARED");
  }

  async submitPayout(submissionId: string): Promise<PayoutAttempt> {
    const stored = await this.#requiredBySubmissionId(submissionId);
    await this.#verifyChain();
    const transaction = await this.#open(stored);
    const transactionReference = calculateSignedTransactionHash(transaction);
    if (
      transactionReference !== stored.transactionReference ||
      transaction.sender_address !== stored.senderAddress ||
      transaction.nonce !== stored.nonce
    ) {
      throw new StarknetPrivacySdkPayoutError(
        "payload_unavailable",
        "Prepared payout transaction identity does not match its durable record",
      );
    }
    if (!(await this.#claimSubmission(stored))) {
      return payoutAttempt(stored, "UNKNOWN");
    }
    const response = await this.#externalValue(
      () => this.#rpc.invokeSignedTx(transaction),
      "The prepared Starknet payout could not be submitted",
    );
    if (typeof response !== "object" || response === null) {
      throw invalidRpcResponse();
    }
    const returnedReference = inputFelt(
      (response as { readonly transaction_hash?: unknown }).transaction_hash,
      "submitted transaction hash",
      false,
      "invalid_response",
    );
    if (returnedReference !== stored.transactionReference) {
      throw new StarknetPrivacySdkPayoutError(
        "invalid_response",
        "Starknet RPC returned a different transaction hash for the prepared payout",
      );
    }
    return payoutAttempt(stored, "PENDING");
  }

  async getPayoutStatus(submissionId: string): Promise<PayoutAttempt> {
    const stored = await this.#requiredBySubmissionId(submissionId);
    const observation = await this.#observePayout(stored);
    switch (observation.status) {
      case "FINAL": {
        const included = await this.#recordInclusion(
          stored,
          observedInclusion(observation.blockHash, observation.blockNumber),
        );
        return payoutAttempt(included, "PAID");
      }
      case "PENDING": {
        const included = await this.#recordInclusion(
          stored,
          observedInclusion(observation.blockHash, observation.blockNumber),
        );
        return payoutAttempt(included, "PENDING");
      }
      case "NOT_FOUND":
        return payoutAttempt(stored, "PREPARED");
      case "REVERTED": {
        const included = await this.#recordInclusion(
          stored,
          observedInclusion(observation.blockHash, observation.blockNumber),
        );
        return payoutAttempt(included, "FAILED");
      }
      case "CONFLICTED":
      case "REORGED":
      case "UNKNOWN":
        return payoutAttempt(stored, "UNKNOWN");
    }
  }

  async reobserveFinalPayout(submissionId: string): Promise<FinalPayoutCanonicalObservation> {
    const stored = await this.#requiredBySubmissionId(submissionId);
    const inclusion = stored.inclusion;
    if (inclusion === undefined) {
      throw invalidInput("Prepared payout has no accepted inclusion to reobserve");
    }
    let observation: ValidatedPreparedPayoutObservation;
    try {
      observation = await this.#observePayout(stored);
    } catch (error) {
      if (error instanceof StarknetPrivacySdkPayoutError && error.code === "provider_failure") {
        return finalPayoutObservation(stored, inclusion, "UNKNOWN");
      }
      throw error;
    }
    if (observation.status !== "NOT_FOUND" && observation.status !== "UNKNOWN") {
      const observedBlock = observedInclusion(observation.blockHash, observation.blockNumber);
      if (!samePayoutInclusion(observedBlock, inclusion)) {
        throw invalidRpcResponse();
      }
    }
    switch (observation.status) {
      case "FINAL":
        return finalPayoutObservation(stored, inclusion, "FINAL");
      case "CONFLICTED":
        return finalPayoutObservation(stored, inclusion, "CONFLICTED");
      case "REVERTED":
        return finalPayoutObservation(stored, inclusion, "REVERTED");
      case "REORGED":
        return finalPayoutObservation(stored, inclusion, "REORGED");
      case "NOT_FOUND":
      case "PENDING":
      case "UNKNOWN":
        return finalPayoutObservation(stored, inclusion, "UNKNOWN");
    }
  }

  #validateRequest(value: MeltPaymentEnvelope): NormalizedPayoutRequest {
    if (
      typeof value !== "object" ||
      value === null ||
      value.version !== 1 ||
      value.kind !== "melt"
    ) {
      throw invalidInput("Payout request version or kind is invalid");
    }
    if (value.network !== "SN_SEPOLIA") {
      throw invalidInput("Payout request is not for Starknet Sepolia");
    }
    const tokenContract = inputAddress(value.token_contract, "payout token contract");
    if (tokenContract !== this.#tokenContract) {
      throw invalidInput("Payout request token does not match the configured token");
    }
    if (!Number.isSafeInteger(value.amount) || value.amount <= 0) {
      throw invalidInput("Payout amount is not a positive safe integer");
    }
    if (
      typeof value.amount_base_units !== "string" ||
      value.amount_base_units.length > MAXIMUM_DECIMAL_AMOUNT_LENGTH ||
      !/^[1-9][0-9]*$/.test(value.amount_base_units)
    ) {
      throw invalidInput("Payout base-unit amount is invalid");
    }
    let expectedBaseUnits: bigint;
    try {
      expectedBaseUnits = cashuUsdcToBaseUnits(BigInt(value.amount));
    } catch {
      throw invalidInput("Payout amount is outside the Cashu USDC range");
    }
    if (BigInt(value.amount_base_units) !== expectedBaseUnits) {
      throw invalidInput("Payout amount does not match its exact USDC base-unit value");
    }
    if (!Number.isSafeInteger(value.expires_at) || value.expires_at <= 0) {
      throw invalidInput("Payout expiry is invalid");
    }
    if (
      typeof value.destination !== "object" ||
      value.destination === null ||
      Array.isArray(value.destination)
    ) {
      throw invalidInput("Payout destination is invalid");
    }
    let destination: StarknetPayoutDestination;
    try {
      destination = this.#resolveDestination(value.destination);
    } catch {
      throw invalidInput("Payout destination could not be resolved");
    }
    if (typeof destination !== "object" || destination === null) {
      throw invalidInput("Payout destination resolver returned an invalid result");
    }
    const destinationPool = inputAddress(destination.poolContract, "destination pool contract");
    if (destinationPool !== this.#poolContract) {
      throw invalidInput("Payout destination does not match the configured privacy pool");
    }
    const recipientAddress = inputAddress(destination.recipientAddress, "payout recipient address");
    const requestDigest = payoutRequestDigest({
      network: value.network,
      poolContract: destinationPool,
      tokenContract,
      recipientAddress,
      amount: value.amount,
      amountBaseUnits: value.amount_base_units,
      expiresAt: value.expires_at,
    });
    return { requestDigest, amountBaseUnits: expectedBaseUnits, recipientAddress };
  }

  #assertUnexpired(request: MeltPaymentEnvelope): void {
    const now = this.#now().getTime();
    if (!Number.isFinite(now)) {
      throw new StarknetPrivacySdkPayoutError(
        "invalid_response",
        "Prepared payout clock returned an invalid time",
      );
    }
    if (request.expires_at <= Math.floor(now / 1_000)) {
      throw invalidInput("Payout request has expired before preparation");
    }
  }

  async #verifyChain(): Promise<void> {
    const chainId = await this.#externalValue(
      () => this.#rpc.getChainId(),
      "Starknet payout RPC could not report its chain ID",
    );
    if (inputFelt(chainId, "Starknet chain ID", false, "invalid_response") !== SEPOLIA_CHAIN_ID) {
      throw new StarknetPrivacySdkPayoutError(
        "invalid_response",
        "Starknet payout RPC is connected to the wrong chain",
      );
    }
  }

  async #loadByIntentId(intentId: string): Promise<PreparedPayoutRecord | null> {
    let record: PreparedPayoutRecord | null;
    try {
      record = await this.#store.getByIntentId(intentId);
    } catch (error) {
      throw storeError(error);
    }
    if (record === null) {
      return null;
    }
    return validatedStoredRecord(record);
  }

  async #requiredBySubmissionId(submissionIdValue: string): Promise<PreparedPayoutRecord> {
    const submissionId = inputIdentifier(submissionIdValue, "submission ID");
    let record: PreparedPayoutRecord | null;
    try {
      record = await this.#store.getBySubmissionId(submissionId);
    } catch (error) {
      throw storeError(error);
    }
    if (record === null) {
      throw invalidInput("Prepared payout submission does not exist");
    }
    const validated = validatedStoredRecord(record);
    if (validated.submissionId !== submissionId) {
      throw new StarknetPrivacySdkPayoutError(
        "store_failure",
        "Prepared payout store returned a different submission",
      );
    }
    return validated;
  }

  async #createOrGet(candidate: PreparedPayoutCandidate): Promise<PreparedPayoutRecord> {
    try {
      return validatedStoredRecord(await this.#store.createOrGet(candidate));
    } catch (error) {
      throw storeError(error);
    }
  }

  async #recordInclusion(
    record: PreparedPayoutRecord,
    inclusion: PreparedPayoutInclusion,
  ): Promise<PreparedPayoutRecord> {
    try {
      return validatedStoredRecord(
        await this.#store.recordInclusion({
          submissionId: record.submissionId,
          transactionReference: record.transactionReference,
          ...inclusion,
        }),
      );
    } catch (error) {
      throw storeError(error);
    }
  }

  async #claimSubmission(record: PreparedPayoutRecord): Promise<boolean> {
    const now = this.#now();
    const acquiredMilliseconds = now instanceof Date ? now.getTime() : Number.NaN;
    const expiresMilliseconds = acquiredMilliseconds + this.#limits.submissionLeaseMilliseconds;
    if (!Number.isFinite(acquiredMilliseconds) || !Number.isFinite(expiresMilliseconds)) {
      throw new StarknetPrivacySdkPayoutError(
        "invalid_response",
        "Prepared payout clock returned an invalid time",
      );
    }
    let acquiredAt: string;
    let expiresAt: string;
    try {
      acquiredAt = new Date(acquiredMilliseconds).toISOString();
      expiresAt = new Date(expiresMilliseconds).toISOString();
    } catch {
      throw new StarknetPrivacySdkPayoutError(
        "invalid_response",
        "Prepared payout clock returned an invalid time",
      );
    }
    try {
      return await this.#store.claimSubmission({
        submissionId: record.submissionId,
        transactionReference: record.transactionReference,
        leaseId: randomBytes(SUBMISSION_LEASE_ID_BYTES).toString("base64url"),
        acquiredAt,
        expiresAt,
      });
    } catch (error) {
      throw storeError(error);
    }
  }

  async #observePayout(stored: PreparedPayoutRecord): Promise<ValidatedPreparedPayoutObservation> {
    const observation = await this.#externalValue(
      () =>
        this.#statusSource.observePayoutTransaction({
          network: "SN_SEPOLIA",
          transactionReference: stored.transactionReference,
          finalityPolicy: this.#finalityPolicy,
          ...(stored.inclusion === undefined ? {} : { knownInclusion: { ...stored.inclusion } }),
        }),
      "The prepared payout status could not be observed",
    );
    if (typeof observation !== "object" || observation === null) {
      throw invalidRpcResponse();
    }
    const transactionReference = inputFelt(
      observation.transactionReference,
      "observed transaction hash",
      false,
      "invalid_response",
    );
    if (
      transactionReference !== stored.transactionReference ||
      !CHAIN_STATUSES.has(observation.status)
    ) {
      throw invalidRpcResponse();
    }
    return {
      transactionReference,
      status: observation.status,
      ...(observation.blockHash === undefined ? {} : { blockHash: observation.blockHash }),
      ...(observation.blockNumber === undefined ? {} : { blockNumber: observation.blockNumber }),
    };
  }

  #assertStoredRequest(record: PreparedPayoutRecord, requestDigest: string): void {
    if (
      record.requestDigest !== requestDigest ||
      record.adapterVersion !== this.adapterVersion ||
      record.senderAddress !== this.#senderAddress
    ) {
      throw new StarknetPrivacySdkPayoutError(
        "store_conflict",
        "Prepared payout intent is bound to a different request or adapter",
      );
    }
  }

  async #seal(
    transaction: StarknetSignedInvokeTransaction,
    context: PreparedPayoutPayloadContext,
  ): Promise<PreparedPayoutCandidate["encryptedTransaction"]> {
    try {
      return await this.#cipher.seal(transaction, context);
    } catch {
      throw new StarknetPrivacySdkPayoutError(
        "payload_unavailable",
        "Prepared payout transaction could not be sealed",
      );
    }
  }

  async #open(record: PreparedPayoutRecord): Promise<StarknetSignedInvokeTransaction> {
    let value: unknown;
    try {
      value = await this.#cipher.open(
        record.encryptedTransaction,
        preparedPayoutPayloadContext(record),
      );
    } catch {
      throw new StarknetPrivacySdkPayoutError(
        "payload_unavailable",
        "Prepared payout transaction could not be opened",
      );
    }
    return normalizeSignedTransaction(value, this.#limits);
  }

  async #externalValue<Value>(operation: () => Promise<Value>, message: string): Promise<Value> {
    try {
      return await withTimeout(operation(), this.#limits.requestTimeoutMilliseconds);
    } catch (error) {
      if (error instanceof StarknetPrivacySdkPayoutError) {
        throw error;
      }
      throw new StarknetPrivacySdkPayoutError("provider_failure", message);
    }
  }
}

function validateSdkResult(
  value: StarknetPrivacySdkPayoutExecuteResult,
  poolContract: string,
  provingBlock: StarknetPayoutProvingBlock,
  limits: PayoutLimits,
): ValidatedSdkCallAndProof {
  if (typeof value !== "object" || value === null || !Array.isArray(value.warnings)) {
    throw invalidSdkResponse();
  }
  if (value.warnings.length !== 0) {
    throw new StarknetPrivacySdkPayoutError(
      "preparation_rejected",
      "Privacy SDK reported a privacy warning for the prepared payout",
    );
  }
  if (typeof value.callAndProof !== "object" || value.callAndProof === null) {
    throw invalidSdkResponse();
  }
  const callAndProof = value.callAndProof as {
    readonly call?: unknown;
    readonly proof?: unknown;
  };
  if (
    typeof callAndProof.call !== "object" ||
    callAndProof.call === null ||
    typeof callAndProof.proof !== "object" ||
    callAndProof.proof === null
  ) {
    throw invalidSdkResponse();
  }
  const call = callAndProof.call as {
    readonly contractAddress?: unknown;
    readonly entrypoint?: unknown;
    readonly calldata?: unknown;
  };
  const proof = callAndProof.proof as {
    readonly data?: unknown;
    readonly output?: unknown;
    readonly proofFacts?: unknown;
  };
  if (
    inputAddress(call.contractAddress, "SDK payout pool", "invalid_response") !== poolContract ||
    call.entrypoint !== "apply_actions"
  ) {
    throw invalidSdkResponse();
  }
  const calldata = inputFeltArray(
    call.calldata,
    "SDK payout calldata",
    1,
    limits.maximumCallCalldataFelts,
    "invalid_response",
  );
  const proofFacts = inputFeltArray(
    proof.proofFacts,
    "SDK payout proof facts",
    MINIMUM_BLOCK_BOUND_PROOF_FACTS,
    limits.maximumProofFacts,
    "invalid_response",
  );
  if (
    proofFacts[PROOF_BASE_BLOCK_NUMBER_INDEX] !== `0x${provingBlock.blockNumber.toString(16)}` ||
    proofFacts[PROOF_BASE_BLOCK_HASH_INDEX] !== provingBlock.blockHash
  ) {
    throw new StarknetPrivacySdkPayoutError(
      "invalid_response",
      "Privacy SDK proof facts do not match the selected proving block",
    );
  }
  inputFeltArray(
    proof.output,
    "SDK payout proof output",
    1,
    limits.maximumProofOutputFelts,
    "invalid_response",
  );
  const proofData = inputBase64Proof(proof.data, limits.maximumProofBytes);
  return {
    call: { contractAddress: poolContract, entrypoint: "apply_actions", calldata },
    proof: proofData,
    proofFacts,
  };
}

function inputProvingBlock(value: unknown): StarknetPayoutProvingBlock {
  if (typeof value !== "object" || value === null) {
    throw new StarknetPrivacySdkPayoutError(
      "invalid_response",
      "Proving-block selector returned an invalid block",
    );
  }
  const candidate = value as { readonly blockHash?: unknown; readonly blockNumber?: unknown };
  const blockHash = inputFelt(candidate.blockHash, "proving block hash", false, "invalid_response");
  if (
    typeof candidate.blockNumber !== "bigint" ||
    candidate.blockNumber < 0n ||
    candidate.blockNumber > MAXIMUM_BLOCK_NUMBER
  ) {
    throw new StarknetPrivacySdkPayoutError(
      "invalid_response",
      "Proving-block selector returned an invalid block number",
    );
  }
  return { blockHash, blockNumber: candidate.blockNumber };
}

function normalizeSignedTransaction(
  value: unknown,
  limits: PayoutLimits,
): StarknetSignedInvokeTransaction {
  if (typeof value !== "object" || value === null) {
    throw invalidSignedTransaction();
  }
  const candidate = value as Partial<StarknetSignedInvokeTransaction>;
  if (candidate.type !== "INVOKE" || candidate.version !== ETransactionVersion.V3) {
    throw invalidSignedTransaction();
  }
  const senderAddress = inputAddress(
    candidate.sender_address,
    "signed transaction sender",
    "invalid_response",
  );
  const calldata = inputFeltArray(
    candidate.calldata,
    "signed transaction calldata",
    1,
    limits.maximumTransactionCalldataFelts,
    "invalid_response",
  );
  const signature = inputFeltArray(
    candidate.signature,
    "signed transaction signature",
    1,
    limits.maximumSignatureFelts,
    "invalid_response",
  );
  const nonce = inputFelt(candidate.nonce, "signed transaction nonce", true, "invalid_response");
  const paymasterData = inputFeltArray(
    candidate.paymaster_data,
    "signed transaction paymaster data",
    0,
    MAXIMUM_AUXILIARY_TRANSACTION_FELTS,
    "invalid_response",
  );
  const accountDeploymentData = inputFeltArray(
    candidate.account_deployment_data,
    "signed transaction account deployment data",
    0,
    MAXIMUM_AUXILIARY_TRANSACTION_FELTS,
    "invalid_response",
  );
  const proofFacts = inputFeltArray(
    candidate.proof_facts,
    "signed transaction proof facts",
    1,
    limits.maximumProofFacts,
    "invalid_response",
  );
  const proof = inputBase64Proof(candidate.proof, limits.maximumProofBytes);
  const tip = inputUnsignedInteger(candidate.tip, "signed transaction tip", 64);
  const resourceBounds = inputResourceBounds(candidate.resource_bounds);
  assertFeePolicy(resourceBounds.bigint, tip, limits);
  const nonceMode = inputDataAvailabilityMode(candidate.nonce_data_availability_mode);
  const feeMode = inputDataAvailabilityMode(candidate.fee_data_availability_mode);
  return {
    type: "INVOKE",
    sender_address: senderAddress,
    calldata,
    version: ETransactionVersion.V3,
    signature,
    nonce,
    resource_bounds: resourceBounds.serialized,
    tip: `0x${tip.toString(16)}`,
    paymaster_data: paymasterData,
    account_deployment_data: accountDeploymentData,
    nonce_data_availability_mode: nonceMode.serialized,
    fee_data_availability_mode: feeMode.serialized,
    proof_facts: proofFacts,
    proof,
  };
}

function expectedSignedCalldata(call: Call, cairoVersion: unknown, limits: PayoutLimits): string[] {
  if (cairoVersion !== "0" && cairoVersion !== "1") {
    throw new StarknetPrivacySdkPayoutError(
      "invalid_response",
      "Starknet account returned an unsupported Cairo version",
    );
  }
  let calldata: unknown;
  try {
    calldata = transaction.getExecuteCalldata([call], cairoVersion);
  } catch {
    throw invalidSignedTransaction();
  }
  return inputFeltArray(
    calldata,
    "expected signed transaction calldata",
    1,
    limits.maximumTransactionCalldataFelts,
    "invalid_response",
  );
}

function assertFeePolicy(
  resourceBounds: ResourceBoundsBN,
  tip: bigint,
  limits: PayoutLimits,
): void {
  const maximumResourceFee =
    resourceBounds.l1_gas.max_amount * resourceBounds.l1_gas.max_price_per_unit +
    resourceBounds.l1_data_gas.max_amount * resourceBounds.l1_data_gas.max_price_per_unit +
    resourceBounds.l2_gas.max_amount * resourceBounds.l2_gas.max_price_per_unit;
  if (maximumResourceFee > limits.maximumResourceFeeFri || tip > limits.maximumTipFri) {
    throw new StarknetPrivacySdkPayoutError(
      "preparation_rejected",
      "Signed payout transaction exceeds the configured fee policy",
    );
  }
}

function calculateSignedTransactionHash(transaction: StarknetSignedInvokeTransaction): string {
  const resourceBounds = inputResourceBounds(transaction.resource_bounds).bigint;
  const nonceMode = inputDataAvailabilityMode(transaction.nonce_data_availability_mode).hash;
  const feeMode = inputDataAvailabilityMode(transaction.fee_data_availability_mode).hash;
  const calculated = hash.calculateInvokeTransactionHash({
    senderAddress: transaction.sender_address,
    version: ETransactionVersion.V3,
    compiledCalldata: transaction.calldata,
    chainId: constants.StarknetChainId.SN_SEPOLIA,
    nonce: transaction.nonce,
    accountDeploymentData: transaction.account_deployment_data,
    nonceDataAvailabilityMode: nonceMode,
    feeDataAvailabilityMode: feeMode,
    resourceBounds,
    tip: transaction.tip,
    paymasterData: transaction.paymaster_data,
    proofFacts: transaction.proof_facts,
  });
  return inputFelt(calculated, "calculated transaction hash", false, "invalid_response");
}

function inputResourceBounds(value: unknown): {
  readonly serialized: StarknetSignedInvokeTransaction["resource_bounds"];
  readonly bigint: ResourceBoundsBN;
} {
  if (typeof value !== "object" || value === null) {
    throw invalidSignedTransaction();
  }
  const candidate = value as {
    readonly l1_gas?: unknown;
    readonly l1_data_gas?: unknown;
    readonly l2_gas?: unknown;
  };
  const l1Gas = inputResourceBound(candidate.l1_gas, "L1 gas");
  const l1DataGas = inputResourceBound(candidate.l1_data_gas, "L1 data gas");
  const l2Gas = inputResourceBound(candidate.l2_gas, "L2 gas");
  return {
    serialized: {
      l1_gas: serializedResourceBound(l1Gas),
      l1_data_gas: serializedResourceBound(l1DataGas),
      l2_gas: serializedResourceBound(l2Gas),
    },
    bigint: {
      l1_gas: l1Gas,
      l1_data_gas: l1DataGas,
      l2_gas: l2Gas,
    },
  };
}

function inputResourceBound(
  value: unknown,
  label: string,
): { readonly max_amount: bigint; readonly max_price_per_unit: bigint } {
  if (typeof value !== "object" || value === null) {
    throw invalidSignedTransaction();
  }
  const candidate = value as {
    readonly max_amount?: unknown;
    readonly max_price_per_unit?: unknown;
  };
  return {
    max_amount: inputUnsignedInteger(candidate.max_amount, `${label} maximum amount`, 64),
    max_price_per_unit: inputUnsignedInteger(
      candidate.max_price_per_unit,
      `${label} maximum price per unit`,
      128,
    ),
  };
}

function serializedResourceBound(value: {
  readonly max_amount: bigint;
  readonly max_price_per_unit: bigint;
}): { readonly max_amount: string; readonly max_price_per_unit: string } {
  return {
    max_amount: `0x${value.max_amount.toString(16)}`,
    max_price_per_unit: `0x${value.max_price_per_unit.toString(16)}`,
  };
}

function inputDataAvailabilityMode(value: unknown): {
  readonly serialized: (typeof EDataAvailabilityMode)[keyof typeof EDataAvailabilityMode];
  readonly hash: (typeof EDAMode)[keyof typeof EDAMode];
} {
  if (value === EDataAvailabilityMode.L1) {
    return { serialized: EDataAvailabilityMode.L1, hash: EDAMode.L1 };
  }
  if (value === EDataAvailabilityMode.L2) {
    return { serialized: EDataAvailabilityMode.L2, hash: EDAMode.L2 };
  }
  throw invalidSignedTransaction();
}

function inputUnsignedInteger(value: unknown, label: string, bits: number): bigint {
  if (typeof value !== "string" || !/^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) {
    throw new StarknetPrivacySdkPayoutError("invalid_response", `${label} is invalid`);
  }
  const parsed = BigInt(value);
  if (parsed >= 1n << BigInt(bits)) {
    throw new StarknetPrivacySdkPayoutError("invalid_response", `${label} is out of range`);
  }
  return parsed;
}

function inputFeltArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  code: StarknetPrivacySdkPayoutErrorCode,
): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new StarknetPrivacySdkPayoutError(code, `${label} is invalid`);
  }
  return Array.from(value, (item, index) => inputFelt(item, `${label} item ${index}`, true, code));
}

function inputBase64Proof(value: unknown, maximumBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumBytes * 2) {
    throw invalidSdkResponse();
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64");
  } catch {
    throw invalidSdkResponse();
  }
  if (
    decoded.byteLength === 0 ||
    decoded.byteLength > maximumBytes ||
    decoded.toString("base64") !== value
  ) {
    throw invalidSdkResponse();
  }
  return value;
}

function inputAddress(
  value: unknown,
  label: string,
  code: StarknetPrivacySdkPayoutErrorCode = "invalid_input",
): string {
  const normalized = inputFelt(value, label, false, code);
  if (BigInt(normalized) >= STARKNET_ADDRESS_BOUND) {
    throw new StarknetPrivacySdkPayoutError(code, `${label} is out of range`);
  }
  return normalized;
}

function configuredAddress(value: unknown, label: string): string {
  try {
    return inputAddress(value, label);
  } catch {
    throw configurationError(`Configured ${label} is invalid`);
  }
}

function inputFelt(
  value: unknown,
  label: string,
  allowZero: boolean,
  code: StarknetPrivacySdkPayoutErrorCode = "invalid_input",
): string {
  if (
    (typeof value !== "string" && typeof value !== "bigint") ||
    (typeof value === "string" &&
      (value.length > MAXIMUM_FELT_LENGTH || !/^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(value)))
  ) {
    throw new StarknetPrivacySdkPayoutError(code, `${label} is invalid`);
  }
  const parsed = BigInt(value);
  if ((!allowZero && parsed === 0n) || parsed < 0n || parsed >= STARK_FIELD_PRIME) {
    throw new StarknetPrivacySdkPayoutError(code, `${label} is out of range`);
  }
  return `0x${parsed.toString(16)}`;
}

function inputIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAXIMUM_IDENTIFIER_LENGTH ||
    containsControlCharacter(value)
  ) {
    throw invalidInput(`Payout ${label} is invalid`);
  }
  return value;
}

function payoutRequestDigest(input: {
  readonly network: string;
  readonly poolContract: string;
  readonly tokenContract: string;
  readonly recipientAddress: string;
  readonly amount: number;
  readonly amountBaseUnits: string;
  readonly expiresAt: number;
}): string {
  const encoded = JSON.stringify({
    domain: "cashu-strk20/private-payout-request/v1",
    network: input.network,
    poolContract: input.poolContract,
    tokenContract: input.tokenContract,
    recipientAddress: input.recipientAddress,
    amount: input.amount.toString(10),
    amountBaseUnits: input.amountBaseUnits,
    expiresAt: input.expiresAt.toString(10),
  });
  return `sha256:${createHash("sha256").update(encoded, "utf8").digest("hex")}`;
}

function payoutAttempt(
  record: PreparedPayoutRecord,
  status: PayoutAttempt["status"],
): PayoutAttempt {
  return {
    intentId: record.intentId,
    submissionId: record.submissionId,
    status,
    transactionReference: record.transactionReference,
  };
}

function finalPayoutObservation(
  record: PreparedPayoutRecord,
  inclusion: PreparedPayoutInclusion,
  status: FinalPayoutCanonicalObservation["status"],
): FinalPayoutCanonicalObservation {
  return {
    intentId: record.intentId,
    submissionId: record.submissionId,
    transactionReference: record.transactionReference,
    inclusion: { ...inclusion },
    status,
  };
}

function samePayoutInclusion(
  left: PreparedPayoutInclusion,
  right: PreparedPayoutInclusion,
): boolean {
  return left.blockHash === right.blockHash && left.blockNumber === right.blockNumber;
}

function validatedStoredRecord(value: PreparedPayoutRecord): PreparedPayoutRecord {
  try {
    assertPreparedPayoutRecord(value);
    return clonePreparedPayoutRecord(value);
  } catch {
    throw new StarknetPrivacySdkPayoutError(
      "store_failure",
      "Prepared payout store returned an invalid artifact",
    );
  }
}

function observedInclusion(blockHash: unknown, blockNumber: unknown): PreparedPayoutInclusion {
  const normalizedHash = inputFelt(
    blockHash,
    "observed payout block hash",
    false,
    "invalid_response",
  );
  if (typeof blockNumber !== "bigint" || blockNumber < 0n || blockNumber > MAXIMUM_BLOCK_NUMBER) {
    throw invalidRpcResponse();
  }
  return { blockHash: normalizedHash, blockNumber };
}

function storeError(error: unknown): StarknetPrivacySdkPayoutError {
  if (error instanceof StarknetPrivacySdkPayoutError) {
    return error;
  }
  if (error instanceof PreparedPayoutConflictError) {
    return new StarknetPrivacySdkPayoutError(
      "store_conflict",
      "Prepared payout ownership conflicts with another artifact",
    );
  }
  if (error instanceof PreparedPayoutIntegrityError) {
    return new StarknetPrivacySdkPayoutError(
      "store_failure",
      "Prepared payout store rejected an invalid artifact",
    );
  }
  return new StarknetPrivacySdkPayoutError("store_failure", "Prepared payout store is unavailable");
}

function configuredLimits(value: StarknetPrivacySdkPayoutLimits): PayoutLimits {
  if (typeof value !== "object" || value === null) {
    throw configurationError("Prepared payout resource limits are invalid");
  }
  const requestTimeoutMilliseconds = configuredPositiveInteger(
    value.requestTimeoutMilliseconds,
    HARD_MAXIMUM_REQUEST_TIMEOUT_MILLISECONDS,
    "request timeout",
  );
  const submissionLeaseMilliseconds = configuredPositiveInteger(
    value.submissionLeaseMilliseconds,
    MAXIMUM_PREPARED_PAYOUT_SUBMISSION_LEASE_MILLISECONDS,
    "submission lease",
  );
  if (submissionLeaseMilliseconds <= requestTimeoutMilliseconds) {
    throw configurationError("Configured submission lease must outlive the request timeout");
  }
  return {
    maximumCallCalldataFelts: configuredPositiveInteger(
      value.maximumCallCalldataFelts,
      HARD_MAXIMUM_CALLDATA_FELTS,
      "maximum SDK call calldata",
    ),
    maximumProofBytes: configuredPositiveInteger(
      value.maximumProofBytes,
      HARD_MAXIMUM_PROOF_BYTES,
      "maximum proof bytes",
    ),
    maximumProofFacts: configuredProofFactLimit(value.maximumProofFacts),
    maximumProofOutputFelts: configuredPositiveInteger(
      value.maximumProofOutputFelts,
      HARD_MAXIMUM_PROOF_OUTPUT_FELTS,
      "maximum proof output",
    ),
    maximumSignatureFelts: configuredPositiveInteger(
      value.maximumSignatureFelts,
      HARD_MAXIMUM_SIGNATURE_FELTS,
      "maximum signature felts",
    ),
    maximumTransactionCalldataFelts: configuredPositiveInteger(
      value.maximumTransactionCalldataFelts,
      HARD_MAXIMUM_CALLDATA_FELTS,
      "maximum transaction calldata",
    ),
    maximumResourceFeeFri: configuredBigInt(
      value.maximumResourceFeeFri,
      1n,
      HARD_MAXIMUM_RESOURCE_FEE_FRI,
      "maximum resource fee in fri",
    ),
    maximumTipFri: configuredBigInt(
      value.maximumTipFri,
      0n,
      HARD_MAXIMUM_TIP_FRI,
      "maximum priority tip in fri",
    ),
    requestTimeoutMilliseconds,
    submissionLeaseMilliseconds,
  };
}

function configuredProofFactLimit(value: number): number {
  const configured = configuredPositiveInteger(
    value,
    HARD_MAXIMUM_PROOF_FACTS,
    "maximum proof facts",
  );
  if (configured < MINIMUM_BLOCK_BOUND_PROOF_FACTS) {
    throw configurationError("Configured maximum proof facts cannot bind a proving block");
  }
  return configured;
}

function configuredBigInt(value: bigint, minimum: bigint, maximum: bigint, label: string): bigint {
  if (typeof value !== "bigint" || value < minimum || value > maximum) {
    throw configurationError(`Configured ${label} is invalid`);
  }
  return value;
}

function configuredPositiveInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw configurationError(`Configured ${label} is invalid`);
  }
  return value;
}

function assertConfiguredObject(
  value: unknown,
  methods: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    methods.some((method) => typeof (value as Record<string, unknown>)[method] !== "function")
  ) {
    throw configurationError(`Configured ${label} is invalid`);
  }
}

function configuredIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAXIMUM_IDENTIFIER_LENGTH ||
    containsControlCharacter(value)
  ) {
    throw configurationError(`Configured ${label} is invalid`);
  }
  return value;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function withTimeout<Value>(
  operation: Promise<Value>,
  timeoutMilliseconds: number,
): Promise<Value> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Prepared payout request timed out")),
      timeoutMilliseconds,
    );
    timeout.unref?.();
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

function invalidInput(message: string): StarknetPrivacySdkPayoutError {
  return new StarknetPrivacySdkPayoutError("invalid_input", message);
}

function invalidSdkResponse(): StarknetPrivacySdkPayoutError {
  return new StarknetPrivacySdkPayoutError(
    "invalid_response",
    "Privacy SDK returned an invalid prepared payout",
  );
}

function invalidSignedTransaction(): StarknetPrivacySdkPayoutError {
  return new StarknetPrivacySdkPayoutError(
    "invalid_response",
    "Starknet account returned an invalid signed payout transaction",
  );
}

function invalidRpcResponse(): StarknetPrivacySdkPayoutError {
  return new StarknetPrivacySdkPayoutError(
    "invalid_response",
    "Starknet payout provider returned an invalid response",
  );
}

function configurationError(message: string): StarknetPrivacySdkPayoutConfigurationError {
  return new StarknetPrivacySdkPayoutConfigurationError(message);
}

const CHAIN_STATUSES: ReadonlySet<StarknetPreparedPayoutChainStatus> = new Set([
  "CONFLICTED",
  "FINAL",
  "NOT_FOUND",
  "PENDING",
  "REORGED",
  "REVERTED",
  "UNKNOWN",
]);
const SEPOLIA_CHAIN_ID = "0x534e5f5345504f4c4941";
const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
const STARKNET_ADDRESS_BOUND = (1n << 251n) - 256n;
const SUBMISSION_ID_BYTES = 32;
const SUBMISSION_LEASE_ID_BYTES = 32;
const MAXIMUM_FELT_LENGTH = 78;
const MAXIMUM_IDENTIFIER_LENGTH = 512;
const MAXIMUM_DECIMAL_AMOUNT_LENGTH = 32;
const MAXIMUM_BLOCK_NUMBER = (1n << 64n) - 1n;
const MINIMUM_BLOCK_BOUND_PROOF_FACTS = 6;
const PROOF_BASE_BLOCK_NUMBER_INDEX = 4;
const PROOF_BASE_BLOCK_HASH_INDEX = 5;
const MAXIMUM_AUXILIARY_TRANSACTION_FELTS = 256;
const HARD_MAXIMUM_CALLDATA_FELTS = 100_000;
const HARD_MAXIMUM_PROOF_BYTES = 2 * 1024 * 1024;
const HARD_MAXIMUM_PROOF_FACTS = 16_384;
const HARD_MAXIMUM_PROOF_OUTPUT_FELTS = 100_000;
const HARD_MAXIMUM_SIGNATURE_FELTS = 1_024;
const HARD_MAXIMUM_RESOURCE_FEE_FRI = (1n << 256n) - 1n;
const HARD_MAXIMUM_TIP_FRI = (1n << 64n) - 1n;
const HARD_MAXIMUM_REQUEST_TIMEOUT_MILLISECONDS = 5 * 60_000;
