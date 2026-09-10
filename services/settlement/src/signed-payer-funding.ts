import { isDeepStrictEqual } from "node:util";

import {
  baseUnitsToCashuUsdc,
  PAYMENT_OBSERVATION_STATUSES,
  type PaymentObservation,
  type StarknetNetwork,
} from "@cashu-strk20/strk20-method";
import { FundingGatewayProtocolError } from "./funding.js";
import type {
  FundingDiscoveryInput,
  FundingEvidenceReference,
  FundingInstructionRequest,
  FundingInstructions,
  PrivateFundingGateway,
} from "./gateway.js";
import type { VerifiedPayerBinding } from "./payer-bindings.js";
import {
  type CollectedIncomingPrivacyEvidence,
  PrivacyEvidenceConfigurationError,
  PrivacyEvidenceProtocolError,
  type ReobservedPrivacyEvidence,
  STARKNET_PRIVACY_EVIDENCE_VERIFIER,
  toSignedPayerPaymentObservation,
} from "./privacy-evidence.js";

export interface SignedPayerPrivacyEvidenceReader {
  collect(): Promise<readonly CollectedIncomingPrivacyEvidence[]>;
  reobserve(
    knownEvidence: readonly FundingEvidenceReference[],
  ): Promise<readonly ReobservedPrivacyEvidence[]>;
}

export interface SignedPayerFundingGatewayConfig {
  readonly network: StarknetNetwork;
  readonly poolContract: string;
  readonly recipientAddress: string;
  readonly tokenContract: string;
  readonly finalityPolicy: string;
  readonly payerBindingVerifierVersion: string;
}

export class SignedPayerFundingGatewayConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignedPayerFundingGatewayConfigurationError";
  }
}

export class SignedPayerPrivacyFundingGateway implements PrivateFundingGateway {
  readonly supportedAttributionProfiles = Object.freeze(["signed_payer"] as const);
  readonly #network: "SN_SEPOLIA";
  readonly #poolContract: string;
  readonly #recipientAddress: string;
  readonly #tokenContract: string;
  readonly #finalityPolicy: string;
  readonly #payerBindingVerifierVersion: string;

  constructor(
    readonly evidence: SignedPayerPrivacyEvidenceReader,
    config: SignedPayerFundingGatewayConfig,
  ) {
    if (
      typeof evidence !== "object" ||
      evidence === null ||
      typeof evidence.collect !== "function" ||
      typeof evidence.reobserve !== "function"
    ) {
      throw new SignedPayerFundingGatewayConfigurationError(
        "Configured privacy evidence reader is invalid",
      );
    }
    if (config.network !== "SN_SEPOLIA") {
      throw new SignedPayerFundingGatewayConfigurationError(
        "Only Starknet Sepolia signed-payer funding is enabled",
      );
    }
    this.#network = config.network;
    this.#poolContract = configuredAddress(config.poolContract, "pool contract");
    this.#recipientAddress = configuredAddress(config.recipientAddress, "recipient address");
    this.#tokenContract = configuredAddress(config.tokenContract, "token contract");
    if (
      this.#poolContract === this.#recipientAddress ||
      this.#poolContract === this.#tokenContract ||
      this.#recipientAddress === this.#tokenContract
    ) {
      throw new SignedPayerFundingGatewayConfigurationError(
        "Funding pool, recipient, and token identities must be distinct",
      );
    }
    this.#finalityPolicy = configuredIdentifier(config.finalityPolicy, "finality policy");
    this.#payerBindingVerifierVersion = configuredIdentifier(
      config.payerBindingVerifierVersion,
      "payer-binding verifier version",
    );
  }

  async createFundingInstructions(input: FundingInstructionRequest): Promise<FundingInstructions> {
    const binding = this.#bindingForInstruction(input);
    return {
      paymentRequestId: input.paymentRequestId,
      destination: this.#destination(binding),
    };
  }

  async findFundingPayments(input: FundingDiscoveryInput): Promise<readonly PaymentObservation[]> {
    const binding = this.#binding(input.paymentRequestId, input.verifiedPayerBinding);
    const destination = this.#destination(binding);
    const known = this.#knownObservations(input.knownEvidence, binding, destination);

    try {
      const references = known.map(fundingEvidenceReference);
      const reobserved = await this.evidence.reobserve(references);
      const knownByEvidenceId = this.#applyReobservedStatuses(known, reobserved);
      let fresh: readonly CollectedIncomingPrivacyEvidence[];
      try {
        fresh = await this.evidence.collect();
      } catch (error) {
        if (
          knownByEvidenceId.size > 0 &&
          !(error instanceof PrivacyEvidenceProtocolError) &&
          !(error instanceof PrivacyEvidenceConfigurationError)
        ) {
          return [...knownByEvidenceId.values()].sort(compareObservationIds).map(cloneObservation);
        }
        throw error;
      }
      if (!Array.isArray(fresh)) {
        throw new PrivacyEvidenceProtocolError("Privacy evidence collection is malformed");
      }

      const observations = new Map(knownByEvidenceId);
      const freshEvidenceIds = new Set<string>();
      for (const candidate of fresh) {
        this.#assertCollectedScope(candidate);
        const observation = toSignedPayerPaymentObservation({
          paymentRequestId: input.paymentRequestId,
          expectedPayerAddress: binding.payerAddress,
          expectedRecipientAddress: this.#recipientAddress,
          expectedNoteReference: binding.expectedNoteReference,
          payerBindingBlockNumber: binding.blockNumber,
          destination,
          evidence: candidate,
          ...(input.transactionHint === undefined
            ? {}
            : { transactionHint: input.transactionHint }),
        });
        if (freshEvidenceIds.has(candidate.evidenceId)) {
          throw new PrivacyEvidenceProtocolError(
            "Privacy evidence collection contains a duplicate evidence ID",
          );
        }
        freshEvidenceIds.add(candidate.evidenceId);
        if (observation === null) {
          continue;
        }
        const existing = observations.get(observation.evidence_id);
        if (existing !== undefined) {
          if (!sameObservationIdentity(existing, observation)) {
            observations.set(observation.evidence_id, {
              ...cloneObservation(existing),
              status: "CONFLICTED",
            });
          }
          continue;
        }
        observations.set(observation.evidence_id, observation);
      }
      return [...observations.values()].sort(compareObservationIds).map(cloneObservation);
    } catch (error) {
      if (
        error instanceof PrivacyEvidenceProtocolError ||
        error instanceof PrivacyEvidenceConfigurationError
      ) {
        throw new FundingGatewayProtocolError("Privacy funding evidence is malformed");
      }
      throw error;
    }
  }

  #bindingForInstruction(input: FundingInstructionRequest): VerifiedPayerBinding {
    if (input.attributionProfile !== "signed_payer") {
      throw new FundingGatewayProtocolError(
        "Signed-payer funding gateway received another attribution profile",
      );
    }
    const binding = this.#binding(input.paymentRequestId, input.verifiedPayerBinding);
    if (
      input.network !== this.#network ||
      inputAddress(input.poolContract, "funding pool contract") !== this.#poolContract ||
      inputAddress(input.tokenContract, "funding token contract") !== this.#tokenContract ||
      typeof input.amountBaseUnits !== "bigint" ||
      input.amountBaseUnits !== binding.amountBaseUnits ||
      exactUnixSeconds(input.expiresAt, "funding expiry") !== binding.fundingExpiresAt
    ) {
      throw new FundingGatewayProtocolError(
        "Signed-payer funding instructions do not match the verified binding",
      );
    }
    try {
      baseUnitsToCashuUsdc(input.amountBaseUnits);
    } catch {
      throw new FundingGatewayProtocolError("Signed-payer funding amount is invalid");
    }
    return binding;
  }

  #binding(
    paymentRequestId: string,
    value: VerifiedPayerBinding | undefined,
  ): VerifiedPayerBinding {
    if (
      value === undefined ||
      !validPaymentRequestId(paymentRequestId) ||
      value.paymentRequestId !== paymentRequestId ||
      value.network !== this.#network ||
      inputAddress(value.poolContract, "payer-binding pool contract") !== this.#poolContract ||
      inputAddress(value.recipientAddress, "payer-binding recipient address") !==
        this.#recipientAddress ||
      inputAddress(value.tokenContract, "payer-binding token contract") !== this.#tokenContract ||
      inputAddress(value.payerAddress, "payer-binding payer address") !== value.payerAddress ||
      inputFelt(value.expectedNoteReference, "payer-binding expected note reference") !==
        value.expectedNoteReference ||
      typeof value.amountBaseUnits !== "bigint" ||
      value.amountBaseUnits <= 0n ||
      !validUnixSeconds(value.fundingExpiresAt) ||
      !validUnixSeconds(value.challengeExpiresAt) ||
      !validUnixSeconds(value.verifiedAt) ||
      value.verifiedAt >= value.challengeExpiresAt ||
      value.challengeExpiresAt > value.fundingExpiresAt ||
      !validChallengeId(value.challengeId) ||
      inputFelt(value.messageHash, "payer-binding message hash") !== value.messageHash ||
      inputFelt(value.blockHash, "payer-binding block hash") !== value.blockHash ||
      typeof value.blockNumber !== "bigint" ||
      value.blockNumber < 0n ||
      value.blockNumber > MAX_BLOCK_NUMBER ||
      value.verifierVersion !== this.#payerBindingVerifierVersion
    ) {
      throw new FundingGatewayProtocolError("Verified payer binding is invalid for this gateway");
    }
    try {
      baseUnitsToCashuUsdc(value.amountBaseUnits);
    } catch {
      throw new FundingGatewayProtocolError("Verified payer binding amount is invalid");
    }
    return { ...value };
  }

  #knownObservations(
    value: readonly PaymentObservation[],
    binding: VerifiedPayerBinding,
    destination: Readonly<Record<string, unknown>>,
  ): readonly PaymentObservation[] {
    if (!Array.isArray(value) || value.length > MAX_KNOWN_OBSERVATIONS) {
      throw new FundingGatewayProtocolError("Known funding evidence is malformed");
    }
    const evidenceIds = new Set<string>();
    return Array.from(value, (observation) => {
      if (
        typeof observation !== "object" ||
        observation === null ||
        observation.payment_request_id !== binding.paymentRequestId ||
        observation.network !== this.#network ||
        observation.pool_contract !== this.#poolContract ||
        observation.sender_address !== binding.payerAddress ||
        observation.recipient_address !== this.#recipientAddress ||
        observation.token_contract !== this.#tokenContract ||
        observation.note_reference !== binding.expectedNoteReference ||
        typeof observation.block_number !== "bigint" ||
        observation.block_number <= binding.blockNumber ||
        observation.block_number > MAX_BLOCK_NUMBER ||
        typeof observation.amount_base_units !== "bigint" ||
        observation.amount_base_units <= 0n ||
        observation.amount_base_units > MAX_U128 ||
        observation.attribution_profile !== "signed_payer" ||
        observation.finality_policy !== this.#finalityPolicy ||
        observation.verifier_version !== STARKNET_PRIVACY_EVIDENCE_VERIFIER ||
        !PAYMENT_OBSERVATION_STATUSES.includes(observation.status) ||
        !isDeepStrictEqual(observation.destination, destination) ||
        evidenceIds.has(observation.evidence_id)
      ) {
        throw new FundingGatewayProtocolError("Known funding evidence identity is invalid");
      }
      evidenceIds.add(observation.evidence_id);
      return cloneObservation(observation);
    });
  }

  #applyReobservedStatuses(
    known: readonly PaymentObservation[],
    value: readonly ReobservedPrivacyEvidence[],
  ): Map<string, PaymentObservation> {
    if (!Array.isArray(value) || value.length !== known.length) {
      throw new PrivacyEvidenceProtocolError("Reobserved privacy evidence is incomplete");
    }
    const byEvidenceId = new Map<string, ReobservedPrivacyEvidence>();
    for (const candidate of value) {
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        !PAYMENT_OBSERVATION_STATUSES.includes(candidate.status) ||
        byEvidenceId.has(candidate.evidenceId)
      ) {
        throw new PrivacyEvidenceProtocolError("Reobserved privacy evidence is malformed");
      }
      byEvidenceId.set(candidate.evidenceId, candidate);
    }

    return new Map(
      known.map((observation) => {
        const reobserved = byEvidenceId.get(observation.evidence_id);
        if (
          reobserved === undefined ||
          !isDeepStrictEqual(reobserved, {
            ...fundingEvidenceReference(observation),
            status: reobserved.status,
          })
        ) {
          throw new PrivacyEvidenceProtocolError(
            "Reobserved privacy evidence changed its persisted reference",
          );
        }
        return [
          observation.evidence_id,
          { ...cloneObservation(observation), status: reobserved.status },
        ];
      }),
    );
  }

  #assertCollectedScope(value: CollectedIncomingPrivacyEvidence): void {
    if (
      typeof value !== "object" ||
      value === null ||
      value.network !== this.#network ||
      value.poolContract !== this.#poolContract ||
      value.recipientAddress !== this.#recipientAddress ||
      value.tokenContract !== this.#tokenContract ||
      value.finalityPolicy !== this.#finalityPolicy
    ) {
      throw new PrivacyEvidenceProtocolError(
        "Collected privacy evidence is outside the configured funding scope",
      );
    }
  }

  #destination(binding: VerifiedPayerBinding): Readonly<Record<string, unknown>> {
    return {
      pool_contract: this.#poolContract,
      recipient_address: this.#recipientAddress,
      note_reference: binding.expectedNoteReference,
    };
  }
}

function fundingEvidenceReference(observation: PaymentObservation): FundingEvidenceReference {
  return {
    evidenceId: observation.evidence_id,
    noteReference: observation.note_reference,
    transactionReference: observation.transaction_reference,
    blockHash: observation.block_hash,
    blockNumber: observation.block_number,
  };
}

function sameObservationIdentity(left: PaymentObservation, right: PaymentObservation): boolean {
  const { status: _leftStatus, ...leftIdentity } = left;
  const { status: _rightStatus, ...rightIdentity } = right;
  return isDeepStrictEqual(leftIdentity, rightIdentity);
}

function cloneObservation(value: PaymentObservation): PaymentObservation {
  return { ...value, destination: structuredClone(value.destination) };
}

function compareObservationIds(left: PaymentObservation, right: PaymentObservation): number {
  return left.evidence_id.localeCompare(right.evidence_id);
}

function configuredAddress(value: string, label: string): string {
  try {
    return normalizeAddress(value);
  } catch {
    throw new SignedPayerFundingGatewayConfigurationError(`Configured ${label} is invalid`);
  }
}

function inputAddress(value: string, label: string): string {
  try {
    return normalizeAddress(value);
  } catch {
    throw new FundingGatewayProtocolError(`${label} is invalid`);
  }
}

function normalizeAddress(value: unknown): string {
  const address = parseHex(value);
  if (address === 0n || address >= STARKNET_ADDRESS_BOUND) {
    throw new Error("Address is outside the supported range");
  }
  return `0x${address.toString(16)}`;
}

function inputFelt(value: string, label: string): string {
  let felt: bigint;
  try {
    felt = parseHex(value);
  } catch {
    throw new FundingGatewayProtocolError(`${label} is invalid`);
  }
  if (felt === 0n || felt >= STARK_FIELD_PRIME) {
    throw new FundingGatewayProtocolError(`${label} is invalid`);
  }
  return `0x${felt.toString(16)}`;
}

function parseHex(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    value.length > MAX_FELT_TEXT_LENGTH ||
    !/^0x[0-9a-fA-F]+$/.test(value)
  ) {
    throw new Error("Value is not hexadecimal");
  }
  return BigInt(value);
}

function configuredIdentifier(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value !== value.trim()
  ) {
    throw new SignedPayerFundingGatewayConfigurationError(`Configured ${label} is invalid`);
  }
  return value;
}

function validPaymentRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= PAYMENT_REQUEST_ID_MINIMUM_LENGTH &&
    value.length <= MAX_OPAQUE_IDENTIFIER_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function validChallengeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= CHALLENGE_ID_MINIMUM_LENGTH &&
    value.length <= MAX_OPAQUE_IDENTIFIER_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function exactUnixSeconds(value: Date, label: string): number {
  if (!(value instanceof Date)) {
    throw new FundingGatewayProtocolError(`${label} is invalid`);
  }
  const milliseconds = value.getTime();
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds % 1_000 !== 0) {
    throw new FundingGatewayProtocolError(`${label} is invalid`);
  }
  return milliseconds / 1_000;
}

function validUnixSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

const MAX_KNOWN_OBSERVATIONS = 10_000;
const MAX_OPAQUE_IDENTIFIER_LENGTH = 512;
const PAYMENT_REQUEST_ID_MINIMUM_LENGTH = 22;
const CHALLENGE_ID_MINIMUM_LENGTH = 22;
const MAX_FELT_TEXT_LENGTH = 66;
const MAX_BLOCK_NUMBER = (1n << 64n) - 1n;
const MAX_U128 = (1n << 128n) - 1n;
const STARKNET_ADDRESS_BOUND = (1n << 251n) - 256n;
const STARK_FIELD_PRIME = (1n << 251n) + (17n << 192n) + 1n;
