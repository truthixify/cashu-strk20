export const PREPARED_PAYOUT_PAYLOAD_VERSION = 1 as const;
export const MAXIMUM_PREPARED_PAYOUT_SUBMISSION_LEASE_MILLISECONDS = 10 * 60 * 1_000;

export interface EncryptedPreparedPayoutPayload {
  readonly algorithm: "A256GCM";
  readonly keyId: string;
  readonly initializationVector: string;
  readonly ciphertext: string;
  readonly authenticationTag: string;
}

export interface PreparedPayoutPayloadContext {
  readonly payloadVersion: typeof PREPARED_PAYOUT_PAYLOAD_VERSION;
  readonly submissionId: string;
  readonly intentId: string;
  readonly requestDigest: string;
  readonly adapterVersion: string;
  readonly senderAddress: string;
  readonly nonce: string;
  readonly transactionReference: string;
}

export interface PreparedPayoutInclusion {
  readonly blockHash: string;
  readonly blockNumber: bigint;
}

export interface PreparedPayoutInclusionCandidate extends PreparedPayoutInclusion {
  readonly submissionId: string;
  readonly transactionReference: string;
}

export interface PreparedPayoutSubmissionLeaseCandidate {
  readonly submissionId: string;
  readonly transactionReference: string;
  readonly leaseId: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export type PreparedPayoutFinalityIncidentStatus = "CONFLICTED" | "REORGED";

export interface PreparedPayoutFinalityIncident {
  readonly status: PreparedPayoutFinalityIncidentStatus;
  readonly detectedAt: string;
  readonly observerVersion: string;
}

export interface PreparedPayoutFinalityIncidentCandidate extends PreparedPayoutFinalityIncident {
  readonly intentId: string;
  readonly submissionId: string;
  readonly transactionReference: string;
}

export interface PreparedPayoutRecord extends PreparedPayoutPayloadContext {
  readonly encryptedTransaction: EncryptedPreparedPayoutPayload;
  readonly finalityIncident?: PreparedPayoutFinalityIncident;
  readonly inclusion?: PreparedPayoutInclusion;
}

export type PreparedPayoutCandidate = PreparedPayoutRecord;

export interface PreparedPayoutStore {
  getByIntentId(intentId: string): Promise<PreparedPayoutRecord | null>;
  getBySubmissionId(submissionId: string): Promise<PreparedPayoutRecord | null>;
  /** Atomically retain one artifact per intent, transaction hash, and sender nonce. */
  createOrGet(candidate: PreparedPayoutCandidate): Promise<PreparedPayoutRecord>;
  /** Atomically fence one broadcaster until expiry; an identical retry is idempotent. */
  claimSubmission(candidate: PreparedPayoutSubmissionLeaseCandidate): Promise<boolean>;
  /** Atomically retain the first accepted canonical inclusion; never replace its block identity. */
  recordInclusion(candidate: PreparedPayoutInclusionCandidate): Promise<PreparedPayoutRecord>;
  /** Atomically retain the first post-terminal canonicality incident for operator handling. */
  recordFinalityIncident(
    candidate: PreparedPayoutFinalityIncidentCandidate,
  ): Promise<PreparedPayoutRecord>;
}

export class PreparedPayoutConflictError extends Error {
  readonly code:
    | "intent_conflict"
    | "inclusion_conflict"
    | "nonce_conflict"
    | "submission_conflict"
    | "transaction_conflict";

  constructor(
    code: PreparedPayoutConflictError["code"],
    message = "Prepared payout ownership conflicts with an existing artifact",
  ) {
    super(message);
    this.name = "PreparedPayoutConflictError";
    this.code = code;
  }
}

export class PreparedPayoutIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreparedPayoutIntegrityError";
  }
}

/** Deterministic test store. A funded service requires a separate durable encrypted-payload store. */
export class InMemoryPreparedPayoutStore implements PreparedPayoutStore {
  readonly #byIntentId = new Map<string, PreparedPayoutRecord>();
  readonly #intentIdBySubmissionId = new Map<string, string>();
  readonly #intentIdByTransactionReference = new Map<string, string>();
  readonly #intentIdBySenderNonce = new Map<string, string>();
  readonly #submissionLeaseBySubmissionId = new Map<
    string,
    PreparedPayoutSubmissionLeaseCandidate
  >();

  async getByIntentId(intentId: string): Promise<PreparedPayoutRecord | null> {
    assertOpaqueIdentifier(intentId, "Intent ID");
    const record = this.#byIntentId.get(intentId);
    return record === undefined ? null : clonePreparedPayoutRecord(record);
  }

  async getBySubmissionId(submissionId: string): Promise<PreparedPayoutRecord | null> {
    assertOpaqueIdentifier(submissionId, "Submission ID");
    const intentId = this.#intentIdBySubmissionId.get(submissionId);
    if (intentId === undefined) {
      return null;
    }
    const record = this.#byIntentId.get(intentId);
    if (record === undefined) {
      throw new PreparedPayoutIntegrityError("Prepared payout indexes are inconsistent");
    }
    return clonePreparedPayoutRecord(record);
  }

  async createOrGet(candidate: PreparedPayoutCandidate): Promise<PreparedPayoutRecord> {
    assertPreparedPayoutRecord(candidate);
    const existing = this.#byIntentId.get(candidate.intentId);
    if (existing !== undefined) {
      assertSamePreparedPayoutRequest(existing, candidate);
      return clonePreparedPayoutRecord(existing);
    }

    this.#assertUnowned(
      this.#intentIdBySubmissionId,
      candidate.submissionId,
      candidate.intentId,
      "submission_conflict",
    );
    this.#assertUnowned(
      this.#intentIdByTransactionReference,
      candidate.transactionReference,
      candidate.intentId,
      "transaction_conflict",
    );
    this.#assertUnowned(
      this.#intentIdBySenderNonce,
      senderNonceKey(candidate),
      candidate.intentId,
      "nonce_conflict",
    );

    const record = clonePreparedPayoutRecord(candidate);
    this.#byIntentId.set(record.intentId, record);
    this.#intentIdBySubmissionId.set(record.submissionId, record.intentId);
    this.#intentIdByTransactionReference.set(record.transactionReference, record.intentId);
    this.#intentIdBySenderNonce.set(senderNonceKey(record), record.intentId);
    return clonePreparedPayoutRecord(record);
  }

  async claimSubmission(candidate: PreparedPayoutSubmissionLeaseCandidate): Promise<boolean> {
    assertPreparedPayoutSubmissionLeaseCandidate(candidate);
    const intentId = this.#intentIdBySubmissionId.get(candidate.submissionId);
    if (intentId === undefined) {
      throw new PreparedPayoutIntegrityError("Prepared payout submission does not exist");
    }
    const record = this.#byIntentId.get(intentId);
    if (record === undefined) {
      throw new PreparedPayoutIntegrityError("Prepared payout indexes are inconsistent");
    }
    assertSubmissionLeaseTransaction(record, candidate);
    const existing = this.#submissionLeaseBySubmissionId.get(candidate.submissionId);
    if (existing !== undefined) {
      if (existing.leaseId === candidate.leaseId) {
        if (!sameSubmissionLease(existing, candidate)) {
          throw new PreparedPayoutIntegrityError(
            "Prepared payout submission lease ID has conflicting bounds",
          );
        }
        return true;
      }
      if (Date.parse(existing.expiresAt) > Date.parse(candidate.acquiredAt)) {
        return false;
      }
    }
    this.#submissionLeaseBySubmissionId.set(candidate.submissionId, { ...candidate });
    return true;
  }

  async recordInclusion(
    candidate: PreparedPayoutInclusionCandidate,
  ): Promise<PreparedPayoutRecord> {
    assertPreparedPayoutInclusionCandidate(candidate);
    const intentId = this.#intentIdBySubmissionId.get(candidate.submissionId);
    if (intentId === undefined) {
      throw new PreparedPayoutIntegrityError("Prepared payout submission does not exist");
    }
    const existing = this.#byIntentId.get(intentId);
    if (existing === undefined) {
      throw new PreparedPayoutIntegrityError("Prepared payout indexes are inconsistent");
    }
    assertInclusionTransaction(existing, candidate);
    if (existing.inclusion !== undefined) {
      assertSameInclusion(existing.inclusion, candidate);
      return clonePreparedPayoutRecord(existing);
    }
    const updated: PreparedPayoutRecord = {
      ...existing,
      inclusion: payoutInclusion(candidate),
    };
    this.#byIntentId.set(intentId, updated);
    return clonePreparedPayoutRecord(updated);
  }

  async recordFinalityIncident(
    candidate: PreparedPayoutFinalityIncidentCandidate,
  ): Promise<PreparedPayoutRecord> {
    assertPreparedPayoutFinalityIncidentCandidate(candidate);
    const intentId = this.#intentIdBySubmissionId.get(candidate.submissionId);
    if (intentId === undefined) {
      throw new PreparedPayoutIntegrityError("Prepared payout submission does not exist");
    }
    const existing = this.#byIntentId.get(intentId);
    if (existing === undefined) {
      throw new PreparedPayoutIntegrityError("Prepared payout indexes are inconsistent");
    }
    assertIncidentOwnership(existing, candidate);
    if (existing.inclusion === undefined) {
      throw new PreparedPayoutIntegrityError(
        "Prepared payout has no accepted inclusion to monitor",
      );
    }
    if (existing.finalityIncident !== undefined) {
      return clonePreparedPayoutRecord(existing);
    }
    const updated: PreparedPayoutRecord = {
      ...existing,
      finalityIncident: payoutFinalityIncident(candidate),
    };
    this.#byIntentId.set(intentId, updated);
    return clonePreparedPayoutRecord(updated);
  }

  #assertUnowned(
    index: ReadonlyMap<string, string>,
    key: string,
    intentId: string,
    code: PreparedPayoutConflictError["code"],
  ): void {
    const owner = index.get(key);
    if (owner !== undefined && owner !== intentId) {
      throw new PreparedPayoutConflictError(code);
    }
  }
}

export function preparedPayoutPayloadContext(
  record: PreparedPayoutPayloadContext,
): PreparedPayoutPayloadContext {
  const context = {
    payloadVersion: record.payloadVersion,
    submissionId: record.submissionId,
    intentId: record.intentId,
    requestDigest: record.requestDigest,
    adapterVersion: record.adapterVersion,
    senderAddress: record.senderAddress,
    nonce: record.nonce,
    transactionReference: record.transactionReference,
  };
  assertPreparedPayoutContext(context);
  return context;
}

export function assertSamePreparedPayoutRequest(
  existing: PreparedPayoutRecord,
  candidate: PreparedPayoutCandidate,
): void {
  if (
    existing.requestDigest !== candidate.requestDigest ||
    existing.adapterVersion !== candidate.adapterVersion ||
    existing.senderAddress !== candidate.senderAddress
  ) {
    throw new PreparedPayoutConflictError("intent_conflict");
  }
}

export function assertPreparedPayoutRecord(
  value: PreparedPayoutRecord,
): asserts value is PreparedPayoutRecord {
  assertPreparedPayoutContext(value);
  const encrypted = value.encryptedTransaction;
  if (typeof encrypted !== "object" || encrypted === null || encrypted.algorithm !== "A256GCM") {
    throw new PreparedPayoutIntegrityError("Prepared payout encryption envelope is invalid");
  }
  assertOpaqueIdentifier(encrypted.keyId, "Encryption key ID", MAXIMUM_KEY_ID_LENGTH);
  assertBase64Url(encrypted.initializationVector, "Encryption initialization vector", 16, 16);
  assertBase64Url(encrypted.authenticationTag, "Encryption authentication tag", 22, 22);
  assertBase64Url(
    encrypted.ciphertext,
    "Encrypted transaction payload",
    1,
    MAXIMUM_ENCRYPTED_TRANSACTION_LENGTH,
  );
  if (value.inclusion !== undefined) {
    assertPreparedPayoutInclusion(value.inclusion);
  }
  if (value.finalityIncident !== undefined) {
    assertPreparedPayoutFinalityIncident(value.finalityIncident);
    if (value.inclusion === undefined) {
      throw new PreparedPayoutIntegrityError(
        "Prepared payout finality incident has no original inclusion",
      );
    }
  }
}

export function clonePreparedPayoutRecord(record: PreparedPayoutRecord): PreparedPayoutRecord {
  assertPreparedPayoutRecord(record);
  return {
    ...preparedPayoutPayloadContext(record),
    encryptedTransaction: { ...record.encryptedTransaction },
    ...(record.finalityIncident === undefined
      ? {}
      : { finalityIncident: payoutFinalityIncident(record.finalityIncident) }),
    ...(record.inclusion === undefined ? {} : { inclusion: payoutInclusion(record.inclusion) }),
  };
}

export function assertPreparedPayoutFinalityIncidentCandidate(
  value: PreparedPayoutFinalityIncidentCandidate,
): asserts value is PreparedPayoutFinalityIncidentCandidate {
  if (typeof value !== "object" || value === null) {
    throw new PreparedPayoutIntegrityError("Prepared payout finality incident is invalid");
  }
  assertOpaqueIdentifier(value.intentId, "Intent ID");
  assertOpaqueIdentifier(value.submissionId, "Submission ID");
  assertCanonicalFelt(value.transactionReference, "Transaction reference", false);
  assertPreparedPayoutFinalityIncident(value);
}

export function assertPreparedPayoutInclusionCandidate(
  value: PreparedPayoutInclusionCandidate,
): asserts value is PreparedPayoutInclusionCandidate {
  if (typeof value !== "object" || value === null) {
    throw new PreparedPayoutIntegrityError("Prepared payout inclusion is invalid");
  }
  assertOpaqueIdentifier(value.submissionId, "Submission ID");
  assertCanonicalFelt(value.transactionReference, "Transaction reference", false);
  assertPreparedPayoutInclusion(value);
}

export function assertPreparedPayoutSubmissionLeaseCandidate(
  value: PreparedPayoutSubmissionLeaseCandidate,
): asserts value is PreparedPayoutSubmissionLeaseCandidate {
  if (typeof value !== "object" || value === null) {
    throw new PreparedPayoutIntegrityError("Prepared payout submission lease is invalid");
  }
  assertOpaqueIdentifier(value.submissionId, "Submission ID");
  assertCanonicalFelt(value.transactionReference, "Transaction reference", false);
  assertOpaqueIdentifier(value.leaseId, "Submission lease ID", MAXIMUM_LEASE_ID_LENGTH);
  if (!isCanonicalTimestamp(value.acquiredAt) || !isCanonicalTimestamp(value.expiresAt)) {
    throw new PreparedPayoutIntegrityError("Prepared payout submission lease timestamp is invalid");
  }
  const duration = Date.parse(value.expiresAt) - Date.parse(value.acquiredAt);
  if (duration <= 0 || duration > MAXIMUM_PREPARED_PAYOUT_SUBMISSION_LEASE_MILLISECONDS) {
    throw new PreparedPayoutIntegrityError("Prepared payout submission lease duration is invalid");
  }
}

function assertPreparedPayoutInclusion(
  value: PreparedPayoutInclusion,
): asserts value is PreparedPayoutInclusion {
  if (typeof value !== "object" || value === null) {
    throw new PreparedPayoutIntegrityError("Prepared payout inclusion is invalid");
  }
  assertCanonicalFelt(value.blockHash, "Inclusion block hash", false);
  if (
    typeof value.blockNumber !== "bigint" ||
    value.blockNumber < 0n ||
    value.blockNumber > MAXIMUM_BLOCK_NUMBER
  ) {
    throw new PreparedPayoutIntegrityError("Inclusion block number is out of range");
  }
}

function assertInclusionTransaction(
  record: PreparedPayoutRecord,
  candidate: PreparedPayoutInclusionCandidate,
): void {
  if (record.transactionReference !== candidate.transactionReference) {
    throw new PreparedPayoutIntegrityError(
      "Prepared payout inclusion belongs to a different transaction",
    );
  }
}

function assertSubmissionLeaseTransaction(
  record: PreparedPayoutRecord,
  candidate: PreparedPayoutSubmissionLeaseCandidate,
): void {
  if (record.transactionReference !== candidate.transactionReference) {
    throw new PreparedPayoutIntegrityError(
      "Prepared payout submission lease belongs to a different transaction",
    );
  }
}

function sameSubmissionLease(
  existing: PreparedPayoutSubmissionLeaseCandidate,
  candidate: PreparedPayoutSubmissionLeaseCandidate,
): boolean {
  return (
    existing.submissionId === candidate.submissionId &&
    existing.transactionReference === candidate.transactionReference &&
    existing.leaseId === candidate.leaseId &&
    existing.acquiredAt === candidate.acquiredAt &&
    existing.expiresAt === candidate.expiresAt
  );
}

function assertSameInclusion(
  existing: PreparedPayoutInclusion,
  candidate: PreparedPayoutInclusion,
): void {
  if (
    existing.blockHash !== candidate.blockHash ||
    existing.blockNumber !== candidate.blockNumber
  ) {
    throw new PreparedPayoutConflictError(
      "inclusion_conflict",
      "Prepared payout already has a different canonical inclusion",
    );
  }
}

function assertPreparedPayoutFinalityIncident(
  value: PreparedPayoutFinalityIncident,
): asserts value is PreparedPayoutFinalityIncident {
  if (
    typeof value !== "object" ||
    value === null ||
    (value.status !== "CONFLICTED" && value.status !== "REORGED") ||
    !isCanonicalTimestamp(value.detectedAt)
  ) {
    throw new PreparedPayoutIntegrityError("Prepared payout finality incident is invalid");
  }
  assertOpaqueIdentifier(
    value.observerVersion,
    "Finality observer version",
    MAXIMUM_ADAPTER_VERSION_LENGTH,
  );
}

function assertIncidentOwnership(
  record: PreparedPayoutRecord,
  candidate: PreparedPayoutFinalityIncidentCandidate,
): void {
  if (
    record.intentId !== candidate.intentId ||
    record.transactionReference !== candidate.transactionReference
  ) {
    throw new PreparedPayoutIntegrityError(
      "Prepared payout finality incident belongs to a different payout",
    );
  }
}

function payoutInclusion(value: PreparedPayoutInclusion): PreparedPayoutInclusion {
  return { blockHash: value.blockHash, blockNumber: value.blockNumber };
}

function payoutFinalityIncident(
  value: PreparedPayoutFinalityIncident,
): PreparedPayoutFinalityIncident {
  return {
    status: value.status,
    detectedAt: value.detectedAt,
    observerVersion: value.observerVersion,
  };
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_TIMESTAMP_PATTERN.test(value)) {
    return false;
  }
  const milliseconds = new Date(value).getTime();
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function assertPreparedPayoutContext(value: PreparedPayoutPayloadContext): void {
  if (value.payloadVersion !== PREPARED_PAYOUT_PAYLOAD_VERSION) {
    throw new PreparedPayoutIntegrityError("Prepared payout payload version is unsupported");
  }
  assertOpaqueIdentifier(value.submissionId, "Submission ID");
  assertOpaqueIdentifier(value.intentId, "Intent ID");
  assertDigest(value.requestDigest);
  assertOpaqueIdentifier(value.adapterVersion, "Adapter version", MAXIMUM_ADAPTER_VERSION_LENGTH);
  assertCanonicalFelt(value.senderAddress, "Sender address", false);
  assertCanonicalFelt(value.nonce, "Transaction nonce", true);
  assertCanonicalFelt(value.transactionReference, "Transaction reference", false);
}

function assertDigest(value: string): void {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new PreparedPayoutIntegrityError("Prepared payout request digest is invalid");
  }
}

function assertCanonicalFelt(value: string, label: string, allowZero: boolean): void {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) {
    throw new PreparedPayoutIntegrityError(`${label} is not a canonical felt`);
  }
  const parsed = BigInt(value);
  if ((!allowZero && parsed === 0n) || parsed >= STARK_FIELD_PRIME) {
    throw new PreparedPayoutIntegrityError(`${label} is out of range`);
  }
}

function assertOpaqueIdentifier(
  value: string,
  label: string,
  maximum = MAXIMUM_IDENTIFIER_LENGTH,
): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    containsControlCharacter(value)
  ) {
    throw new PreparedPayoutIntegrityError(`${label} is invalid`);
  }
}

function assertBase64Url(value: string, label: string, minimum: number, maximum: number): void {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new PreparedPayoutIntegrityError(`${label} is invalid`);
  }
}

function senderNonceKey(record: Pick<PreparedPayoutRecord, "senderAddress" | "nonce">): string {
  return JSON.stringify([record.senderAddress, record.nonce]);
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

const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
const MAXIMUM_IDENTIFIER_LENGTH = 512;
const MAXIMUM_ADAPTER_VERSION_LENGTH = 256;
const MAXIMUM_KEY_ID_LENGTH = 128;
const MAXIMUM_LEASE_ID_LENGTH = 128;
const MAXIMUM_ENCRYPTED_TRANSACTION_LENGTH = 4 * 1024 * 1024;
const MAXIMUM_BLOCK_NUMBER = (1n << 64n) - 1n;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
