import { isDeepStrictEqual } from "node:util";

import type { StarknetNetwork } from "@cashu-strk20/strk20-method";

export interface PayerBindingRequestIdentity {
  readonly paymentRequestId: string;
  readonly network: StarknetNetwork;
  readonly poolContract: string;
  readonly recipientAddress: string;
  readonly tokenContract: string;
  readonly expectedNoteReference: string;
  readonly amountBaseUnits: string;
  readonly payerAddress: string;
  readonly fundingExpiresAt: number;
  readonly challengeExpiresAt: number;
}

export interface PayerBindingVerificationRecord {
  readonly messageHash: string;
  readonly blockHash: string;
  readonly blockNumber: bigint;
  readonly verifierVersion: string;
  readonly verifiedAt: number;
}

export const PAYER_BINDING_CHALLENGE_STATES = ["OPEN", "VERIFIED", "EXPIRED"] as const;

export type PayerBindingChallengeState = (typeof PAYER_BINDING_CHALLENGE_STATES)[number];

export interface PayerBindingChallengeRecord {
  readonly identity: PayerBindingRequestIdentity;
  readonly challengeId: string;
  readonly state: PayerBindingChallengeState;
  readonly verification?: PayerBindingVerificationRecord;
}

export interface PayerBindingChallengeCandidate {
  readonly identity: PayerBindingRequestIdentity;
  readonly challengeId: string;
}

export interface VerifyPayerBindingChallengeInput {
  readonly paymentRequestId: string;
  readonly challengeId: string;
  readonly verification: PayerBindingVerificationRecord;
}

export interface PayerBindingChallengeStore {
  getPayerBinding(paymentRequestId: string): Promise<PayerBindingChallengeRecord | null>;
  /** Atomically create one challenge per request, or return the request's existing challenge. */
  createOrGetPayerBinding(
    candidate: PayerBindingChallengeCandidate,
  ): Promise<PayerBindingChallengeRecord>;
  /** Atomically consume one unambiguous challenge. Completed verification retries are idempotent. */
  markPayerBindingVerified(
    input: VerifyPayerBindingChallengeInput,
  ): Promise<PayerBindingChallengeRecord>;
  expirePayerBinding(
    paymentRequestId: string,
    expiredAt: number,
  ): Promise<PayerBindingChallengeRecord>;
}

export class PayerBindingConflictError extends Error {
  constructor() {
    super("Payment request is already bound to different payer challenge fields");
    this.name = "PayerBindingConflictError";
  }
}

export class PayerBindingChallengeConflictError extends Error {
  constructor() {
    super("Payer challenge ID is already bound to another payment request");
    this.name = "PayerBindingChallengeConflictError";
  }
}

export class PayerBindingAttributionConflictError extends Error {
  constructor() {
    super("Payer binding conflicts with an existing verified attribution");
    this.name = "PayerBindingAttributionConflictError";
  }
}

export class PayerBindingIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayerBindingIntegrityError";
  }
}

export class InMemoryPayerBindingChallengeStore implements PayerBindingChallengeStore {
  readonly #byPaymentRequestId = new Map<string, PayerBindingChallengeRecord>();
  readonly #paymentRequestIdByChallengeId = new Map<string, string>();

  async getPayerBinding(paymentRequestId: string): Promise<PayerBindingChallengeRecord | null> {
    assertPayerBindingIdentifier(paymentRequestId, "Payment request ID");
    const record = this.#byPaymentRequestId.get(paymentRequestId);
    return record === undefined ? null : clonePayerBindingChallengeRecord(record);
  }

  async createOrGetPayerBinding(
    candidate: PayerBindingChallengeCandidate,
  ): Promise<PayerBindingChallengeRecord> {
    validateCandidate(candidate);
    const existing = this.#byPaymentRequestId.get(candidate.identity.paymentRequestId);
    if (existing !== undefined) {
      assertSamePayerBindingRequest(existing.identity, candidate.identity);
      return clonePayerBindingChallengeRecord(existing);
    }
    const owner = this.#paymentRequestIdByChallengeId.get(candidate.challengeId);
    if (owner !== undefined && owner !== candidate.identity.paymentRequestId) {
      throw new PayerBindingChallengeConflictError();
    }

    const record = createPayerBindingChallengeRecord(candidate);
    this.#paymentRequestIdByChallengeId.set(
      candidate.challengeId,
      candidate.identity.paymentRequestId,
    );
    this.#byPaymentRequestId.set(candidate.identity.paymentRequestId, record);
    return clonePayerBindingChallengeRecord(record);
  }

  async markPayerBindingVerified(
    input: VerifyPayerBindingChallengeInput,
  ): Promise<PayerBindingChallengeRecord> {
    const existing = this.#required(input.paymentRequestId);
    const updated = applyPayerBindingVerification(existing, input);
    if (existing.state !== "VERIFIED") {
      for (const candidate of this.#byPaymentRequestId.values()) {
        if (payerBindingAttributionConflicts(updated, candidate)) {
          throw new PayerBindingAttributionConflictError();
        }
      }
    }
    this.#byPaymentRequestId.set(input.paymentRequestId, updated);
    return clonePayerBindingChallengeRecord(updated);
  }

  async expirePayerBinding(
    paymentRequestId: string,
    expiredAt: number,
  ): Promise<PayerBindingChallengeRecord> {
    const existing = this.#required(paymentRequestId);
    const updated = expirePayerBindingChallenge(existing, expiredAt);
    this.#byPaymentRequestId.set(paymentRequestId, updated);
    return clonePayerBindingChallengeRecord(updated);
  }

  #required(paymentRequestId: string): PayerBindingChallengeRecord {
    assertPayerBindingIdentifier(paymentRequestId, "Payment request ID");
    const record = this.#byPaymentRequestId.get(paymentRequestId);
    if (record === undefined) {
      throw new PayerBindingIntegrityError("Payer challenge does not exist");
    }
    return record;
  }
}

export function createPayerBindingChallengeRecord(
  candidate: PayerBindingChallengeCandidate,
): PayerBindingChallengeRecord {
  validateCandidate(candidate);
  return {
    identity: { ...candidate.identity },
    challengeId: candidate.challengeId,
    state: "OPEN",
  };
}

export function applyPayerBindingVerification(
  existing: PayerBindingChallengeRecord,
  input: VerifyPayerBindingChallengeInput,
): PayerBindingChallengeRecord {
  assertPayerBindingIdentifier(input.challengeId, "Challenge ID");
  if (
    existing.identity.paymentRequestId !== input.paymentRequestId ||
    existing.challengeId !== input.challengeId
  ) {
    throw new PayerBindingIntegrityError("Payer challenge does not match its payment request");
  }
  if (existing.state === "VERIFIED") {
    return existing;
  }
  if (existing.state !== "OPEN") {
    throw new PayerBindingIntegrityError("Expired payer challenge cannot be verified");
  }
  validateVerification(input.verification, existing.identity.challengeExpiresAt);
  return {
    ...existing,
    state: "VERIFIED",
    verification: { ...input.verification },
  };
}

export function expirePayerBindingChallenge(
  existing: PayerBindingChallengeRecord,
  expiredAt: number,
): PayerBindingChallengeRecord {
  assertTimestamp(expiredAt, "Challenge expiry observation");
  if (existing.state !== "OPEN") {
    return existing;
  }
  if (expiredAt < existing.identity.challengeExpiresAt) {
    throw new PayerBindingIntegrityError("Payer challenge cannot expire before its deadline");
  }
  return { ...existing, state: "EXPIRED" };
}

export function assertSamePayerBindingRequest(
  existing: PayerBindingRequestIdentity,
  candidate: PayerBindingRequestIdentity,
): void {
  const { challengeExpiresAt: _existingChallengeExpiry, ...existingRequest } = existing;
  const { challengeExpiresAt: _candidateChallengeExpiry, ...candidateRequest } = candidate;
  if (!isDeepStrictEqual(existingRequest, candidateRequest)) {
    throw new PayerBindingConflictError();
  }
}

export function clonePayerBindingChallengeRecord(
  record: PayerBindingChallengeRecord,
): PayerBindingChallengeRecord {
  return {
    ...record,
    identity: { ...record.identity },
    ...(record.verification === undefined ? {} : { verification: { ...record.verification } }),
  };
}

export function payerBindingAttributionConflicts(
  left: PayerBindingChallengeRecord,
  right: PayerBindingChallengeRecord,
): boolean {
  if (left.identity.paymentRequestId === right.identity.paymentRequestId) {
    return false;
  }
  if (left.state !== "VERIFIED" || left.verification === undefined) {
    throw new PayerBindingIntegrityError("Candidate payer binding is not verified");
  }
  if (right.state !== "VERIFIED") {
    return false;
  }
  if (right.verification === undefined) {
    throw new PayerBindingIntegrityError("Stored verified payer binding has no evidence");
  }

  return (
    (left.identity.network === right.identity.network &&
      left.identity.poolContract === right.identity.poolContract &&
      left.identity.expectedNoteReference === right.identity.expectedNoteReference) ||
    (left.identity.network === right.identity.network &&
      left.identity.poolContract === right.identity.poolContract &&
      left.identity.recipientAddress === right.identity.recipientAddress &&
      left.identity.tokenContract === right.identity.tokenContract &&
      left.identity.amountBaseUnits === right.identity.amountBaseUnits &&
      left.identity.payerAddress === right.identity.payerAddress &&
      left.verification.verifiedAt < right.identity.fundingExpiresAt &&
      right.verification.verifiedAt < left.identity.fundingExpiresAt)
  );
}

function validateCandidate(candidate: PayerBindingChallengeCandidate): void {
  assertPayerBindingIdentifier(candidate.identity.paymentRequestId, "Payment request ID");
  assertPayerBindingIdentifier(candidate.challengeId, "Challenge ID");
  assertCanonicalAddress(candidate.identity.poolContract, "Pool contract");
  assertCanonicalAddress(candidate.identity.recipientAddress, "Recipient address");
  assertCanonicalAddress(candidate.identity.tokenContract, "Token contract");
  assertCanonicalNonzeroFelt(candidate.identity.expectedNoteReference, "Expected note reference");
  assertCanonicalAddress(candidate.identity.payerAddress, "Payer address");
  if (candidate.identity.network !== "SN_SEPOLIA") {
    throw new PayerBindingIntegrityError("Payer challenge network is unsupported");
  }
  if (
    !/^[1-9][0-9]*$/.test(candidate.identity.amountBaseUnits) ||
    BigInt(candidate.identity.amountBaseUnits) > MAX_U128
  ) {
    throw new PayerBindingIntegrityError("Payer challenge amount is invalid");
  }
  assertTimestamp(candidate.identity.fundingExpiresAt, "Funding expiry");
  assertTimestamp(candidate.identity.challengeExpiresAt, "Challenge expiry");
  if (candidate.identity.challengeExpiresAt > candidate.identity.fundingExpiresAt) {
    throw new PayerBindingIntegrityError("Payer challenge outlives its funding request");
  }
}

function validateVerification(
  verification: PayerBindingVerificationRecord,
  challengeExpiresAt: number,
): void {
  assertCanonicalFelt(verification.messageHash, "Message hash");
  assertCanonicalFelt(verification.blockHash, "Block hash");
  assertPayerBindingIdentifier(verification.verifierVersion, "Verifier version");
  if (
    typeof verification.blockNumber !== "bigint" ||
    verification.blockNumber < 0n ||
    verification.blockNumber > MAX_BLOCK_NUMBER
  ) {
    throw new PayerBindingIntegrityError("Signature verification block number is invalid");
  }
  assertTimestamp(verification.verifiedAt, "Signature verification time");
  if (verification.verifiedAt >= challengeExpiresAt) {
    throw new PayerBindingIntegrityError("Signature was verified after the challenge expired");
  }
}

export function assertPayerBindingIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512) {
    throw new PayerBindingIntegrityError(`${label} is invalid`);
  }
}

function assertCanonicalAddress(value: string, label: string): void {
  const address = parseHex(value, label);
  if (
    address === 0n ||
    address >= STARKNET_ADDRESS_BOUND ||
    value !== `0x${address.toString(16)}`
  ) {
    throw new PayerBindingIntegrityError(`${label} is invalid`);
  }
}

function assertCanonicalFelt(value: string, label: string): void {
  const felt = parseHex(value, label);
  if (felt >= STARK_FIELD_PRIME || value !== `0x${felt.toString(16)}`) {
    throw new PayerBindingIntegrityError(`${label} is invalid`);
  }
}

function assertCanonicalNonzeroFelt(value: string, label: string): void {
  assertCanonicalFelt(value, label);
  if (value === "0x0") {
    throw new PayerBindingIntegrityError(`${label} is invalid`);
  }
}

function parseHex(value: string, label: string): bigint {
  if (typeof value !== "string" || value.length > 66 || !/^0x[0-9a-f]+$/.test(value)) {
    throw new PayerBindingIntegrityError(`${label} is invalid`);
  }
  return BigInt(value);
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PayerBindingIntegrityError(`${label} is invalid`);
  }
}

const MAX_U128 = (1n << 128n) - 1n;
const MAX_BLOCK_NUMBER = (1n << 64n) - 1n;
const STARKNET_ADDRESS_BOUND = (1n << 251n) - 256n;
const STARK_FIELD_PRIME = (1n << 251n) + (17n << 192n) + 1n;
