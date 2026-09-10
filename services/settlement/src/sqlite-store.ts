import { chmodSync, closeSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

import {
  ATTRIBUTION_PROFILES,
  type AttributionProfile,
  INCOMING_STATES,
  type IncomingState,
  PAYMENT_OBSERVATION_STATUSES,
  type PaymentObservation,
  type PaymentObservationStatus,
  STARKNET_NETWORKS,
  type StarknetNetwork,
} from "@cashu-strk20/strk20-method";

import {
  applyFundingEvidence,
  assertFundingIdentifier,
  assertSameFundingRequest,
  cloneFundingRequestRecord,
  createFundingRequestRecord,
  expireFundingRequest,
  FundingEvidenceConflictError,
  type FundingEvidenceRecord,
  type FundingRequestCandidate,
  type FundingRequestRecord,
  type FundingRequestStore,
  markFundingRequestPaid,
  type RecordFundingEvidenceInput,
  requireFundingOperator,
} from "./funding-records.js";
import type { PayoutAttempt } from "./gateway.js";
import {
  applySettlementAttempt,
  assertIntentIdentifier,
  assertSameIntent,
  attachSettlementSubmission,
  cloneSettlementIntentRecord,
  createSettlementIntentRecord,
  IntentIntegrityError,
  SETTLEMENT_INTENT_STATES,
  type SettlementIntentCandidate,
  type SettlementIntentRecord,
  type SettlementIntentState,
  type SettlementIntentStore,
} from "./intents.js";
import {
  applyPayerBindingVerification,
  assertPayerBindingIdentifier,
  assertSamePayerBindingRequest,
  clonePayerBindingChallengeRecord,
  createPayerBindingChallengeRecord,
  expirePayerBindingChallenge,
  PAYER_BINDING_CHALLENGE_STATES,
  PayerBindingAttributionConflictError,
  type PayerBindingChallengeCandidate,
  PayerBindingChallengeConflictError,
  type PayerBindingChallengeRecord,
  type PayerBindingChallengeState,
  type PayerBindingChallengeStore,
  payerBindingAttributionConflicts,
  type VerifyPayerBindingChallengeInput,
} from "./payer-binding-records.js";
import { type VerifiedPayerBinding, verifiedPayerBindingFromRecord } from "./payer-bindings.js";
import {
  assertClaimPayoutFinalityWatchesInput,
  assertClaimPayoutIncidentAlertsInput,
  assertCompletePayoutFinalityWatchInput,
  assertCompletePayoutIncidentAlertInput,
  assertRecordPayoutIncidentInput,
  assertRetryPayoutFinalityWatchInput,
  assertRetryPayoutIncidentAlertInput,
  type ClaimPayoutFinalityWatchesInput,
  type ClaimPayoutIncidentAlertsInput,
  type CompletePayoutFinalityWatchInput,
  type CompletePayoutIncidentAlertInput,
  clonePayoutFinalityWatchLease,
  clonePayoutIncidentAlert,
  clonePayoutIncidentAlertLease,
  cloneTerminalPayoutWatchCandidate,
  PayoutFinalityJobIntegrityError,
  type PayoutFinalityJobStore,
  type PayoutFinalityWatchLease,
  type PayoutIncidentAlertLease,
  type RecordPayoutIncidentInput,
  type RetryPayoutFinalityWatchInput,
  type RetryPayoutIncidentAlertInput,
  type TerminalPayoutWatchCandidate,
} from "./payout-finality-jobs.js";
import { SettlementProfilePausedError } from "./settlement-admission.js";
import {
  assertSettlementPauseRecord,
  cloneSettlementPauseRecord,
  cloneSettlementProfile,
  SETTLEMENT_METHOD,
  type SettlementPauseCandidate,
  type SettlementPauseRecord,
  type SettlementPauseStore,
  type SettlementProfile,
} from "./settlement-pauses.js";

export class SettlementStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SettlementStoreError";
  }
}

export class SettlementStoreCorruptionError extends SettlementStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SettlementStoreCorruptionError";
  }
}

export interface SqliteSettlementStoreOptions {
  readonly busyTimeoutMilliseconds?: number;
}

/** Local spike persistence. The pinned Node SQLite API remains experimental and is not encrypted. */
export class SqliteSettlementStore
  implements
    FundingRequestStore,
    SettlementIntentStore,
    PayerBindingChallengeStore,
    SettlementPauseStore,
    PayoutFinalityJobStore
{
  readonly #database: DatabaseSync;

  constructor(path: string, options: SqliteSettlementStoreOptions = {}) {
    const timeout = options.busyTimeoutMilliseconds ?? DEFAULT_BUSY_TIMEOUT_MILLISECONDS;
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > MAX_BUSY_TIMEOUT_MILLISECONDS) {
      throw new SettlementStoreError("SQLite busy timeout is invalid");
    }
    prepareDatabaseFile(path);
    this.#database = new DatabaseSync(path, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      timeout,
    });
    try {
      if (path !== SQLITE_MEMORY_PATH) {
        chmodSync(path, 0o600);
      }
      this.#configure();
      this.#initializeSchema();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close(): void {
    if (this.#database.isOpen) {
      this.#database.close();
    }
  }

  async getByPaymentRequestId(paymentRequestId: string): Promise<FundingRequestRecord | null> {
    assertFundingIdentifier(paymentRequestId, "Payment request ID");
    return this.#readTransaction(() => this.#readFundingRequest(paymentRequestId));
  }

  async getPayerBinding(paymentRequestId: string): Promise<PayerBindingChallengeRecord | null> {
    assertPayerBindingIdentifier(paymentRequestId, "Payment request ID");
    return this.#readTransaction(() => this.#readPayerBinding(paymentRequestId));
  }

  async createOrGetPayerBinding(
    candidate: PayerBindingChallengeCandidate,
  ): Promise<PayerBindingChallengeRecord> {
    return this.#writeTransaction(() => this.#createOrGetPayerBinding(candidate));
  }

  async markPayerBindingVerified(
    input: VerifyPayerBindingChallengeInput,
  ): Promise<PayerBindingChallengeRecord> {
    return this.#writeTransaction(() => {
      const existing = this.#requiredPayerBinding(input.paymentRequestId);
      const updated = applyPayerBindingVerification(existing, input);
      if (existing.state !== "VERIFIED") {
        if (updated.verification === undefined) {
          throw new SettlementStoreError("Verified payer binding is missing verification evidence");
        }
        const rows = this.#database
          .prepare(
            `SELECT payment_request_id
             FROM payer_binding_challenges
             WHERE state = 'VERIFIED' AND payment_request_id != ?
               AND (
                 (
                   network = ? AND pool_contract = ? AND expected_note_reference = ?
                 ) OR (
                   network = ? AND pool_contract = ? AND recipient_address = ?
                   AND token_contract = ? AND amount_base_units = ? AND payer_address = ?
                   AND verified_at < ? AND funding_expires_at > ?
                 )
               )
             LIMIT 1`,
          )
          .all(
            input.paymentRequestId,
            updated.identity.network,
            updated.identity.poolContract,
            updated.identity.expectedNoteReference,
            updated.identity.network,
            updated.identity.poolContract,
            updated.identity.recipientAddress,
            updated.identity.tokenContract,
            updated.identity.amountBaseUnits,
            updated.identity.payerAddress,
            updated.identity.fundingExpiresAt,
            updated.verification.verifiedAt,
          );
        for (const row of rows) {
          const candidate = this.#requiredPayerBinding(rowString(row, "payment_request_id"));
          if (payerBindingAttributionConflicts(updated, candidate)) {
            throw new PayerBindingAttributionConflictError();
          }
        }
      }
      this.#updatePayerBinding(updated);
      return clonePayerBindingChallengeRecord(updated);
    });
  }

  async expirePayerBinding(
    paymentRequestId: string,
    expiredAt: number,
  ): Promise<PayerBindingChallengeRecord> {
    return this.#writeTransaction(() => {
      const updated = expirePayerBindingChallenge(
        this.#requiredPayerBinding(paymentRequestId),
        expiredAt,
      );
      this.#updatePayerBinding(updated);
      return clonePayerBindingChallengeRecord(updated);
    });
  }

  async createOrGet(candidate: FundingRequestCandidate): Promise<FundingRequestRecord>;
  async createOrGet(candidate: SettlementIntentCandidate): Promise<SettlementIntentRecord>;
  async createOrGet(
    candidate: FundingRequestCandidate | SettlementIntentCandidate,
  ): Promise<FundingRequestRecord | SettlementIntentRecord> {
    return this.#writeTransaction(() =>
      "intentId" in candidate
        ? this.#createOrGetIntent(candidate)
        : this.#createOrGetFundingRequest(candidate),
    );
  }

  async recordEvidence(input: RecordFundingEvidenceInput): Promise<FundingRequestRecord> {
    return this.#writeTransaction(() => {
      const existing = this.#requiredFundingRequest(input.paymentRequestId);
      const owner = this.#readEvidenceOwner(input.observation.evidence_id);
      if (owner !== null && owner !== input.paymentRequestId) {
        throw new FundingEvidenceConflictError();
      }
      const updated = applyFundingEvidence(existing, input);
      this.#writeFundingEvidence(updated, input.observation.evidence_id);
      this.#updateFundingRequest(updated);
      return cloneFundingRequestRecord(updated);
    });
  }

  async markPaid(paymentRequestId: string, evidenceId: string): Promise<FundingRequestRecord> {
    return this.#writeTransaction(() => {
      const existing = this.#requiredFundingRequest(paymentRequestId);
      const updated = markFundingRequestPaid(existing, evidenceId);
      if (existing.state !== "PAID") {
        this.#assertProfileActive({
          method: SETTLEMENT_METHOD,
          network: existing.identity.network,
          tokenContract: existing.identity.tokenContract,
        });
      }
      this.#updateFundingRequest(updated);
      return cloneFundingRequestRecord(updated);
    });
  }

  async expire(paymentRequestId: string): Promise<FundingRequestRecord> {
    return this.#writeTransaction(() => {
      const updated = expireFundingRequest(this.#requiredFundingRequest(paymentRequestId));
      this.#updateFundingRequest(updated);
      return cloneFundingRequestRecord(updated);
    });
  }

  async requireOperator(paymentRequestId: string, reason: string): Promise<FundingRequestRecord> {
    return this.#writeTransaction(() => {
      const updated = requireFundingOperator(
        this.#requiredFundingRequest(paymentRequestId),
        reason,
      );
      this.#updateFundingRequest(updated);
      return cloneFundingRequestRecord(updated);
    });
  }

  async getByQuoteId(quoteId: string): Promise<SettlementIntentRecord | null> {
    assertIntentIdentifier(quoteId, "Quote ID");
    return this.#readTransaction(() => {
      const row = this.#database
        .prepare("SELECT intent_id FROM settlement_intents WHERE quote_id = ?")
        .get(quoteId);
      return row === undefined ? null : this.#requiredIntent(rowString(row, "intent_id"));
    });
  }

  async attachSubmission(intentId: string, submissionId: string): Promise<SettlementIntentRecord> {
    assertIntentIdentifier(submissionId, "Submission ID");
    return this.#writeTransaction(() => {
      const existing = this.#requiredIntent(intentId);
      if (existing.submissionId !== undefined) {
        return cloneSettlementIntentRecord(existing);
      }
      this.#assertProfileActive({
        method: SETTLEMENT_METHOD,
        network: existing.identity.network as StarknetNetwork,
        tokenContract: existing.identity.tokenContract,
      });
      const ownerRow = this.#database
        .prepare("SELECT intent_id FROM settlement_intents WHERE submission_id = ?")
        .get(submissionId);
      if (ownerRow !== undefined && rowString(ownerRow, "intent_id") !== intentId) {
        throw new IntentIntegrityError("Submission ID is already bound to another payout");
      }
      const updated = attachSettlementSubmission(existing, submissionId);
      this.#updateIntent(updated);
      return cloneSettlementIntentRecord(updated);
    });
  }

  async recordAttempt(attempt: PayoutAttempt): Promise<SettlementIntentRecord> {
    return this.#writeTransaction(() => {
      const updated = applySettlementAttempt(this.#requiredIntent(attempt.intentId), attempt);
      this.#updateIntent(updated);
      if (updated.state === "PAID" || updated.state === "FAILED") {
        this.#scheduleTerminalPayout({
          intentId: updated.intentId,
          quoteId: updated.identity.quoteId,
          profile: {
            method: SETTLEMENT_METHOD,
            network: updated.identity.network as StarknetNetwork,
            tokenContract: updated.identity.tokenContract,
          },
          nextCheckAt: 0,
        });
      }
      return cloneSettlementIntentRecord(updated);
    });
  }

  async getPause(profile: SettlementProfile): Promise<SettlementPauseRecord | null> {
    const ownedProfile = cloneSettlementProfile(profile);
    return this.#readTransaction(() => this.#readSettlementPause(ownedProfile));
  }

  async pause(candidate: SettlementPauseCandidate): Promise<SettlementPauseRecord> {
    assertSettlementPauseRecord(candidate);
    const owned = cloneSettlementPauseRecord(candidate);
    return this.#writeTransaction(() => {
      const existing = this.#readSettlementPause(owned.profile);
      if (existing !== null) {
        return existing;
      }
      this.#assertSettlementPauseOwnership(owned);
      this.#database
        .prepare(
          `INSERT INTO settlement_pauses (
            method, network, token_contract, reason, intent_id, submission_id,
            transaction_reference, original_block_hash, original_block_number,
            detected_at, observer_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          owned.profile.method,
          owned.profile.network,
          owned.profile.tokenContract,
          owned.reason,
          owned.intentId,
          owned.submissionId,
          owned.transactionReference,
          owned.originalInclusion.blockHash,
          owned.originalInclusion.blockNumber.toString(),
          owned.detectedAt,
          owned.observerVersion,
        );
      const stored = this.#readSettlementPause(owned.profile);
      if (stored === null) {
        throw new SettlementStoreCorruptionError("Settlement pause write was not retained");
      }
      return stored;
    });
  }

  async scheduleTerminalPayout(candidate: TerminalPayoutWatchCandidate): Promise<void> {
    const owned = cloneTerminalPayoutWatchCandidate(candidate);
    this.#writeTransaction(() => this.#scheduleTerminalPayout(owned));
  }

  async claimDuePayoutFinalityWatches(
    input: ClaimPayoutFinalityWatchesInput,
  ): Promise<readonly PayoutFinalityWatchLease[]> {
    assertClaimPayoutFinalityWatchesInput(input);
    return this.#writeTransaction(() => this.#claimDuePayoutFinalityWatches(input));
  }

  async completePayoutFinalityWatch(input: CompletePayoutFinalityWatchInput): Promise<void> {
    assertCompletePayoutFinalityWatchInput(input);
    this.#writeTransaction(() => {
      const result = this.#database
        .prepare(
          `UPDATE payout_finality_watches
           SET next_check_at = ?, consecutive_failures = 0, last_checked_at = ?,
               last_status = ?, lease_id = NULL, lease_expires_at = NULL
           WHERE intent_id = ? AND state = 'ACTIVE' AND lease_id = ?
             AND lease_expires_at > ?`,
        )
        .run(
          input.nextCheckAt,
          input.checkedAt,
          input.status,
          input.intentId,
          input.leaseId,
          input.checkedAt,
        );
      if (Number(result.changes) !== 1) {
        throw new PayoutFinalityJobIntegrityError("Payout finality watch lease is not active");
      }
    });
  }

  async retryPayoutFinalityWatch(input: RetryPayoutFinalityWatchInput): Promise<void> {
    assertRetryPayoutFinalityWatchInput(input);
    this.#writeTransaction(() => {
      const result = this.#database
        .prepare(
          `UPDATE payout_finality_watches
           SET next_check_at = ?, consecutive_failures = consecutive_failures + 1,
               last_checked_at = ?, last_status = ?, lease_id = NULL, lease_expires_at = NULL
           WHERE intent_id = ? AND state = 'ACTIVE' AND lease_id = ?
             AND lease_expires_at > ? AND consecutive_failures < ?`,
        )
        .run(
          input.nextCheckAt,
          input.checkedAt,
          input.status,
          input.intentId,
          input.leaseId,
          input.checkedAt,
          Number.MAX_SAFE_INTEGER,
        );
      if (Number(result.changes) !== 1) {
        throw new PayoutFinalityJobIntegrityError("Payout finality watch lease is not active");
      }
    });
  }

  async recordPayoutIncident(input: RecordPayoutIncidentInput): Promise<void> {
    assertRecordPayoutIncidentInput(input);
    const alert = clonePayoutIncidentAlert(input.alert);
    this.#writeTransaction(() => this.#recordPayoutIncident({ ...input, alert }));
  }

  async claimDuePayoutIncidentAlerts(
    input: ClaimPayoutIncidentAlertsInput,
  ): Promise<readonly PayoutIncidentAlertLease[]> {
    assertClaimPayoutIncidentAlertsInput(input);
    return this.#writeTransaction(() => this.#claimDuePayoutIncidentAlerts(input));
  }

  async completePayoutIncidentAlert(input: CompletePayoutIncidentAlertInput): Promise<void> {
    assertCompletePayoutIncidentAlertInput(input);
    this.#writeTransaction(() => {
      const result = this.#database
        .prepare(
          `UPDATE payout_incident_alerts
           SET state = 'DELIVERED', delivered_at = ?, lease_id = NULL, lease_expires_at = NULL
           WHERE alert_id = ? AND state = 'PENDING' AND lease_id = ?
             AND lease_expires_at > ?`,
        )
        .run(input.deliveredAt, input.alertId, input.leaseId, input.deliveredAt);
      if (Number(result.changes) !== 1) {
        throw new PayoutFinalityJobIntegrityError("Payout incident alert lease is not active");
      }
    });
  }

  async retryPayoutIncidentAlert(input: RetryPayoutIncidentAlertInput): Promise<void> {
    assertRetryPayoutIncidentAlertInput(input);
    this.#writeTransaction(() => {
      const result = this.#database
        .prepare(
          `UPDATE payout_incident_alerts
           SET delivery_attempts = delivery_attempts + 1, next_attempt_at = ?,
               lease_id = NULL, lease_expires_at = NULL
           WHERE alert_id = ? AND state = 'PENDING' AND lease_id = ?
             AND lease_expires_at > ? AND delivery_attempts < ?`,
        )
        .run(
          input.nextAttemptAt,
          input.alertId,
          input.leaseId,
          input.attemptedAt,
          Number.MAX_SAFE_INTEGER,
        );
      if (Number(result.changes) !== 1) {
        throw new PayoutFinalityJobIntegrityError("Payout incident alert lease is not active");
      }
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
      throw new SettlementStoreError("Unable to read settlement schema version");
    }
    let version = rowInteger(versionRow, "user_version");
    if (version === 0) {
      this.#writeTransaction(() => {
        this.#database.exec(SCHEMA_SQL);
        this.#database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
      version = SCHEMA_VERSION;
    }
    if (version === LEGACY_SCHEMA_VERSION) {
      throw new SettlementStoreError(
        "Settlement schema 1 contains payer bindings without note-bound attribution; operator migration is required",
      );
    }
    if (version === NOTE_BOUND_SCHEMA_VERSION) {
      this.#assertPayerBindingNoteConstraint();
      this.#writeTransaction(() => {
        this.#database.exec(SETTLEMENT_PAUSE_SCHEMA_SQL);
        this.#database.exec(`PRAGMA user_version = ${PAUSE_SCHEMA_VERSION}`);
      });
      version = PAUSE_SCHEMA_VERSION;
    }
    if (version === PAUSE_SCHEMA_VERSION) {
      this.#assertPayerBindingNoteConstraint();
      this.#assertSettlementPauseSchema();
      this.#writeTransaction(() => {
        this.#database.exec(PAYOUT_FINALITY_JOB_SCHEMA_SQL);
        this.#database.exec(
          `INSERT INTO payout_finality_watches (
             intent_id, state, next_check_at, consecutive_failures
           )
           SELECT intent_id, 'ACTIVE', 0, 0
           FROM settlement_intents
           WHERE state IN ('PAID', 'FAILED')`,
        );
        this.#database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
      version = SCHEMA_VERSION;
    }
    if (version !== SCHEMA_VERSION) {
      throw new SettlementStoreError(`Unsupported settlement schema version ${version}`);
    }
    const rows = this.#database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all();
    const tables = new Set(rows.map((row) => rowString(row, "name")));
    for (const table of REQUIRED_TABLES) {
      if (!tables.has(table)) {
        throw new SettlementStoreCorruptionError("Settlement schema is incomplete");
      }
    }
    this.#assertPayerBindingNoteConstraint();
    this.#assertSettlementPauseSchema();
    this.#assertPayoutFinalityJobSchema();
  }

  #assertPayerBindingNoteConstraint(): void {
    const tableColumns = this.#database
      .prepare("PRAGMA table_info(payer_binding_challenges)")
      .all()
      .map((row) => rowString(row, "name"));
    if (!tableColumns.includes("expected_note_reference")) {
      throw new SettlementStoreCorruptionError(
        "Settlement payer-binding schema is missing note attribution",
      );
    }

    const index = this.#database
      .prepare("PRAGMA index_list(payer_binding_challenges)")
      .all()
      .find((row) => rowString(row, "name") === PAYER_BINDING_NOTE_INDEX);
    if (index === undefined || !rowBoolean(index, "unique") || !rowBoolean(index, "partial")) {
      throw new SettlementStoreCorruptionError(
        "Settlement payer-binding note constraint is missing",
      );
    }
    const indexColumns = this.#database
      .prepare(`PRAGMA index_info(${PAYER_BINDING_NOTE_INDEX})`)
      .all()
      .map((row) => rowString(row, "name"));
    if (!isDeepStrictEqual(indexColumns, ["network", "pool_contract", "expected_note_reference"])) {
      throw new SettlementStoreCorruptionError(
        "Settlement payer-binding note constraint is malformed",
      );
    }
  }

  #assertSettlementPauseSchema(): void {
    const rows = this.#database.prepare("PRAGMA table_info(settlement_pauses)").all();
    const columns = rows.map((row) => rowString(row, "name"));
    if (!isDeepStrictEqual(columns, SETTLEMENT_PAUSE_COLUMNS)) {
      throw new SettlementStoreCorruptionError("Settlement pause schema is malformed");
    }
    const primaryKey = rows
      .filter((row) => rowInteger(row, "pk") > 0)
      .sort((left, right) => rowInteger(left, "pk") - rowInteger(right, "pk"))
      .map((row) => rowString(row, "name"));
    if (!isDeepStrictEqual(primaryKey, ["method", "network", "token_contract"])) {
      throw new SettlementStoreCorruptionError(
        "Settlement pause ownership constraint is malformed",
      );
    }
    const foreignKeys = this.#database.prepare("PRAGMA foreign_key_list(settlement_pauses)").all();
    const foreignKey = foreignKeys[0];
    if (
      foreignKeys.length !== 1 ||
      foreignKey === undefined ||
      rowString(foreignKey, "table") !== "settlement_intents" ||
      rowString(foreignKey, "from") !== "intent_id" ||
      rowString(foreignKey, "to") !== "intent_id" ||
      rowString(foreignKey, "on_delete") !== "RESTRICT"
    ) {
      throw new SettlementStoreCorruptionError("Settlement pause intent constraint is malformed");
    }
  }

  #assertPayoutFinalityJobSchema(): void {
    assertTableColumns(
      this.#database,
      "payout_finality_watches",
      PAYOUT_FINALITY_WATCH_COLUMNS,
      "Payout finality watch schema is malformed",
    );
    assertTableColumns(
      this.#database,
      "payout_incident_alerts",
      PAYOUT_INCIDENT_ALERT_COLUMNS,
      "Payout incident alert schema is malformed",
    );
    assertPrimaryKeyColumns(this.#database, "payout_finality_watches", ["intent_id"]);
    assertPrimaryKeyColumns(this.#database, "payout_incident_alerts", ["alert_id"]);
    const watchForeignKeys = this.#database
      .prepare("PRAGMA foreign_key_list(payout_finality_watches)")
      .all();
    if (
      watchForeignKeys.length !== 1 ||
      rowString(watchForeignKeys[0] ?? {}, "table") !== "settlement_intents" ||
      rowString(watchForeignKeys[0] ?? {}, "from") !== "intent_id" ||
      rowString(watchForeignKeys[0] ?? {}, "to") !== "intent_id" ||
      rowString(watchForeignKeys[0] ?? {}, "on_delete") !== "RESTRICT"
    ) {
      throw new SettlementStoreCorruptionError(
        "Payout finality watch intent constraint is malformed",
      );
    }
    const alertForeignKeys = this.#database
      .prepare("PRAGMA foreign_key_list(payout_incident_alerts)")
      .all()
      .filter((row) => rowString(row, "table") === "settlement_pauses")
      .sort((left, right) => rowInteger(left, "seq") - rowInteger(right, "seq"));
    const alertForeignKeyColumns = alertForeignKeys.map((row) => [
      rowString(row, "from"),
      rowString(row, "to"),
    ]);
    if (
      alertForeignKeys.length !== 3 ||
      !isDeepStrictEqual(alertForeignKeyColumns, [
        ["method", "method"],
        ["network", "network"],
        ["token_contract", "token_contract"],
      ]) ||
      alertForeignKeys.some((row) => rowString(row, "on_delete") !== "RESTRICT")
    ) {
      throw new SettlementStoreCorruptionError(
        "Payout incident alert pause constraint is malformed",
      );
    }
    assertIndexColumns(
      this.#database,
      "payout_finality_watches",
      "payout_finality_watch_due_index",
      ["state", "next_check_at", "lease_expires_at", "intent_id"],
      false,
    );
    assertIndexColumns(
      this.#database,
      "payout_incident_alerts",
      "payout_incident_alert_due_index",
      ["state", "next_attempt_at", "lease_expires_at", "alert_id"],
      false,
    );
    assertIndexColumns(
      this.#database,
      "payout_incident_alerts",
      "payout_incident_alert_profile_unique",
      ["method", "network", "token_contract"],
      true,
    );
  }

  #createOrGetFundingRequest(candidate: FundingRequestCandidate): FundingRequestRecord {
    const existing = this.#readFundingRequest(candidate.identity.paymentRequestId);
    if (existing !== null) {
      assertSameFundingRequest(existing.identity, candidate.identity);
      return existing;
    }
    this.#assertProfileActive({
      method: SETTLEMENT_METHOD,
      network: candidate.identity.network,
      tokenContract: candidate.identity.tokenContract,
    });
    if (candidate.identity.attributionProfile === "signed_payer") {
      if (candidate.identity.verifiedPayerBinding === undefined) {
        throw new SettlementStoreError("Signed-payer funding is missing its verified binding");
      }
      const durableBinding = verifiedPayerBindingFromRecord(
        this.#requiredPayerBinding(candidate.identity.paymentRequestId),
      );
      if (!isDeepStrictEqual(durableBinding, candidate.identity.verifiedPayerBinding)) {
        throw new SettlementStoreError(
          "Signed-payer funding does not match its durable verified binding",
        );
      }
    } else if (candidate.identity.verifiedPayerBinding !== undefined) {
      throw new SettlementStoreError("Quote-channel funding cannot contain a payer binding");
    }
    const created = createFundingRequestRecord(candidate);
    this.#database
      .prepare(
        `INSERT INTO funding_requests (
          payment_request_id, network, pool_contract, token_contract, amount_base_units,
          expires_at, attribution_profile, destination_json, finality_policy, payer_binding_json,
          state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        created.identity.paymentRequestId,
        created.identity.network,
        created.identity.poolContract,
        created.identity.tokenContract,
        created.identity.amountBaseUnits,
        created.identity.expiresAt,
        created.identity.attributionProfile,
        encodeJsonRecord(created.identity.destination, "funding destination"),
        created.identity.finalityPolicy,
        encodeVerifiedPayerBinding(created.identity.verifiedPayerBinding),
        created.state,
      );
    return cloneFundingRequestRecord(created);
  }

  #createOrGetPayerBinding(candidate: PayerBindingChallengeCandidate): PayerBindingChallengeRecord {
    const existing = this.#readPayerBinding(candidate.identity.paymentRequestId);
    if (existing !== null) {
      assertSamePayerBindingRequest(existing.identity, candidate.identity);
      return existing;
    }
    const ownerRow = this.#database
      .prepare("SELECT payment_request_id FROM payer_binding_challenges WHERE challenge_id = ?")
      .get(candidate.challengeId);
    if (ownerRow !== undefined) {
      throw new PayerBindingChallengeConflictError();
    }

    const created = createPayerBindingChallengeRecord(candidate);
    this.#database
      .prepare(
        `INSERT INTO payer_binding_challenges (
          payment_request_id, challenge_id, network, pool_contract, recipient_address,
          token_contract, expected_note_reference, amount_base_units, payer_address,
          funding_expires_at, challenge_expires_at, state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        created.identity.paymentRequestId,
        created.challengeId,
        created.identity.network,
        created.identity.poolContract,
        created.identity.recipientAddress,
        created.identity.tokenContract,
        created.identity.expectedNoteReference,
        created.identity.amountBaseUnits,
        created.identity.payerAddress,
        created.identity.fundingExpiresAt,
        created.identity.challengeExpiresAt,
        created.state,
      );
    return clonePayerBindingChallengeRecord(created);
  }

  #createOrGetIntent(candidate: SettlementIntentCandidate): SettlementIntentRecord {
    const quoteRow = this.#database
      .prepare("SELECT intent_id FROM settlement_intents WHERE quote_id = ?")
      .get(candidate.identity.quoteId);
    if (quoteRow !== undefined) {
      const existing = this.#requiredIntent(rowString(quoteRow, "intent_id"));
      assertSameIntent(existing.identity, candidate.identity);
      return existing;
    }
    const intentRow = this.#database
      .prepare("SELECT intent_id FROM settlement_intents WHERE intent_id = ?")
      .get(candidate.intentId);
    if (intentRow !== undefined) {
      throw new IntentIntegrityError("Intent ID is already bound to another payout");
    }
    this.#assertProfileActive({
      method: SETTLEMENT_METHOD,
      network: candidate.identity.network as StarknetNetwork,
      tokenContract: candidate.identity.tokenContract,
    });

    const created = createSettlementIntentRecord(candidate);
    this.#database
      .prepare(
        `INSERT INTO settlement_intents (
          intent_id, quote_id, network, token_contract, amount_base_units, expires_at,
          destination_json, state, transaction_references_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        created.intentId,
        created.identity.quoteId,
        created.identity.network,
        created.identity.tokenContract,
        created.identity.amountBaseUnits,
        created.identity.expiresAt,
        encodeJsonRecord(created.identity.destination, "payout destination"),
        created.state,
        encodeStringArray(created.transactionReferences, "transaction references"),
      );
    return cloneSettlementIntentRecord(created);
  }

  #readFundingRequest(paymentRequestId: string): FundingRequestRecord | null {
    const row = this.#database
      .prepare("SELECT * FROM funding_requests WHERE payment_request_id = ?")
      .get(paymentRequestId);
    if (row === undefined) {
      return null;
    }
    const evidenceRows = this.#database
      .prepare(
        `SELECT * FROM funding_evidence
         WHERE payment_request_id = ?
         ORDER BY first_observed_at, evidence_id`,
      )
      .all(paymentRequestId);
    const record = parseFundingRequest(row, evidenceRows);
    if (record.identity.verifiedPayerBinding !== undefined) {
      let durableBinding: VerifiedPayerBinding;
      try {
        durableBinding = verifiedPayerBindingFromRecord(
          this.#requiredPayerBinding(paymentRequestId),
        );
      } catch (error) {
        throw corruption("Signed-payer funding has no valid durable payer binding", error);
      }
      if (!isDeepStrictEqual(durableBinding, record.identity.verifiedPayerBinding)) {
        throw corruption("Signed-payer funding binding differs from its durable challenge");
      }
    }
    return record;
  }

  #requiredFundingRequest(paymentRequestId: string): FundingRequestRecord {
    const record = this.#readFundingRequest(paymentRequestId);
    if (record === null) {
      throw new SettlementStoreError("Funding request does not exist");
    }
    return record;
  }

  #readPayerBinding(paymentRequestId: string): PayerBindingChallengeRecord | null {
    const row = this.#database
      .prepare("SELECT * FROM payer_binding_challenges WHERE payment_request_id = ?")
      .get(paymentRequestId);
    return row === undefined ? null : parsePayerBinding(row);
  }

  #requiredPayerBinding(paymentRequestId: string): PayerBindingChallengeRecord {
    const record = this.#readPayerBinding(paymentRequestId);
    if (record === null) {
      throw new SettlementStoreError("Payer binding challenge does not exist");
    }
    return record;
  }

  #readEvidenceOwner(evidenceId: string): string | null {
    const row = this.#database
      .prepare("SELECT payment_request_id FROM funding_evidence WHERE evidence_id = ?")
      .get(evidenceId);
    return row === undefined ? null : rowString(row, "payment_request_id");
  }

  #writeFundingEvidence(record: FundingRequestRecord, evidenceId: string): void {
    const evidence = record.evidence.find(
      (candidate) => candidate.observation.evidence_id === evidenceId,
    );
    if (evidence === undefined) {
      throw new SettlementStoreError("Funding transition omitted its evidence record");
    }
    const observation = evidence.observation;
    this.#database
      .prepare(
        `INSERT INTO funding_evidence (
          evidence_id, payment_request_id, network, pool_contract, sender_address,
          recipient_address, token_contract, amount_base_units, attribution_profile,
          destination_json, block_hash, block_number,
          note_reference, transaction_reference, status, finality_policy, verifier_version,
          first_observed_at, last_observed_at, matches_request
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(evidence_id) DO UPDATE SET
          status = excluded.status,
          last_observed_at = excluded.last_observed_at
        WHERE funding_evidence.payment_request_id = excluded.payment_request_id`,
      )
      .run(
        observation.evidence_id,
        record.identity.paymentRequestId,
        observation.network,
        observation.pool_contract,
        observation.sender_address,
        observation.recipient_address,
        observation.token_contract,
        observation.amount_base_units.toString(),
        observation.attribution_profile,
        encodeJsonRecord(observation.destination, "evidence destination"),
        observation.block_hash,
        observation.block_number.toString(),
        observation.note_reference,
        observation.transaction_reference,
        observation.status,
        observation.finality_policy,
        observation.verifier_version,
        evidence.firstObservedAt,
        evidence.lastObservedAt,
        evidence.matchesRequest ? 1 : 0,
      );
  }

  #updateFundingRequest(record: FundingRequestRecord): void {
    const result = this.#database
      .prepare(
        `UPDATE funding_requests
         SET state = ?, accepted_evidence_id = ?, operator_reason = ?
         WHERE payment_request_id = ?`,
      )
      .run(
        record.state,
        record.acceptedEvidenceId ?? null,
        record.operatorReason ?? null,
        record.identity.paymentRequestId,
      );
    if (Number(result.changes) !== 1) {
      throw new SettlementStoreError("Funding request update did not affect one record");
    }
  }

  #updatePayerBinding(record: PayerBindingChallengeRecord): void {
    const verification = record.verification;
    const result = this.#database
      .prepare(
        `UPDATE payer_binding_challenges
         SET state = ?, message_hash = ?, block_hash = ?, block_number = ?,
             verifier_version = ?, verified_at = ?
         WHERE payment_request_id = ?`,
      )
      .run(
        record.state,
        verification?.messageHash ?? null,
        verification?.blockHash ?? null,
        verification?.blockNumber.toString() ?? null,
        verification?.verifierVersion ?? null,
        verification?.verifiedAt ?? null,
        record.identity.paymentRequestId,
      );
    if (Number(result.changes) !== 1) {
      throw new SettlementStoreError("Payer binding update did not affect one record");
    }
  }

  #requiredIntent(intentId: string): SettlementIntentRecord {
    const row = this.#database
      .prepare("SELECT * FROM settlement_intents WHERE intent_id = ?")
      .get(intentId);
    if (row === undefined) {
      throw new IntentIntegrityError("Settlement intent does not exist");
    }
    return parseSettlementIntent(row);
  }

  #updateIntent(record: SettlementIntentRecord): void {
    const result = this.#database
      .prepare(
        `UPDATE settlement_intents
         SET state = ?, submission_id = ?, transaction_references_json = ?
         WHERE intent_id = ?`,
      )
      .run(
        record.state,
        record.submissionId ?? null,
        encodeStringArray(record.transactionReferences, "transaction references"),
        record.intentId,
      );
    if (Number(result.changes) !== 1) {
      throw new SettlementStoreError("Settlement intent update did not affect one record");
    }
  }

  #readSettlementPause(profile: SettlementProfile): SettlementPauseRecord | null {
    const row = this.#database
      .prepare(
        `SELECT * FROM settlement_pauses
         WHERE method = ? AND network = ? AND token_contract = ?`,
      )
      .get(profile.method, profile.network, profile.tokenContract);
    return row === undefined ? null : parseSettlementPause(row);
  }

  #assertProfileActive(profile: SettlementProfile): void {
    const owned = cloneSettlementProfile(profile);
    if (this.#readSettlementPause(owned) !== null) {
      throw new SettlementProfilePausedError();
    }
  }

  #scheduleTerminalPayout(candidateValue: TerminalPayoutWatchCandidate): void {
    const candidate = cloneTerminalPayoutWatchCandidate(candidateValue);
    const intent = this.#requiredIntent(candidate.intentId);
    if (
      (intent.state !== "PAID" && intent.state !== "FAILED") ||
      intent.identity.quoteId !== candidate.quoteId ||
      intent.identity.network !== candidate.profile.network ||
      intent.identity.tokenContract !== candidate.profile.tokenContract
    ) {
      throw new PayoutFinalityJobIntegrityError(
        "Terminal payout watch does not match a terminal settlement intent",
      );
    }
    const existing = this.#database
      .prepare(
        `SELECT w.intent_id, i.quote_id, i.network, i.token_contract
         FROM payout_finality_watches AS w
         JOIN settlement_intents AS i ON i.intent_id = w.intent_id
         WHERE w.intent_id = ?`,
      )
      .get(candidate.intentId);
    if (existing !== undefined) {
      if (
        rowString(existing, "quote_id") !== candidate.quoteId ||
        rowNetwork(existing, "network") !== candidate.profile.network ||
        rowStoredAddress(existing, "token_contract") !== candidate.profile.tokenContract
      ) {
        throw new PayoutFinalityJobIntegrityError(
          "Terminal payout watch conflicts with an existing intent",
        );
      }
      return;
    }
    this.#database
      .prepare(
        `INSERT INTO payout_finality_watches (
          intent_id, state, next_check_at, consecutive_failures
        ) VALUES (?, 'ACTIVE', ?, 0)`,
      )
      .run(candidate.intentId, candidate.nextCheckAt);
  }

  #claimDuePayoutFinalityWatches(
    input: ClaimPayoutFinalityWatchesInput,
  ): readonly PayoutFinalityWatchLease[] {
    const rows = this.#database
      .prepare(
        `SELECT w.intent_id, w.next_check_at, w.consecutive_failures,
                i.quote_id, i.network, i.token_contract
         FROM payout_finality_watches AS w
         JOIN settlement_intents AS i ON i.intent_id = w.intent_id
         WHERE w.state = 'ACTIVE' AND w.next_check_at <= ?
           AND (w.lease_expires_at IS NULL OR w.lease_expires_at <= ?)
         ORDER BY w.next_check_at, w.intent_id
         LIMIT ?`,
      )
      .all(input.now, input.now, input.limit);
    return rows.map((row) => {
      const intentId = rowString(row, "intent_id");
      const result = this.#database
        .prepare(
          `UPDATE payout_finality_watches
           SET lease_id = ?, lease_expires_at = ?
           WHERE intent_id = ? AND state = 'ACTIVE' AND next_check_at <= ?
             AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
        )
        .run(input.leaseId, input.leaseExpiresAt, intentId, input.now, input.now);
      if (Number(result.changes) !== 1) {
        throw new SettlementStoreCorruptionError(
          "Payout finality watch claim lost transactional ownership",
        );
      }
      try {
        return clonePayoutFinalityWatchLease({
          intentId,
          quoteId: rowString(row, "quote_id"),
          profile: {
            method: SETTLEMENT_METHOD,
            network: rowNetwork(row, "network"),
            tokenContract: rowStoredAddress(row, "token_contract"),
          },
          nextCheckAt: rowNonNegativeInteger(row, "next_check_at"),
          leaseId: input.leaseId,
          leaseExpiresAt: input.leaseExpiresAt,
          consecutiveFailures: rowNonNegativeInteger(row, "consecutive_failures"),
        });
      } catch (error) {
        if (error instanceof SettlementStoreCorruptionError) {
          throw error;
        }
        throw corruption("Payout finality watch violates its storage invariants", error);
      }
    });
  }

  #recordPayoutIncident(input: RecordPayoutIncidentInput): void {
    const alert = clonePayoutIncidentAlert(input.alert);
    if (alert.pause.intentId !== input.intentId) {
      throw new PayoutFinalityJobIntegrityError(
        "Payout incident alert does not match its terminal watch",
      );
    }
    const storedPause = this.#readSettlementPause(alert.pause.profile);
    if (storedPause === null || !isDeepStrictEqual(storedPause, alert.pause)) {
      throw new PayoutFinalityJobIntegrityError(
        "Payout incident alert does not match the durable profile pause",
      );
    }
    const existing = this.#database
      .prepare(
        `SELECT alert_id FROM payout_incident_alerts
         WHERE alert_id = ? OR (method = ? AND network = ? AND token_contract = ?)
         LIMIT 1`,
      )
      .get(
        alert.alertId,
        alert.pause.profile.method,
        alert.pause.profile.network,
        alert.pause.profile.tokenContract,
      );
    if (existing !== undefined && rowString(existing, "alert_id") !== alert.alertId) {
      throw new PayoutFinalityJobIntegrityError(
        "Payout incident profile is already assigned to another alert",
      );
    }
    if (existing === undefined) {
      this.#database
        .prepare(
          `INSERT INTO payout_incident_alerts (
            alert_id, method, network, token_contract, state, delivery_attempts,
            next_attempt_at, created_at
          ) VALUES (?, ?, ?, ?, 'PENDING', 0, ?, ?)`,
        )
        .run(
          alert.alertId,
          alert.pause.profile.method,
          alert.pause.profile.network,
          alert.pause.profile.tokenContract,
          input.checkedAt,
          input.checkedAt,
        );
    }
    const status = alert.pause.reason === "PAYOUT_FINALITY_REORGED" ? "REORGED" : "CONFLICTED";
    const result = this.#database
      .prepare(
        `UPDATE payout_finality_watches
         SET state = 'INCIDENT', next_check_at = NULL, last_checked_at = ?, last_status = ?,
             lease_id = NULL, lease_expires_at = NULL
         WHERE intent_id = ? AND state = 'ACTIVE' AND lease_id = ?
           AND lease_expires_at > ?`,
      )
      .run(input.checkedAt, status, input.intentId, input.leaseId, input.checkedAt);
    if (Number(result.changes) !== 1) {
      throw new PayoutFinalityJobIntegrityError("Payout finality watch lease is not active");
    }
  }

  #claimDuePayoutIncidentAlerts(
    input: ClaimPayoutIncidentAlertsInput,
  ): readonly PayoutIncidentAlertLease[] {
    const rows = this.#database
      .prepare(
        `SELECT a.alert_id, a.delivery_attempts, a.next_attempt_at,
                p.method, p.network, p.token_contract, p.reason, p.intent_id, p.submission_id,
                p.transaction_reference, p.original_block_hash, p.original_block_number,
                p.detected_at, p.observer_version
         FROM payout_incident_alerts AS a
         JOIN settlement_pauses AS p
           ON p.method = a.method AND p.network = a.network
          AND p.token_contract = a.token_contract
         WHERE a.state = 'PENDING' AND a.next_attempt_at <= ?
           AND (a.lease_expires_at IS NULL OR a.lease_expires_at <= ?)
         ORDER BY a.next_attempt_at, a.alert_id
         LIMIT ?`,
      )
      .all(input.now, input.now, input.limit);
    return rows.map((row) => {
      const alertId = rowString(row, "alert_id");
      const result = this.#database
        .prepare(
          `UPDATE payout_incident_alerts
           SET lease_id = ?, lease_expires_at = ?
           WHERE alert_id = ? AND state = 'PENDING' AND next_attempt_at <= ?
             AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
        )
        .run(input.leaseId, input.leaseExpiresAt, alertId, input.now, input.now);
      if (Number(result.changes) !== 1) {
        throw new SettlementStoreCorruptionError(
          "Payout incident alert claim lost transactional ownership",
        );
      }
      try {
        return clonePayoutIncidentAlertLease({
          alertId,
          pause: parseSettlementPause(row),
          leaseId: input.leaseId,
          leaseExpiresAt: input.leaseExpiresAt,
          deliveryAttempts: rowNonNegativeInteger(row, "delivery_attempts"),
          nextAttemptAt: rowNonNegativeInteger(row, "next_attempt_at"),
        });
      } catch (error) {
        if (error instanceof SettlementStoreCorruptionError) {
          throw error;
        }
        throw corruption("Payout incident alert violates its storage invariants", error);
      }
    });
  }

  #assertSettlementPauseOwnership(candidate: SettlementPauseCandidate): void {
    const intent = this.#requiredIntent(candidate.intentId);
    if (
      (intent.state !== "PAID" && intent.state !== "FAILED") ||
      intent.identity.network !== candidate.profile.network ||
      intent.identity.tokenContract !== candidate.profile.tokenContract ||
      intent.submissionId !== candidate.submissionId ||
      intent.transactionReferences.length !== 1 ||
      intent.transactionReferences[0] !== candidate.transactionReference
    ) {
      throw new SettlementStoreError(
        "Settlement pause does not match one terminal payout transaction",
      );
    }
  }

  #readTransaction<T>(operation: () => T): T {
    return this.#transaction("BEGIN", operation);
  }

  #writeTransaction<T>(operation: () => T): T {
    return this.#transaction("BEGIN IMMEDIATE", operation);
  }

  #transaction<T>(begin: "BEGIN" | "BEGIN IMMEDIATE", operation: () => T): T {
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
          "Settlement operation and rollback both failed",
        );
      }
      throw error;
    }
  }
}

function parseSettlementPause(row: Record<string, unknown>): SettlementPauseRecord {
  try {
    const record: SettlementPauseRecord = {
      profile: {
        method: rowString(row, "method") as "strk20",
        network: rowNetwork(row, "network"),
        tokenContract: rowStoredAddress(row, "token_contract"),
      },
      reason: rowString(row, "reason") as SettlementPauseRecord["reason"],
      intentId: rowString(row, "intent_id"),
      submissionId: rowString(row, "submission_id"),
      transactionReference: rowStoredFelt(row, "transaction_reference"),
      originalInclusion: {
        blockHash: rowStoredFelt(row, "original_block_hash"),
        blockNumber: BigInt(rowNonNegativeDecimal(row, "original_block_number")),
      },
      detectedAt: rowString(row, "detected_at"),
      observerVersion: rowString(row, "observer_version"),
    };
    assertSettlementPauseRecord(record);
    return cloneSettlementPauseRecord(record);
  } catch (error) {
    throw corruption("Settlement pause row is invalid", error);
  }
}

function parseFundingRequest(
  row: Record<string, unknown>,
  evidenceRows: readonly Record<string, unknown>[],
): FundingRequestRecord {
  const paymentRequestId = rowString(row, "payment_request_id");
  const evidence = evidenceRows.map((evidenceRow) => parseFundingEvidence(evidenceRow));
  const acceptedEvidenceId = rowOptionalString(row, "accepted_evidence_id");
  const operatorReason = rowOptionalString(row, "operator_reason");
  const record: FundingRequestRecord = {
    identity: {
      paymentRequestId,
      network: rowNetwork(row, "network"),
      poolContract: rowStoredAddress(row, "pool_contract"),
      tokenContract: rowStoredAddress(row, "token_contract"),
      amountBaseUnits: rowPositiveDecimal(row, "amount_base_units"),
      expiresAt: rowPositiveInteger(row, "expires_at"),
      attributionProfile: rowAttributionProfile(row, "attribution_profile"),
      destination: rowJsonRecord(row, "destination_json"),
      finalityPolicy: rowString(row, "finality_policy"),
      ...readVerifiedPayerBinding(row, "payer_binding_json"),
    },
    state: rowIncomingState(row, "state"),
    evidence,
    ...(acceptedEvidenceId === null ? {} : { acceptedEvidenceId }),
    ...(operatorReason === null ? {} : { operatorReason }),
  };

  const payerBinding = record.identity.verifiedPayerBinding;
  if (
    (record.identity.attributionProfile === "signed_payer" && payerBinding === undefined) ||
    (record.identity.attributionProfile === "quote_channel" && payerBinding !== undefined)
  ) {
    throw corruption("Funding attribution profile and payer binding disagree");
  }
  if (
    payerBinding !== undefined &&
    (payerBinding.paymentRequestId !== paymentRequestId ||
      payerBinding.network !== record.identity.network ||
      payerBinding.poolContract !== record.identity.poolContract ||
      payerBinding.tokenContract !== record.identity.tokenContract ||
      payerBinding.amountBaseUnits.toString() !== record.identity.amountBaseUnits ||
      payerBinding.fundingExpiresAt !== record.identity.expiresAt)
  ) {
    throw corruption("Verified payer binding does not match its funding request");
  }

  for (const item of evidence) {
    if (item.observation.payment_request_id !== paymentRequestId) {
      throw corruption("Funding evidence belongs to another request");
    }
  }
  if (record.state === "OBSERVED" || record.state === "PAID") {
    if (record.acceptedEvidenceId === undefined) {
      throw corruption("Funding state requires accepted evidence");
    }
  }
  if (record.acceptedEvidenceId !== undefined) {
    const accepted = evidence.find(
      (item) => item.observation.evidence_id === record.acceptedEvidenceId,
    );
    if (accepted === undefined || !accepted.matchesRequest) {
      throw corruption("Accepted funding evidence is missing or mismatched");
    }
    if (record.state === "PAID" && accepted.observation.status !== "FINAL") {
      throw corruption("Paid funding evidence is not final");
    }
  }
  if (record.state === "OPERATOR_REQUIRED" && record.operatorReason === undefined) {
    throw corruption("Operator-required funding is missing its reason");
  }
  if (record.state !== "OPERATOR_REQUIRED" && record.operatorReason !== undefined) {
    throw corruption("Funding operator reason exists outside operator-required state");
  }
  for (const item of evidence) {
    if (item.matchesRequest && !evidenceMatchesRequest(record, item.observation)) {
      throw corruption("Matching funding evidence does not match its request");
    }
  }
  return cloneFundingRequestRecord(record);
}

function parseFundingEvidence(row: Record<string, unknown>): FundingEvidenceRecord {
  const firstObservedAt = rowPositiveInteger(row, "first_observed_at");
  const lastObservedAt = rowPositiveInteger(row, "last_observed_at");
  if (lastObservedAt < firstObservedAt) {
    throw corruption("Funding evidence timestamps are inconsistent");
  }
  return {
    observation: {
      network: rowNetwork(row, "network"),
      pool_contract: rowStoredAddress(row, "pool_contract"),
      sender_address: rowStoredAddress(row, "sender_address"),
      recipient_address: rowStoredAddress(row, "recipient_address"),
      token_contract: rowStoredAddress(row, "token_contract"),
      amount_base_units: BigInt(rowPositiveDecimal(row, "amount_base_units")),
      payment_request_id: rowString(row, "payment_request_id"),
      attribution_profile: rowAttributionProfile(row, "attribution_profile"),
      destination: rowJsonRecord(row, "destination_json"),
      evidence_id: rowString(row, "evidence_id"),
      note_reference: rowString(row, "note_reference"),
      transaction_reference: rowString(row, "transaction_reference"),
      block_hash: rowString(row, "block_hash"),
      block_number: BigInt(rowNonNegativeDecimal(row, "block_number")),
      status: rowObservationStatus(row, "status"),
      finality_policy: rowString(row, "finality_policy"),
      verifier_version: rowString(row, "verifier_version"),
    },
    firstObservedAt,
    lastObservedAt,
    matchesRequest: rowBoolean(row, "matches_request"),
  };
}

function parsePayerBinding(row: Record<string, unknown>): PayerBindingChallengeRecord {
  try {
    return parsePayerBindingRecord(row);
  } catch (error) {
    if (error instanceof SettlementStoreCorruptionError) {
      throw error;
    }
    throw corruption("Payer binding record violates domain invariants", error);
  }
}

function parsePayerBindingRecord(row: Record<string, unknown>): PayerBindingChallengeRecord {
  const candidate: PayerBindingChallengeCandidate = {
    identity: {
      paymentRequestId: rowString(row, "payment_request_id"),
      network: rowNetwork(row, "network"),
      poolContract: rowString(row, "pool_contract"),
      recipientAddress: rowString(row, "recipient_address"),
      tokenContract: rowString(row, "token_contract"),
      expectedNoteReference: rowString(row, "expected_note_reference"),
      amountBaseUnits: rowPositiveDecimal(row, "amount_base_units"),
      payerAddress: rowString(row, "payer_address"),
      fundingExpiresAt: rowPositiveInteger(row, "funding_expires_at"),
      challengeExpiresAt: rowPositiveInteger(row, "challenge_expires_at"),
    },
    challengeId: rowString(row, "challenge_id"),
  };
  let record = createPayerBindingChallengeRecord(candidate);
  const state = rowPayerBindingState(row, "state");
  if (state === "VERIFIED") {
    const messageHash = rowOptionalString(row, "message_hash");
    const blockHash = rowOptionalString(row, "block_hash");
    const blockNumber = rowOptionalNonNegativeDecimal(row, "block_number");
    const verifierVersion = rowOptionalString(row, "verifier_version");
    const verifiedAt = rowOptionalPositiveInteger(row, "verified_at");
    if (
      messageHash === null ||
      blockHash === null ||
      blockNumber === null ||
      verifierVersion === null ||
      verifiedAt === null
    ) {
      throw corruption("Verified payer binding is missing verification evidence");
    }
    record = applyPayerBindingVerification(record, {
      paymentRequestId: candidate.identity.paymentRequestId,
      challengeId: candidate.challengeId,
      verification: {
        messageHash,
        blockHash,
        blockNumber: BigInt(blockNumber),
        verifierVersion,
        verifiedAt,
      },
    });
  } else {
    if (
      rowOptionalString(row, "message_hash") !== null ||
      rowOptionalString(row, "block_hash") !== null ||
      rowOptionalNonNegativeDecimal(row, "block_number") !== null ||
      rowOptionalString(row, "verifier_version") !== null ||
      rowOptionalPositiveInteger(row, "verified_at") !== null
    ) {
      throw corruption("Unverified payer binding contains verification evidence");
    }
    if (state === "EXPIRED") {
      record = expirePayerBindingChallenge(record, record.identity.challengeExpiresAt);
    }
  }
  return clonePayerBindingChallengeRecord(record);
}

function parseSettlementIntent(row: Record<string, unknown>): SettlementIntentRecord {
  const submissionId = rowOptionalString(row, "submission_id");
  const record: SettlementIntentRecord = {
    intentId: rowString(row, "intent_id"),
    identity: {
      quoteId: rowString(row, "quote_id"),
      network: rowString(row, "network"),
      tokenContract: rowString(row, "token_contract"),
      amountBaseUnits: rowPositiveDecimal(row, "amount_base_units"),
      expiresAt: rowPositiveInteger(row, "expires_at"),
      destination: rowJsonRecord(row, "destination_json"),
    },
    state: rowIntentState(row, "state"),
    ...(submissionId === null ? {} : { submissionId }),
    transactionReferences: rowStringArray(row, "transaction_references_json"),
  };
  if (
    record.state !== "INTENT_RECORDED" &&
    record.state !== "OPERATOR_REQUIRED" &&
    record.submissionId === undefined
  ) {
    throw corruption("Advanced payout state is missing its submission ID");
  }
  if (new Set(record.transactionReferences).size !== record.transactionReferences.length) {
    throw corruption("Payout transaction references contain duplicates");
  }
  return cloneSettlementIntentRecord(record);
}

function evidenceMatchesRequest(
  record: FundingRequestRecord,
  observation: PaymentObservation,
): boolean {
  return (
    observation.payment_request_id === record.identity.paymentRequestId &&
    observation.network === record.identity.network &&
    observation.pool_contract === record.identity.poolContract &&
    observation.token_contract === record.identity.tokenContract &&
    observation.amount_base_units.toString() === record.identity.amountBaseUnits &&
    observation.attribution_profile === record.identity.attributionProfile &&
    (record.identity.verifiedPayerBinding === undefined ||
      (observation.sender_address === record.identity.verifiedPayerBinding.payerAddress &&
        observation.recipient_address === record.identity.verifiedPayerBinding.recipientAddress &&
        observation.note_reference ===
          record.identity.verifiedPayerBinding.expectedNoteReference)) &&
    isDeepStrictEqual(observation.destination, record.identity.destination) &&
    observation.finality_policy === record.identity.finalityPolicy
  );
}

function rowStoredAddress(row: Record<string, unknown>, key: string): string {
  const value = rowString(row, key);
  if (value.length > MAX_STARKNET_HEX_TEXT_LENGTH || !/^0x[0-9a-f]+$/.test(value)) {
    throw corruption(`Settlement column ${key} is not a canonical Starknet address`);
  }
  const address = BigInt(value);
  if (
    address === 0n ||
    address >= STARKNET_ADDRESS_BOUND ||
    value !== `0x${address.toString(16)}`
  ) {
    throw corruption(`Settlement column ${key} is not a canonical Starknet address`);
  }
  return value;
}

function rowStoredFelt(row: Record<string, unknown>, key: string): string {
  const value = rowString(row, key);
  if (value.length > MAX_STARKNET_HEX_TEXT_LENGTH || !/^0x[0-9a-f]+$/.test(value)) {
    throw corruption(`Settlement column ${key} is not a canonical Starknet felt`);
  }
  const felt = BigInt(value);
  if (felt === 0n || felt >= STARK_FIELD_PRIME || value !== `0x${felt.toString(16)}`) {
    throw corruption(`Settlement column ${key} is not a canonical Starknet felt`);
  }
  return value;
}

function encodeJsonRecord(value: Readonly<Record<string, unknown>>, label: string): string {
  try {
    const encoded = JSON.stringify(value);
    const decoded: unknown = JSON.parse(encoded);
    if (!isPlainRecord(decoded) || !isDeepStrictEqual(decoded, value)) {
      throw new Error("JSON round trip changed the value");
    }
    return encoded;
  } catch (error) {
    throw new SettlementStoreError(`${label} is not losslessly JSON serializable`, {
      cause: error,
    });
  }
}

function encodeStringArray(value: readonly string[], label: string): string {
  const items = Array.from(value);
  if (items.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new SettlementStoreError(`${label} contains an invalid identifier`);
  }
  return JSON.stringify(items);
}

function encodeVerifiedPayerBinding(binding: VerifiedPayerBinding | undefined): string | null {
  if (binding === undefined) {
    return null;
  }
  return encodeJsonRecord(
    {
      ...binding,
      amountBaseUnits: binding.amountBaseUnits.toString(),
      blockNumber: binding.blockNumber.toString(),
    },
    "verified payer binding",
  );
}

function readVerifiedPayerBinding(
  row: Record<string, unknown>,
  key: string,
): { readonly verifiedPayerBinding?: VerifiedPayerBinding } {
  const encoded = rowOptionalString(row, key);
  if (encoded === null) {
    return {};
  }
  const value = parseJson(encoded, key);
  if (!isPlainRecord(value)) {
    throw corruption(`Settlement column ${key} is not a payer binding object`);
  }
  try {
    const candidate: PayerBindingChallengeCandidate = {
      identity: {
        paymentRequestId: rowString(value, "paymentRequestId"),
        network: rowNetwork(value, "network"),
        poolContract: rowString(value, "poolContract"),
        recipientAddress: rowString(value, "recipientAddress"),
        tokenContract: rowString(value, "tokenContract"),
        expectedNoteReference: rowString(value, "expectedNoteReference"),
        amountBaseUnits: rowPositiveDecimal(value, "amountBaseUnits"),
        payerAddress: rowString(value, "payerAddress"),
        fundingExpiresAt: rowPositiveInteger(value, "fundingExpiresAt"),
        challengeExpiresAt: rowPositiveInteger(value, "challengeExpiresAt"),
      },
      challengeId: rowString(value, "challengeId"),
    };
    const record = applyPayerBindingVerification(createPayerBindingChallengeRecord(candidate), {
      paymentRequestId: candidate.identity.paymentRequestId,
      challengeId: candidate.challengeId,
      verification: {
        messageHash: rowString(value, "messageHash"),
        blockHash: rowString(value, "blockHash"),
        blockNumber: BigInt(rowNonNegativeDecimal(value, "blockNumber")),
        verifierVersion: rowString(value, "verifierVersion"),
        verifiedAt: rowPositiveInteger(value, "verifiedAt"),
      },
    });
    if (record.identity.network !== "SN_SEPOLIA" || record.verification === undefined) {
      throw new Error("Verified payer binding has invalid state");
    }
    return {
      verifiedPayerBinding: {
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
      },
    };
  } catch (error) {
    if (error instanceof SettlementStoreCorruptionError) {
      throw error;
    }
    throw corruption("Verified payer binding violates domain invariants", error);
  }
}

function rowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw corruption(`Settlement column ${key} is not a non-empty string`);
  }
  return value;
}

function rowOptionalString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null) {
    return null;
  }
  return rowString(row, key);
}

function rowOptionalPositiveInteger(row: Record<string, unknown>, key: string): number | null {
  if (row[key] === null) {
    return null;
  }
  return rowPositiveInteger(row, key);
}

function rowInteger(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw corruption(`Settlement column ${key} is not a safe integer`);
  }
  return value;
}

function rowPositiveInteger(row: Record<string, unknown>, key: string): number {
  const value = rowInteger(row, key);
  if (value <= 0) {
    throw corruption(`Settlement column ${key} is not positive`);
  }
  return value;
}

function rowNonNegativeInteger(row: Record<string, unknown>, key: string): number {
  const value = rowInteger(row, key);
  if (value < 0) {
    throw corruption(`Settlement column ${key} is negative`);
  }
  return value;
}

function rowBoolean(row: Record<string, unknown>, key: string): boolean {
  const value = rowInteger(row, key);
  if (value !== 0 && value !== 1) {
    throw corruption(`Settlement column ${key} is not boolean`);
  }
  return value === 1;
}

function rowPositiveDecimal(row: Record<string, unknown>, key: string): string {
  const value = rowString(row, key);
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw corruption(`Settlement column ${key} is not a positive decimal`);
  }
  return value;
}

function rowNonNegativeDecimal(row: Record<string, unknown>, key: string): string {
  const value = rowString(row, key);
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw corruption(`Settlement column ${key} is not a non-negative decimal`);
  }
  return value;
}

function rowOptionalNonNegativeDecimal(row: Record<string, unknown>, key: string): string | null {
  if (row[key] === null) {
    return null;
  }
  return rowNonNegativeDecimal(row, key);
}

function rowJsonRecord(
  row: Record<string, unknown>,
  key: string,
): Readonly<Record<string, unknown>> {
  const value = parseJson(rowString(row, key), key);
  if (!isPlainRecord(value)) {
    throw corruption(`Settlement column ${key} is not a JSON object`);
  }
  return value;
}

function rowStringArray(row: Record<string, unknown>, key: string): readonly string[] {
  const value = parseJson(rowString(row, key), key);
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    throw corruption(`Settlement column ${key} is not an identifier array`);
  }
  return [...value];
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw corruption(`Settlement column ${label} contains invalid JSON`, error);
  }
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function rowNetwork(row: Record<string, unknown>, key: string): StarknetNetwork {
  const value = rowString(row, key);
  if (!STARKNET_NETWORKS.includes(value as StarknetNetwork)) {
    throw corruption(`Settlement column ${key} is not a Starknet network`);
  }
  return value as StarknetNetwork;
}

function rowAttributionProfile(row: Record<string, unknown>, key: string): AttributionProfile {
  const value = rowString(row, key);
  if (!ATTRIBUTION_PROFILES.includes(value as AttributionProfile)) {
    throw corruption(`Settlement column ${key} is not an attribution profile`);
  }
  return value as AttributionProfile;
}

function rowIncomingState(row: Record<string, unknown>, key: string): IncomingState {
  const value = rowString(row, key);
  if (!INCOMING_STATES.includes(value as IncomingState)) {
    throw corruption(`Settlement column ${key} is not an incoming state`);
  }
  return value as IncomingState;
}

function rowObservationStatus(row: Record<string, unknown>, key: string): PaymentObservationStatus {
  const value = rowString(row, key);
  if (!PAYMENT_OBSERVATION_STATUSES.includes(value as PaymentObservationStatus)) {
    throw corruption(`Settlement column ${key} is not an observation status`);
  }
  return value as PaymentObservationStatus;
}

function rowIntentState(row: Record<string, unknown>, key: string): SettlementIntentState {
  const value = rowString(row, key);
  if (!SETTLEMENT_INTENT_STATES.includes(value as SettlementIntentState)) {
    throw corruption(`Settlement column ${key} is not a payout state`);
  }
  return value as SettlementIntentState;
}

function rowPayerBindingState(
  row: Record<string, unknown>,
  key: string,
): PayerBindingChallengeState {
  const value = rowString(row, key);
  if (!PAYER_BINDING_CHALLENGE_STATES.includes(value as PayerBindingChallengeState)) {
    throw corruption(`Settlement column ${key} is not a payer binding state`);
  }
  return value as PayerBindingChallengeState;
}

function assertTableColumns(
  database: DatabaseSync,
  table: string,
  expected: readonly string[],
  message: string,
): void {
  const columns = database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => rowString(row, "name"));
  if (!isDeepStrictEqual(columns, expected)) {
    throw new SettlementStoreCorruptionError(message);
  }
}

function assertIndexColumns(
  database: DatabaseSync,
  table: string,
  index: string,
  expected: readonly string[],
  unique: boolean,
): void {
  const metadata = database
    .prepare(`PRAGMA index_list(${table})`)
    .all()
    .find((row) => rowString(row, "name") === index);
  if (metadata === undefined || rowBoolean(metadata, "unique") !== unique) {
    throw new SettlementStoreCorruptionError("Payout finality job index is missing");
  }
  const columns = database
    .prepare(`PRAGMA index_info(${index})`)
    .all()
    .map((row) => rowString(row, "name"));
  if (!isDeepStrictEqual(columns, expected)) {
    throw new SettlementStoreCorruptionError("Payout finality job index is malformed");
  }
}

function assertPrimaryKeyColumns(
  database: DatabaseSync,
  table: string,
  expected: readonly string[],
): void {
  const primaryKey = database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .filter((row) => rowInteger(row, "pk") > 0)
    .sort((left, right) => rowInteger(left, "pk") - rowInteger(right, "pk"))
    .map((row) => rowString(row, "name"));
  if (!isDeepStrictEqual(primaryKey, expected)) {
    throw new SettlementStoreCorruptionError(
      "Payout finality job ownership constraint is malformed",
    );
  }
}

function corruption(message: string, cause?: unknown): SettlementStoreCorruptionError {
  return new SettlementStoreCorruptionError(message, cause === undefined ? {} : { cause });
}

function prepareDatabaseFile(path: string): void {
  if (path === SQLITE_MEMORY_PATH) {
    return;
  }
  if (path.trim().length === 0 || path.startsWith("file:")) {
    throw new SettlementStoreError("SQLite database path is invalid");
  }
  const descriptor = openSync(path, "a", 0o600);
  closeSync(descriptor);
  chmodSync(path, 0o600);
}

const LEGACY_SCHEMA_VERSION = 1;
const NOTE_BOUND_SCHEMA_VERSION = 2;
const PAUSE_SCHEMA_VERSION = 3;
const SCHEMA_VERSION = 4;
const PAYER_BINDING_NOTE_INDEX = "verified_payer_note_reference_unique";
const SQLITE_MEMORY_PATH = ":memory:";
const DEFAULT_BUSY_TIMEOUT_MILLISECONDS = 5_000;
const MAX_BUSY_TIMEOUT_MILLISECONDS = 60_000;
const MAX_STARKNET_HEX_TEXT_LENGTH = 66;
const STARKNET_ADDRESS_BOUND = (1n << 251n) - 256n;
const STARK_FIELD_PRIME = (1n << 251n) + (17n << 192n) + 1n;
const REQUIRED_TABLES = [
  "funding_requests",
  "funding_evidence",
  "payer_binding_challenges",
  "settlement_intents",
  "settlement_pauses",
  "payout_finality_watches",
  "payout_incident_alerts",
] as const;

const SETTLEMENT_PAUSE_COLUMNS = [
  "method",
  "network",
  "token_contract",
  "reason",
  "intent_id",
  "submission_id",
  "transaction_reference",
  "original_block_hash",
  "original_block_number",
  "detected_at",
  "observer_version",
] as const;

const SETTLEMENT_PAUSE_SCHEMA_SQL = `
  CREATE TABLE settlement_pauses (
    method TEXT NOT NULL CHECK (method = 'strk20'),
    network TEXT NOT NULL CHECK (network IN ('SN_SEPOLIA', 'SN_MAIN')),
    token_contract TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (
      reason IN ('PAYOUT_FINALITY_CONFLICTED', 'PAYOUT_FINALITY_REORGED')
    ),
    intent_id TEXT NOT NULL REFERENCES settlement_intents(intent_id) ON DELETE RESTRICT,
    submission_id TEXT NOT NULL,
    transaction_reference TEXT NOT NULL,
    original_block_hash TEXT NOT NULL,
    original_block_number TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    observer_version TEXT NOT NULL,
    PRIMARY KEY (method, network, token_contract)
  ) STRICT;
`;

const PAYOUT_FINALITY_WATCH_COLUMNS = [
  "intent_id",
  "state",
  "next_check_at",
  "consecutive_failures",
  "last_checked_at",
  "last_status",
  "lease_id",
  "lease_expires_at",
] as const;

const PAYOUT_INCIDENT_ALERT_COLUMNS = [
  "alert_id",
  "method",
  "network",
  "token_contract",
  "state",
  "delivery_attempts",
  "next_attempt_at",
  "created_at",
  "delivered_at",
  "lease_id",
  "lease_expires_at",
] as const;

const PAYOUT_FINALITY_JOB_SCHEMA_SQL = `
  CREATE TABLE payout_finality_watches (
    intent_id TEXT PRIMARY KEY REFERENCES settlement_intents(intent_id) ON DELETE RESTRICT,
    state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'INCIDENT')),
    next_check_at INTEGER CHECK (
      next_check_at IS NULL OR (next_check_at >= 0 AND next_check_at <= 9007199254740991)
    ),
    consecutive_failures INTEGER NOT NULL CHECK (
      consecutive_failures >= 0 AND consecutive_failures <= 9007199254740991
    ),
    last_checked_at INTEGER CHECK (
      last_checked_at IS NULL OR (last_checked_at >= 0 AND last_checked_at <= 9007199254740991)
    ),
    last_status TEXT CHECK (
      last_status IS NULL OR
      last_status IN ('CONFLICTED', 'ERROR', 'FINAL', 'REORGED', 'REVERTED', 'UNKNOWN')
    ),
    lease_id TEXT,
    lease_expires_at INTEGER CHECK (
      lease_expires_at IS NULL OR
      (lease_expires_at >= 0 AND lease_expires_at <= 9007199254740991)
    ),
    CHECK (
      (lease_id IS NULL AND lease_expires_at IS NULL) OR
      (lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    ),
    CHECK (
      (state = 'ACTIVE' AND next_check_at IS NOT NULL) OR
      (state = 'INCIDENT' AND next_check_at IS NULL AND last_status IN ('CONFLICTED', 'REORGED'))
    )
  ) STRICT;

  CREATE INDEX payout_finality_watch_due_index
    ON payout_finality_watches(state, next_check_at, lease_expires_at, intent_id);

  CREATE TABLE payout_incident_alerts (
    alert_id TEXT PRIMARY KEY,
    method TEXT NOT NULL,
    network TEXT NOT NULL,
    token_contract TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('PENDING', 'DELIVERED')),
    delivery_attempts INTEGER NOT NULL CHECK (
      delivery_attempts >= 0 AND delivery_attempts <= 9007199254740991
    ),
    next_attempt_at INTEGER NOT NULL CHECK (
      next_attempt_at >= 0 AND next_attempt_at <= 9007199254740991
    ),
    created_at INTEGER NOT NULL CHECK (created_at >= 0 AND created_at <= 9007199254740991),
    delivered_at INTEGER CHECK (
      delivered_at IS NULL OR
      (delivered_at >= created_at AND delivered_at <= 9007199254740991)
    ),
    lease_id TEXT,
    lease_expires_at INTEGER CHECK (
      lease_expires_at IS NULL OR
      (lease_expires_at >= 0 AND lease_expires_at <= 9007199254740991)
    ),
    FOREIGN KEY (method, network, token_contract)
      REFERENCES settlement_pauses(method, network, token_contract) ON DELETE RESTRICT,
    CHECK (
      (lease_id IS NULL AND lease_expires_at IS NULL) OR
      (lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    ),
    CHECK (
      (state = 'PENDING' AND delivered_at IS NULL) OR
      (state = 'DELIVERED' AND delivered_at IS NOT NULL AND lease_id IS NULL)
    )
  ) STRICT;

  CREATE UNIQUE INDEX payout_incident_alert_profile_unique
    ON payout_incident_alerts(method, network, token_contract);

  CREATE INDEX payout_incident_alert_due_index
    ON payout_incident_alerts(state, next_attempt_at, lease_expires_at, alert_id);
`;

const SCHEMA_SQL = `
  CREATE TABLE funding_requests (
    payment_request_id TEXT PRIMARY KEY,
    network TEXT NOT NULL CHECK (network IN ('SN_SEPOLIA', 'SN_MAIN')),
    pool_contract TEXT NOT NULL,
    token_contract TEXT NOT NULL,
    amount_base_units TEXT NOT NULL,
    expires_at INTEGER NOT NULL CHECK (expires_at > 0),
    attribution_profile TEXT NOT NULL CHECK (attribution_profile IN ('quote_channel', 'signed_payer')),
    destination_json TEXT NOT NULL CHECK (json_valid(destination_json)),
    finality_policy TEXT NOT NULL,
    payer_binding_json TEXT CHECK (payer_binding_json IS NULL OR json_valid(payer_binding_json)),
    state TEXT NOT NULL CHECK (
      state IN ('CREATED', 'OBSERVED', 'PAID', 'ISSUED', 'EXPIRED', 'LATE_PAYMENT', 'REJECTED', 'OPERATOR_REQUIRED')
    ),
    accepted_evidence_id TEXT,
    operator_reason TEXT,
    CHECK (
      (attribution_profile = 'signed_payer' AND payer_binding_json IS NOT NULL) OR
      (attribution_profile = 'quote_channel' AND payer_binding_json IS NULL)
    ),
    FOREIGN KEY (payment_request_id, accepted_evidence_id)
      REFERENCES funding_evidence(payment_request_id, evidence_id)
      DEFERRABLE INITIALLY DEFERRED
  ) STRICT;

  CREATE TABLE funding_evidence (
    evidence_id TEXT PRIMARY KEY,
    payment_request_id TEXT NOT NULL REFERENCES funding_requests(payment_request_id) ON DELETE RESTRICT,
    network TEXT NOT NULL CHECK (network IN ('SN_SEPOLIA', 'SN_MAIN')),
    pool_contract TEXT NOT NULL,
    sender_address TEXT NOT NULL,
    recipient_address TEXT NOT NULL,
    token_contract TEXT NOT NULL,
    amount_base_units TEXT NOT NULL,
    attribution_profile TEXT NOT NULL CHECK (attribution_profile IN ('quote_channel', 'signed_payer')),
    destination_json TEXT NOT NULL CHECK (json_valid(destination_json)),
    block_hash TEXT NOT NULL,
    block_number TEXT NOT NULL,
    note_reference TEXT NOT NULL,
    transaction_reference TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'FINAL', 'REORGED', 'CONFLICTED')),
    finality_policy TEXT NOT NULL,
    verifier_version TEXT NOT NULL,
    first_observed_at INTEGER NOT NULL CHECK (first_observed_at > 0),
    last_observed_at INTEGER NOT NULL CHECK (last_observed_at >= first_observed_at),
    matches_request INTEGER NOT NULL CHECK (matches_request IN (0, 1)),
    UNIQUE (payment_request_id, evidence_id)
  ) STRICT;

  CREATE INDEX funding_evidence_request_index
    ON funding_evidence(payment_request_id, first_observed_at, evidence_id);

  CREATE TABLE payer_binding_challenges (
    payment_request_id TEXT PRIMARY KEY,
    challenge_id TEXT NOT NULL UNIQUE,
    network TEXT NOT NULL CHECK (network = 'SN_SEPOLIA'),
    pool_contract TEXT NOT NULL,
    recipient_address TEXT NOT NULL,
    token_contract TEXT NOT NULL,
    expected_note_reference TEXT NOT NULL,
    amount_base_units TEXT NOT NULL,
    payer_address TEXT NOT NULL,
    funding_expires_at INTEGER NOT NULL CHECK (funding_expires_at > 0),
    challenge_expires_at INTEGER NOT NULL CHECK (
      challenge_expires_at > 0 AND challenge_expires_at <= funding_expires_at
    ),
    state TEXT NOT NULL CHECK (state IN ('OPEN', 'VERIFIED', 'EXPIRED')),
    message_hash TEXT,
    block_hash TEXT,
    block_number TEXT,
    verifier_version TEXT,
    verified_at INTEGER,
    CHECK (
      (
        state = 'VERIFIED' AND message_hash IS NOT NULL AND block_hash IS NOT NULL AND
        block_number IS NOT NULL AND verifier_version IS NOT NULL AND verified_at IS NOT NULL
      ) OR (
        state != 'VERIFIED' AND message_hash IS NULL AND block_hash IS NULL AND
        block_number IS NULL AND verifier_version IS NULL AND verified_at IS NULL
      )
    )
  ) STRICT;

  CREATE UNIQUE INDEX ${PAYER_BINDING_NOTE_INDEX}
    ON payer_binding_challenges(network, pool_contract, expected_note_reference)
    WHERE state = 'VERIFIED';

  CREATE TABLE settlement_intents (
    intent_id TEXT PRIMARY KEY,
    quote_id TEXT NOT NULL UNIQUE,
    network TEXT NOT NULL,
    token_contract TEXT NOT NULL,
    amount_base_units TEXT NOT NULL,
    expires_at INTEGER NOT NULL CHECK (expires_at > 0),
    destination_json TEXT NOT NULL CHECK (json_valid(destination_json)),
    state TEXT NOT NULL CHECK (
      state IN ('INTENT_RECORDED', 'PENDING', 'UNKNOWN', 'PAID', 'FAILED', 'OPERATOR_REQUIRED')
    ),
    submission_id TEXT UNIQUE,
    transaction_references_json TEXT NOT NULL CHECK (json_valid(transaction_references_json))
  ) STRICT;

  ${SETTLEMENT_PAUSE_SCHEMA_SQL}

  ${PAYOUT_FINALITY_JOB_SCHEMA_SQL}
`;
