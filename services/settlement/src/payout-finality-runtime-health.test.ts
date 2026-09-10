import { describe, expect, it } from "vitest";
import type {
  PayoutFinalityRuntimeCycle,
  PayoutFinalityRuntimeSnapshot,
} from "./payout-finality-runtime.js";
import {
  PayoutFinalityRuntimeHealthConfigurationError,
  PayoutFinalityRuntimeHealthEvaluator,
  PayoutFinalityRuntimeHealthIntegrityError,
} from "./payout-finality-runtime-health.js";

const CHECKED_AT = "2033-05-18T03:35:00.000Z";
const RUNTIME_STARTED_AT = "2033-05-18T03:30:00.000Z";

describe("payout finality runtime health", () => {
  it("reports a recently completed healthy runtime without private detail", () => {
    const evaluator = createEvaluator();

    expect(evaluator.evaluate(healthySnapshot())).toEqual({
      status: "HEALTHY",
      checkedAt: CHECKED_AT,
      reasons: [],
    });
  });

  it("reports startup while the first cycle remains within its liveness budget", () => {
    const evaluator = createEvaluator();

    expect(
      evaluator.evaluate(
        healthySnapshot({
          runtimeStartedAt: "2033-05-18T03:34:31.000Z",
          cyclesCompleted: 0,
          lastCycle: undefined,
        }),
      ),
    ).toEqual({
      status: "STARTING",
      checkedAt: CHECKED_AT,
      reasons: ["AWAITING_FIRST_CYCLE"],
    });
    expect(
      evaluator.evaluate(
        healthySnapshot({
          runtimeStartedAt: "2033-05-18T03:34:00.000Z",
          cycleInProgress: true,
          cycleStartedAt: "2033-05-18T03:34:31.000Z",
          cyclesCompleted: 0,
          lastCycle: undefined,
        }),
      ),
    ).toMatchObject({ status: "STARTING", reasons: ["AWAITING_FIRST_CYCLE"] });
  });

  it("alarms at the exact idle and active-cycle boundaries", () => {
    const evaluator = createEvaluator();

    expect(
      evaluator.evaluate(
        healthySnapshot({
          runtimeStartedAt: "2033-05-18T03:34:00.000Z",
          cyclesCompleted: 0,
          lastCycle: undefined,
        }),
      ),
    ).toMatchObject({ status: "UNHEALTHY", reasons: ["COMPLETION_STALE"] });
    expect(
      evaluator.evaluate(
        healthySnapshot({
          lastCycle: healthyCycle({
            startedAt: "2033-05-18T03:33:59.000Z",
            completedAt: "2033-05-18T03:34:00.000Z",
          }),
        }),
      ),
    ).toMatchObject({ status: "UNHEALTHY", reasons: ["COMPLETION_STALE"] });
    expect(
      evaluator.evaluate(
        healthySnapshot({
          cycleInProgress: true,
          cycleStartedAt: "2033-05-18T03:34:30.000Z",
        }),
      ),
    ).toMatchObject({ status: "UNHEALTHY", reasons: ["CYCLE_STALLED"] });
  });

  it("distinguishes a recent degraded cycle from a configured degraded streak", () => {
    const evaluator = createEvaluator();
    const degraded = degradedCycle();

    expect(
      evaluator.evaluate(
        healthySnapshot({
          cyclesCompleted: 2,
          lastCycle: degraded,
          consecutiveDegradedCycles: 2,
        }),
      ),
    ).toMatchObject({ status: "DEGRADED", reasons: ["DEGRADED_CYCLE_STREAK"] });
    expect(
      evaluator.evaluate(
        healthySnapshot({
          cyclesCompleted: 3,
          lastCycle: degraded,
          consecutiveDegradedCycles: 3,
        }),
      ),
    ).toMatchObject({ status: "UNHEALTHY", reasons: ["DEGRADED_CYCLE_STREAK"] });
  });

  it("retains deterministic reasons when liveness and worker degradation both fail", () => {
    const evaluator = createEvaluator();

    expect(
      evaluator.evaluate(
        healthySnapshot({
          cycleInProgress: true,
          cycleStartedAt: "2033-05-18T03:34:30.000Z",
          lastCycle: degradedCycle(),
          consecutiveDegradedCycles: 1,
        }),
      ),
    ).toEqual({
      status: "UNHEALTHY",
      checkedAt: CHECKED_AT,
      reasons: ["CYCLE_STALLED", "DEGRADED_CYCLE_STREAK"],
    });
  });

  it("reports stopped and stopping runtimes as unhealthy", () => {
    const evaluator = createEvaluator();

    expect(
      evaluator.evaluate(healthySnapshot({ state: "STOPPED", runtimeStartedAt: undefined })),
    ).toMatchObject({ status: "UNHEALTHY", reasons: ["RUNTIME_STOPPED"] });
    expect(evaluator.evaluate(healthySnapshot({ state: "STOPPING" }))).toMatchObject({
      status: "UNHEALTHY",
      reasons: ["RUNTIME_STOPPING"],
    });
  });

  it.each([
    {
      name: "missing running start",
      change: { runtimeStartedAt: undefined },
    },
    {
      name: "future running start",
      change: { runtimeStartedAt: "2033-05-18T03:35:01.000Z" },
    },
    {
      name: "cycle flag without timestamp",
      change: { cycleInProgress: true },
    },
    {
      name: "cycle timestamp without flag",
      change: { cycleStartedAt: "2033-05-18T03:34:50.000Z" },
    },
    {
      name: "missing completed cycle",
      change: { lastCycle: undefined },
    },
    {
      name: "degraded count beyond completed count",
      change: { consecutiveDegradedCycles: 2 },
    },
    {
      name: "healthy cycle with degraded count",
      change: { consecutiveDegradedCycles: 1 },
    },
    {
      name: "degraded cycle without degraded count",
      change: { lastCycle: degradedCycle() },
    },
    {
      name: "healthy label over failed worker",
      change: {
        lastCycle: healthyCycle({ finality: { status: "FAILED" } }),
      },
    },
    {
      name: "malformed worker summary",
      change: {
        lastCycle: healthyCycle({
          finality: {
            status: "SUCCEEDED",
            summary: { claimed: 1, healthy: 0, ambiguous: 0, incidents: 0, failed: 0 },
          },
        }),
      },
    },
    {
      name: "overlapping completed and active cycles",
      change: {
        cycleInProgress: true,
        cycleStartedAt: "2033-05-18T03:34:30.000Z",
        lastCycle: healthyCycle({ completedAt: "2033-05-18T03:34:31.000Z" }),
      },
    },
  ])("rejects an invalid $name snapshot with a fixed error", ({ change }) => {
    const evaluator = createEvaluator();
    const snapshot = healthySnapshot({
      ...change,
      privateDetail: "quote-secret-1",
    } as unknown as SnapshotChange);

    expect(() => evaluator.evaluate(snapshot)).toThrow(
      new PayoutFinalityRuntimeHealthIntegrityError(
        "Payout finality runtime health snapshot is invalid",
      ),
    );
    try {
      evaluator.evaluate(snapshot);
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain("quote-secret-1");
    }
  });

  it("rejects hostile snapshots and clocks without exposing their failures", () => {
    const evaluator = createEvaluator();
    const hostileSnapshot = new Proxy({} as PayoutFinalityRuntimeSnapshot, {
      get() {
        throw new Error("quote-secret-1");
      },
    });
    expect(() => evaluator.evaluate(hostileSnapshot)).toThrow(
      PayoutFinalityRuntimeHealthIntegrityError,
    );

    const hostileClock = createEvaluator({
      now() {
        throw new Error("private clock configuration");
      },
    });
    expect(() => hostileClock.evaluate(healthySnapshot())).toThrow(
      new PayoutFinalityRuntimeHealthIntegrityError(
        "Payout finality runtime health clock is invalid",
      ),
    );

    const hostileConfig = new Proxy(
      {} as ConstructorParameters<typeof PayoutFinalityRuntimeHealthEvaluator>[0],
      {
        get() {
          throw new Error("private policy configuration");
        },
      },
    );
    expect(() => new PayoutFinalityRuntimeHealthEvaluator(hostileConfig)).toThrow(
      new PayoutFinalityRuntimeHealthConfigurationError(
        "Configured payout finality runtime health policy is invalid",
      ),
    );
  });

  it("rejects unsafe policies with fixed configuration errors", () => {
    for (const change of [
      { maximumCycleDurationMilliseconds: 0 },
      { maximumIdleDurationMilliseconds: 1.5 },
      { unhealthyAfterConsecutiveDegradedCycles: Number.MAX_SAFE_INTEGER + 1 },
      { now: "not-a-clock" },
    ]) {
      expect(() => createEvaluator(change as never)).toThrow(
        PayoutFinalityRuntimeHealthConfigurationError,
      );
    }
  });
});

function createEvaluator(
  change: Partial<ConstructorParameters<typeof PayoutFinalityRuntimeHealthEvaluator>[0]> = {},
): PayoutFinalityRuntimeHealthEvaluator {
  return new PayoutFinalityRuntimeHealthEvaluator({
    maximumCycleDurationMilliseconds: 30_000,
    maximumIdleDurationMilliseconds: 60_000,
    unhealthyAfterConsecutiveDegradedCycles: 3,
    now: () => new Date(CHECKED_AT),
    ...change,
  });
}

function healthySnapshot(change: SnapshotChange = {}): PayoutFinalityRuntimeSnapshot {
  return {
    state: "RUNNING",
    runtimeStartedAt: RUNTIME_STARTED_AT,
    cycleInProgress: false,
    cyclesCompleted: 1,
    consecutiveDegradedCycles: 0,
    lastCycle: healthyCycle(),
    ...change,
  } as unknown as PayoutFinalityRuntimeSnapshot;
}

type SnapshotChange = {
  readonly [Key in keyof PayoutFinalityRuntimeSnapshot]?:
    | PayoutFinalityRuntimeSnapshot[Key]
    | undefined;
} & { readonly privateDetail?: string };

function healthyCycle(
  change: Partial<PayoutFinalityRuntimeCycle> = {},
): PayoutFinalityRuntimeCycle {
  return {
    status: "HEALTHY",
    startedAt: "2033-05-18T03:34:29.000Z",
    completedAt: "2033-05-18T03:34:30.000Z",
    finality: {
      status: "SUCCEEDED",
      summary: { claimed: 0, healthy: 0, ambiguous: 0, incidents: 0, failed: 0 },
    },
    alerts: {
      status: "SUCCEEDED",
      summary: { claimed: 0, delivered: 0, failed: 0 },
    },
    ...change,
  };
}

function degradedCycle(): PayoutFinalityRuntimeCycle {
  return {
    ...healthyCycle(),
    status: "DEGRADED",
    finality: { status: "FAILED" },
  };
}
