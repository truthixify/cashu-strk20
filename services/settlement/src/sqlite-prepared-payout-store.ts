import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  assertPreparedPayoutFinalityIncidentCandidate,
  assertPreparedPayoutInclusionCandidate,
  assertPreparedPayoutRecord,
  assertPreparedPayoutSubmissionLeaseCandidate,
  assertSamePreparedPayoutRequest,
  clonePreparedPayoutRecord,
  type PreparedPayoutCandidate,
  PreparedPayoutConflictError,
  type PreparedPayoutFinalityIncidentCandidate,
  type PreparedPayoutInclusionCandidate,
  PreparedPayoutIntegrityError,
  type PreparedPayoutRecord,
  type PreparedPayoutSubmissionLeaseCandidate,
  type PreparedPayoutStore,
} from "./prepared-payouts.js";

export class PreparedPayoutStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PreparedPayoutStoreError";
  }
}

export class PreparedPayoutStoreCorruptionError extends PreparedPayoutStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PreparedPayoutStoreCorruptionError";
  }
}

export interface SqlitePreparedPayoutStoreOptions {
  readonly busyTimeoutMilliseconds?: number;
}

/** Dedicated local persistence for authenticated encrypted signed-transaction artifacts. */
export class SqlitePreparedPayoutStore implements PreparedPayoutStore {
  readonly #database: DatabaseSync;
  readonly #path: string;

  constructor(path: string, options: SqlitePreparedPayoutStoreOptions = {}) {
    const timeout = options.busyTimeoutMilliseconds ?? DEFAULT_BUSY_TIMEOUT_MILLISECONDS;
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > MAX_BUSY_TIMEOUT_MILLISECONDS) {
      throw new PreparedPayoutStoreError("Prepared payout SQLite busy timeout is invalid");
    }
    prepareDatabaseFile(path);
    this.#path = path;
    this.#database = new DatabaseSync(path, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      timeout,
    });
    try {
      secureDatabaseFiles(path);
      this.#configure();
      this.#initializeSchema();
      secureDatabaseFiles(path);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close(): void {
    if (this.#database.isOpen) {
      this.#database.close();
    }
    secureDatabaseFiles(this.#path);
  }

  async getByIntentId(intentId: string): Promise<PreparedPayoutRecord | null> {
    assertLookupIdentifier(intentId, "Intent ID");
    return this.#readTransaction(() => this.#readByIntentId(intentId));
  }

  async getBySubmissionId(submissionId: string): Promise<PreparedPayoutRecord | null> {
    assertLookupIdentifier(submissionId, "Submission ID");
    return this.#readTransaction(() => this.#readBySubmissionId(submissionId));
  }

  async createOrGet(candidate: PreparedPayoutCandidate): Promise<PreparedPayoutRecord> {
    assertPreparedPayoutRecord(candidate);
    return this.#writeTransaction(() => {
      const existing = this.#readByIntentId(candidate.intentId);
      if (existing !== null) {
        assertSamePreparedPayoutRequest(existing, candidate);
        return existing;
      }
      this.#assertUnowned(candidate);
      try {
        this.#database
          .prepare(
            `INSERT INTO prepared_payouts (
              intent_id, submission_id, request_digest, adapter_version, sender_address, nonce,
              transaction_reference, payload_version, encryption_algorithm, encryption_key_id,
              initialization_vector, ciphertext, authentication_tag
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            candidate.intentId,
            candidate.submissionId,
            candidate.requestDigest,
            candidate.adapterVersion,
            candidate.senderAddress,
            candidate.nonce,
            candidate.transactionReference,
            candidate.payloadVersion,
            candidate.encryptedTransaction.algorithm,
            candidate.encryptedTransaction.keyId,
            candidate.encryptedTransaction.initializationVector,
            candidate.encryptedTransaction.ciphertext,
            candidate.encryptedTransaction.authenticationTag,
          );
      } catch (error) {
        throw new PreparedPayoutStoreError("Prepared payout artifact could not be persisted", {
          cause: error,
        });
      }
      secureDatabaseFiles(this.#path);
      return clonePreparedPayoutRecord(candidate);
    });
  }

  async claimSubmission(candidate: PreparedPayoutSubmissionLeaseCandidate): Promise<boolean> {
    assertPreparedPayoutSubmissionLeaseCandidate(candidate);
    return this.#writeTransaction(() => {
      const row = this.#database
        .prepare(
          `SELECT submission_id, transaction_reference, submission_lease_id,
                  submission_lease_acquired_at, submission_lease_expires_at
           FROM prepared_payouts WHERE submission_id = ?`,
        )
        .get(candidate.submissionId);
      if (row === undefined) {
        throw new PreparedPayoutIntegrityError("Prepared payout submission does not exist");
      }
      const existing = parseSubmissionLease(row);
      if (rowString(row, "transaction_reference") !== candidate.transactionReference) {
        throw new PreparedPayoutIntegrityError(
          "Prepared payout submission lease belongs to a different transaction",
        );
      }
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
      try {
        const result = this.#database
          .prepare(
            `UPDATE prepared_payouts
             SET submission_lease_id = ?, submission_lease_acquired_at = ?,
                 submission_lease_expires_at = ?
             WHERE submission_id = ? AND transaction_reference = ?`,
          )
          .run(
            candidate.leaseId,
            candidate.acquiredAt,
            candidate.expiresAt,
            candidate.submissionId,
            candidate.transactionReference,
          );
        if (result.changes !== 1) {
          throw corruption("Prepared payout submission lease update lost atomic ownership");
        }
      } catch (error) {
        if (error instanceof PreparedPayoutStoreCorruptionError) {
          throw error;
        }
        throw new PreparedPayoutStoreError(
          "Prepared payout submission lease could not be persisted",
          { cause: error },
        );
      }
      secureDatabaseFiles(this.#path);
      return true;
    });
  }

  async recordInclusion(
    candidate: PreparedPayoutInclusionCandidate,
  ): Promise<PreparedPayoutRecord> {
    assertPreparedPayoutInclusionCandidate(candidate);
    return this.#writeTransaction(() => {
      const existing = this.#readBySubmissionId(candidate.submissionId);
      if (existing === null) {
        throw new PreparedPayoutIntegrityError("Prepared payout submission does not exist");
      }
      if (existing.transactionReference !== candidate.transactionReference) {
        throw new PreparedPayoutIntegrityError(
          "Prepared payout inclusion belongs to a different transaction",
        );
      }
      if (existing.inclusion !== undefined) {
        if (
          existing.inclusion.blockHash !== candidate.blockHash ||
          existing.inclusion.blockNumber !== candidate.blockNumber
        ) {
          throw new PreparedPayoutConflictError(
            "inclusion_conflict",
            "Prepared payout already has a different canonical inclusion",
          );
        }
        return existing;
      }
      try {
        const result = this.#database
          .prepare(
            `UPDATE prepared_payouts
             SET inclusion_block_hash = ?, inclusion_block_number = ?
             WHERE submission_id = ? AND transaction_reference = ?
               AND inclusion_block_hash IS NULL AND inclusion_block_number IS NULL`,
          )
          .run(
            candidate.blockHash,
            candidate.blockNumber.toString(10),
            candidate.submissionId,
            candidate.transactionReference,
          );
        if (result.changes !== 1) {
          throw corruption("Prepared payout inclusion update lost atomic ownership");
        }
      } catch (error) {
        if (error instanceof PreparedPayoutStoreCorruptionError) {
          throw error;
        }
        throw new PreparedPayoutStoreError("Prepared payout inclusion could not be persisted", {
          cause: error,
        });
      }
      secureDatabaseFiles(this.#path);
      return clonePreparedPayoutRecord({
        ...existing,
        inclusion: { blockHash: candidate.blockHash, blockNumber: candidate.blockNumber },
      });
    });
  }

  async recordFinalityIncident(
    candidate: PreparedPayoutFinalityIncidentCandidate,
  ): Promise<PreparedPayoutRecord> {
    assertPreparedPayoutFinalityIncidentCandidate(candidate);
    return this.#writeTransaction(() => {
      const existing = this.#readBySubmissionId(candidate.submissionId);
      if (existing === null) {
        throw new PreparedPayoutIntegrityError("Prepared payout submission does not exist");
      }
      if (
        existing.intentId !== candidate.intentId ||
        existing.transactionReference !== candidate.transactionReference
      ) {
        throw new PreparedPayoutIntegrityError(
          "Prepared payout finality incident belongs to a different payout",
        );
      }
      if (existing.inclusion === undefined) {
        throw new PreparedPayoutIntegrityError(
          "Prepared payout has no accepted inclusion to monitor",
        );
      }
      if (existing.finalityIncident !== undefined) {
        return existing;
      }
      try {
        const result = this.#database
          .prepare(
            `UPDATE prepared_payouts
             SET finality_incident_status = ?, finality_incident_detected_at = ?,
                 finality_incident_observer_version = ?
             WHERE intent_id = ? AND submission_id = ? AND transaction_reference = ?
               AND finality_incident_status IS NULL
               AND finality_incident_detected_at IS NULL
               AND finality_incident_observer_version IS NULL`,
          )
          .run(
            candidate.status,
            candidate.detectedAt,
            candidate.observerVersion,
            candidate.intentId,
            candidate.submissionId,
            candidate.transactionReference,
          );
        if (result.changes !== 1) {
          throw corruption("Prepared payout finality incident update lost atomic ownership");
        }
      } catch (error) {
        if (error instanceof PreparedPayoutStoreCorruptionError) {
          throw error;
        }
        throw new PreparedPayoutStoreError(
          "Prepared payout finality incident could not be persisted",
          { cause: error },
        );
      }
      secureDatabaseFiles(this.#path);
      return clonePreparedPayoutRecord({
        ...existing,
        finalityIncident: {
          status: candidate.status,
          detectedAt: candidate.detectedAt,
          observerVersion: candidate.observerVersion,
        },
      });
    });
  }

  #configure(): void {
    this.#database.exec("PRAGMA trusted_schema = OFF");
    this.#database.exec("PRAGMA secure_delete = ON");
    this.#database.exec("PRAGMA synchronous = FULL");
    this.#database.exec("PRAGMA journal_mode = WAL");
  }

  #initializeSchema(): void {
    const versionRow = this.#database.prepare("PRAGMA user_version").get();
    if (versionRow === undefined) {
      throw new PreparedPayoutStoreError("Unable to read prepared payout schema version");
    }
    let version = rowInteger(versionRow, "user_version");
    if (version !== 0) {
      this.#assertPreparedPayoutTablePresent();
    }
    if (version === 0) {
      this.#writeTransaction(() => {
        this.#database.exec(SCHEMA_SQL);
        this.#database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
      this.#assertSchemaColumns(PREPARED_PAYOUT_COLUMNS);
      return;
    }
    if (version === LEGACY_SCHEMA_VERSION) {
      this.#assertSchemaColumns(LEGACY_PREPARED_PAYOUT_COLUMNS);
      this.#writeTransaction(() => {
        this.#database.exec("ALTER TABLE prepared_payouts ADD COLUMN inclusion_block_hash TEXT");
        this.#database.exec("ALTER TABLE prepared_payouts ADD COLUMN inclusion_block_number TEXT");
        this.#database.exec(`PRAGMA user_version = ${INCLUSION_SCHEMA_VERSION}`);
      });
      version = INCLUSION_SCHEMA_VERSION;
    }
    if (version === INCLUSION_SCHEMA_VERSION) {
      this.#assertSchemaColumns(INCLUSION_PREPARED_PAYOUT_COLUMNS);
      this.#writeTransaction(() => {
        this.#database.exec(
          "ALTER TABLE prepared_payouts ADD COLUMN finality_incident_status TEXT",
        );
        this.#database.exec(
          "ALTER TABLE prepared_payouts ADD COLUMN finality_incident_detected_at TEXT",
        );
        this.#database.exec(
          "ALTER TABLE prepared_payouts ADD COLUMN finality_incident_observer_version TEXT",
        );
        this.#database.exec(`PRAGMA user_version = ${FINALITY_SCHEMA_VERSION}`);
      });
      version = FINALITY_SCHEMA_VERSION;
    }
    if (version === FINALITY_SCHEMA_VERSION) {
      this.#assertSchemaColumns(FINALITY_PREPARED_PAYOUT_COLUMNS);
      this.#writeTransaction(() => {
        this.#database.exec("ALTER TABLE prepared_payouts ADD COLUMN submission_lease_id TEXT");
        this.#database.exec(
          "ALTER TABLE prepared_payouts ADD COLUMN submission_lease_acquired_at TEXT",
        );
        this.#database.exec(
          "ALTER TABLE prepared_payouts ADD COLUMN submission_lease_expires_at TEXT",
        );
        this.#database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
      version = SCHEMA_VERSION;
    }
    if (version !== SCHEMA_VERSION) {
      throw new PreparedPayoutStoreError(`Unsupported prepared payout schema version ${version}`);
    }
    this.#assertSchemaColumns(PREPARED_PAYOUT_COLUMNS);
  }

  #assertSchemaColumns(expectedColumns: readonly string[]): void {
    this.#assertPreparedPayoutTablePresent();
    const columns = new Set(
      this.#database
        .prepare("PRAGMA table_info(prepared_payouts)")
        .all()
        .map((row) => rowString(row, "name")),
    );
    if (
      columns.size !== expectedColumns.length ||
      expectedColumns.some((column) => !columns.has(column))
    ) {
      throw corruption("Prepared payout schema has an unexpected column layout");
    }
  }

  #assertPreparedPayoutTablePresent(): void {
    const table = this.#database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(PREPARED_PAYOUT_TABLE);
    if (table === undefined) {
      throw corruption(
        "Prepared payout schema is incomplete or shares an incompatible database file",
      );
    }
  }

  #assertUnowned(candidate: PreparedPayoutCandidate): void {
    if (
      this.#database
        .prepare("SELECT intent_id FROM prepared_payouts WHERE submission_id = ?")
        .get(candidate.submissionId) !== undefined
    ) {
      throw new PreparedPayoutConflictError("submission_conflict");
    }
    if (
      this.#database
        .prepare("SELECT intent_id FROM prepared_payouts WHERE transaction_reference = ?")
        .get(candidate.transactionReference) !== undefined
    ) {
      throw new PreparedPayoutConflictError("transaction_conflict");
    }
    if (
      this.#database
        .prepare("SELECT intent_id FROM prepared_payouts WHERE sender_address = ? AND nonce = ?")
        .get(candidate.senderAddress, candidate.nonce) !== undefined
    ) {
      throw new PreparedPayoutConflictError("nonce_conflict");
    }
  }

  #readByIntentId(intentId: string): PreparedPayoutRecord | null {
    const row = this.#database
      .prepare("SELECT * FROM prepared_payouts WHERE intent_id = ?")
      .get(intentId);
    return row === undefined ? null : parsePreparedPayout(row);
  }

  #readBySubmissionId(submissionId: string): PreparedPayoutRecord | null {
    const row = this.#database
      .prepare("SELECT * FROM prepared_payouts WHERE submission_id = ?")
      .get(submissionId);
    return row === undefined ? null : parsePreparedPayout(row);
  }

  #readTransaction<Value>(operation: () => Value): Value {
    return this.#transaction("BEGIN", operation);
  }

  #writeTransaction<Value>(operation: () => Value): Value {
    return this.#transaction("BEGIN IMMEDIATE", operation);
  }

  #transaction<Value>(begin: "BEGIN" | "BEGIN IMMEDIATE", operation: () => Value): Value {
    this.#database.exec(begin);
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        if (this.#database.isTransaction) {
          this.#database.exec("ROLLBACK");
        }
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Prepared payout operation and rollback both failed",
        );
      }
      throw error;
    }
  }
}

function parsePreparedPayout(row: Record<string, unknown>): PreparedPayoutRecord {
  try {
    parseSubmissionLease(row);
    const inclusion = parseInclusion(row);
    const finalityIncident = parseFinalityIncident(row);
    const record: PreparedPayoutRecord = {
      payloadVersion: rowInteger(row, "payload_version") as 1,
      intentId: rowString(row, "intent_id"),
      submissionId: rowString(row, "submission_id"),
      requestDigest: rowString(row, "request_digest"),
      adapterVersion: rowString(row, "adapter_version"),
      senderAddress: rowString(row, "sender_address"),
      nonce: rowString(row, "nonce"),
      transactionReference: rowString(row, "transaction_reference"),
      encryptedTransaction: {
        algorithm: rowString(row, "encryption_algorithm") as "A256GCM",
        keyId: rowString(row, "encryption_key_id"),
        initializationVector: rowString(row, "initialization_vector"),
        ciphertext: rowString(row, "ciphertext"),
        authenticationTag: rowString(row, "authentication_tag"),
      },
      ...(finalityIncident === undefined ? {} : { finalityIncident }),
      ...(inclusion === undefined ? {} : { inclusion }),
    };
    assertPreparedPayoutRecord(record);
    return clonePreparedPayoutRecord(record);
  } catch (error) {
    if (error instanceof PreparedPayoutStoreCorruptionError) {
      throw error;
    }
    throw corruption("Prepared payout artifact violates its storage invariants", error);
  }
}

function parseSubmissionLease(
  row: Record<string, unknown>,
): PreparedPayoutSubmissionLeaseCandidate | undefined {
  const leaseId = rowNullableString(row, "submission_lease_id");
  const acquiredAt = rowNullableString(row, "submission_lease_acquired_at");
  const expiresAt = rowNullableString(row, "submission_lease_expires_at");
  if (leaseId === null && acquiredAt === null && expiresAt === null) {
    return undefined;
  }
  if (leaseId === null || acquiredAt === null || expiresAt === null) {
    throw corruption("Prepared payout submission lease columns are inconsistent");
  }
  const lease = {
    submissionId: rowString(row, "submission_id"),
    transactionReference: rowString(row, "transaction_reference"),
    leaseId,
    acquiredAt,
    expiresAt,
  };
  try {
    assertPreparedPayoutSubmissionLeaseCandidate(lease);
  } catch (error) {
    throw corruption("Prepared payout submission lease violates its storage invariants", error);
  }
  return lease;
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

function parseInclusion(
  row: Record<string, unknown>,
): PreparedPayoutRecord["inclusion"] | undefined {
  const blockHash = rowNullableString(row, "inclusion_block_hash");
  const blockNumber = rowNullableString(row, "inclusion_block_number");
  if (blockHash === null && blockNumber === null) {
    return undefined;
  }
  if (blockHash === null || blockNumber === null || !/^(?:0|[1-9][0-9]*)$/.test(blockNumber)) {
    throw corruption("Prepared payout inclusion columns are inconsistent");
  }
  return { blockHash, blockNumber: BigInt(blockNumber) };
}

function parseFinalityIncident(
  row: Record<string, unknown>,
): PreparedPayoutRecord["finalityIncident"] | undefined {
  const status = rowNullableString(row, "finality_incident_status");
  const detectedAt = rowNullableString(row, "finality_incident_detected_at");
  const observerVersion = rowNullableString(row, "finality_incident_observer_version");
  if (status === null && detectedAt === null && observerVersion === null) {
    return undefined;
  }
  if (status === null || detectedAt === null || observerVersion === null) {
    throw corruption("Prepared payout finality incident columns are inconsistent");
  }
  return {
    status: status as "CONFLICTED" | "REORGED",
    detectedAt,
    observerVersion,
  };
}

function rowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw corruption(`Prepared payout column ${key} is not text`);
  }
  return value;
}

function rowNullableString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== "string") {
    throw corruption(`Prepared payout column ${key} is not nullable text`);
  }
  return value;
}

function rowInteger(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw corruption(`Prepared payout column ${key} is not a safe integer`);
  }
  return value;
}

function assertLookupIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512) {
    throw new PreparedPayoutStoreError(`${label} is invalid`);
  }
}

function corruption(message: string, cause?: unknown): PreparedPayoutStoreCorruptionError {
  return new PreparedPayoutStoreCorruptionError(message, cause === undefined ? {} : { cause });
}

function prepareDatabaseFile(path: string): void {
  if (path === SQLITE_MEMORY_PATH) {
    return;
  }
  if (typeof path !== "string" || path.trim().length === 0 || path.startsWith("file:")) {
    throw new PreparedPayoutStoreError("Prepared payout SQLite database path is invalid");
  }
  const descriptor = openSync(path, "a", 0o600);
  closeSync(descriptor);
  chmodSync(path, 0o600);
}

function secureDatabaseFiles(path: string): void {
  if (path === SQLITE_MEMORY_PATH) {
    return;
  }
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(candidate)) {
      chmodSync(candidate, 0o600);
    }
  }
}

const LEGACY_SCHEMA_VERSION = 1;
const INCLUSION_SCHEMA_VERSION = 2;
const FINALITY_SCHEMA_VERSION = 3;
const SCHEMA_VERSION = 4;
const PREPARED_PAYOUT_TABLE = "prepared_payouts";
const SQLITE_MEMORY_PATH = ":memory:";
const DEFAULT_BUSY_TIMEOUT_MILLISECONDS = 5_000;
const MAX_BUSY_TIMEOUT_MILLISECONDS = 60_000;

const LEGACY_PREPARED_PAYOUT_COLUMNS = [
  "intent_id",
  "submission_id",
  "request_digest",
  "adapter_version",
  "sender_address",
  "nonce",
  "transaction_reference",
  "payload_version",
  "encryption_algorithm",
  "encryption_key_id",
  "initialization_vector",
  "ciphertext",
  "authentication_tag",
] as const;

const INCLUSION_PREPARED_PAYOUT_COLUMNS = [
  ...LEGACY_PREPARED_PAYOUT_COLUMNS,
  "inclusion_block_hash",
  "inclusion_block_number",
] as const;

const FINALITY_PREPARED_PAYOUT_COLUMNS = [
  ...INCLUSION_PREPARED_PAYOUT_COLUMNS,
  "finality_incident_status",
  "finality_incident_detected_at",
  "finality_incident_observer_version",
] as const;

const PREPARED_PAYOUT_COLUMNS = [
  ...FINALITY_PREPARED_PAYOUT_COLUMNS,
  "submission_lease_id",
  "submission_lease_acquired_at",
  "submission_lease_expires_at",
] as const;

const SCHEMA_SQL = `
  CREATE TABLE prepared_payouts (
    intent_id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL UNIQUE,
    request_digest TEXT NOT NULL,
    adapter_version TEXT NOT NULL,
    sender_address TEXT NOT NULL,
    nonce TEXT NOT NULL,
    transaction_reference TEXT NOT NULL UNIQUE,
    payload_version INTEGER NOT NULL CHECK (payload_version = 1),
    encryption_algorithm TEXT NOT NULL CHECK (encryption_algorithm = 'A256GCM'),
    encryption_key_id TEXT NOT NULL,
    initialization_vector TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    authentication_tag TEXT NOT NULL,
    inclusion_block_hash TEXT,
    inclusion_block_number TEXT,
    finality_incident_status TEXT,
    finality_incident_detected_at TEXT,
    finality_incident_observer_version TEXT,
    submission_lease_id TEXT,
    submission_lease_acquired_at TEXT,
    submission_lease_expires_at TEXT,
    CHECK (
      (inclusion_block_hash IS NULL AND inclusion_block_number IS NULL) OR
      (inclusion_block_hash IS NOT NULL AND inclusion_block_number IS NOT NULL)
    ),
    CHECK (
      (
        finality_incident_status IS NULL AND
        finality_incident_detected_at IS NULL AND
        finality_incident_observer_version IS NULL
      ) OR (
        finality_incident_status IN ('CONFLICTED', 'REORGED') AND
        finality_incident_detected_at IS NOT NULL AND
        finality_incident_observer_version IS NOT NULL
      )
    ),
    CHECK (finality_incident_status IS NULL OR inclusion_block_hash IS NOT NULL),
    CHECK (
      (
        submission_lease_id IS NULL AND
        submission_lease_acquired_at IS NULL AND
        submission_lease_expires_at IS NULL
      ) OR (
        submission_lease_id IS NOT NULL AND
        submission_lease_acquired_at IS NOT NULL AND
        submission_lease_expires_at IS NOT NULL
      )
    ),
    UNIQUE (sender_address, nonce)
  ) STRICT;
`;
