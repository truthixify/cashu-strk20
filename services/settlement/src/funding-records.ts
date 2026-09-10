import { isDeepStrictEqual } from "node:util";

import {
  type AttributionProfile,
  canTransitionIncoming,
  type IncomingState,
  type PaymentObservation,
  type StarknetNetwork,
} from "@cashu-strk20/strk20-method";
import type { VerifiedPayerBinding } from "./payer-bindings.js";

export interface FundingRequestIdentity {
  readonly paymentRequestId: string;
  readonly network: StarknetNetwork;
  readonly poolContract: string;
  readonly tokenContract: string;
  readonly amountBaseUnits: string;
  readonly expiresAt: number;
  readonly attributionProfile: AttributionProfile;
  readonly destination: Readonly<Record<string, unknown>>;
  readonly finalityPolicy: string;
  readonly verifiedPayerBinding?: VerifiedPayerBinding;
}

export interface FundingEvidenceRecord {
  readonly observation: PaymentObservation;
  readonly firstObservedAt: number;
  readonly lastObservedAt: number;
  readonly matchesRequest: boolean;
}

export interface FundingRequestRecord {
  readonly identity: FundingRequestIdentity;
  readonly state: IncomingState;
  readonly evidence: readonly FundingEvidenceRecord[];
  readonly acceptedEvidenceId?: string;
  readonly operatorReason?: string;
}

export interface FundingRequestCandidate {
  readonly identity: FundingRequestIdentity;
}

export interface RecordFundingEvidenceInput {
  readonly paymentRequestId: string;
  readonly observation: PaymentObservation;
  readonly observedAt: number;
  readonly matchesRequest: boolean;
}

export interface FundingRequestStore {
  getByPaymentRequestId(paymentRequestId: string): Promise<FundingRequestRecord | null>;
  /** Atomically create by unique payment request ID, or validate and return the existing record. */
  createOrGet(candidate: FundingRequestCandidate): Promise<FundingRequestRecord>;
  /** Atomically claim an evidence ID globally and apply its conservative incoming-state effect. */
  recordEvidence(input: RecordFundingEvidenceInput): Promise<FundingRequestRecord>;
  /** Mark paid only when the accepted evidence is recorded as matching and final. */
  markPaid(paymentRequestId: string, evidenceId: string): Promise<FundingRequestRecord>;
  /** Expire only a request with no accepted observation. */
  expire(paymentRequestId: string): Promise<FundingRequestRecord>;
  requireOperator(paymentRequestId: string, reason: string): Promise<FundingRequestRecord>;
}

export class FundingRequestConflictError extends Error {
  constructor() {
    super("An existing payment request ID is bound to different funding instructions");
    this.name = "FundingRequestConflictError";
  }
}

export class FundingEvidenceConflictError extends Error {
  constructor() {
    super("Funding evidence is already bound to another payment request");
    this.name = "FundingEvidenceConflictError";
  }
}

export class FundingIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FundingIntegrityError";
  }
}

export function assertSameFundingRequest(
  existing: FundingRequestIdentity,
  candidate: FundingRequestIdentity,
): void {
  if (!isDeepStrictEqual(existing, candidate)) {
    throw new FundingRequestConflictError();
  }
}

/** Deterministic test/local store. Production settlement requires transactional durable storage. */
export class InMemoryFundingRequestStore implements FundingRequestStore {
  readonly #byPaymentRequestId = new Map<string, FundingRequestRecord>();
  readonly #paymentRequestIdByEvidenceId = new Map<string, string>();

  async getByPaymentRequestId(paymentRequestId: string): Promise<FundingRequestRecord | null> {
    assertFundingIdentifier(paymentRequestId, "Payment request ID");
    const record = this.#byPaymentRequestId.get(paymentRequestId);
    return record === undefined ? null : cloneFundingRequestRecord(record);
  }

  async createOrGet(candidate: FundingRequestCandidate): Promise<FundingRequestRecord> {
    assertFundingIdentifier(candidate.identity.paymentRequestId, "Payment request ID");
    const existing = this.#byPaymentRequestId.get(candidate.identity.paymentRequestId);
    if (existing !== undefined) {
      assertSameFundingRequest(existing.identity, candidate.identity);
      return cloneFundingRequestRecord(existing);
    }

    const record = createFundingRequestRecord(candidate);
    this.#byPaymentRequestId.set(candidate.identity.paymentRequestId, record);
    return cloneFundingRequestRecord(record);
  }

  async recordEvidence(input: RecordFundingEvidenceInput): Promise<FundingRequestRecord> {
    const existing = this.#required(input.paymentRequestId);
    const evidenceId = input.observation.evidence_id;
    assertFundingIdentifier(evidenceId, "Evidence ID");

    const owner = this.#paymentRequestIdByEvidenceId.get(evidenceId);
    if (owner !== undefined && owner !== input.paymentRequestId) {
      throw new FundingEvidenceConflictError();
    }

    const updated = applyFundingEvidence(existing, input);

    this.#paymentRequestIdByEvidenceId.set(evidenceId, input.paymentRequestId);
    this.#byPaymentRequestId.set(input.paymentRequestId, updated);
    return cloneFundingRequestRecord(updated);
  }

  async markPaid(paymentRequestId: string, evidenceId: string): Promise<FundingRequestRecord> {
    const existing = this.#required(paymentRequestId);
    const updated = markFundingRequestPaid(existing, evidenceId);
    this.#byPaymentRequestId.set(paymentRequestId, updated);
    return cloneFundingRequestRecord(updated);
  }

  async expire(paymentRequestId: string): Promise<FundingRequestRecord> {
    const updated = expireFundingRequest(this.#required(paymentRequestId));
    this.#byPaymentRequestId.set(paymentRequestId, updated);
    return cloneFundingRequestRecord(updated);
  }

  async requireOperator(paymentRequestId: string, reason: string): Promise<FundingRequestRecord> {
    const updated = requireFundingOperator(this.#required(paymentRequestId), reason);
    this.#byPaymentRequestId.set(paymentRequestId, updated);
    return cloneFundingRequestRecord(updated);
  }

  #required(paymentRequestId: string): FundingRequestRecord {
    const record = this.#byPaymentRequestId.get(paymentRequestId);
    if (record === undefined) {
      throw new FundingIntegrityError("Funding request does not exist");
    }
    return record;
  }
}

export function createFundingRequestRecord(
  candidate: FundingRequestCandidate,
): FundingRequestRecord {
  assertFundingIdentifier(candidate.identity.paymentRequestId, "Payment request ID");
  return {
    identity: cloneIdentity(candidate.identity),
    state: "CREATED",
    evidence: [],
  };
}

export function applyFundingEvidence(
  existing: FundingRequestRecord,
  input: RecordFundingEvidenceInput,
): FundingRequestRecord {
  assertFundingIdentifier(input.paymentRequestId, "Payment request ID");
  assertFundingIdentifier(input.observation.evidence_id, "Evidence ID");
  assertTimestamp(input.observedAt, "Observation time");
  if (existing.identity.paymentRequestId !== input.paymentRequestId) {
    throw new FundingIntegrityError("Funding evidence does not match the stored request");
  }

  const evidenceId = input.observation.evidence_id;
  const evidence = mergeEvidence(existing.evidence, input);
  let updated: FundingRequestRecord = { ...existing, evidence };
  const recordedEvidence = evidence.find(
    (candidate) => candidate.observation.evidence_id === evidenceId,
  );
  if (recordedEvidence === undefined) {
    throw new FundingIntegrityError("Recorded funding evidence is missing");
  }
  const status = recordedEvidence.observation.status;

  if (status === "CONFLICTED") {
    updated = transitionToOperator(updated, "provider_disagreement");
  } else if (status === "REORGED") {
    if (existing.acceptedEvidenceId === evidenceId) {
      updated =
        existing.state === "PAID"
          ? transitionToOperator(updated, "reorg_after_payment")
          : transitionIfAllowed(updated, "REJECTED");
    }
  } else if (!input.matchesRequest) {
    if (existing.state === "CREATED") {
      updated = transitionIfAllowed(updated, "REJECTED");
    }
  } else if (existing.acceptedEvidenceId === undefined) {
    if (existing.state === "EXPIRED" || existing.state === "LATE_PAYMENT") {
      updated = transitionIfAllowed(updated, "LATE_PAYMENT");
    } else if (existing.state === "CREATED" || existing.state === "REJECTED") {
      if (updated.state === "REJECTED") {
        updated = transitionIfAllowed(updated, "CREATED");
      }
      updated = {
        ...transitionIfAllowed(updated, "OBSERVED"),
        acceptedEvidenceId: evidenceId,
      };
    }
  } else if (existing.acceptedEvidenceId !== evidenceId) {
    updated = transitionToOperator(updated, "multiple_matching_payments");
  }
  return updated;
}

export function markFundingRequestPaid(
  existing: FundingRequestRecord,
  evidenceId: string,
): FundingRequestRecord {
  assertFundingIdentifier(evidenceId, "Evidence ID");
  if (existing.state === "PAID" && existing.acceptedEvidenceId === evidenceId) {
    return existing;
  }
  if (existing.state !== "OBSERVED" || existing.acceptedEvidenceId !== evidenceId) {
    throw new FundingIntegrityError("Only accepted observed evidence can mark a request paid");
  }

  const evidence = existing.evidence.find(
    (candidate) => candidate.observation.evidence_id === evidenceId,
  );
  if (
    evidence === undefined ||
    !evidence.matchesRequest ||
    evidence.observation.status !== "FINAL"
  ) {
    throw new FundingIntegrityError("Funding evidence is not final and matching");
  }
  return transitionIfAllowed(existing, "PAID");
}

export function expireFundingRequest(existing: FundingRequestRecord): FundingRequestRecord {
  let updated = existing;
  if (updated.state === "REJECTED") {
    updated = transitionIfAllowed(updated, "CREATED");
  }
  return updated.state === "CREATED" ? transitionIfAllowed(updated, "EXPIRED") : updated;
}

export function requireFundingOperator(
  existing: FundingRequestRecord,
  reason: string,
): FundingRequestRecord {
  assertFundingIdentifier(reason, "Operator reason");
  return transitionToOperator(existing, reason);
}

function mergeEvidence(
  existing: readonly FundingEvidenceRecord[],
  input: RecordFundingEvidenceInput,
): readonly FundingEvidenceRecord[] {
  const index = existing.findIndex(
    (candidate) => candidate.observation.evidence_id === input.observation.evidence_id,
  );
  if (index === -1) {
    return [
      ...existing,
      {
        observation: cloneObservation(input.observation),
        firstObservedAt: input.observedAt,
        lastObservedAt: input.observedAt,
        matchesRequest: input.matchesRequest,
      },
    ];
  }

  const current = existing[index];
  if (current === undefined) {
    throw new FundingIntegrityError("Funding evidence index is invalid");
  }
  assertSameEvidence(current.observation, input.observation);
  if (current.matchesRequest !== input.matchesRequest) {
    throw new FundingIntegrityError("Funding evidence match result changed across reconciliation");
  }

  const merged: FundingEvidenceRecord = {
    ...current,
    observation: {
      ...cloneObservation(current.observation),
      status: mergeObservationStatus(current.observation.status, input.observation.status),
    },
    lastObservedAt: Math.max(current.lastObservedAt, input.observedAt),
  };
  return existing.map((candidate, candidateIndex) =>
    candidateIndex === index ? merged : candidate,
  );
}

function assertSameEvidence(existing: PaymentObservation, candidate: PaymentObservation): void {
  const { status: _existingStatus, ...existingIdentity } = existing;
  const { status: _candidateStatus, ...candidateIdentity } = candidate;
  if (!isDeepStrictEqual(existingIdentity, candidateIdentity)) {
    throw new FundingIntegrityError("Funding evidence identity changed across reconciliation");
  }
}

function mergeObservationStatus(
  existing: PaymentObservation["status"],
  candidate: PaymentObservation["status"],
): PaymentObservation["status"] {
  if (existing === candidate || existing === "CONFLICTED") {
    return existing;
  }
  if (candidate === "CONFLICTED" || candidate === "REORGED") {
    return candidate;
  }
  if (existing === "REORGED") {
    return "CONFLICTED";
  }
  if (existing === "FINAL" && candidate === "PENDING") {
    return existing;
  }
  return candidate;
}

function transitionIfAllowed(
  record: FundingRequestRecord,
  state: IncomingState,
): FundingRequestRecord {
  if (record.state === state) {
    return record;
  }
  if (!canTransitionIncoming(record.state, state)) {
    throw new FundingIntegrityError(`Illegal funding transition from ${record.state} to ${state}`);
  }
  return { ...record, state };
}

function transitionToOperator(record: FundingRequestRecord, reason: string): FundingRequestRecord {
  if (record.state === "OPERATOR_REQUIRED") {
    return record;
  }
  if (record.state === "ISSUED") {
    throw new FundingIntegrityError("Issued funding requires mint-level incident handling");
  }
  return { ...transitionIfAllowed(record, "OPERATOR_REQUIRED"), operatorReason: reason };
}

export function assertFundingIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512) {
    throw new FundingIntegrityError(`${label} is invalid`);
  }
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new FundingIntegrityError(`${label} is invalid`);
  }
}

function cloneIdentity(identity: FundingRequestIdentity): FundingRequestIdentity {
  return {
    ...identity,
    destination: structuredClone(identity.destination),
    ...(identity.verifiedPayerBinding === undefined
      ? {}
      : { verifiedPayerBinding: { ...identity.verifiedPayerBinding } }),
  };
}

function cloneObservation(observation: PaymentObservation): PaymentObservation {
  return {
    ...observation,
    destination: structuredClone(observation.destination),
  };
}

export function cloneFundingRequestRecord(record: FundingRequestRecord): FundingRequestRecord {
  return {
    ...record,
    identity: cloneIdentity(record.identity),
    evidence: record.evidence.map((evidence) => ({
      ...evidence,
      observation: cloneObservation(evidence.observation),
    })),
  };
}
