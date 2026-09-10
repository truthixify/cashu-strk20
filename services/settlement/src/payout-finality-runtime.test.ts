import { describe, expect, it } from "vitest";

import {
  PayoutFinalityRuntime,
  PayoutFinalityRuntimeBusyError,
  PayoutFinalityRuntimeConfigurationError,
  PayoutFinalityRuntimeIntegrityError,
  type PayoutFinalityRuntimeTimer,
} from "./payout-finality-runtime.js";
import type {
  PayoutFinalityRunSummary,
  PayoutIncidentAlertRunSummary,
} from "./payout-finality-scheduler.js";

describe("payout finality runtime", () => {
  it("runs finality before alerts and exposes a quote-free healthy snapshot", async () => {
    const calls: string[] = [];
    const runtime = createRuntime({
      scheduler: {
        async runDue() {
          calls.push("finality");
          return finalitySummary({ claimed: 1, healthy: 1 });
        },
      },
      alertDispatcher: {
        async runDue() {
          calls.push("alerts");
          return alertSummary({ claimed: 1, delivered: 1 });
        },
      },
    });

    const cycle = await runtime.runOnce();

    expect(calls).toEqual(["finality", "alerts"]);
    expect(cycle).toEqual({
      status: "HEALTHY",
      startedAt: "2033-05-18T03:33:20.000Z",
      completedAt: "2033-05-18T03:33:21.000Z",
      finality: {
        status: "SUCCEEDED",
        summary: { claimed: 1, healthy: 1, ambiguous: 0, incidents: 0, failed: 0 },
      },
      alerts: { status: "SUCCEEDED", summary: { claimed: 1, delivered: 1, failed: 0 } },
    });
    expect(runtime.snapshot()).toMatchObject({
      state: "STOPPED",
      cycleInProgress: false,
      cyclesCompleted: 1,
      consecutiveDegradedCycles: 0,
      lastCycle: cycle,
    });
  });

  it("redacts a finality dependency failure and still dispatches existing alerts", async () => {
    let alertCalls = 0;
    const runtime = createRuntime({
      scheduler: {
        async runDue(): Promise<never> {
          throw new Error("quote-secret-1 at private database path");
        },
      },
      alertDispatcher: {
        async runDue() {
          alertCalls += 1;
          return alertSummary();
        },
      },
    });

    const cycle = await runtime.runOnce();

    expect(cycle).toMatchObject({
      status: "DEGRADED",
      finality: { status: "FAILED" },
      alerts: { status: "SUCCEEDED" },
    });
    expect(alertCalls).toBe(1);
    expect(JSON.stringify({ cycle, snapshot: runtime.snapshot() })).not.toContain("quote-secret");
    expect(runtime.snapshot().consecutiveDegradedCycles).toBe(1);
  });

  it("maps a malformed dependency summary to a fixed degraded result", async () => {
    const runtime = createRuntime({
      scheduler: {
        async runDue() {
          return {
            ...finalitySummary(),
            claimed: 2,
            privateDetail: "quote-secret-1",
          } as PayoutFinalityRunSummary;
        },
      },
    });

    const cycle = await runtime.runOnce();

    expect(cycle.finality).toEqual({ status: "FAILED" });
    expect(JSON.stringify(cycle)).not.toContain("quote-secret");
  });

  it("rejects an overlapping cycle without invoking either worker twice", async () => {
    const deferred = deferredValue<PayoutFinalityRunSummary>();
    let finalityCalls = 0;
    let alertCalls = 0;
    const runtime = createRuntime({
      scheduler: {
        async runDue() {
          finalityCalls += 1;
          return deferred.promise;
        },
      },
      alertDispatcher: {
        async runDue() {
          alertCalls += 1;
          return alertSummary();
        },
      },
    });

    const active = runtime.runOnce();
    await expect(runtime.runOnce()).rejects.toBeInstanceOf(PayoutFinalityRuntimeBusyError);
    expect(runtime.snapshot()).toMatchObject({ cycleInProgress: true, cyclesCompleted: 0 });

    deferred.resolve(finalitySummary());
    await active;

    expect(finalityCalls).toBe(1);
    expect(alertCalls).toBe(1);
  });

  it("starts immediately, repeats at the configured interval, and cancels cleanly", async () => {
    const timer = new ManualTimer();
    let cycles = 0;
    const runtime = createRuntime({
      timer,
      scheduler: {
        async runDue() {
          cycles += 1;
          return finalitySummary();
        },
      },
    });

    runtime.start();
    runtime.start();
    expect(runtime.snapshot()).toMatchObject({
      state: "RUNNING",
      runtimeStartedAt: "2033-05-18T03:33:20.000Z",
    });
    expect(timer.nextDelay()).toBe(0);

    await timer.fireNext();

    expect(cycles).toBe(1);
    expect(timer.nextDelay()).toBe(1_000);
    const stopping = runtime.stop();
    await expect(runtime.runOnce()).rejects.toBeInstanceOf(PayoutFinalityRuntimeBusyError);
    await stopping;
    await runtime.stop();
    expect(timer.size).toBe(0);
    expect(runtime.snapshot()).toMatchObject({ state: "STOPPED", cyclesCompleted: 1 });
    expect(runtime.snapshot()).not.toHaveProperty("runtimeStartedAt");
  });

  it("waits for an active cycle during shutdown", async () => {
    const timer = new ManualTimer();
    const deferred = deferredValue<PayoutFinalityRunSummary>();
    const runtime = createRuntime({
      timer,
      scheduler: {
        async runDue() {
          return deferred.promise;
        },
      },
    });
    runtime.start();
    const scheduled = timer.fireNext();
    await Promise.resolve();

    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(runtime.snapshot().state).toBe("STOPPING");
    expect(() => runtime.start()).toThrow(PayoutFinalityRuntimeBusyError);

    deferred.resolve(finalitySummary());
    await scheduled;
    await stopping;

    expect(stopped).toBe(true);
    expect(runtime.snapshot()).toMatchObject({ state: "STOPPED", cycleInProgress: false });
  });

  it("waits for ownership to settle before reporting timer-cancellation failure", async () => {
    const timer = new FailingCancelTimer();
    const deferred = deferredValue<PayoutFinalityRunSummary>();
    let finalityCalls = 0;
    const runtime = createRuntime({
      timer,
      scheduler: {
        async runDue() {
          finalityCalls += 1;
          return deferred.promise;
        },
      },
    });
    runtime.start();
    const active = runtime.runOnce();
    let stopSettled = false;
    const stopping = runtime.stop().finally(() => {
      stopSettled = true;
    });
    await Promise.resolve();

    expect(stopSettled).toBe(false);
    expect(runtime.snapshot().state).toBe("STOPPING");
    deferred.resolve(finalitySummary());
    await active;
    await expect(stopping).rejects.toEqual(
      new PayoutFinalityRuntimeIntegrityError(
        "Payout finality runtime timer could not be cancelled",
      ),
    );

    expect(stopSettled).toBe(true);
    await timer.fireNext();
    expect(finalityCalls).toBe(1);
    expect(runtime.snapshot().state).toBe("STOPPED");
  });

  it("stops the scheduled loop when its clock loses monotonicity", async () => {
    const timer = new ManualTimer();
    const runtime = createRuntime({
      timer,
      now: sequenceClock(2_000_000_000, 2_000_000_000, 1_999_999_999),
    });
    runtime.start();

    await timer.fireNext();

    expect(runtime.snapshot()).toMatchObject({ state: "STOPPED", cyclesCompleted: 0 });
    expect(timer.size).toBe(0);
  });

  it("rejects unsafe configuration and a clock rollback with fixed errors", async () => {
    expect(() => createRuntime({ intervalMilliseconds: 0 })).toThrow(
      PayoutFinalityRuntimeConfigurationError,
    );
    expect(() =>
      createRuntime({
        scheduler: {} as ConstructorParameters<typeof PayoutFinalityRuntime>[0]["scheduler"],
      }),
    ).toThrow(PayoutFinalityRuntimeConfigurationError);

    const hostileTimer = new Proxy({} as PayoutFinalityRuntimeTimer, {
      get() {
        throw new Error("private timer configuration");
      },
    });
    expect(() => createRuntime({ timer: hostileTimer })).toThrow(
      PayoutFinalityRuntimeConfigurationError,
    );

    const missingHandleTimer: PayoutFinalityRuntimeTimer = {
      schedule() {
        return undefined;
      },
      cancel() {},
    };
    const unscheduled = createRuntime({ timer: missingHandleTimer });
    expect(() => unscheduled.start()).toThrow(PayoutFinalityRuntimeIntegrityError);
    expect(unscheduled.snapshot().state).toBe("STOPPED");
    expect(unscheduled.snapshot()).not.toHaveProperty("runtimeStartedAt");

    const startupTimer = new ManualTimer();
    const invalidStartup = createRuntime({
      timer: startupTimer,
      now: () => new Date(Number.NaN),
    });
    expect(() => invalidStartup.start()).toThrow(
      new PayoutFinalityRuntimeIntegrityError("Payout finality runtime startup clock is invalid"),
    );
    expect(invalidStartup.snapshot()).toMatchObject({ state: "STOPPED", cyclesCompleted: 0 });
    expect(invalidStartup.snapshot()).not.toHaveProperty("runtimeStartedAt");
    expect(startupTimer.size).toBe(0);

    const runtime = createRuntime({
      now: sequenceClock(2_000_000_000, 1_999_999_999),
    });
    await expect(runtime.runOnce()).rejects.toEqual(
      new PayoutFinalityRuntimeIntegrityError(
        "Payout finality runtime clock moved backwards during a cycle",
      ),
    );
    expect(runtime.snapshot()).toMatchObject({ cycleInProgress: false, cyclesCompleted: 0 });
  });
});

function createRuntime(
  change: Partial<ConstructorParameters<typeof PayoutFinalityRuntime>[0]> = {},
): PayoutFinalityRuntime {
  return new PayoutFinalityRuntime({
    scheduler: {
      async runDue() {
        return finalitySummary();
      },
    },
    alertDispatcher: {
      async runDue() {
        return alertSummary();
      },
    },
    intervalMilliseconds: 1_000,
    now: sequenceClock(2_000_000_000, 2_000_000_001),
    ...change,
  });
}

function finalitySummary(change: Partial<PayoutFinalityRunSummary> = {}): PayoutFinalityRunSummary {
  return { claimed: 0, healthy: 0, ambiguous: 0, incidents: 0, failed: 0, ...change };
}

function alertSummary(
  change: Partial<PayoutIncidentAlertRunSummary> = {},
): PayoutIncidentAlertRunSummary {
  return { claimed: 0, delivered: 0, failed: 0, ...change };
}

function sequenceClock(...seconds: number[]): () => Date {
  let index = 0;
  return () => {
    const secondsValue = seconds[Math.min(index, seconds.length - 1)];
    index += 1;
    return new Date((secondsValue ?? Number.NaN) * 1_000);
  };
}

function deferredValue<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) {
        throw new Error("Deferred value is unavailable");
      }
      resolvePromise(value);
    },
  };
}

class ManualTimer implements PayoutFinalityRuntimeTimer {
  readonly #scheduled = new Map<unknown, { callback: () => Promise<void>; delay: number }>();
  #nextHandle = 0;

  get size(): number {
    return this.#scheduled.size;
  }

  schedule(callback: () => Promise<void>, delayMilliseconds: number): unknown {
    const handle = ++this.#nextHandle;
    this.#scheduled.set(handle, { callback, delay: delayMilliseconds });
    return handle;
  }

  cancel(handle: unknown): void {
    this.#scheduled.delete(handle);
  }

  nextDelay(): number | undefined {
    return this.#scheduled.values().next().value?.delay;
  }

  async fireNext(): Promise<void> {
    const entry = this.#scheduled.entries().next().value;
    if (entry === undefined) {
      throw new Error("No runtime timer is scheduled");
    }
    const [handle, scheduled] = entry;
    this.#scheduled.delete(handle);
    await scheduled.callback();
  }
}

class FailingCancelTimer extends ManualTimer {
  override cancel(): void {
    throw new Error("private timer handle");
  }
}
