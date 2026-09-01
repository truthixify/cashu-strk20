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

  async getByQuoteId(quoteId: string): Promise<SettlementIntentRecord | null> {
    assertIdentifier(quoteId, "Quote ID");
    const intentId = this.#intentIdByQuoteId.get(quoteId);
    return intentId === undefined ? null : cloneRecord(this.#required(intentId));
  }

  async createOrGet(candidate: SettlementIntentCandidate): Promise<SettlementIntentRecord> {
    assertIdentifier(candidate.intentId, "Intent ID");
    assertIdentifier(candidate.identity.quoteId, "Quote ID");

    const existingIntentId = this.#intentIdByQuoteId.get(candidate.identity.quoteId);
    if (existingIntentId !== undefined) {
      const existing = this.#required(existingIntentId);
      assertSameIntent(existing.identity, candidate.identity);
      return cloneRecord(existing);
    }

    if (this.#byIntentId.has(candidate.intentId)) {
      throw new IntentIntegrityError("Intent ID is already bound to another payout");
    }

    const record: SettlementIntentRecord = {
      intentId: candidate.intentId,
      identity: cloneIdentity(candidate.identity),
      state: "INTENT_RECORDED",
      transactionReferences: [],
    };

    this.#byIntentId.set(candidate.intentId, record);
    this.#intentIdByQuoteId.set(candidate.identity.quoteId, candidate.intentId);
    return cloneRecord(record);
  }

  async attachSubmission(intentId: string, submissionId: string): Promise<SettlementIntentRecord> {
    assertIdentifier(submissionId, "Submission ID");
    const existing = this.#required(intentId);

    if (existing.submissionId !== undefined) {
      return cloneRecord(existing);
    }

    if (existing.state !== "INTENT_RECORDED") {
      throw new IntentIntegrityError("Cannot attach a submission after settlement has advanced");
    }

    const updated = { ...existing, submissionId };
    this.#byIntentId.set(intentId, updated);
    return cloneRecord(updated);
  }

  async recordAttempt(attempt: PayoutAttempt): Promise<SettlementIntentRecord> {
    const existing = this.#required(attempt.intentId);
    if (existing.submissionId !== attempt.submissionId) {
      throw new IntentIntegrityError("Gateway attempt does not match the recorded submission");
    }

    const transactionReferences = appendUnique(
      existing.transactionReferences,
      attempt.transactionReference,
    );

    if (attempt.status === "PREPARED") {
      const updated = { ...existing, transactionReferences };
      this.#byIntentId.set(existing.intentId, updated);
      return cloneRecord(updated);
    }

    if (existing.state === "PAID" || existing.state === "FAILED") {
      if (
        (attempt.status === "PAID" || attempt.status === "FAILED") &&
        existing.state !== attempt.status
      ) {
        throw new IntentIntegrityError("Gateway reported conflicting terminal payout states");
      }
      const updated = { ...existing, transactionReferences };
      this.#byIntentId.set(existing.intentId, updated);
      return cloneRecord(updated);
    }

    if (existing.state === "OPERATOR_REQUIRED") {
      return cloneRecord(existing);
    }

    if (existing.state === attempt.status) {
      const updated = { ...existing, transactionReferences };
      this.#byIntentId.set(existing.intentId, updated);
      return cloneRecord(updated);
    }

    if (!canTransitionOutgoing(existing.state, attempt.status)) {
      throw new IntentIntegrityError(
        `Illegal payout transition from ${existing.state} to ${attempt.status}`,
      );
    }

    const updated = { ...existing, state: attempt.status, transactionReferences };
    this.#byIntentId.set(existing.intentId, updated);
    return cloneRecord(updated);
  }

  #required(intentId: string): SettlementIntentRecord {
    const record = this.#byIntentId.get(intentId);
    if (record === undefined) {
      throw new IntentIntegrityError("Settlement intent does not exist");
    }
    return record;
  }
}

function assertIdentifier(value: string, label: string): void {
  if (value.trim().length === 0 || value.length > 512) {
    throw new IntentIntegrityError(`${label} is invalid`);
  }
}

function appendUnique(existing: readonly string[], value: string | undefined): readonly string[] {
  if (value === undefined || existing.includes(value)) {
    return existing;
  }
  return [...existing, value];
}

function cloneIdentity(identity: SettlementIntentIdentity): SettlementIntentIdentity {
  return {
    ...identity,
    destination: structuredClone(identity.destination),
  };
}

function cloneRecord(record: SettlementIntentRecord): SettlementIntentRecord {
  return {
    ...record,
    identity: cloneIdentity(record.identity),
    transactionReferences: [...record.transactionReferences],
  };
}
