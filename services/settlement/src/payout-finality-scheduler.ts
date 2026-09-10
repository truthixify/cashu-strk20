import { randomUUID } from "node:crypto";

import type { FinalPayoutCanonicalStatus } from "./payout-finality.js";
import {
  clonePayoutFinalityWatchLease,
  clonePayoutIncidentAlert,
  clonePayoutIncidentAlertLease,
  derivePayoutIncidentAlert,
  MAXIMUM_PAYOUT_FINALITY_BATCH_SIZE,
  type PayoutFinalityJobStore,
  type PayoutFinalityWatchLease,
  type PayoutIncidentAlert,
  type PayoutIncidentAlertLease,
} from "./payout-finality-jobs.js";
import type { PayoutFinalitySupervision } from "./payout-finality-supervisor.js";
import {
  assertSettlementPauseRecord,
  cloneSettlementPauseRecord,
  cloneSettlementProfile,
  type SettlementPauseRecord,
  type SettlementProfile,
} from "./settlement-pauses.js";

export interface PayoutFinalitySupervisorRunner {
  checkAndPause(quoteId: string): Promise<PayoutFinalitySupervision>;
}

export interface PayoutIncidentAlertSink {
  /** Delivery is at least once. The sink must treat alertId as an idempotency key. */
  deliverPayoutIncidentAlert(alert: PayoutIncidentAlert): Promise<void>;
}

export interface PayoutFinalitySchedulerConfig {
  readonly supervisor: PayoutFinalitySupervisorRunner;
  readonly jobStore: PayoutFinalityJobStore;
  readonly batchSize: number;
  readonly leaseSeconds: number;
  readonly callbackTimeoutMilliseconds: number;
  readonly healthyCheckIntervalSeconds: number;
  readonly retryBaseSeconds: number;
  readonly maximumRetrySeconds: number;
  readonly now?: () => Date;
  readonly createLeaseId?: () => string;
}

export interface PayoutIncidentAlertDispatcherConfig {
  readonly sink: PayoutIncidentAlertSink;
  readonly jobStore: PayoutFinalityJobStore;
  readonly batchSize: number;
  readonly leaseSeconds: number;
  readonly callbackTimeoutMilliseconds: number;
  readonly retryBaseSeconds: number;
  readonly maximumRetrySeconds: number;
  readonly now?: () => Date;
  readonly createLeaseId?: () => string;
}

export interface PayoutFinalityRunSummary {
  readonly claimed: number;
  readonly healthy: number;
  readonly ambiguous: number;
  readonly incidents: number;
  readonly failed: number;
}

export interface PayoutIncidentAlertRunSummary {
  readonly claimed: number;
  readonly delivered: number;
  readonly failed: number;
}

export class PayoutFinalitySchedulerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayoutFinalitySchedulerConfigurationError";
  }
}

export class PayoutFinalitySchedulerIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayoutFinalitySchedulerIntegrityError";
  }
}

export type PayoutFinalitySchedulerDependencyErrorCode = "job_store_unavailable";

export class PayoutFinalitySchedulerDependencyError extends Error {
  readonly code: PayoutFinalitySchedulerDependencyErrorCode;

  constructor(code: PayoutFinalitySchedulerDependencyErrorCode, message: string) {
    super(message);
    this.name = "PayoutFinalitySchedulerDependencyError";
    this.code = code;
  }
}

interface RetryPolicy {
  readonly retryBaseSeconds: number;
  readonly maximumRetrySeconds: number;
}

interface RunnerPolicy extends RetryPolicy {
  readonly batchSize: number;
  readonly leaseSeconds: number;
  readonly callbackTimeoutMilliseconds: number;
}

/** Pull-based bounded worker. The caller owns invocation frequency and process lifecycle. */
export class PayoutFinalityScheduler {
  readonly #supervisor: PayoutFinalitySupervisorRunner;
  readonly #jobStore: PayoutFinalityJobStore;
  readonly #policy: RunnerPolicy & { readonly healthyCheckIntervalSeconds: number };
  readonly #now: () => Date;
  readonly #createLeaseId: () => string;

  constructor(config: PayoutFinalitySchedulerConfig) {
    assertDependency(config?.supervisor, "checkAndPause", "payout finality supervisor");
    assertJobStore(config?.jobStore);
    const policy = validatedRunnerPolicy(config);
    const healthyCheckIntervalSeconds = validatedPositiveDuration(
      config.healthyCheckIntervalSeconds,
      "healthy check interval",
    );
    assertClockAndLeaseFactory(config.now, config.createLeaseId);
    this.#supervisor = config.supervisor;
    this.#jobStore = config.jobStore;
    this.#policy = { ...policy, healthyCheckIntervalSeconds };
    this.#now = config.now ?? (() => new Date());
    this.#createLeaseId = config.createLeaseId ?? randomUUID;
  }

  async runDue(): Promise<PayoutFinalityRunSummary> {
    const now = schedulerNow(this.#now);
    const leaseId = schedulerLeaseId(this.#createLeaseId);
    const leaseExpiresAt = addSeconds(now, this.#policy.leaseSeconds);
    let claimedValue: readonly PayoutFinalityWatchLease[];
    try {
      claimedValue = await this.#jobStore.claimDuePayoutFinalityWatches({
        leaseId,
        now,
        leaseExpiresAt,
        limit: this.#policy.batchSize,
      });
    } catch {
      throw jobStoreUnavailable();
    }
    const claimed = validatedWatchClaims(
      claimedValue,
      leaseId,
      leaseExpiresAt,
      now,
      this.#policy.batchSize,
    );
    const summary = mutableFinalitySummary(claimed.length);
    for (const watch of claimed) {
      let supervisionValue: PayoutFinalitySupervision;
      try {
        supervisionValue = await withTimeout(
          this.#supervisor.checkAndPause(watch.quoteId),
          this.#policy.callbackTimeoutMilliseconds,
        );
      } catch {
        await this.#retryWatch(watch, schedulerCheckedAt(this.#now, now), "ERROR");
        summary.failed += 1;
        continue;
      }

      let supervision: PayoutFinalitySupervision;
      try {
        supervision = validatedSupervision(supervisionValue, watch.profile);
      } catch {
        await this.#retryWatch(watch, schedulerCheckedAt(this.#now, now), "ERROR");
        summary.failed += 1;
        continue;
      }

      if (supervision.paused) {
        const pause = supervision.pause;
        if (pause === undefined || pause.intentId !== watch.intentId) {
          await this.#retryWatch(watch, schedulerCheckedAt(this.#now, now), "ERROR");
          summary.failed += 1;
          continue;
        }
        const checkedAt = schedulerCheckedAt(this.#now, now);
        if (!leaseIsActive(watch, checkedAt)) {
          summary.failed += 1;
          continue;
        }
        try {
          await this.#jobStore.recordPayoutIncident({
            intentId: watch.intentId,
            leaseId: watch.leaseId,
            checkedAt,
            alert: derivePayoutIncidentAlert(pause),
          });
        } catch {
          throw jobStoreUnavailable();
        }
        summary.incidents += 1;
        continue;
      }

      if (supervision.status === "UNKNOWN") {
        const retained = await this.#retryWatch(
          watch,
          schedulerCheckedAt(this.#now, now),
          "UNKNOWN",
        );
        if (retained) {
          summary.ambiguous += 1;
        } else {
          summary.failed += 1;
        }
        continue;
      }
      if (supervision.status !== "FINAL" && supervision.status !== "REVERTED") {
        await this.#retryWatch(watch, schedulerCheckedAt(this.#now, now), "ERROR");
        summary.failed += 1;
        continue;
      }
      const checkedAt = schedulerCheckedAt(this.#now, now);
      if (!leaseIsActive(watch, checkedAt)) {
        summary.failed += 1;
        continue;
      }
      try {
        await this.#jobStore.completePayoutFinalityWatch({
          intentId: watch.intentId,
          leaseId: watch.leaseId,
          checkedAt,
          nextCheckAt: addSeconds(checkedAt, this.#policy.healthyCheckIntervalSeconds),
          status: supervision.status,
        });
      } catch {
        throw jobStoreUnavailable();
      }
      summary.healthy += 1;
    }
    return { ...summary };
  }

  async #retryWatch(
    watch: PayoutFinalityWatchLease,
    now: number,
    status: "ERROR" | "UNKNOWN",
  ): Promise<boolean> {
    if (!leaseIsActive(watch, now)) {
      return false;
    }
    const delay = retryDelay(watch.consecutiveFailures, this.#policy);
    try {
      await this.#jobStore.retryPayoutFinalityWatch({
        intentId: watch.intentId,
        leaseId: watch.leaseId,
        checkedAt: now,
        nextCheckAt: addSeconds(now, delay),
        status,
      });
    } catch {
      throw jobStoreUnavailable();
    }
    return true;
  }
}

/** At-least-once bounded alert outbox dispatcher with a stable sink idempotency key. */
export class PayoutIncidentAlertDispatcher {
  readonly #sink: PayoutIncidentAlertSink;
  readonly #jobStore: PayoutFinalityJobStore;
  readonly #policy: RunnerPolicy;
  readonly #now: () => Date;
  readonly #createLeaseId: () => string;

  constructor(config: PayoutIncidentAlertDispatcherConfig) {
    assertDependency(config?.sink, "deliverPayoutIncidentAlert", "payout incident alert sink");
    assertJobStore(config?.jobStore);
    const policy = validatedRunnerPolicy(config);
    assertClockAndLeaseFactory(config.now, config.createLeaseId);
    this.#sink = config.sink;
    this.#jobStore = config.jobStore;
    this.#policy = policy;
    this.#now = config.now ?? (() => new Date());
    this.#createLeaseId = config.createLeaseId ?? randomUUID;
  }

  async runDue(): Promise<PayoutIncidentAlertRunSummary> {
    const now = schedulerNow(this.#now);
    const leaseId = schedulerLeaseId(this.#createLeaseId);
    const leaseExpiresAt = addSeconds(now, this.#policy.leaseSeconds);
    let claimedValue: readonly PayoutIncidentAlertLease[];
    try {
      claimedValue = await this.#jobStore.claimDuePayoutIncidentAlerts({
        leaseId,
        now,
        leaseExpiresAt,
        limit: this.#policy.batchSize,
      });
    } catch {
      throw jobStoreUnavailable();
    }
    const claimed = validatedAlertClaims(
      claimedValue,
      leaseId,
      leaseExpiresAt,
      now,
      this.#policy.batchSize,
    );
    const summary = { claimed: claimed.length, delivered: 0, failed: 0 };
    for (const alert of claimed) {
      try {
        await withTimeout(
          this.#sink.deliverPayoutIncidentAlert(clonePayoutIncidentAlert(alert)),
          this.#policy.callbackTimeoutMilliseconds,
        );
      } catch {
        const attemptedAt = schedulerCheckedAt(this.#now, now);
        if (!leaseIsActive(alert, attemptedAt)) {
          summary.failed += 1;
          continue;
        }
        const delay = retryDelay(alert.deliveryAttempts, this.#policy);
        try {
          await this.#jobStore.retryPayoutIncidentAlert({
            alertId: alert.alertId,
            leaseId: alert.leaseId,
            attemptedAt,
            nextAttemptAt: addSeconds(attemptedAt, delay),
          });
        } catch {
          throw jobStoreUnavailable();
        }
        summary.failed += 1;
        continue;
      }
      const deliveredAt = schedulerCheckedAt(this.#now, now);
      if (!leaseIsActive(alert, deliveredAt)) {
        summary.failed += 1;
        continue;
      }
      try {
        await this.#jobStore.completePayoutIncidentAlert({
          alertId: alert.alertId,
          leaseId: alert.leaseId,
          deliveredAt,
        });
      } catch {
        throw jobStoreUnavailable();
      }
      summary.delivered += 1;
    }
    return { ...summary };
  }
}

function validatedRunnerPolicy(config: {
  readonly batchSize: number;
  readonly leaseSeconds: number;
  readonly callbackTimeoutMilliseconds: number;
  readonly retryBaseSeconds: number;
  readonly maximumRetrySeconds: number;
}): RunnerPolicy {
  if (
    !Number.isSafeInteger(config.batchSize) ||
    config.batchSize < 1 ||
    config.batchSize > MAXIMUM_PAYOUT_FINALITY_BATCH_SIZE
  ) {
    throw new PayoutFinalitySchedulerConfigurationError(
      "Configured payout finality batch size is invalid",
    );
  }
  const leaseSeconds = validatedPositiveDuration(
    config.leaseSeconds,
    "lease duration",
    MAXIMUM_LEASE_SECONDS,
  );
  const callbackTimeoutMilliseconds = validatedPositiveDuration(
    config.callbackTimeoutMilliseconds,
    "callback timeout",
    MAXIMUM_CALLBACK_TIMEOUT_MILLISECONDS,
  );
  if (callbackTimeoutMilliseconds * config.batchSize >= leaseSeconds * 1_000) {
    throw new PayoutFinalitySchedulerConfigurationError(
      "Configured payout finality callback budget must be shorter than the lease",
    );
  }
  const retryBaseSeconds = validatedPositiveDuration(config.retryBaseSeconds, "retry base");
  const maximumRetrySeconds = validatedPositiveDuration(
    config.maximumRetrySeconds,
    "maximum retry",
  );
  if (retryBaseSeconds > maximumRetrySeconds) {
    throw new PayoutFinalitySchedulerConfigurationError(
      "Configured payout finality retry range is invalid",
    );
  }
  return {
    batchSize: config.batchSize,
    leaseSeconds,
    callbackTimeoutMilliseconds,
    retryBaseSeconds,
    maximumRetrySeconds,
  };
}

function validatedPositiveDuration(
  value: number,
  label: string,
  maximum = MAXIMUM_DURATION_SECONDS,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new PayoutFinalitySchedulerConfigurationError(
      `Configured payout finality ${label} is invalid`,
    );
  }
  return value;
}

function assertClockAndLeaseFactory(
  now: (() => Date) | undefined,
  createLeaseId: (() => string) | undefined,
): void {
  if (now !== undefined && typeof now !== "function") {
    throw new PayoutFinalitySchedulerConfigurationError(
      "Configured payout finality clock is invalid",
    );
  }
  if (createLeaseId !== undefined && typeof createLeaseId !== "function") {
    throw new PayoutFinalitySchedulerConfigurationError(
      "Configured payout finality lease factory is invalid",
    );
  }
}

function assertDependency(value: unknown, method: string, label: string): void {
  let valid = false;
  try {
    valid =
      typeof value === "object" &&
      value !== null &&
      typeof (value as Record<string, unknown>)[method] === "function";
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new PayoutFinalitySchedulerConfigurationError(`Configured ${label} is invalid`);
  }
}

function assertJobStore(value: unknown): asserts value is PayoutFinalityJobStore {
  const methods = [
    "scheduleTerminalPayout",
    "claimDuePayoutFinalityWatches",
    "completePayoutFinalityWatch",
    "retryPayoutFinalityWatch",
    "recordPayoutIncident",
    "claimDuePayoutIncidentAlerts",
    "completePayoutIncidentAlert",
    "retryPayoutIncidentAlert",
  ];
  let valid = false;
  try {
    valid =
      typeof value === "object" &&
      value !== null &&
      methods.every((method) => typeof (value as Record<string, unknown>)[method] === "function");
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new PayoutFinalitySchedulerConfigurationError(
      "Configured payout finality job store is invalid",
    );
  }
}

function validatedWatchClaims(
  value: readonly PayoutFinalityWatchLease[],
  leaseId: string,
  leaseExpiresAt: number,
  now: number,
  limit: number,
): readonly PayoutFinalityWatchLease[] {
  let items: readonly PayoutFinalityWatchLease[];
  try {
    if (!Array.isArray(value) || value.length > limit) {
      throw new Error("invalid batch");
    }
    items = Array.from(value);
  } catch {
    throw new PayoutFinalitySchedulerIntegrityError(
      "Payout finality job store returned an invalid watch batch",
    );
  }
  const intentIds = new Set<string>();
  const quoteIds = new Set<string>();
  return items.map((item) => {
    let watch: PayoutFinalityWatchLease;
    try {
      watch = clonePayoutFinalityWatchLease(item);
    } catch {
      throw new PayoutFinalitySchedulerIntegrityError(
        "Payout finality job store returned an invalid watch",
      );
    }
    if (
      watch.leaseId !== leaseId ||
      watch.leaseExpiresAt !== leaseExpiresAt ||
      watch.nextCheckAt > now ||
      intentIds.has(watch.intentId) ||
      quoteIds.has(watch.quoteId)
    ) {
      throw new PayoutFinalitySchedulerIntegrityError(
        "Payout finality job store returned a conflicting watch batch",
      );
    }
    intentIds.add(watch.intentId);
    quoteIds.add(watch.quoteId);
    return watch;
  });
}

function validatedAlertClaims(
  value: readonly PayoutIncidentAlertLease[],
  leaseId: string,
  leaseExpiresAt: number,
  now: number,
  limit: number,
): readonly PayoutIncidentAlertLease[] {
  let items: readonly PayoutIncidentAlertLease[];
  try {
    if (!Array.isArray(value) || value.length > limit) {
      throw new Error("invalid batch");
    }
    items = Array.from(value);
  } catch {
    throw new PayoutFinalitySchedulerIntegrityError(
      "Payout finality job store returned an invalid alert batch",
    );
  }
  const alertIds = new Set<string>();
  return items.map((item) => {
    let alert: PayoutIncidentAlertLease;
    try {
      alert = clonePayoutIncidentAlertLease(item);
    } catch {
      throw new PayoutFinalitySchedulerIntegrityError(
        "Payout finality job store returned an invalid alert",
      );
    }
    if (
      alert.leaseId !== leaseId ||
      alert.leaseExpiresAt !== leaseExpiresAt ||
      alert.nextAttemptAt > now ||
      alertIds.has(alert.alertId)
    ) {
      throw new PayoutFinalitySchedulerIntegrityError(
        "Payout finality job store returned a conflicting alert batch",
      );
    }
    alertIds.add(alert.alertId);
    return alert;
  });
}

function validatedSupervision(
  value: PayoutFinalitySupervision,
  expectedProfile: SettlementProfile,
): PayoutFinalitySupervision {
  if (typeof value !== "object" || value === null) {
    throw invalidSupervision();
  }
  let profile: SettlementProfile;
  let status: FinalPayoutCanonicalStatus;
  let paused: boolean;
  let pauseValue: SettlementPauseRecord | undefined;
  try {
    profile = cloneSettlementProfile(value.profile);
    status = value.status;
    paused = value.paused;
    pauseValue = value.pause;
  } catch {
    throw invalidSupervision();
  }
  if (
    !sameProfile(profile, expectedProfile) ||
    !FINAL_PAYOUT_STATUSES.has(status) ||
    typeof paused !== "boolean"
  ) {
    throw invalidSupervision();
  }
  if (!paused) {
    if (pauseValue !== undefined || status === "CONFLICTED" || status === "REORGED") {
      throw invalidSupervision();
    }
    return { profile, status, paused: false };
  }
  if (pauseValue === undefined || (status !== "CONFLICTED" && status !== "REORGED")) {
    throw invalidSupervision();
  }
  let pause: SettlementPauseRecord;
  try {
    assertSettlementPauseRecord(pauseValue);
    pause = cloneSettlementPauseRecord(pauseValue);
  } catch {
    throw invalidSupervision();
  }
  if (
    !sameProfile(pause.profile, profile) ||
    (status === "REORGED" && pause.reason !== "PAYOUT_FINALITY_REORGED") ||
    (status === "CONFLICTED" && pause.reason !== "PAYOUT_FINALITY_CONFLICTED")
  ) {
    throw invalidSupervision();
  }
  return { profile, status, paused: true, pause };
}

function retryDelay(consecutiveFailures: number, policy: RetryPolicy): number {
  if (!Number.isSafeInteger(consecutiveFailures) || consecutiveFailures < 0) {
    throw new PayoutFinalitySchedulerIntegrityError("Payout finality retry count is invalid");
  }
  let delay = policy.retryBaseSeconds;
  for (
    let index = 0;
    index < consecutiveFailures && delay < policy.maximumRetrySeconds;
    index += 1
  ) {
    delay = Math.min(policy.maximumRetrySeconds, delay * 2);
  }
  return delay;
}

function schedulerNow(now: () => Date): number {
  let value: Date;
  try {
    value = now();
  } catch {
    throw new PayoutFinalitySchedulerIntegrityError("Payout finality clock failed");
  }
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()) || value.getTime() < 0) {
    throw new PayoutFinalitySchedulerIntegrityError(
      "Payout finality clock returned an invalid time",
    );
  }
  const seconds = Math.floor(value.getTime() / 1_000);
  if (!Number.isSafeInteger(seconds)) {
    throw new PayoutFinalitySchedulerIntegrityError(
      "Payout finality clock returned an invalid time",
    );
  }
  return seconds;
}

function schedulerCheckedAt(now: () => Date, startedAt: number): number {
  const checkedAt = schedulerNow(now);
  if (checkedAt < startedAt) {
    throw new PayoutFinalitySchedulerIntegrityError(
      "Payout finality clock moved backwards during a run",
    );
  }
  return checkedAt;
}

function schedulerLeaseId(createLeaseId: () => string): string {
  let value: string;
  try {
    value = createLeaseId();
  } catch {
    throw new PayoutFinalitySchedulerIntegrityError("Payout finality lease factory failed");
  }
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAXIMUM_IDENTIFIER_LENGTH ||
    containsControlCharacter(value)
  ) {
    throw new PayoutFinalitySchedulerIntegrityError(
      "Payout finality lease factory returned an invalid ID",
    );
  }
  return value;
}

function addSeconds(timestamp: number, seconds: number): number {
  const value = timestamp + seconds;
  if (!Number.isSafeInteger(value)) {
    throw new PayoutFinalitySchedulerIntegrityError("Payout finality schedule overflowed");
  }
  return value;
}

async function withTimeout<Value>(
  operation: Promise<Value>,
  timeoutMilliseconds: number,
): Promise<Value> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Payout finality callback timed out")),
          timeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function sameProfile(left: SettlementProfile, right: SettlementProfile): boolean {
  return (
    left.method === right.method &&
    left.network === right.network &&
    left.tokenContract === right.tokenContract
  );
}

function leaseIsActive(lease: { readonly leaseExpiresAt: number }, at: number): boolean {
  return at < lease.leaseExpiresAt;
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

function mutableFinalitySummary(claimed: number): {
  claimed: number;
  healthy: number;
  ambiguous: number;
  incidents: number;
  failed: number;
} {
  return { claimed, healthy: 0, ambiguous: 0, incidents: 0, failed: 0 };
}

function invalidSupervision(): PayoutFinalitySchedulerIntegrityError {
  return new PayoutFinalitySchedulerIntegrityError(
    "Payout finality supervisor returned an invalid result",
  );
}

function jobStoreUnavailable(): PayoutFinalitySchedulerDependencyError {
  return new PayoutFinalitySchedulerDependencyError(
    "job_store_unavailable",
    "Payout finality job store is unavailable",
  );
}

const FINAL_PAYOUT_STATUSES: ReadonlySet<FinalPayoutCanonicalStatus> = new Set([
  "CONFLICTED",
  "FINAL",
  "REORGED",
  "REVERTED",
  "UNKNOWN",
]);
const MAXIMUM_DURATION_SECONDS = 31_536_000;
const MAXIMUM_LEASE_SECONDS = 3_600;
const MAXIMUM_CALLBACK_TIMEOUT_MILLISECONDS = 5 * 60 * 1_000;
const MAXIMUM_IDENTIFIER_LENGTH = 512;
