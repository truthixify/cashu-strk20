import { createHash } from "node:crypto";

import {
  assertSettlementPauseRecord,
  cloneSettlementPauseRecord,
  cloneSettlementProfile,
  type SettlementPauseRecord,
  type SettlementProfile,
} from "./settlement-pauses.js";

export interface TerminalPayoutWatchCandidate {
  readonly intentId: string;
  readonly quoteId: string;
  readonly profile: SettlementProfile;
  readonly nextCheckAt: number;
}

export interface PayoutFinalityWatchLease extends TerminalPayoutWatchCandidate {
  readonly leaseId: string;
  readonly leaseExpiresAt: number;
  readonly consecutiveFailures: number;
}

export interface PayoutIncidentAlert {
  readonly alertId: string;
  readonly pause: SettlementPauseRecord;
}

export interface PayoutIncidentAlertLease extends PayoutIncidentAlert {
  readonly leaseId: string;
  readonly leaseExpiresAt: number;
  readonly deliveryAttempts: number;
  readonly nextAttemptAt: number;
}

export interface ClaimPayoutFinalityWatchesInput {
  readonly leaseId: string;
  readonly now: number;
  readonly leaseExpiresAt: number;
  readonly limit: number;
}

export interface CompletePayoutFinalityWatchInput {
  readonly intentId: string;
  readonly leaseId: string;
  readonly checkedAt: number;
  readonly nextCheckAt: number;
  readonly status: "FINAL" | "REVERTED";
}

export interface RetryPayoutFinalityWatchInput {
  readonly intentId: string;
  readonly leaseId: string;
  readonly checkedAt: number;
  readonly nextCheckAt: number;
  readonly status: "ERROR" | "UNKNOWN";
}

export interface RecordPayoutIncidentInput {
  readonly intentId: string;
  readonly leaseId: string;
  readonly checkedAt: number;
  readonly alert: PayoutIncidentAlert;
}

export interface ClaimPayoutIncidentAlertsInput {
  readonly leaseId: string;
  readonly now: number;
  readonly leaseExpiresAt: number;
  readonly limit: number;
}

export interface CompletePayoutIncidentAlertInput {
  readonly alertId: string;
  readonly leaseId: string;
  readonly deliveredAt: number;
}

export interface RetryPayoutIncidentAlertInput {
  readonly alertId: string;
  readonly leaseId: string;
  readonly attemptedAt: number;
  readonly nextAttemptAt: number;
}

export interface PayoutFinalityJobStore {
  /** Idempotently retain one monitoring job per terminal payout intent. */
  scheduleTerminalPayout(candidate: TerminalPayoutWatchCandidate): Promise<void>;
  claimDuePayoutFinalityWatches(
    input: ClaimPayoutFinalityWatchesInput,
  ): Promise<readonly PayoutFinalityWatchLease[]>;
  completePayoutFinalityWatch(input: CompletePayoutFinalityWatchInput): Promise<void>;
  retryPayoutFinalityWatch(input: RetryPayoutFinalityWatchInput): Promise<void>;
  /** Close the watch and atomically retain one value-free alert for the persisted incident. */
  recordPayoutIncident(input: RecordPayoutIncidentInput): Promise<void>;
  claimDuePayoutIncidentAlerts(
    input: ClaimPayoutIncidentAlertsInput,
  ): Promise<readonly PayoutIncidentAlertLease[]>;
  completePayoutIncidentAlert(input: CompletePayoutIncidentAlertInput): Promise<void>;
  retryPayoutIncidentAlert(input: RetryPayoutIncidentAlertInput): Promise<void>;
}

export class PayoutFinalityJobIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayoutFinalityJobIntegrityError";
  }
}

interface InMemoryWatch extends TerminalPayoutWatchCandidate {
  readonly state: "ACTIVE" | "INCIDENT";
  readonly consecutiveFailures: number;
  readonly lastCheckedAt?: number;
  readonly lastStatus?: "CONFLICTED" | "ERROR" | "FINAL" | "REORGED" | "REVERTED" | "UNKNOWN";
  readonly leaseId?: string;
  readonly leaseExpiresAt?: number;
}

interface InMemoryAlert extends PayoutIncidentAlert {
  readonly state: "PENDING" | "DELIVERED";
  readonly deliveryAttempts: number;
  readonly nextAttemptAt: number;
  readonly deliveredAt?: number;
  readonly leaseId?: string;
  readonly leaseExpiresAt?: number;
}

/** Deterministic job store for tests. Funded deployments require durable transactional storage. */
export class InMemoryPayoutFinalityJobStore implements PayoutFinalityJobStore {
  readonly #watches = new Map<string, InMemoryWatch>();
  readonly #intentIdByQuoteId = new Map<string, string>();
  readonly #alerts = new Map<string, InMemoryAlert>();
  readonly #alertIdByProfile = new Map<string, string>();

  async scheduleTerminalPayout(candidateValue: TerminalPayoutWatchCandidate): Promise<void> {
    const candidate = cloneTerminalPayoutWatchCandidate(candidateValue);
    const existing = this.#watches.get(candidate.intentId);
    if (existing !== undefined) {
      if (!sameWatchIdentity(existing, candidate)) {
        throw new PayoutFinalityJobIntegrityError(
          "Terminal payout watch conflicts with an existing intent",
        );
      }
      return;
    }
    const quoteOwner = this.#intentIdByQuoteId.get(candidate.quoteId);
    if (quoteOwner !== undefined && quoteOwner !== candidate.intentId) {
      throw new PayoutFinalityJobIntegrityError(
        "Terminal payout quote is already assigned to another watch",
      );
    }
    this.#watches.set(candidate.intentId, {
      ...candidate,
      state: "ACTIVE",
      consecutiveFailures: 0,
    });
    this.#intentIdByQuoteId.set(candidate.quoteId, candidate.intentId);
  }

  async claimDuePayoutFinalityWatches(
    input: ClaimPayoutFinalityWatchesInput,
  ): Promise<readonly PayoutFinalityWatchLease[]> {
    assertClaim(input);
    const due = [...this.#watches.values()]
      .filter(
        (watch) =>
          watch.state === "ACTIVE" &&
          watch.nextCheckAt <= input.now &&
          (watch.leaseExpiresAt === undefined || watch.leaseExpiresAt <= input.now),
      )
      .sort(compareWatches)
      .slice(0, input.limit);
    return due.map((watch) => {
      const leased: InMemoryWatch = {
        ...watch,
        leaseId: input.leaseId,
        leaseExpiresAt: input.leaseExpiresAt,
      };
      this.#watches.set(watch.intentId, leased);
      return clonePayoutFinalityWatchLease({
        ...cloneTerminalPayoutWatchCandidate(leased),
        leaseId: input.leaseId,
        leaseExpiresAt: input.leaseExpiresAt,
        consecutiveFailures: leased.consecutiveFailures,
      });
    });
  }

  async completePayoutFinalityWatch(input: CompletePayoutFinalityWatchInput): Promise<void> {
    assertCompletion(input);
    const existing = this.#requiredLeasedWatch(input.intentId, input.leaseId, input.checkedAt);
    this.#watches.set(input.intentId, {
      ...withoutWatchLease(existing),
      nextCheckAt: input.nextCheckAt,
      consecutiveFailures: 0,
      lastCheckedAt: input.checkedAt,
      lastStatus: input.status,
    });
  }

  async retryPayoutFinalityWatch(input: RetryPayoutFinalityWatchInput): Promise<void> {
    assertRetry(input);
    const existing = this.#requiredLeasedWatch(input.intentId, input.leaseId, input.checkedAt);
    if (existing.consecutiveFailures >= Number.MAX_SAFE_INTEGER) {
      throw new PayoutFinalityJobIntegrityError("Payout finality retry counter overflowed");
    }
    this.#watches.set(input.intentId, {
      ...withoutWatchLease(existing),
      nextCheckAt: input.nextCheckAt,
      consecutiveFailures: existing.consecutiveFailures + 1,
      lastCheckedAt: input.checkedAt,
      lastStatus: input.status,
    });
  }

  async recordPayoutIncident(input: RecordPayoutIncidentInput): Promise<void> {
    assertRecordIncident(input);
    const existing = this.#requiredLeasedWatch(input.intentId, input.leaseId, input.checkedAt);
    if (
      existing.intentId !== input.alert.pause.intentId ||
      !sameProfile(existing.profile, input.alert.pause.profile)
    ) {
      throw new PayoutFinalityJobIntegrityError(
        "Payout incident alert does not match its terminal watch",
      );
    }
    const profile = profileKey(input.alert.pause.profile);
    const ownedAlert = clonePayoutIncidentAlert(input.alert);
    const profileOwner = this.#alertIdByProfile.get(profile);
    if (profileOwner !== undefined && profileOwner !== ownedAlert.alertId) {
      throw new PayoutFinalityJobIntegrityError(
        "Payout incident profile is already assigned to another alert",
      );
    }
    const storedAlert = this.#alerts.get(ownedAlert.alertId);
    if (storedAlert !== undefined && !sameAlert(storedAlert, ownedAlert)) {
      throw new PayoutFinalityJobIntegrityError(
        "Payout incident alert conflicts with an existing alert",
      );
    }
    this.#alerts.set(ownedAlert.alertId, {
      ...(storedAlert ?? ownedAlert),
      state: storedAlert?.state ?? "PENDING",
      deliveryAttempts: storedAlert?.deliveryAttempts ?? 0,
      nextAttemptAt: storedAlert?.nextAttemptAt ?? input.checkedAt,
    });
    this.#alertIdByProfile.set(profile, ownedAlert.alertId);
    this.#watches.set(existing.intentId, {
      ...withoutWatchLease(existing),
      state: "INCIDENT",
      lastCheckedAt: input.checkedAt,
      lastStatus: ownedAlert.pause.reason === "PAYOUT_FINALITY_REORGED" ? "REORGED" : "CONFLICTED",
    });
  }

  async claimDuePayoutIncidentAlerts(
    input: ClaimPayoutIncidentAlertsInput,
  ): Promise<readonly PayoutIncidentAlertLease[]> {
    assertClaim(input);
    const due = [...this.#alerts.values()]
      .filter(
        (alert) =>
          alert.state === "PENDING" &&
          alert.nextAttemptAt <= input.now &&
          (alert.leaseExpiresAt === undefined || alert.leaseExpiresAt <= input.now),
      )
      .sort(compareAlerts)
      .slice(0, input.limit);
    return due.map((alert) => {
      const leased: InMemoryAlert = {
        ...alert,
        leaseId: input.leaseId,
        leaseExpiresAt: input.leaseExpiresAt,
      };
      this.#alerts.set(alert.alertId, leased);
      return clonePayoutIncidentAlertLease({
        ...clonePayoutIncidentAlert(leased),
        leaseId: input.leaseId,
        leaseExpiresAt: input.leaseExpiresAt,
        deliveryAttempts: leased.deliveryAttempts,
        nextAttemptAt: leased.nextAttemptAt,
      });
    });
  }

  async completePayoutIncidentAlert(input: CompletePayoutIncidentAlertInput): Promise<void> {
    assertAlertCompletion(input);
    const existing = this.#requiredLeasedAlert(input.alertId, input.leaseId, input.deliveredAt);
    this.#alerts.set(input.alertId, {
      ...withoutAlertLease(existing),
      state: "DELIVERED",
      deliveredAt: input.deliveredAt,
    });
  }

  async retryPayoutIncidentAlert(input: RetryPayoutIncidentAlertInput): Promise<void> {
    assertAlertRetry(input);
    const existing = this.#requiredLeasedAlert(input.alertId, input.leaseId, input.attemptedAt);
    if (existing.deliveryAttempts >= Number.MAX_SAFE_INTEGER) {
      throw new PayoutFinalityJobIntegrityError("Payout incident alert retry counter overflowed");
    }
    this.#alerts.set(input.alertId, {
      ...withoutAlertLease(existing),
      deliveryAttempts: existing.deliveryAttempts + 1,
      nextAttemptAt: input.nextAttemptAt,
    });
  }

  #requiredLeasedWatch(intentId: string, leaseId: string, at: number): InMemoryWatch {
    const existing = this.#watches.get(intentId);
    if (
      existing === undefined ||
      existing.state !== "ACTIVE" ||
      existing.leaseId !== leaseId ||
      existing.leaseExpiresAt === undefined ||
      existing.leaseExpiresAt <= at
    ) {
      throw new PayoutFinalityJobIntegrityError("Payout finality watch lease is not active");
    }
    return existing;
  }

  #requiredLeasedAlert(alertId: string, leaseId: string, at: number): InMemoryAlert {
    const existing = this.#alerts.get(alertId);
    if (
      existing === undefined ||
      existing.state !== "PENDING" ||
      existing.leaseId !== leaseId ||
      existing.leaseExpiresAt === undefined ||
      existing.leaseExpiresAt <= at
    ) {
      throw new PayoutFinalityJobIntegrityError("Payout incident alert lease is not active");
    }
    return existing;
  }
}

export function derivePayoutIncidentAlert(pauseValue: SettlementPauseRecord): PayoutIncidentAlert {
  const pause = cloneSettlementPauseRecord(pauseValue);
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        pause.profile.method,
        pause.profile.network,
        pause.profile.tokenContract,
        pause.reason,
        pause.intentId,
        pause.submissionId,
        pause.transactionReference,
        pause.originalInclusion.blockHash,
        pause.originalInclusion.blockNumber.toString(10),
        pause.detectedAt,
        pause.observerVersion,
      ]),
    )
    .digest("hex");
  return { alertId: `payout_incident_${digest}`, pause };
}

export function assertPayoutIncidentAlert(value: unknown): asserts value is PayoutIncidentAlert {
  if (typeof value !== "object" || value === null) {
    throw new PayoutFinalityJobIntegrityError("Payout incident alert is invalid");
  }
  let alertId: unknown;
  let pause: unknown;
  try {
    alertId = (value as Partial<PayoutIncidentAlert>).alertId;
    pause = (value as Partial<PayoutIncidentAlert>).pause;
  } catch {
    throw new PayoutFinalityJobIntegrityError("Payout incident alert is invalid");
  }
  if (typeof alertId !== "string" || !PAYOUT_INCIDENT_ALERT_ID.test(alertId)) {
    throw new PayoutFinalityJobIntegrityError("Payout incident alert ID is invalid");
  }
  try {
    assertSettlementPauseRecord(pause);
  } catch {
    throw new PayoutFinalityJobIntegrityError("Payout incident alert pause is invalid");
  }
  let expectedAlertId: string;
  try {
    expectedAlertId = derivePayoutIncidentAlert(pause).alertId;
  } catch {
    throw new PayoutFinalityJobIntegrityError("Payout incident alert pause is invalid");
  }
  if (expectedAlertId !== alertId) {
    throw new PayoutFinalityJobIntegrityError("Payout incident alert ID does not match its pause");
  }
}

export function clonePayoutIncidentAlert(alert: PayoutIncidentAlert): PayoutIncidentAlert {
  assertPayoutIncidentAlert(alert);
  try {
    return {
      alertId: alert.alertId,
      pause: cloneSettlementPauseRecord(alert.pause),
    };
  } catch {
    throw new PayoutFinalityJobIntegrityError("Payout incident alert is invalid");
  }
}

export function cloneTerminalPayoutWatchCandidate(
  candidate: TerminalPayoutWatchCandidate,
): TerminalPayoutWatchCandidate {
  try {
    assertIdentifier(candidate.intentId, "Terminal payout intent ID");
    assertIdentifier(candidate.quoteId, "Terminal payout quote ID");
    assertTimestamp(candidate.nextCheckAt, "Terminal payout next check time");
    return {
      intentId: candidate.intentId,
      quoteId: candidate.quoteId,
      profile: cloneSettlementProfile(candidate.profile),
      nextCheckAt: candidate.nextCheckAt,
    };
  } catch (error) {
    if (error instanceof PayoutFinalityJobIntegrityError) {
      throw error;
    }
    throw new PayoutFinalityJobIntegrityError("Terminal payout watch is invalid");
  }
}

export function assertClaimPayoutFinalityWatchesInput(
  input: ClaimPayoutFinalityWatchesInput,
): void {
  assertClaim(input);
}

export function assertCompletePayoutFinalityWatchInput(
  input: CompletePayoutFinalityWatchInput,
): void {
  assertCompletion(input);
}

export function assertRetryPayoutFinalityWatchInput(input: RetryPayoutFinalityWatchInput): void {
  assertRetry(input);
}

export function assertRecordPayoutIncidentInput(input: RecordPayoutIncidentInput): void {
  assertRecordIncident(input);
}

export function assertClaimPayoutIncidentAlertsInput(input: ClaimPayoutIncidentAlertsInput): void {
  assertClaim(input);
}

export function assertCompletePayoutIncidentAlertInput(
  input: CompletePayoutIncidentAlertInput,
): void {
  assertAlertCompletion(input);
}

export function assertRetryPayoutIncidentAlertInput(input: RetryPayoutIncidentAlertInput): void {
  assertAlertRetry(input);
}

export function clonePayoutFinalityWatchLease(
  watch: PayoutFinalityWatchLease,
): PayoutFinalityWatchLease {
  if (watch.leaseId === undefined || watch.leaseExpiresAt === undefined) {
    throw new PayoutFinalityJobIntegrityError("Payout finality watch has no active lease");
  }
  assertIdentifier(watch.leaseId, "Payout finality lease ID");
  assertTimestamp(watch.leaseExpiresAt, "Payout finality lease expiry");
  assertCounter(watch.consecutiveFailures, "Payout finality failure count");
  return {
    ...cloneTerminalPayoutWatchCandidate(watch),
    leaseId: watch.leaseId,
    leaseExpiresAt: watch.leaseExpiresAt,
    consecutiveFailures: watch.consecutiveFailures,
  };
}

export function clonePayoutIncidentAlertLease(
  alert: PayoutIncidentAlertLease,
): PayoutIncidentAlertLease {
  if (alert.leaseId === undefined || alert.leaseExpiresAt === undefined) {
    throw new PayoutFinalityJobIntegrityError("Payout incident alert has no active lease");
  }
  assertIdentifier(alert.leaseId, "Payout incident alert lease ID");
  assertTimestamp(alert.leaseExpiresAt, "Payout incident alert lease expiry");
  assertCounter(alert.deliveryAttempts, "Payout incident alert attempt count");
  assertTimestamp(alert.nextAttemptAt, "Payout incident alert next attempt time");
  return {
    ...clonePayoutIncidentAlert(alert),
    leaseId: alert.leaseId,
    leaseExpiresAt: alert.leaseExpiresAt,
    deliveryAttempts: alert.deliveryAttempts,
    nextAttemptAt: alert.nextAttemptAt,
  };
}

function assertClaim(input: ClaimPayoutFinalityWatchesInput): void {
  assertIdentifier(input.leaseId, "Payout finality lease ID");
  assertTimestamp(input.now, "Payout finality claim time");
  assertTimestamp(input.leaseExpiresAt, "Payout finality lease expiry");
  if (input.leaseExpiresAt <= input.now) {
    throw new PayoutFinalityJobIntegrityError("Payout finality lease expiry is invalid");
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAXIMUM_BATCH_SIZE) {
    throw new PayoutFinalityJobIntegrityError("Payout finality claim limit is invalid");
  }
}

function assertCompletion(input: CompletePayoutFinalityWatchInput): void {
  assertIdentifier(input.intentId, "Payout finality intent ID");
  assertIdentifier(input.leaseId, "Payout finality lease ID");
  assertTimestamp(input.checkedAt, "Payout finality check time");
  assertFutureTimestamp(input.nextCheckAt, input.checkedAt, "Payout finality next check time");
  if (input.status !== "FINAL" && input.status !== "REVERTED") {
    throw new PayoutFinalityJobIntegrityError("Payout finality healthy status is invalid");
  }
}

function assertRetry(input: RetryPayoutFinalityWatchInput): void {
  assertIdentifier(input.intentId, "Payout finality intent ID");
  assertIdentifier(input.leaseId, "Payout finality lease ID");
  assertTimestamp(input.checkedAt, "Payout finality check time");
  assertFutureTimestamp(input.nextCheckAt, input.checkedAt, "Payout finality retry time");
  if (input.status !== "ERROR" && input.status !== "UNKNOWN") {
    throw new PayoutFinalityJobIntegrityError("Payout finality retry status is invalid");
  }
}

function assertRecordIncident(input: RecordPayoutIncidentInput): void {
  assertIdentifier(input.intentId, "Payout finality intent ID");
  assertIdentifier(input.leaseId, "Payout finality lease ID");
  assertTimestamp(input.checkedAt, "Payout finality check time");
  assertPayoutIncidentAlert(input.alert);
}

function assertAlertCompletion(input: CompletePayoutIncidentAlertInput): void {
  assertAlertId(input.alertId);
  assertIdentifier(input.leaseId, "Payout incident alert lease ID");
  assertTimestamp(input.deliveredAt, "Payout incident alert delivery time");
}

function assertAlertRetry(input: RetryPayoutIncidentAlertInput): void {
  assertAlertId(input.alertId);
  assertIdentifier(input.leaseId, "Payout incident alert lease ID");
  assertTimestamp(input.attemptedAt, "Payout incident alert attempt time");
  assertFutureTimestamp(input.nextAttemptAt, input.attemptedAt, "Payout incident alert retry time");
}

function assertAlertId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !PAYOUT_INCIDENT_ALERT_ID.test(value)) {
    throw new PayoutFinalityJobIntegrityError("Payout incident alert ID is invalid");
  }
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAXIMUM_IDENTIFIER_LENGTH ||
    containsControlCharacter(value)
  ) {
    throw new PayoutFinalityJobIntegrityError(`${label} is invalid`);
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PayoutFinalityJobIntegrityError(`${label} is invalid`);
  }
}

function assertFutureTimestamp(
  value: unknown,
  now: number,
  label: string,
): asserts value is number {
  assertTimestamp(value, label);
  if (value <= now) {
    throw new PayoutFinalityJobIntegrityError(`${label} is invalid`);
  }
}

function assertCounter(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PayoutFinalityJobIntegrityError(`${label} is invalid`);
  }
}

function withoutWatchLease(watch: InMemoryWatch): InMemoryWatch {
  const { leaseExpiresAt: _leaseExpiresAt, leaseId: _leaseId, ...unleased } = watch;
  return unleased;
}

function withoutAlertLease(alert: InMemoryAlert): InMemoryAlert {
  const { leaseExpiresAt: _leaseExpiresAt, leaseId: _leaseId, ...unleased } = alert;
  return unleased;
}

function sameWatchIdentity(
  left: TerminalPayoutWatchCandidate,
  right: TerminalPayoutWatchCandidate,
): boolean {
  return (
    left.intentId === right.intentId &&
    left.quoteId === right.quoteId &&
    sameProfile(left.profile, right.profile)
  );
}

function sameProfile(left: SettlementProfile, right: SettlementProfile): boolean {
  return (
    left.method === right.method &&
    left.network === right.network &&
    left.tokenContract === right.tokenContract
  );
}

function sameAlert(left: PayoutIncidentAlert, right: PayoutIncidentAlert): boolean {
  return (
    left.alertId === right.alertId &&
    derivePayoutIncidentAlert(left.pause).alertId === right.alertId
  );
}

function compareWatches(left: InMemoryWatch, right: InMemoryWatch): number {
  return left.nextCheckAt - right.nextCheckAt || left.intentId.localeCompare(right.intentId);
}

function compareAlerts(left: InMemoryAlert, right: InMemoryAlert): number {
  return left.nextAttemptAt - right.nextAttemptAt || left.alertId.localeCompare(right.alertId);
}

function profileKey(profile: SettlementProfile): string {
  return JSON.stringify([profile.method, profile.network, profile.tokenContract]);
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

const PAYOUT_INCIDENT_ALERT_ID = /^payout_incident_[0-9a-f]{64}$/;
const MAXIMUM_IDENTIFIER_LENGTH = 512;
export const MAXIMUM_PAYOUT_FINALITY_BATCH_SIZE = 100;
const MAXIMUM_BATCH_SIZE = MAXIMUM_PAYOUT_FINALITY_BATCH_SIZE;
