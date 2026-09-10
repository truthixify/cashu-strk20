import type {
  PayoutFinalityRuntimeCycle,
  PayoutFinalityRuntimeSnapshot,
} from "./payout-finality-runtime.js";

export interface PayoutFinalityRuntimeHealthConfig {
  readonly maximumCycleDurationMilliseconds: number;
  readonly maximumIdleDurationMilliseconds: number;
  readonly unhealthyAfterConsecutiveDegradedCycles: number;
  readonly now?: () => Date;
}

export type PayoutFinalityRuntimeHealthStatus = "DEGRADED" | "HEALTHY" | "STARTING" | "UNHEALTHY";

export type PayoutFinalityRuntimeHealthReason =
  | "AWAITING_FIRST_CYCLE"
  | "COMPLETION_STALE"
  | "CYCLE_STALLED"
  | "DEGRADED_CYCLE_STREAK"
  | "RUNTIME_STOPPED"
  | "RUNTIME_STOPPING";

export interface PayoutFinalityRuntimeHealthReport {
  readonly status: PayoutFinalityRuntimeHealthStatus;
  readonly checkedAt: string;
  readonly reasons: readonly PayoutFinalityRuntimeHealthReason[];
}

export class PayoutFinalityRuntimeHealthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayoutFinalityRuntimeHealthConfigurationError";
  }
}

export class PayoutFinalityRuntimeHealthIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayoutFinalityRuntimeHealthIntegrityError";
  }
}

interface ValidatedSnapshot {
  readonly state: PayoutFinalityRuntimeSnapshot["state"];
  readonly runtimeStartedAtMilliseconds?: number;
  readonly cycleStartedAtMilliseconds?: number;
  readonly cyclesCompleted: number;
  readonly consecutiveDegradedCycles: number;
  readonly lastCycleCompletedAtMilliseconds?: number;
}

export class PayoutFinalityRuntimeHealthEvaluator {
  readonly #maximumCycleDurationMilliseconds: number;
  readonly #maximumIdleDurationMilliseconds: number;
  readonly #unhealthyAfterConsecutiveDegradedCycles: number;
  readonly #now: () => Date;

  constructor(config: PayoutFinalityRuntimeHealthConfig) {
    this.#maximumCycleDurationMilliseconds = healthPolicyInteger(
      healthConfigProperty(config, "maximumCycleDurationMilliseconds"),
      "maximum cycle duration",
    );
    this.#maximumIdleDurationMilliseconds = healthPolicyInteger(
      healthConfigProperty(config, "maximumIdleDurationMilliseconds"),
      "maximum idle duration",
    );
    this.#unhealthyAfterConsecutiveDegradedCycles = healthPolicyInteger(
      healthConfigProperty(config, "unhealthyAfterConsecutiveDegradedCycles"),
      "degraded-cycle threshold",
    );
    const configuredNow = healthConfigProperty(config, "now");
    if (configuredNow !== undefined && typeof configuredNow !== "function") {
      throw new PayoutFinalityRuntimeHealthConfigurationError(
        "Configured payout finality runtime health clock is invalid",
      );
    }
    this.#now = (configuredNow as (() => Date) | undefined) ?? (() => new Date());
  }

  evaluate(snapshot: PayoutFinalityRuntimeSnapshot): PayoutFinalityRuntimeHealthReport {
    const checkedAt = healthTimestamp(this.#now);
    const checkedAtMilliseconds = Date.parse(checkedAt);
    const validated = validateSnapshot(snapshot, checkedAtMilliseconds);

    if (validated.state === "STOPPED") {
      return report("UNHEALTHY", checkedAt, ["RUNTIME_STOPPED"]);
    }
    if (validated.state === "STOPPING") {
      return report("UNHEALTHY", checkedAt, ["RUNTIME_STOPPING"]);
    }

    const reasons: PayoutFinalityRuntimeHealthReason[] = [];
    if (validated.cycleStartedAtMilliseconds !== undefined) {
      if (
        checkedAtMilliseconds - validated.cycleStartedAtMilliseconds >=
        this.#maximumCycleDurationMilliseconds
      ) {
        reasons.push("CYCLE_STALLED");
      }
    } else {
      const lastProgressAt =
        validated.lastCycleCompletedAtMilliseconds ?? validated.runtimeStartedAtMilliseconds;
      if (
        lastProgressAt === undefined ||
        checkedAtMilliseconds - lastProgressAt >= this.#maximumIdleDurationMilliseconds
      ) {
        reasons.push("COMPLETION_STALE");
      }
    }

    if (validated.consecutiveDegradedCycles > 0) {
      reasons.push("DEGRADED_CYCLE_STREAK");
    }

    const hasLivenessFailure = reasons.some(
      (reason) => reason === "CYCLE_STALLED" || reason === "COMPLETION_STALE",
    );
    if (
      hasLivenessFailure ||
      validated.consecutiveDegradedCycles >= this.#unhealthyAfterConsecutiveDegradedCycles
    ) {
      return report("UNHEALTHY", checkedAt, reasons);
    }
    if (validated.cyclesCompleted === 0) {
      return report("STARTING", checkedAt, ["AWAITING_FIRST_CYCLE"]);
    }
    if (validated.consecutiveDegradedCycles > 0) {
      return report("DEGRADED", checkedAt, reasons);
    }
    return report("HEALTHY", checkedAt, []);
  }
}

function healthPolicyInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new PayoutFinalityRuntimeHealthConfigurationError(
      `Configured payout finality runtime health ${label} is invalid`,
    );
  }
  return value as number;
}

function healthConfigProperty(
  value: unknown,
  property: keyof PayoutFinalityRuntimeHealthConfig,
): unknown {
  try {
    return typeof value === "object" && value !== null ? Reflect.get(value, property) : undefined;
  } catch {
    throw new PayoutFinalityRuntimeHealthConfigurationError(
      "Configured payout finality runtime health policy is invalid",
    );
  }
}

function healthTimestamp(now: () => Date): string {
  try {
    const value: unknown = now();
    if (!(value instanceof Date)) {
      throw new Error("invalid clock");
    }
    const milliseconds = Date.prototype.getTime.call(value);
    if (!Number.isFinite(milliseconds)) {
      throw new Error("invalid clock");
    }
    return new Date(milliseconds).toISOString();
  } catch {
    throw new PayoutFinalityRuntimeHealthIntegrityError(
      "Payout finality runtime health clock is invalid",
    );
  }
}

function validateSnapshot(
  value: PayoutFinalityRuntimeSnapshot,
  checkedAtMilliseconds: number,
): ValidatedSnapshot {
  try {
    if (typeof value !== "object" || value === null) {
      throw new Error("invalid snapshot");
    }
    const state = runtimeState(value.state);
    const runtimeStartedAtMilliseconds = optionalTimestamp(
      value.runtimeStartedAt,
      checkedAtMilliseconds,
    );
    if (
      (state === "RUNNING" && runtimeStartedAtMilliseconds === undefined) ||
      (state === "STOPPED" && runtimeStartedAtMilliseconds !== undefined)
    ) {
      throw new Error("invalid runtime start");
    }

    const cycleInProgress = value.cycleInProgress;
    if (typeof cycleInProgress !== "boolean") {
      throw new Error("invalid cycle state");
    }
    const cycleStartedAtMilliseconds = optionalTimestamp(
      value.cycleStartedAt,
      checkedAtMilliseconds,
    );
    if (cycleInProgress !== (cycleStartedAtMilliseconds !== undefined)) {
      throw new Error("invalid cycle start");
    }

    const cyclesCompleted = counter(value.cyclesCompleted);
    const consecutiveDegradedCycles = counter(value.consecutiveDegradedCycles);
    if (consecutiveDegradedCycles > cyclesCompleted) {
      throw new Error("invalid degraded count");
    }

    const lastCycle = value.lastCycle;
    if ((cyclesCompleted === 0) !== (lastCycle === undefined)) {
      throw new Error("invalid last cycle presence");
    }
    const validatedLastCycle =
      lastCycle === undefined ? undefined : validateCycle(lastCycle, checkedAtMilliseconds);
    if (
      validatedLastCycle !== undefined &&
      ((validatedLastCycle.status === "HEALTHY" && consecutiveDegradedCycles !== 0) ||
        (validatedLastCycle.status === "DEGRADED" && consecutiveDegradedCycles === 0))
    ) {
      throw new Error("invalid degraded count");
    }
    if (
      cycleStartedAtMilliseconds !== undefined &&
      validatedLastCycle !== undefined &&
      cycleStartedAtMilliseconds < validatedLastCycle.completedAtMilliseconds
    ) {
      throw new Error("overlapping cycles");
    }

    return {
      state,
      ...(runtimeStartedAtMilliseconds === undefined ? {} : { runtimeStartedAtMilliseconds }),
      ...(cycleStartedAtMilliseconds === undefined ? {} : { cycleStartedAtMilliseconds }),
      cyclesCompleted,
      consecutiveDegradedCycles,
      ...(validatedLastCycle === undefined
        ? {}
        : { lastCycleCompletedAtMilliseconds: validatedLastCycle.completedAtMilliseconds }),
    };
  } catch {
    throw new PayoutFinalityRuntimeHealthIntegrityError(
      "Payout finality runtime health snapshot is invalid",
    );
  }
}

function validateCycle(
  value: PayoutFinalityRuntimeCycle,
  checkedAtMilliseconds: number,
): {
  readonly status: PayoutFinalityRuntimeCycle["status"];
  readonly completedAtMilliseconds: number;
} {
  if (typeof value !== "object" || value === null) {
    throw new Error("invalid cycle");
  }
  const status = value.status;
  if (status !== "DEGRADED" && status !== "HEALTHY") {
    throw new Error("invalid cycle status");
  }
  const startedAtMilliseconds = timestamp(value.startedAt, checkedAtMilliseconds);
  const completedAtMilliseconds = timestamp(value.completedAt, checkedAtMilliseconds);
  if (completedAtMilliseconds < startedAtMilliseconds) {
    throw new Error("invalid cycle timing");
  }
  const finalitySucceeded = validateFinality(value.finality);
  const alertsSucceeded = validateAlerts(value.alerts);
  if ((status === "HEALTHY") !== (finalitySucceeded && alertsSucceeded)) {
    throw new Error("invalid cycle result");
  }
  return { status, completedAtMilliseconds };
}

function validateFinality(value: PayoutFinalityRuntimeCycle["finality"]): boolean {
  if (typeof value !== "object" || value === null) {
    throw new Error("invalid finality result");
  }
  const status = value.status;
  if (status === "FAILED") {
    return false;
  }
  if (status !== "SUCCEEDED") {
    throw new Error("invalid finality status");
  }
  const summary = value.summary;
  const claimed = counter(summary.claimed);
  const handled =
    counter(summary.healthy) +
    counter(summary.ambiguous) +
    counter(summary.incidents) +
    counter(summary.failed);
  if (!Number.isSafeInteger(handled) || claimed !== handled) {
    throw new Error("invalid finality summary");
  }
  return true;
}

function validateAlerts(value: PayoutFinalityRuntimeCycle["alerts"]): boolean {
  if (typeof value !== "object" || value === null) {
    throw new Error("invalid alert result");
  }
  const status = value.status;
  if (status === "FAILED") {
    return false;
  }
  if (status !== "SUCCEEDED") {
    throw new Error("invalid alert status");
  }
  const summary = value.summary;
  const claimed = counter(summary.claimed);
  const handled = counter(summary.delivered) + counter(summary.failed);
  if (!Number.isSafeInteger(handled) || claimed !== handled) {
    throw new Error("invalid alert summary");
  }
  return true;
}

function runtimeState(value: unknown): PayoutFinalityRuntimeSnapshot["state"] {
  if (value !== "RUNNING" && value !== "STOPPED" && value !== "STOPPING") {
    throw new Error("invalid runtime state");
  }
  return value;
}

function optionalTimestamp(value: unknown, checkedAtMilliseconds: number): number | undefined {
  return value === undefined ? undefined : timestamp(value, checkedAtMilliseconds);
}

function timestamp(value: unknown, checkedAtMilliseconds: number): number {
  if (typeof value !== "string" || !CANONICAL_TIMESTAMP_LENGTHS.has(value.length)) {
    throw new Error("invalid timestamp");
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value ||
    milliseconds > checkedAtMilliseconds
  ) {
    throw new Error("invalid timestamp");
  }
  return milliseconds;
}

function counter(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("invalid counter");
  }
  return value as number;
}

function report(
  status: PayoutFinalityRuntimeHealthStatus,
  checkedAt: string,
  reasons: readonly PayoutFinalityRuntimeHealthReason[],
): PayoutFinalityRuntimeHealthReport {
  return { status, checkedAt, reasons: [...reasons] };
}

const CANONICAL_TIMESTAMP_LENGTHS = new Set([
  "2000-01-01T00:00:00.000Z".length,
  "+010000-01-01T00:00:00.000Z".length,
]);
