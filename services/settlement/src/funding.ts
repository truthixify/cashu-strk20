import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  ATTRIBUTION_PROFILES,
  type AttributionProfile,
  assertCashuAmount,
  baseUnitsToCashuUsdc,
  PAYMENT_OBSERVATION_STATUSES,
  type PaymentObservation,
  STARKNET_NETWORKS,
  type StarknetNetwork,
} from "@cashu-strk20/strk20-method";
import {
  assertSameFundingRequest,
  FundingEvidenceConflictError,
  type FundingRequestIdentity,
  type FundingRequestRecord,
  type FundingRequestStore,
} from "./funding-records.js";
import type {
  FundingDiscoveryInput,
  FundingInstructions,
  FundingRequestInput,
  PrivateFundingGateway,
} from "./gateway.js";
import { fundingGatewayAttributionProfiles } from "./gateway.js";
import type { PayerBindingChallengeStore } from "./payer-binding-records.js";
import { type VerifiedPayerBinding, verifiedPayerBindingFromRecord } from "./payer-bindings.js";
import { derivePrivacyEvidenceId } from "./privacy-evidence.js";
import {
  SettlementFundingFinalizationBlockedError,
  type SettlementFundingFinalizationGate,
} from "./settlement-activity-gate.js";
import {
  type SettlementAdmissionChecker,
  SettlementAdmissionUnavailableError,
  SettlementProfilePausedError,
} from "./settlement-admission.js";
import { SETTLEMENT_METHOD } from "./settlement-pauses.js";

export type FundingValidationErrorCode =
  | "invalid_payment_request_id"
  | "invalid_funding_request"
  | "unsupported_network"
  | "unsupported_pool"
  | "unsupported_token"
  | "unsupported_attribution_profile"
  | "amount_out_of_range"
  | "request_expired";

export class FundingValidationError extends Error {
  readonly code: FundingValidationErrorCode;

  constructor(code: FundingValidationErrorCode, message: string) {
    super(message);
    this.name = "FundingValidationError";
    this.code = code;
  }
}

export class FundingGatewayProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FundingGatewayProtocolError";
  }
}

export class FundingConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FundingConfigurationError";
  }
}

export class FundingCoordinatorIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FundingCoordinatorIntegrityError";
  }
}

export interface FundingProgress {
  readonly paymentRequestId: string;
  readonly state: FundingRequestRecord["state"];
  readonly destination: Readonly<Record<string, unknown>>;
  readonly acceptedEvidenceId?: string;
  readonly operatorReason?: string;
}

export interface FundingReconciliationInput {
  readonly paymentRequestId: string;
  readonly transactionHint?: string;
}

export interface FundingCoordinatorConfig {
  readonly network: StarknetNetwork;
  readonly poolContract: string;
  readonly tokenContract: string;
  readonly attributionProfiles: readonly AttributionProfile[];
  readonly minimumAmount: bigint;
  readonly maximumAmount: bigint;
  readonly finalityPolicy: string;
  readonly payerBindingRecipientAddress?: string;
  readonly payerBindingVerifierVersion?: string;
  readonly payerBindingStore?: PayerBindingChallengeStore;
  readonly admission: SettlementAdmissionChecker;
  readonly finalizationGate: SettlementFundingFinalizationGate;
  readonly now?: () => Date;
}

export function generatePaymentRequestId(): string {
  return randomBytes(PAYMENT_REQUEST_ID_BYTES).toString("base64url");
}

export class FundingCoordinator {
  readonly #network: StarknetNetwork;
  readonly #poolContract: string;
  readonly #tokenContract: string;
  readonly #attributionProfiles: ReadonlySet<AttributionProfile>;
  readonly #minimumAmount: bigint;
  readonly #maximumAmount: bigint;
  readonly #finalityPolicy: string;
  readonly #payerBindingRecipientAddress: string | undefined;
  readonly #payerBindingVerifierVersion: string | undefined;
  readonly #payerBindingStore: PayerBindingChallengeStore | undefined;
  readonly #admission: SettlementAdmissionChecker;
  readonly #finalizationGate: SettlementFundingFinalizationGate;
  readonly #profile: {
    readonly method: typeof SETTLEMENT_METHOD;
    readonly network: StarknetNetwork;
    readonly tokenContract: string;
  };
  readonly #now: () => Date;

  constructor(
    readonly store: FundingRequestStore,
    readonly gateway: PrivateFundingGateway,
    config: FundingCoordinatorConfig,
  ) {
    if (config.network !== "SN_SEPOLIA") {
      throw new FundingConfigurationError("Only Starknet Sepolia is enabled for funding");
    }
    if (!Array.isArray(config.attributionProfiles) || config.attributionProfiles.length === 0) {
      throw new FundingConfigurationError("At least one attribution profile must be enabled");
    }
    const configuredAttributionProfiles: unknown[] = Array.from(config.attributionProfiles);
    if (
      configuredAttributionProfiles.some(
        (profile) =>
          typeof profile !== "string" ||
          !ATTRIBUTION_PROFILES.includes(profile as AttributionProfile),
      )
    ) {
      throw new FundingConfigurationError("Configured attribution profile is invalid");
    }
    if (new Set(configuredAttributionProfiles).size !== configuredAttributionProfiles.length) {
      throw new FundingConfigurationError("Configured attribution profiles contain duplicates");
    }
    const attributionProfiles = configuredAttributionProfiles as AttributionProfile[];
    let gatewayAttributionProfiles: readonly AttributionProfile[];
    try {
      gatewayAttributionProfiles = fundingGatewayAttributionProfiles(gateway);
    } catch {
      throw new FundingConfigurationError(
        "Configured funding gateway attribution profiles are invalid",
      );
    }
    const gatewayAttributionProfileSet = new Set(gatewayAttributionProfiles);
    if (attributionProfiles.some((profile) => !gatewayAttributionProfileSet.has(profile))) {
      throw new FundingConfigurationError(
        "Configured attribution profile is not supported by the funding gateway",
      );
    }
    try {
      assertCashuAmount(config.minimumAmount);
      assertCashuAmount(config.maximumAmount);
    } catch {
      throw new FundingConfigurationError("Funding amount policy is outside the Cashu u64 range");
    }
    if (config.minimumAmount > config.maximumAmount) {
      throw new FundingConfigurationError("Minimum funding amount exceeds the maximum");
    }

    this.#network = config.network;
    this.#poolContract = normalizeConfiguredAddress(config.poolContract, "pool contract");
    this.#tokenContract = normalizeConfiguredAddress(config.tokenContract, "token contract");
    this.#attributionProfiles = new Set(attributionProfiles);
    this.#minimumAmount = config.minimumAmount;
    this.#maximumAmount = config.maximumAmount;
    this.#finalityPolicy = assertConfiguredIdentifier(config.finalityPolicy, "finality policy");
    if (
      this.#attributionProfiles.has("signed_payer") &&
      (config.payerBindingRecipientAddress === undefined ||
        config.payerBindingVerifierVersion === undefined ||
        config.payerBindingStore === undefined)
    ) {
      throw new FundingConfigurationError(
        "Signed-payer funding requires a recipient and verifier version",
      );
    }
    this.#payerBindingRecipientAddress =
      config.payerBindingRecipientAddress === undefined
        ? undefined
        : normalizeConfiguredAddress(
            config.payerBindingRecipientAddress,
            "payer binding recipient address",
          );
    this.#payerBindingVerifierVersion =
      config.payerBindingVerifierVersion === undefined
        ? undefined
        : assertConfiguredIdentifier(
            config.payerBindingVerifierVersion,
            "payer binding verifier version",
          );
    this.#payerBindingStore = config.payerBindingStore;
    if (
      typeof config.admission !== "object" ||
      config.admission === null ||
      typeof config.admission.assertActive !== "function"
    ) {
      throw new FundingConfigurationError("Configured settlement admission checker is invalid");
    }
    this.#admission = config.admission;
    if (
      typeof config.finalizationGate !== "object" ||
      config.finalizationGate === null ||
      typeof config.finalizationGate.runFundingFinalization !== "function"
    ) {
      throw new FundingConfigurationError(
        "Configured settlement funding finalization gate is invalid",
      );
    }
    this.#finalizationGate = config.finalizationGate;
    this.#profile = {
      method: SETTLEMENT_METHOD,
      network: this.#network,
      tokenContract: this.#tokenContract,
    };
    this.#now = config.now ?? (() => new Date());
  }

  async ensureFundingRequest(input: FundingRequestInput): Promise<FundingProgress> {
    const identityWithoutDestination = await this.#validateFundingRequest(input);
    await this.#assertAdmission();
    const existing = await this.store.getByPaymentRequestId(input.paymentRequestId);
    if (existing !== null) {
      assertSameFundingRequest(existing.identity, {
        ...identityWithoutDestination,
        destination: existing.identity.destination,
      });
      return progress(existing);
    }

    this.#assertUnexpired(identityWithoutDestination.expiresAt);
    const instructions = await this.gateway.createFundingInstructions({
      paymentRequestId: identityWithoutDestination.paymentRequestId,
      network: identityWithoutDestination.network,
      poolContract: identityWithoutDestination.poolContract,
      tokenContract: identityWithoutDestination.tokenContract,
      amountBaseUnits: BigInt(identityWithoutDestination.amountBaseUnits),
      expiresAt: new Date(identityWithoutDestination.expiresAt * 1_000),
      attributionProfile: identityWithoutDestination.attributionProfile,
      ...(identityWithoutDestination.verifiedPayerBinding === undefined
        ? {}
        : { verifiedPayerBinding: { ...identityWithoutDestination.verifiedPayerBinding } }),
    });
    this.#assertInstructions(instructions, input.paymentRequestId);

    const record = await this.store.createOrGet({
      identity: {
        ...identityWithoutDestination,
        destination: structuredClone(instructions.destination),
      },
    });
    return progress(record);
  }

  async reconcileFunding(input: FundingReconciliationInput): Promise<FundingProgress> {
    assertPaymentRequestId(input.paymentRequestId);
    assertTransactionHint(input.transactionHint);
    let record = await this.store.getByPaymentRequestId(input.paymentRequestId);
    if (record === null) {
      throw new FundingValidationError(
        "invalid_payment_request_id",
        "Funding request does not exist",
      );
    }
    if (record.state === "ISSUED" || record.state === "OPERATOR_REQUIRED") {
      return progress(record);
    }

    const discoveryInput: FundingDiscoveryInput = {
      paymentRequestId: input.paymentRequestId,
      knownEvidence: record.evidence
        .map(({ observation }) => structuredClone(observation))
        .sort(compareEvidenceIds),
      ...(record.identity.verifiedPayerBinding === undefined
        ? {}
        : { verifiedPayerBinding: { ...record.identity.verifiedPayerBinding } }),
      ...(input.transactionHint === undefined ? {} : { transactionHint: input.transactionHint }),
    };

    let observations: readonly PaymentObservation[];
    try {
      observations = await this.gateway.findFundingPayments(discoveryInput);
      this.#assertObservationCollection(observations, input.paymentRequestId);
      observations = snapshotObservations(observations);
    } catch (error) {
      if (error instanceof FundingGatewayProtocolError) {
        throw error;
      }
      return progress(record);
    }

    const observedAt = this.#nowSeconds();
    if (
      (record.state === "CREATED" || record.state === "REJECTED") &&
      observedAt >= record.identity.expiresAt
    ) {
      record = await this.store.expire(input.paymentRequestId);
    }

    const ordered = [...observations].sort(compareEvidenceIds);
    for (const observation of ordered) {
      const matchesRequest = this.#matchesRequest(record.identity, observation);
      try {
        record = await this.store.recordEvidence({
          paymentRequestId: input.paymentRequestId,
          observation,
          observedAt,
          matchesRequest,
        });
      } catch (error) {
        if (!(error instanceof FundingEvidenceConflictError)) {
          throw error;
        }
        record = await this.store.requireOperator(
          input.paymentRequestId,
          "evidence_claimed_by_another_request",
        );
      }

      const recordedEvidence = record.evidence.find(
        (candidate) => candidate.observation.evidence_id === observation.evidence_id,
      );
      if (
        matchesRequest &&
        recordedEvidence?.observation.status === "FINAL" &&
        record.state === "OBSERVED" &&
        record.acceptedEvidenceId === observation.evidence_id
      ) {
        try {
          record = await this.#markPaid(input.paymentRequestId, observation.evidence_id);
        } catch (error) {
          if (
            error instanceof SettlementProfilePausedError ||
            error instanceof SettlementFundingFinalizationBlockedError
          ) {
            record = await this.store.requireOperator(
              input.paymentRequestId,
              error instanceof SettlementProfilePausedError
                ? "settlement_profile_paused"
                : "settlement_activity_blocked",
            );
          } else if (error instanceof SettlementAdmissionUnavailableError) {
            return progress(record);
          } else {
            throw error;
          }
        }
      }
      if (record.state === "OPERATOR_REQUIRED") {
        break;
      }
    }

    return progress(record);
  }

  async #assertAdmission(): Promise<void> {
    await this.#admission.assertActive(this.#profile);
  }

  async #markPaid(paymentRequestId: string, evidenceId: string): Promise<FundingRequestRecord> {
    let gateOpen = true;
    let finalizationEntered = false;
    let finalized: FundingRequestRecord | undefined;
    try {
      await this.#finalizationGate.runFundingFinalization(this.#profile, async () => {
        if (!gateOpen || finalizationEntered) {
          throw new FundingCoordinatorIntegrityError(
            "Settlement funding finalization gate invoked the callback more than once",
          );
        }
        finalizationEntered = true;
        await this.#assertAdmission();
        if (!gateOpen) {
          throw new FundingCoordinatorIntegrityError(
            "Settlement funding finalization gate returned before the callback completed",
          );
        }
        finalized = await this.store.markPaid(paymentRequestId, evidenceId);
      });
    } finally {
      gateOpen = false;
    }
    if (!finalizationEntered || finalized === undefined) {
      throw new FundingCoordinatorIntegrityError(
        "Settlement funding finalization gate did not complete the callback",
      );
    }
    return finalized;
  }

  async #validateFundingRequest(
    input: FundingRequestInput,
  ): Promise<Omit<FundingRequestIdentity, "destination">> {
    assertPaymentRequestId(input.paymentRequestId);
    if (input.network !== this.#network) {
      throw new FundingValidationError("unsupported_network", "Funding network is not enabled");
    }
    const poolContract = normalizeInputAddress(input.poolContract, "Funding pool contract");
    if (poolContract !== this.#poolContract) {
      throw new FundingValidationError("unsupported_pool", "Funding pool is not enabled");
    }
    const tokenContract = normalizeInputAddress(input.tokenContract, "Funding token contract");
    if (tokenContract !== this.#tokenContract) {
      throw new FundingValidationError("unsupported_token", "Funding token is not enabled");
    }
    if (!this.#attributionProfiles.has(input.attributionProfile)) {
      throw new FundingValidationError(
        "unsupported_attribution_profile",
        "Funding attribution profile is not enabled",
      );
    }

    let amount: bigint;
    try {
      amount = baseUnitsToCashuUsdc(input.amountBaseUnits);
    } catch {
      throw new FundingValidationError(
        "amount_out_of_range",
        "Funding amount must be an exact positive Cashu USDC value",
      );
    }
    if (amount < this.#minimumAmount || amount > this.#maximumAmount) {
      throw new FundingValidationError(
        "amount_out_of_range",
        "Funding amount is outside the configured policy",
      );
    }

    const expiresAt = exactUnixSeconds(input.expiresAt, "Funding request expiry");
    const verifiedPayerBinding = await this.#validatePayerBinding(
      input,
      poolContract,
      tokenContract,
      expiresAt,
    );
    return {
      paymentRequestId: input.paymentRequestId,
      network: input.network,
      poolContract,
      tokenContract,
      amountBaseUnits: input.amountBaseUnits.toString(),
      expiresAt,
      attributionProfile: input.attributionProfile,
      finalityPolicy: this.#finalityPolicy,
      ...(verifiedPayerBinding === undefined ? {} : { verifiedPayerBinding }),
    };
  }

  async #validatePayerBinding(
    input: FundingRequestInput,
    poolContract: string,
    tokenContract: string,
    expiresAt: number,
  ): Promise<VerifiedPayerBinding | undefined> {
    if (input.attributionProfile !== "signed_payer") {
      return undefined;
    }
    if (
      this.#payerBindingStore === undefined ||
      this.#payerBindingRecipientAddress === undefined ||
      this.#payerBindingVerifierVersion === undefined
    ) {
      throw new FundingValidationError(
        "invalid_funding_request",
        "Signed-payer funding requires a verified payer binding",
      );
    }
    const record = await this.#payerBindingStore.getPayerBinding(input.paymentRequestId);
    if (record === null || record.state !== "VERIFIED") {
      throw new FundingValidationError(
        "invalid_funding_request",
        "Signed-payer funding requires a verified payer binding",
      );
    }
    let binding: VerifiedPayerBinding;
    try {
      binding = verifiedPayerBindingFromRecord(record);
    } catch {
      throw new FundingValidationError(
        "invalid_funding_request",
        "Verified payer binding record is invalid",
      );
    }
    if (
      binding.paymentRequestId !== input.paymentRequestId ||
      binding.network !== this.#network ||
      normalizeBindingAddress(binding.poolContract, "pool contract") !== poolContract ||
      normalizeBindingAddress(binding.recipientAddress, "recipient address") !==
        this.#payerBindingRecipientAddress ||
      normalizeBindingAddress(binding.tokenContract, "token contract") !== tokenContract ||
      binding.amountBaseUnits !== input.amountBaseUnits ||
      binding.fundingExpiresAt !== expiresAt ||
      binding.verifierVersion !== this.#payerBindingVerifierVersion
    ) {
      throw new FundingValidationError(
        "invalid_funding_request",
        "Verified payer binding does not match the funding request",
      );
    }
    const payerAddress = normalizeBindingAddress(binding.payerAddress, "payer address");
    const expectedNoteReference = normalizeBindingFelt(
      binding.expectedNoteReference,
      "expected note reference",
    );
    if (expectedNoteReference === "0x0") {
      throw new FundingValidationError(
        "invalid_funding_request",
        "Verified payer binding has an invalid expected note reference",
      );
    }
    assertBindingIdentifier(binding.challengeId, "challenge ID");
    const messageHash = normalizeBindingFelt(binding.messageHash, "message hash");
    const blockHash = normalizeBindingFelt(binding.blockHash, "block hash");
    if (
      typeof binding.blockNumber !== "bigint" ||
      binding.blockNumber < 0n ||
      binding.blockNumber > MAX_BLOCK_NUMBER ||
      !Number.isSafeInteger(binding.challengeExpiresAt) ||
      binding.challengeExpiresAt <= 0 ||
      binding.challengeExpiresAt > expiresAt ||
      !Number.isSafeInteger(binding.verifiedAt) ||
      binding.verifiedAt <= 0 ||
      binding.verifiedAt >= binding.challengeExpiresAt ||
      binding.verifiedAt > this.#nowSeconds()
    ) {
      throw new FundingValidationError(
        "invalid_funding_request",
        "Verified payer binding contains invalid verification evidence",
      );
    }
    return {
      ...binding,
      poolContract,
      recipientAddress: this.#payerBindingRecipientAddress,
      tokenContract,
      payerAddress,
      expectedNoteReference,
      messageHash,
      blockHash,
    };
  }

  #assertInstructions(
    instructions: unknown,
    paymentRequestId: string,
  ): asserts instructions is FundingInstructions {
    if (typeof instructions !== "object" || instructions === null) {
      throw new FundingGatewayProtocolError("Gateway returned malformed funding instructions");
    }
    const candidate = instructions as Partial<FundingInstructions>;
    if (candidate.paymentRequestId !== paymentRequestId) {
      throw new FundingGatewayProtocolError("Gateway returned instructions for another request");
    }
    if (!isNonEmptyJsonRecord(candidate.destination)) {
      throw new FundingGatewayProtocolError("Gateway returned an invalid funding destination");
    }
  }

  #assertObservationCollection(
    observations: unknown,
    paymentRequestId: string,
  ): asserts observations is readonly PaymentObservation[] {
    if (!Array.isArray(observations) || observations.length > MAX_OBSERVATIONS_PER_SCAN) {
      throw new FundingGatewayProtocolError("Gateway returned an invalid observation collection");
    }
    const evidenceIds = new Set<string>();
    for (const observation of observations) {
      this.#assertObservation(observation, paymentRequestId);
      if (evidenceIds.has(observation.evidence_id)) {
        throw new FundingGatewayProtocolError("Gateway returned duplicate funding evidence");
      }
      evidenceIds.add(observation.evidence_id);
    }
  }

  #assertObservation(
    observation: unknown,
    paymentRequestId: string,
  ): asserts observation is PaymentObservation {
    if (typeof observation !== "object" || observation === null) {
      throw new FundingGatewayProtocolError("Gateway returned malformed funding evidence");
    }
    const candidate = observation as Partial<PaymentObservation>;
    if (candidate.payment_request_id !== paymentRequestId) {
      throw new FundingGatewayProtocolError("Gateway returned evidence for another request");
    }
    assertGatewayIdentifier(candidate.evidence_id, "evidence ID");
    assertGatewayIdentifier(candidate.note_reference, "note reference");
    assertGatewayIdentifier(candidate.transaction_reference, "transaction reference");
    assertGatewayIdentifier(candidate.block_hash, "block hash");
    assertGatewayIdentifier(candidate.verifier_version, "verifier version");
    if (candidate.finality_policy !== this.#finalityPolicy) {
      throw new FundingGatewayProtocolError("Gateway used an unexpected finality policy");
    }
    if (
      candidate.status === undefined ||
      !PAYMENT_OBSERVATION_STATUSES.includes(candidate.status)
    ) {
      throw new FundingGatewayProtocolError("Gateway returned an unknown observation status");
    }
    if (typeof candidate.block_number !== "bigint" || candidate.block_number < 0n) {
      throw new FundingGatewayProtocolError("Gateway returned an invalid block number");
    }
    if (typeof candidate.amount_base_units !== "bigint" || candidate.amount_base_units <= 0n) {
      throw new FundingGatewayProtocolError("Gateway returned an invalid funding amount");
    }
    if (
      candidate.network === undefined ||
      !STARKNET_NETWORKS.includes(candidate.network) ||
      candidate.pool_contract === undefined ||
      candidate.sender_address === undefined ||
      candidate.recipient_address === undefined ||
      candidate.token_contract === undefined ||
      candidate.attribution_profile === undefined ||
      !ATTRIBUTION_PROFILES.includes(candidate.attribution_profile) ||
      !isNonEmptyJsonRecord(candidate.destination)
    ) {
      throw new FundingGatewayProtocolError("Gateway omitted funding evidence identity fields");
    }
    normalizeGatewayAddress(candidate.pool_contract, "pool contract");
    normalizeGatewayAddress(candidate.sender_address, "sender address");
    normalizeGatewayAddress(candidate.recipient_address, "recipient address");
    normalizeGatewayAddress(candidate.token_contract, "token contract");
    let expectedEvidenceId: string;
    try {
      expectedEvidenceId = derivePrivacyEvidenceId(
        candidate.network,
        candidate.pool_contract,
        candidate.note_reference,
      );
    } catch {
      throw new FundingGatewayProtocolError("Gateway returned an invalid note reference");
    }
    if (candidate.evidence_id !== expectedEvidenceId) {
      throw new FundingGatewayProtocolError("Gateway evidence ID does not match its privacy note");
    }
  }

  #matchesRequest(identity: FundingRequestIdentity, observation: PaymentObservation): boolean {
    return (
      observation.network === identity.network &&
      normalizeGatewayAddress(observation.pool_contract, "pool contract") ===
        identity.poolContract &&
      normalizeGatewayAddress(observation.token_contract, "token contract") ===
        identity.tokenContract &&
      observation.amount_base_units.toString() === identity.amountBaseUnits &&
      observation.attribution_profile === identity.attributionProfile &&
      (identity.verifiedPayerBinding === undefined ||
        (normalizeGatewayAddress(observation.sender_address, "sender address") ===
          identity.verifiedPayerBinding.payerAddress &&
          normalizeGatewayAddress(observation.recipient_address, "recipient address") ===
            identity.verifiedPayerBinding.recipientAddress &&
          observation.note_reference === identity.verifiedPayerBinding.expectedNoteReference)) &&
      isDeepStrictEqual(observation.destination, identity.destination)
    );
  }

  #assertUnexpired(expiresAt: number): void {
    if (expiresAt <= this.#nowSeconds()) {
      throw new FundingValidationError("request_expired", "Funding request has expired");
    }
  }

  #nowSeconds(): number {
    const now = this.#now();
    const milliseconds = now instanceof Date ? now.getTime() : Number.NaN;
    if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
      throw new FundingGatewayProtocolError("Settlement clock returned an invalid time");
    }
    return Math.floor(milliseconds / 1_000);
  }
}

function progress(record: FundingRequestRecord): FundingProgress {
  return {
    paymentRequestId: record.identity.paymentRequestId,
    state: record.state,
    destination: structuredClone(record.identity.destination),
    ...(record.acceptedEvidenceId === undefined
      ? {}
      : { acceptedEvidenceId: record.acceptedEvidenceId }),
    ...(record.operatorReason === undefined ? {} : { operatorReason: record.operatorReason }),
  };
}

function compareEvidenceIds(left: PaymentObservation, right: PaymentObservation): number {
  if (left.evidence_id === right.evidence_id) {
    return 0;
  }
  return left.evidence_id < right.evidence_id ? -1 : 1;
}

function assertPaymentRequestId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < PAYMENT_REQUEST_ID_MINIMUM_LENGTH ||
    value.length > MAX_OPAQUE_IDENTIFIER_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new FundingValidationError(
      "invalid_payment_request_id",
      "Payment request ID must be an opaque base64url identifier with at least 128 bits of capacity",
    );
  }
}

function assertTransactionHint(value: string | undefined): void {
  if (
    value !== undefined &&
    (value.trim().length === 0 || value.length > MAX_OPAQUE_IDENTIFIER_LENGTH)
  ) {
    throw new FundingValidationError("invalid_funding_request", "Transaction hint is invalid");
  }
}

function exactUnixSeconds(value: Date, label: string): number {
  if (!(value instanceof Date)) {
    throw new FundingValidationError("invalid_funding_request", `${label} is invalid`);
  }
  const milliseconds = value.getTime();
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds % 1_000 !== 0) {
    throw new FundingValidationError(
      "invalid_funding_request",
      `${label} must be an exact positive Unix second`,
    );
  }
  return milliseconds / 1_000;
}

function isNonEmptyJsonRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return isJsonRecord(value, new Set(), 0) && Object.keys(value).length > 0;
}

function isJsonRecord(
  value: unknown,
  ancestors: Set<object>,
  depth: number,
): value is Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    depth > MAX_DESTINATION_DEPTH ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  return isJsonContainer(value, ancestors, depth);
}

function isJsonContainer(value: object, ancestors: Set<object>, depth: number): boolean {
  if (ancestors.has(value)) {
    return false;
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_DESTINATION_ENTRIES) {
    return false;
  }
  ancestors.add(value);
  const valid = entries.every(([, entry]) => isJsonValue(entry, ancestors, depth + 1));
  ancestors.delete(value);
  return valid;
}

function isJsonValue(value: unknown, ancestors: Set<object>, depth: number): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value);
  }
  if (depth > MAX_DESTINATION_DEPTH || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_DESTINATION_ENTRIES || ancestors.has(value)) {
      return false;
    }
    ancestors.add(value);
    const valid = Array.from(value).every((entry) => isJsonValue(entry, ancestors, depth + 1));
    ancestors.delete(value);
    return valid;
  }
  return isJsonRecord(value, ancestors, depth);
}

function snapshotObservations(
  observations: readonly PaymentObservation[],
): readonly PaymentObservation[] {
  return observations.map((observation) => {
    let snapshot: PaymentObservation;
    try {
      snapshot = structuredClone(observation);
    } catch {
      throw new FundingGatewayProtocolError("Gateway returned unserializable funding evidence");
    }
    return {
      ...snapshot,
      pool_contract: normalizeGatewayAddress(snapshot.pool_contract, "pool contract"),
      sender_address: normalizeGatewayAddress(snapshot.sender_address, "sender address"),
      recipient_address: normalizeGatewayAddress(snapshot.recipient_address, "recipient address"),
      token_contract: normalizeGatewayAddress(snapshot.token_contract, "token contract"),
    };
  });
}

function normalizeConfiguredAddress(value: string, label: string): string {
  try {
    return normalizeAddress(value);
  } catch {
    throw new FundingConfigurationError(`Configured ${label} is invalid`);
  }
}

function normalizeInputAddress(value: string, label: string): string {
  try {
    return normalizeAddress(value);
  } catch {
    throw new FundingValidationError("invalid_funding_request", `${label} is invalid`);
  }
}

function normalizeGatewayAddress(value: string, label: string): string {
  try {
    return normalizeAddress(value);
  } catch {
    throw new FundingGatewayProtocolError(`Gateway returned an invalid ${label}`);
  }
}

function normalizeBindingAddress(value: string, label: string): string {
  try {
    return normalizeAddress(value);
  } catch {
    throw new FundingValidationError(
      "invalid_funding_request",
      `Verified payer binding has an invalid ${label}`,
    );
  }
}

function normalizeBindingFelt(value: string, label: string): string {
  try {
    if (
      typeof value !== "string" ||
      value.length > MAX_STARKNET_ADDRESS_LENGTH ||
      !/^0x[0-9a-fA-F]+$/.test(value)
    ) {
      throw new Error("Invalid felt");
    }
    const felt = BigInt(value);
    if (felt >= STARK_FIELD_PRIME) {
      throw new Error("Invalid felt");
    }
    return `0x${felt.toString(16)}`;
  } catch {
    throw new FundingValidationError(
      "invalid_funding_request",
      `Verified payer binding has an invalid ${label}`,
    );
  }
}

function assertBindingIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512) {
    throw new FundingValidationError(
      "invalid_funding_request",
      `Verified payer binding has an invalid ${label}`,
    );
  }
}

function normalizeAddress(value: string): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_STARKNET_ADDRESS_LENGTH ||
    !/^0x[0-9a-fA-F]+$/.test(value)
  ) {
    throw new Error("Invalid Starknet address");
  }
  const address = BigInt(value);
  if (address === 0n || address >= STARKNET_ADDRESS_BOUND) {
    throw new Error("Invalid Starknet address");
  }
  return `0x${address.toString(16)}`;
}

function assertGatewayIdentifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_OPAQUE_IDENTIFIER_LENGTH
  ) {
    throw new FundingGatewayProtocolError(`Gateway returned an invalid ${label}`);
  }
}

function assertConfiguredIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 128) {
    throw new FundingConfigurationError(`Configured ${label} is invalid`);
  }
  return value;
}

const STARKNET_ADDRESS_BOUND = (1n << 251n) - 256n;
const STARK_FIELD_PRIME = (1n << 251n) + (17n << 192n) + 1n;
const MAX_BLOCK_NUMBER = (1n << 64n) - 1n;
const MAX_STARKNET_ADDRESS_LENGTH = 66;
const MAX_OPAQUE_IDENTIFIER_LENGTH = 512;
const PAYMENT_REQUEST_ID_MINIMUM_LENGTH = 22;
const MAX_OBSERVATIONS_PER_SCAN = 1_000;
const PAYMENT_REQUEST_ID_BYTES = 32;
const MAX_DESTINATION_DEPTH = 8;
const MAX_DESTINATION_ENTRIES = 256;
