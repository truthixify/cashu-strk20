import { randomBytes } from "node:crypto";

import {
  baseUnitsToCashuUsdc,
  PAYMENT_OBSERVATION_STATUSES,
  type PaymentObservationStatus,
  type StarknetNetwork,
} from "@cashu-strk20/strk20-method";
import {
  assertSamePayerBindingRequest,
  PayerBindingAttributionConflictError,
  type PayerBindingChallengeRecord,
  type PayerBindingChallengeState,
  type PayerBindingChallengeStore,
  type PayerBindingRequestIdentity,
} from "./payer-binding-records.js";

export const PAYER_BINDING_DOMAIN_NAME = "CairoCash Funding";
export const PAYER_BINDING_DOMAIN_VERSION = "2";
export const PAYER_BINDING_PRIMARY_TYPE = "CairoCash Funding Authorization";
export const PAYER_BINDING_SNIP12_REVISION = 1;

export interface PayerBindingTypedDataField {
  readonly name: string;
  readonly type: string;
}

export interface PayerBindingTypedData {
  readonly types: Readonly<Record<string, readonly PayerBindingTypedDataField[]>>;
  readonly primaryType: typeof PAYER_BINDING_PRIMARY_TYPE;
  readonly domain: {
    readonly name: typeof PAYER_BINDING_DOMAIN_NAME;
    readonly version: typeof PAYER_BINDING_DOMAIN_VERSION;
    readonly chainId: "SN_SEPOLIA";
    readonly revision: typeof PAYER_BINDING_SNIP12_REVISION;
  };
  readonly message: {
    readonly "Payment Request": string;
    readonly Payer: string;
    readonly Pool: string;
    readonly Recipient: string;
    readonly Token: string;
    readonly "Expected Note": string;
    readonly Amount: string;
    readonly "Funding Expires At": string;
    readonly "Challenge Expires At": string;
    readonly Challenge: string;
  };
}

export interface PayerBindingChallengeInput {
  readonly paymentRequestId: string;
  readonly payerAddress: string;
  readonly expectedNoteReference: string;
  readonly amountBaseUnits: bigint;
  readonly fundingExpiresAt: Date;
}

export interface PayerBindingChallenge {
  readonly paymentRequestId: string;
  readonly challengeId: string;
  readonly payerAddress: string;
  readonly expiresAt: number;
  readonly state: PayerBindingChallengeState;
  readonly typedData: PayerBindingTypedData;
}

export interface PayerBindingSignatureInput {
  readonly paymentRequestId: string;
  readonly challengeId: string;
  readonly signature: readonly string[];
}

export interface VerifiedPayerBinding {
  readonly paymentRequestId: string;
  readonly challengeId: string;
  readonly network: "SN_SEPOLIA";
  readonly poolContract: string;
  readonly recipientAddress: string;
  readonly tokenContract: string;
  readonly expectedNoteReference: string;
  readonly amountBaseUnits: bigint;
  readonly payerAddress: string;
  readonly fundingExpiresAt: number;
  readonly challengeExpiresAt: number;
  readonly messageHash: string;
  readonly blockHash: string;
  readonly blockNumber: bigint;
  readonly verifierVersion: string;
  readonly verifiedAt: number;
}

export type PayerBindingSignatureVerification =
  | { readonly valid: false }
  | {
      readonly valid: true;
      readonly status: PaymentObservationStatus;
      readonly messageHash: string;
      readonly blockHash: string;
      readonly blockNumber: bigint;
      readonly verifierVersion: string;
    };

export interface PayerBindingSignatureVerifier {
  /** Verify the reconstructed SNIP-12 hash through the payer account's SNIP-6 interface. */
  verify(input: {
    readonly network: StarknetNetwork;
    readonly payerAddress: string;
    readonly typedData: PayerBindingTypedData;
    readonly signature: readonly string[];
  }): Promise<PayerBindingSignatureVerification>;
}

export interface PayerBindingCoordinatorConfig {
  readonly network: StarknetNetwork;
  readonly poolContract: string;
  readonly recipientAddress: string;
  readonly tokenContract: string;
  readonly verifierVersion: string;
  readonly challengeTtlSeconds: number;
  readonly now?: () => Date;
  readonly generateChallengeId?: () => string;
}

export type PayerBindingValidationErrorCode =
  | "ambiguous_request"
  | "invalid_request"
  | "invalid_signature"
  | "challenge_not_found"
  | "challenge_mismatch"
  | "challenge_expired"
  | "verification_not_final";

export class PayerBindingValidationError extends Error {
  readonly code: PayerBindingValidationErrorCode;

  constructor(code: PayerBindingValidationErrorCode, message: string) {
    super(message);
    this.name = "PayerBindingValidationError";
    this.code = code;
  }
}

export class PayerBindingConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayerBindingConfigurationError";
  }
}

export class PayerBindingVerifierProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayerBindingVerifierProtocolError";
  }
}

export class PayerBindingCoordinator {
  readonly #network: "SN_SEPOLIA";
  readonly #poolContract: string;
  readonly #recipientAddress: string;
  readonly #tokenContract: string;
  readonly #verifierVersion: string;
  readonly #challengeTtlSeconds: number;
  readonly #now: () => Date;
  readonly #generateChallengeId: () => string;

  constructor(
    readonly store: PayerBindingChallengeStore,
    readonly verifier: PayerBindingSignatureVerifier,
    config: PayerBindingCoordinatorConfig,
  ) {
    if (config.network !== "SN_SEPOLIA") {
      throw new PayerBindingConfigurationError("Only Starknet Sepolia payer binding is enabled");
    }
    this.#network = config.network;
    this.#poolContract = normalizeConfiguredAddress(config.poolContract, "pool contract");
    this.#recipientAddress = normalizeConfiguredAddress(
      config.recipientAddress,
      "recipient address",
    );
    this.#tokenContract = normalizeConfiguredAddress(config.tokenContract, "token contract");
    this.#verifierVersion = configuredIdentifier(config.verifierVersion, "verifier version");
    if (
      !Number.isSafeInteger(config.challengeTtlSeconds) ||
      config.challengeTtlSeconds <= 0 ||
      config.challengeTtlSeconds > MAX_CHALLENGE_TTL_SECONDS
    ) {
      throw new PayerBindingConfigurationError("Configured challenge TTL is invalid");
    }
    this.#challengeTtlSeconds = config.challengeTtlSeconds;
    this.#now = config.now ?? (() => new Date());
    this.#generateChallengeId = config.generateChallengeId ?? generatePayerBindingChallengeId;
  }

  async issueChallenge(input: PayerBindingChallengeInput): Promise<PayerBindingChallenge> {
    const request = this.#validateChallengeInput(input);
    const existing = await this.store.getPayerBinding(request.paymentRequestId);
    if (existing !== null) {
      assertSamePayerBindingRequest(existing.identity, {
        ...request,
        challengeExpiresAt: existing.identity.challengeExpiresAt,
      });
      const now = this.#nowSeconds();
      return publicChallenge(
        existing.state === "OPEN" && now >= existing.identity.challengeExpiresAt
          ? await this.store.expirePayerBinding(request.paymentRequestId, now)
          : existing,
      );
    }

    const now = this.#nowSeconds();
    if (request.fundingExpiresAt <= now) {
      throw new PayerBindingValidationError(
        "challenge_expired",
        "Funding request expires before a payer challenge can be issued",
      );
    }
    const challengeExpiresAt = Math.min(request.fundingExpiresAt, now + this.#challengeTtlSeconds);
    const challengeId = validateChallengeId(this.#generateChallengeId());
    return publicChallenge(
      await this.store.createOrGetPayerBinding({
        identity: { ...request, challengeExpiresAt },
        challengeId,
      }),
    );
  }

  async verifySignature(input: PayerBindingSignatureInput): Promise<VerifiedPayerBinding> {
    const paymentRequestId = validatePaymentRequestId(input.paymentRequestId);
    const challengeId = validateChallengeId(input.challengeId);
    const signature = validateSignature(input.signature);
    const record = await this.store.getPayerBinding(paymentRequestId);
    if (record === null) {
      throw new PayerBindingValidationError(
        "challenge_not_found",
        "Payer challenge does not exist",
      );
    }
    if (record.challengeId !== challengeId) {
      throw new PayerBindingValidationError(
        "challenge_mismatch",
        "Payer challenge does not match the payment request",
      );
    }
    if (record.state === "VERIFIED") {
      return verifiedPayerBindingFromRecord(record);
    }

    const now = this.#nowSeconds();
    if (record.state === "EXPIRED" || now >= record.identity.challengeExpiresAt) {
      if (record.state === "OPEN") {
        await this.store.expirePayerBinding(paymentRequestId, now);
      }
      throw new PayerBindingValidationError("challenge_expired", "Payer challenge has expired");
    }

    const result = validateVerifierResult(
      await this.verifier.verify({
        network: record.identity.network,
        payerAddress: record.identity.payerAddress,
        typedData: buildPayerBindingTypedData(record),
        signature,
      }),
      this.#verifierVersion,
    );
    if (!result.valid) {
      throw new PayerBindingValidationError("invalid_signature", "Payer signature is invalid");
    }
    if (result.status !== "FINAL") {
      throw new PayerBindingValidationError(
        "verification_not_final",
        "Payer signature verification is not final",
      );
    }
    const verifiedAt = this.#nowSeconds();
    if (verifiedAt >= record.identity.challengeExpiresAt) {
      await this.store.expirePayerBinding(paymentRequestId, verifiedAt);
      throw new PayerBindingValidationError(
        "challenge_expired",
        "Payer challenge expired during signature verification",
      );
    }

    try {
      return verifiedPayerBindingFromRecord(
        await this.store.markPayerBindingVerified({
          paymentRequestId,
          challengeId,
          verification: {
            messageHash: result.messageHash,
            blockHash: result.blockHash,
            blockNumber: result.blockNumber,
            verifierVersion: result.verifierVersion,
            verifiedAt,
          },
        }),
      );
    } catch (error) {
      if (error instanceof PayerBindingAttributionConflictError) {
        throw new PayerBindingValidationError(
          "ambiguous_request",
          "Payer binding conflicts with an existing verified attribution",
        );
      }
      throw error;
    }
  }

  #validateChallengeInput(
    input: PayerBindingChallengeInput,
  ): Omit<PayerBindingRequestIdentity, "challengeExpiresAt"> {
    const paymentRequestId = validatePaymentRequestId(input.paymentRequestId);
    const payerAddress = normalizeInputAddress(input.payerAddress, "Payer address");
    const expectedNoteReference = normalizeInputNoteReference(input.expectedNoteReference);
    try {
      baseUnitsToCashuUsdc(input.amountBaseUnits);
    } catch {
      throw new PayerBindingValidationError(
        "invalid_request",
        "Payer binding amount must be an exact positive Cashu USDC value",
      );
    }
    const fundingExpiresAt = exactUnixSeconds(input.fundingExpiresAt, "Funding expiry");
    return {
      paymentRequestId,
      network: this.#network,
      poolContract: this.#poolContract,
      recipientAddress: this.#recipientAddress,
      tokenContract: this.#tokenContract,
      expectedNoteReference,
      amountBaseUnits: input.amountBaseUnits.toString(),
      payerAddress,
      fundingExpiresAt,
    };
  }

  #nowSeconds(): number {
    const now = this.#now();
    const milliseconds = now instanceof Date ? now.getTime() : Number.NaN;
    if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
      throw new PayerBindingVerifierProtocolError("Settlement clock returned an invalid time");
    }
    return Math.floor(milliseconds / 1_000);
  }
}

export function generatePayerBindingChallengeId(): string {
  return randomBytes(CHALLENGE_ID_BYTES).toString("base64url");
}

export function buildPayerBindingTypedData(
  record: Pick<PayerBindingChallengeRecord, "identity" | "challengeId">,
): PayerBindingTypedData {
  return {
    types: {
      StarknetDomain: [
        { name: "name", type: "shortstring" },
        { name: "version", type: "shortstring" },
        { name: "chainId", type: "shortstring" },
        { name: "revision", type: "shortstring" },
      ],
      [PAYER_BINDING_PRIMARY_TYPE]: [
        { name: "Payment Request", type: "string" },
        { name: "Payer", type: "ContractAddress" },
        { name: "Pool", type: "ContractAddress" },
        { name: "Recipient", type: "ContractAddress" },
        { name: "Token", type: "ContractAddress" },
        { name: "Expected Note", type: "felt" },
        { name: "Amount", type: "u128" },
        { name: "Funding Expires At", type: "timestamp" },
        { name: "Challenge Expires At", type: "timestamp" },
        { name: "Challenge", type: "string" },
      ],
    },
    primaryType: PAYER_BINDING_PRIMARY_TYPE,
    domain: {
      name: PAYER_BINDING_DOMAIN_NAME,
      version: PAYER_BINDING_DOMAIN_VERSION,
      chainId: "SN_SEPOLIA",
      revision: PAYER_BINDING_SNIP12_REVISION,
    },
    message: {
      "Payment Request": record.identity.paymentRequestId,
      Payer: record.identity.payerAddress,
      Pool: record.identity.poolContract,
      Recipient: record.identity.recipientAddress,
      Token: record.identity.tokenContract,
      "Expected Note": record.identity.expectedNoteReference,
      Amount: record.identity.amountBaseUnits,
      "Funding Expires At": record.identity.fundingExpiresAt.toString(),
      "Challenge Expires At": record.identity.challengeExpiresAt.toString(),
      Challenge: record.challengeId,
    },
  };
}

function publicChallenge(record: PayerBindingChallengeRecord): PayerBindingChallenge {
  return {
    paymentRequestId: record.identity.paymentRequestId,
    challengeId: record.challengeId,
    payerAddress: record.identity.payerAddress,
    expiresAt: record.identity.challengeExpiresAt,
    state: record.state,
    typedData: structuredClone(buildPayerBindingTypedData(record)),
  };
}

export function verifiedPayerBindingFromRecord(
  record: PayerBindingChallengeRecord,
): VerifiedPayerBinding {
  if (record.state !== "VERIFIED" || record.verification === undefined) {
    throw new PayerBindingVerifierProtocolError("Verified payer challenge has no evidence");
  }
  if (record.identity.network !== "SN_SEPOLIA") {
    throw new PayerBindingVerifierProtocolError("Verified payer challenge has the wrong network");
  }
  return {
    paymentRequestId: record.identity.paymentRequestId,
    challengeId: record.challengeId,
    network: record.identity.network,
    poolContract: record.identity.poolContract,
    recipientAddress: record.identity.recipientAddress,
    tokenContract: record.identity.tokenContract,
    expectedNoteReference: record.identity.expectedNoteReference,
    amountBaseUnits: BigInt(record.identity.amountBaseUnits),
    payerAddress: record.identity.payerAddress,
    fundingExpiresAt: record.identity.fundingExpiresAt,
    challengeExpiresAt: record.identity.challengeExpiresAt,
    ...record.verification,
  };
}

function validateVerifierResult(
  value: PayerBindingSignatureVerification,
  expectedVerifierVersion: string,
): PayerBindingSignatureVerification {
  if (typeof value !== "object" || value === null || typeof value.valid !== "boolean") {
    throw new PayerBindingVerifierProtocolError("Signature verifier returned a malformed result");
  }
  if (!value.valid) {
    return { valid: false };
  }
  if (!PAYMENT_OBSERVATION_STATUSES.includes(value.status)) {
    throw new PayerBindingVerifierProtocolError("Signature verifier returned an unknown status");
  }
  if (value.verifierVersion !== expectedVerifierVersion) {
    throw new PayerBindingVerifierProtocolError(
      "Signature verifier returned an unexpected version",
    );
  }
  return {
    valid: true,
    status: value.status,
    messageHash: normalizeVerifierFelt(value.messageHash, "message hash"),
    blockHash: normalizeVerifierFelt(value.blockHash, "block hash"),
    blockNumber: verifierBlockNumber(value.blockNumber),
    verifierVersion: value.verifierVersion,
  };
}

function validatePaymentRequestId(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < PAYMENT_REQUEST_ID_MINIMUM_LENGTH ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new PayerBindingValidationError("invalid_request", "Payment request ID is invalid");
  }
  return value;
}

function validateChallengeId(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < CHALLENGE_ID_MINIMUM_LENGTH ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new PayerBindingValidationError("invalid_request", "Payer challenge ID is invalid");
  }
  return value;
}

function validateSignature(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SIGNATURE_FELTS) {
    throw new PayerBindingValidationError("invalid_signature", "Payer signature is malformed");
  }
  try {
    return Array.from(value, (felt) => normalizeFelt(felt));
  } catch {
    throw new PayerBindingValidationError("invalid_signature", "Payer signature is malformed");
  }
}

function normalizeConfiguredAddress(value: string, label: string): string {
  try {
    return normalizeAddress(value);
  } catch {
    throw new PayerBindingConfigurationError(`Configured ${label} is invalid`);
  }
}

function normalizeInputAddress(value: string, label: string): string {
  try {
    return normalizeAddress(value);
  } catch {
    throw new PayerBindingValidationError("invalid_request", `${label} is invalid`);
  }
}

function normalizeInputNoteReference(value: string): string {
  try {
    const normalized = normalizeFelt(value);
    if (normalized === "0x0") {
      throw new Error("Note reference is zero");
    }
    return normalized;
  } catch {
    throw new PayerBindingValidationError("invalid_request", "Expected note reference is invalid");
  }
}

function normalizeAddress(value: string): string {
  const address = parseHex(value);
  if (address === 0n || address >= STARKNET_ADDRESS_BOUND) {
    throw new Error("Address is outside the supported range");
  }
  return `0x${address.toString(16)}`;
}

function normalizeVerifierFelt(value: string, label: string): string {
  try {
    return normalizeFelt(value);
  } catch {
    throw new PayerBindingVerifierProtocolError(`Signature verifier returned an invalid ${label}`);
  }
}

function normalizeFelt(value: string): string {
  const felt = parseHex(value);
  if (felt >= STARK_FIELD_PRIME) {
    throw new Error("Value is outside the Stark field");
  }
  return `0x${felt.toString(16)}`;
}

function parseHex(value: string): bigint {
  if (
    typeof value !== "string" ||
    value.length > MAX_FELT_TEXT_LENGTH ||
    !/^0x[0-9a-fA-F]+$/.test(value)
  ) {
    throw new Error("Value is not hexadecimal");
  }
  return BigInt(value);
}

function verifierBlockNumber(value: bigint): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_BLOCK_NUMBER) {
    throw new PayerBindingVerifierProtocolError(
      "Signature verifier returned an invalid block number",
    );
  }
  return value;
}

function exactUnixSeconds(value: Date, label: string): number {
  if (!(value instanceof Date)) {
    throw new PayerBindingValidationError("invalid_request", `${label} is invalid`);
  }
  const milliseconds = value.getTime();
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds % 1_000 !== 0) {
    throw new PayerBindingValidationError(
      "invalid_request",
      `${label} must be an exact positive Unix second`,
    );
  }
  return milliseconds / 1_000;
}

function configuredIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 128) {
    throw new PayerBindingConfigurationError(`Configured ${label} is invalid`);
  }
  return value;
}

const CHALLENGE_ID_BYTES = 32;
const CHALLENGE_ID_MINIMUM_LENGTH = 22;
const PAYMENT_REQUEST_ID_MINIMUM_LENGTH = 22;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_SIGNATURE_FELTS = 256;
const MAX_CHALLENGE_TTL_SECONDS = 3_600;
const MAX_FELT_TEXT_LENGTH = 66;
const MAX_BLOCK_NUMBER = (1n << 64n) - 1n;
const STARKNET_ADDRESS_BOUND = (1n << 251n) - 256n;
const STARK_FIELD_PRIME = (1n << 251n) + (17n << 192n) + 1n;
