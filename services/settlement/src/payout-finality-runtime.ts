import type {
  PayoutFinalityRunSummary,
  PayoutIncidentAlertRunSummary,
} from "./payout-finality-scheduler.js";

export interface PayoutFinalityRuntimeScheduler {
  runDue(): Promise<PayoutFinalityRunSummary>;
}

export interface PayoutFinalityRuntimeAlertDispatcher {
  runDue(): Promise<PayoutIncidentAlertRunSummary>;
}

export interface PayoutFinalityRuntimeTimer {
  schedule(callback: () => Promise<void>, delayMilliseconds: number): unknown;
  cancel(handle: unknown): void;
}

export interface PayoutFinalityRuntimeConfig {
  readonly scheduler: PayoutFinalityRuntimeScheduler;
  readonly alertDispatcher: PayoutFinalityRuntimeAlertDispatcher;
  readonly intervalMilliseconds: number;
  readonly now?: () => Date;
  readonly timer?: PayoutFinalityRuntimeTimer;
}

export interface PayoutFinalityRuntimeCycle {
  readonly status: "DEGRADED" | "HEALTHY";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly finality:
    | { readonly status: "FAILED" }
    | { readonly status: "SUCCEEDED"; readonly summary: PayoutFinalityRunSummary };
  readonly alerts:
    | { readonly status: "FAILED" }
    | { readonly status: "SUCCEEDED"; readonly summary: PayoutIncidentAlertRunSummary };
}

export interface PayoutFinalityRuntimeSnapshot {
  readonly state: "RUNNING" | "STOPPED" | "STOPPING";
  readonly runtimeStartedAt?: string;
  readonly cycleInProgress: boolean;
  readonly cycleStartedAt?: string;
  readonly cyclesCompleted: number;
  readonly consecutiveDegradedCycles: number;
  readonly lastCycle?: PayoutFinalityRuntimeCycle;
}

export class PayoutFinalityRuntimeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayoutFinalityRuntimeConfigurationError";
  }
}

export class PayoutFinalityRuntimeBusyError extends Error {
  constructor(message = "A payout finality runtime cycle is already in progress") {
    super(message);
    this.name = "PayoutFinalityRuntimeBusyError";
  }
}

export class PayoutFinalityRuntimeIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayoutFinalityRuntimeIntegrityError";
  }
}

type FinalityResult = PayoutFinalityRuntimeCycle["finality"];
type AlertResult = PayoutFinalityRuntimeCycle["alerts"];

export class PayoutFinalityRuntime {
  readonly #scheduler: PayoutFinalityRuntimeScheduler;
  readonly #alertDispatcher: PayoutFinalityRuntimeAlertDispatcher;
  readonly #intervalMilliseconds: number;
  readonly #now: () => Date;
  readonly #timer: PayoutFinalityRuntimeTimer;
  #running = false;
  #timerHandle: unknown;
  #cycle: Promise<PayoutFinalityRuntimeCycle> | undefined;
  #stopping: Promise<void> | undefined;
  #runtimeStartedAt: string | undefined;
  #cycleStartedAt: string | undefined;
  #cyclesCompleted = 0;
  #consecutiveDegradedCycles = 0;
  #lastCycle: PayoutFinalityRuntimeCycle | undefined;

  constructor(config: PayoutFinalityRuntimeConfig) {
    assertDependency(config?.scheduler, "payout finality scheduler");
    assertDependency(config?.alertDispatcher, "payout incident alert dispatcher");
    if (
      !Number.isSafeInteger(config.intervalMilliseconds) ||
      config.intervalMilliseconds < 1 ||
      config.intervalMilliseconds > MAXIMUM_RUNTIME_INTERVAL_MILLISECONDS
    ) {
      throw new PayoutFinalityRuntimeConfigurationError(
        "Configured payout finality runtime interval is invalid",
      );
    }
    if (config.now !== undefined && typeof config.now !== "function") {
      throw new PayoutFinalityRuntimeConfigurationError(
        "Configured payout finality runtime clock is invalid",
      );
    }
    assertTimer(config.timer);
    this.#scheduler = config.scheduler;
    this.#alertDispatcher = config.alertDispatcher;
    this.#intervalMilliseconds = config.intervalMilliseconds;
    this.#now = config.now ?? (() => new Date());
    this.#timer = config.timer ?? SYSTEM_TIMER;
  }

  start(): void {
    if (this.#stopping !== undefined) {
      throw new PayoutFinalityRuntimeBusyError(
        "Payout finality runtime shutdown is still in progress",
      );
    }
    if (this.#running) {
      return;
    }
    const runtimeStartedAt = runtimeTimestamp(this.#now, "startup");
    this.#running = true;
    this.#runtimeStartedAt = runtimeStartedAt;
    try {
      this.#schedule(0);
    } catch (error) {
      this.#running = false;
      this.#runtimeStartedAt = undefined;
      throw error;
    }
  }

  stop(): Promise<void> {
    if (this.#stopping !== undefined) {
      return this.#stopping;
    }
    if (!this.#running && this.#timerHandle === undefined && this.#cycle === undefined) {
      return Promise.resolve();
    }
    this.#running = false;
    const timerHandle = this.#timerHandle;
    this.#timerHandle = undefined;
    const stopping = this.#completeStop(timerHandle, this.#cycle);
    this.#stopping = stopping;
    const clearStopping = () => {
      if (this.#stopping === stopping) {
        this.#stopping = undefined;
        this.#runtimeStartedAt = undefined;
      }
    };
    void stopping.then(clearStopping, clearStopping);
    return stopping;
  }

  async runOnce(): Promise<PayoutFinalityRuntimeCycle> {
    if (this.#stopping !== undefined) {
      throw new PayoutFinalityRuntimeBusyError(
        "Payout finality runtime shutdown is still in progress",
      );
    }
    if (this.#cycle !== undefined) {
      throw new PayoutFinalityRuntimeBusyError();
    }
    const startedAt = runtimeTimestamp(this.#now, "start");
    this.#cycleStartedAt = startedAt;
    const cycle = this.#executeCycle(startedAt);
    this.#cycle = cycle;
    try {
      const completed = await cycle;
      this.#lastCycle = cloneCycle(completed);
      this.#cyclesCompleted = incrementCounter(this.#cyclesCompleted);
      this.#consecutiveDegradedCycles =
        completed.status === "DEGRADED" ? incrementCounter(this.#consecutiveDegradedCycles) : 0;
      return cloneCycle(completed);
    } finally {
      if (this.#cycle === cycle) {
        this.#cycle = undefined;
        this.#cycleStartedAt = undefined;
      }
    }
  }

  snapshot(): PayoutFinalityRuntimeSnapshot {
    const state = this.#running ? "RUNNING" : this.#stopping === undefined ? "STOPPED" : "STOPPING";
    return {
      state,
      ...(state === "STOPPED" || this.#runtimeStartedAt === undefined
        ? {}
        : { runtimeStartedAt: this.#runtimeStartedAt }),
      cycleInProgress: this.#cycle !== undefined,
      ...(this.#cycleStartedAt === undefined ? {} : { cycleStartedAt: this.#cycleStartedAt }),
      cyclesCompleted: this.#cyclesCompleted,
      consecutiveDegradedCycles: this.#consecutiveDegradedCycles,
      ...(this.#lastCycle === undefined ? {} : { lastCycle: cloneCycle(this.#lastCycle) }),
    };
  }

  async #executeCycle(startedAt: string): Promise<PayoutFinalityRuntimeCycle> {
    const finality = await this.#runFinality();
    const alerts = await this.#runAlerts();
    const completedAt = runtimeTimestamp(this.#now, "completion");
    if (Date.parse(completedAt) < Date.parse(startedAt)) {
      throw new PayoutFinalityRuntimeIntegrityError(
        "Payout finality runtime clock moved backwards during a cycle",
      );
    }
    return {
      status:
        finality.status === "SUCCEEDED" && alerts.status === "SUCCEEDED" ? "HEALTHY" : "DEGRADED",
      startedAt,
      completedAt,
      finality,
      alerts,
    };
  }

  async #runFinality(): Promise<FinalityResult> {
    try {
      return { status: "SUCCEEDED", summary: finalitySummary(await this.#scheduler.runDue()) };
    } catch {
      return { status: "FAILED" };
    }
  }

  async #runAlerts(): Promise<AlertResult> {
    try {
      return {
        status: "SUCCEEDED",
        summary: alertSummary(await this.#alertDispatcher.runDue()),
      };
    } catch {
      return { status: "FAILED" };
    }
  }

  async #completeStop(
    timerHandle: unknown,
    cycle: Promise<PayoutFinalityRuntimeCycle> | undefined,
  ): Promise<void> {
    let cancellationFailed = false;
    if (timerHandle !== undefined) {
      try {
        this.#timer.cancel(timerHandle);
      } catch {
        cancellationFailed = true;
      }
    }
    if (cycle !== undefined) {
      try {
        await cycle;
      } catch {
        // Shutdown waits for ownership to settle but does not expose a cycle's private failure.
      }
    }
    if (cancellationFailed) {
      throw new PayoutFinalityRuntimeIntegrityError(
        "Payout finality runtime timer could not be cancelled",
      );
    }
  }

  #schedule(delayMilliseconds: number): void {
    try {
      const timerHandle = this.#timer.schedule(
        async () => this.#runScheduledCycle(),
        delayMilliseconds,
      );
      if (timerHandle === undefined) {
        throw new Error("invalid timer handle");
      }
      this.#timerHandle = timerHandle;
    } catch {
      this.#timerHandle = undefined;
      throw new PayoutFinalityRuntimeIntegrityError(
        "Payout finality runtime timer could not be scheduled",
      );
    }
  }

  async #runScheduledCycle(): Promise<void> {
    this.#timerHandle = undefined;
    if (!this.#running) {
      return;
    }
    try {
      if (this.#cycle === undefined) {
        await this.runOnce();
      }
    } catch (error) {
      // Timer callbacks never expose dependency or clock details as unhandled failures.
      if (error instanceof PayoutFinalityRuntimeIntegrityError) {
        this.#running = false;
        this.#runtimeStartedAt = undefined;
      }
    } finally {
      if (this.#running) {
        try {
          this.#schedule(this.#intervalMilliseconds);
        } catch {
          this.#running = false;
          this.#runtimeStartedAt = undefined;
        }
      }
    }
  }
}

function finalitySummary(value: PayoutFinalityRunSummary): PayoutFinalityRunSummary {
  try {
    const summary = {
      claimed: counter(value.claimed),
      healthy: counter(value.healthy),
      ambiguous: counter(value.ambiguous),
      incidents: counter(value.incidents),
      failed: counter(value.failed),
    };
    if (
      summary.claimed !==
      summary.healthy + summary.ambiguous + summary.incidents + summary.failed
    ) {
      throw new Error("invalid summary");
    }
    return summary;
  } catch {
    throw new PayoutFinalityRuntimeIntegrityError(
      "Payout finality scheduler returned an invalid summary",
    );
  }
}

function alertSummary(value: PayoutIncidentAlertRunSummary): PayoutIncidentAlertRunSummary {
  try {
    const summary = {
      claimed: counter(value.claimed),
      delivered: counter(value.delivered),
      failed: counter(value.failed),
    };
    if (summary.claimed !== summary.delivered + summary.failed) {
      throw new Error("invalid summary");
    }
    return summary;
  } catch {
    throw new PayoutFinalityRuntimeIntegrityError(
      "Payout incident alert dispatcher returned an invalid summary",
    );
  }
}

function counter(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("invalid counter");
  }
  return value as number;
}

function assertDependency(value: unknown, label: string): void {
  let valid = false;
  try {
    valid =
      typeof value === "object" &&
      value !== null &&
      typeof (value as { readonly runDue?: unknown }).runDue === "function";
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new PayoutFinalityRuntimeConfigurationError(`Configured ${label} is invalid`);
  }
}

function assertTimer(value: PayoutFinalityRuntimeTimer | undefined): void {
  if (value === undefined) {
    return;
  }
  let valid = false;
  try {
    valid = typeof value.schedule === "function" && typeof value.cancel === "function";
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new PayoutFinalityRuntimeConfigurationError(
      "Configured payout finality runtime timer is invalid",
    );
  }
}

function runtimeTimestamp(now: () => Date, stage: "completion" | "start" | "startup"): string {
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
    throw new PayoutFinalityRuntimeIntegrityError(
      `Payout finality runtime ${stage} clock is invalid`,
    );
  }
}

function cloneCycle(cycle: PayoutFinalityRuntimeCycle): PayoutFinalityRuntimeCycle {
  return {
    status: cycle.status,
    startedAt: cycle.startedAt,
    completedAt: cycle.completedAt,
    finality:
      cycle.finality.status === "FAILED"
        ? { status: "FAILED" }
        : { status: "SUCCEEDED", summary: { ...cycle.finality.summary } },
    alerts:
      cycle.alerts.status === "FAILED"
        ? { status: "FAILED" }
        : { status: "SUCCEEDED", summary: { ...cycle.alerts.summary } },
  };
}

function incrementCounter(value: number): number {
  return value === Number.MAX_SAFE_INTEGER ? value : value + 1;
}

const SYSTEM_TIMER: PayoutFinalityRuntimeTimer = {
  schedule(callback, delayMilliseconds) {
    return setTimeout(() => {
      void callback();
    }, delayMilliseconds);
  },
  cancel(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

const MAXIMUM_RUNTIME_INTERVAL_MILLISECONDS = 60 * 60 * 1_000;
