import { isDeepStrictEqual } from "node:util";

import { canTransitionOutgoing, type MeltPaymentEnvelope } from "@cashu-strk20/strk20-method";

import type { PayoutAttempt } from "./gateway.js";

export interface SettlementIntentIdentity {
  readonly quoteId: string;
  readonly network: string;
  readonly tokenContract: string;
  readonly amountBaseUnits: string;
  readonly expiresAt: number;
  readonly destination: Readonly<Record<string, unknown>>;
}

export type SettlementIntentState =
  | "INTENT_RECORDED"
  | "PENDING"
  | "UNKNOWN"
  | "PAID"
  | "FAILED"
  | "OPERATOR_REQUIRED";

export const SETTLEMENT_INTENT_STATES: readonly SettlementIntentState[] = [
  "INTENT_RECORDED",
  "PENDING",
  "UNKNOWN",
  "PAID",
  "FAILED",
  "OPERATOR_REQUIRED",
];

export interface SettlementIntentRecord {
  readonly intentId: string;
  readonly identity: SettlementIntentIdentity;
  readonly state: SettlementIntentState;
  readonly submissionId?: string;
  readonly transactionReferences: readonly string[];
}

export interface SettlementIntentCandidate {
  readonly intentId: string;
  readonly identity: SettlementIntentIdentity;
}

export interface SettlementIntentStore {
  getByQuoteId(quoteId: string): Promise<SettlementIntentRecord | null>;
  /** Atomically create by unique quote ID, or return the existing record after identity validation. */
  createOrGet(candidate: SettlementIntentCandidate): Promise<SettlementIntentRecord>;
  /** Atomically keep the first submission ID attached to an intent and return the winning record. */
  attachSubmission(intentId: string, submissionId: string): Promise<SettlementIntentRecord>;
  /** Persist one legal monotonic transition without replacing a terminal state with stale data. */
  recordAttempt(attempt: PayoutAttempt): Promise<SettlementIntentRecord>;
}

export class IntentConflictError extends Error {
  constructor() {
    super("An existing quote ID is bound to different payout instructions");
    this.name = "IntentConflictError";
  }
}

export class IntentIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntentIntegrityError";
  }
}

export function intentIdentity(
  quoteId: string,
  request: MeltPaymentEnvelope,
): SettlementIntentIdentity {
  return {
    quoteId,
    network: request.network,
    tokenContract: request.token_contract,
    amountBaseUnits: request.amount_base_units,
    expiresAt: request.expires_at,
    destination: request.destination,
  };
}

export function assertSameIntent(
  existing: SettlementIntentIdentity,
  requested: SettlementIntentIdentity,
): void {
  if (!isDeepStrictEqual(existing, requested)) {
    throw new IntentConflictError();
  }
}

/** Deterministic test/local store. Production settlement requires transactional durable storage. */
export class InMemorySettlementIntentStore implements SettlementIntentStore {
  readonly #byIntentId = new Map<string, SettlementIntentRecord>();
  readonly #intentIdByQuoteId = new Map<string, string>();
  readonly #intentIdBySubmissionId = new Map<string, string>();

  async getByQuoteId(quoteId: string): Promise<SettlementIntentRecord | null> {
    assertIntentIdentifier(quoteId, "Quote ID");
    const intentId = this.#intentIdByQuoteId.get(quoteId);
    return intentId === undefined ? null : cloneSettlementIntentRecord(this.#required(intentId));
  }

  async createOrGet(candidate: SettlementIntentCandidate): Promise<SettlementIntentRecord> {
    assertIntentIdentifier(candidate.intentId, "Intent ID");
    assertIntentIdentifier(candidate.identity.quoteId, "Quote ID");

    const existingIntentId = this.#intentIdByQuoteId.get(candidate.identity.quoteId);
    if (existingIntentId !== undefined) {
      const existing = this.#required(existingIntentId);
      assertSameIntent(existing.identity, candidate.identity);
      return cloneSettlementIntentRecord(existing);
    }

    if (this.#byIntentId.has(candidate.intentId)) {
      throw new IntentIntegrityError("Intent ID is already bound to another payout");
    }

    const record = createSettlementIntentRecord(candidate);

    this.#byIntentId.set(candidate.intentId, record);
    this.#intentIdByQuoteId.set(candidate.identity.quoteId, candidate.intentId);
    return cloneSettlementIntentRecord(record);
  }

  async attachSubmission(intentId: string, submissionId: string): Promise<SettlementIntentRecord> {
    assertIntentIdentifier(submissionId, "Submission ID");
    const existing = this.#required(intentId);
    if (existing.submissionId !== undefined) {
      return cloneSettlementIntentRecord(existing);
    }
    const owner = this.#intentIdBySubmissionId.get(submissionId);
    if (owner !== undefined && owner !== intentId) {
      throw new IntentIntegrityError("Submission ID is already bound to another payout");
    }
    const updated = attachSettlementSubmission(existing, submissionId);
    if (updated.submissionId !== undefined) {
      this.#intentIdBySubmissionId.set(updated.submissionId, intentId);
    }
    this.#byIntentId.set(intentId, updated);
    return cloneSettlementIntentRecord(updated);
  }

  async recordAttempt(attempt: PayoutAttempt): Promise<SettlementIntentRecord> {
    const existing = this.#required(attempt.intentId);
    const updated = applySettlementAttempt(existing, attempt);
    this.#byIntentId.set(existing.intentId, updated);
    return cloneSettlementIntentRecord(updated);
  }

  #required(intentId: string): SettlementIntentRecord {
    const record = this.#byIntentId.get(intentId);
    if (record === undefined) {
      throw new IntentIntegrityError("Settlement intent does not exist");
    }
    return record;
  }
}

export function createSettlementIntentRecord(
  candidate: SettlementIntentCandidate,
): SettlementIntentRecord {
  assertIntentIdentifier(candidate.intentId, "Intent ID");
  assertIntentIdentifier(candidate.identity.quoteId, "Quote ID");
  return {
    intentId: candidate.intentId,
    identity: cloneIntentIdentity(candidate.identity),
    state: "INTENT_RECORDED",
    transactionReferences: [],
  };
}

export function attachSettlementSubmission(
  existing: SettlementIntentRecord,
  submissionId: string,
): SettlementIntentRecord {
  assertIntentIdentifier(submissionId, "Submission ID");
  if (existing.submissionId !== undefined) {
    return existing;
  }
  if (existing.state !== "INTENT_RECORDED") {
    throw new IntentIntegrityError("Cannot attach a submission after settlement has advanced");
  }
  return { ...existing, submissionId };
}

export function applySettlementAttempt(
  existing: SettlementIntentRecord,
  attempt: PayoutAttempt,
): SettlementIntentRecord {
  assertIntentIdentifier(attempt.intentId, "Gateway intent ID");
  assertIntentIdentifier(attempt.submissionId, "Gateway submission ID");
  if (attempt.transactionReference !== undefined) {
    assertIntentIdentifier(attempt.transactionReference, "Transaction reference");
  }
  if (existing.submissionId !== attempt.submissionId) {
    throw new IntentIntegrityError("Gateway attempt does not match the recorded submission");
  }

  const transactionReferences = appendUnique(
    existing.transactionReferences,
    attempt.transactionReference,
  );

  if (attempt.status === "PREPARED") {
    return { ...existing, transactionReferences };
  }
  if (existing.state === "PAID" || existing.state === "FAILED") {
    if (
      (attempt.status === "PAID" || attempt.status === "FAILED") &&
      existing.state !== attempt.status
    ) {
      throw new IntentIntegrityError("Gateway reported conflicting terminal payout states");
    }
    return { ...existing, transactionReferences };
  }
  if (existing.state === "OPERATOR_REQUIRED") {
    return existing;
  }
  if (existing.state === attempt.status) {
    return { ...existing, transactionReferences };
  }
  if (!canTransitionOutgoing(existing.state, attempt.status)) {
    throw new IntentIntegrityError(
      `Illegal payout transition from ${existing.state} to ${attempt.status}`,
    );
  }
  return { ...existing, state: attempt.status, transactionReferences };
}

export function assertIntentIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512) {
    throw new IntentIntegrityError(`${label} is invalid`);
  }
}

function appendUnique(existing: readonly string[], value: string | undefined): readonly string[] {
  if (value === undefined || existing.includes(value)) {
    return existing;
  }
  return [...existing, value];
}

function cloneIntentIdentity(identity: SettlementIntentIdentity): SettlementIntentIdentity {
  return {
    ...identity,
    destination: structuredClone(identity.destination),
  };
}

export function cloneSettlementIntentRecord(
  record: SettlementIntentRecord,
): SettlementIntentRecord {
  return {
    ...record,
    identity: cloneIntentIdentity(record.identity),
    transactionReferences: [...record.transactionReferences],
  };
}
