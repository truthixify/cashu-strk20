import { describe, expect, it } from "vitest";

import {
  InMemoryPayoutFinalityJobStore,
  type PayoutFinalityJobStore,
} from "./payout-finality-jobs.js";
import {
  PayoutFinalityScheduler,
  PayoutFinalitySchedulerConfigurationError,
  PayoutFinalitySchedulerDependencyError,
  PayoutFinalitySchedulerIntegrityError,
  type PayoutFinalitySupervisorRunner,
  PayoutIncidentAlertDispatcher,
  type PayoutIncidentAlertSink,
} from "./payout-finality-scheduler.js";
import type { PayoutFinalitySupervision } from "./payout-finality-supervisor.js";
import type { SettlementPauseRecord } from "./settlement-pauses.js";

const PROFILE = {
  method: "strk20",
  network: "SN_SEPOLIA",
  tokenContract: "0x456",
} as const;

describe("payout finality scheduling", () => {
  it("claims only the configured batch and reschedules healthy watches", async () => {
    const jobStore = new InMemoryPayoutFinalityJobStore();
    await schedule(jobStore, "intent-1", "quote-secret-1");
    await schedule(jobStore, "intent-2", "quote-secret-2");
    await schedule(jobStore, "intent-3", "quote-secret-3");
    const supervisor = new FakeSupervisor(() => healthy("FINAL"));
    const clock = mutableClock(2_000_000_000);
    const scheduler = createScheduler(jobStore, supervisor, clock, { batchSize: 2 });

    const first = await scheduler.runDue();
    const second = await scheduler.runDue();

    expect(first).toEqual({ claimed: 2, healthy: 2, ambiguous: 0, incidents: 0, failed: 0 });
    expect(second).toEqual({ claimed: 1, healthy: 1, ambiguous: 0, incidents: 0, failed: 0 });
    expect(supervisor.calls).toEqual(["quote-secret-1", "quote-secret-2", "quote-secret-3"]);
    expect(JSON.stringify(first)).not.toContain("quote-secret");

    clock.advance(299);
    await expect(scheduler.runDue()).resolves.toMatchObject({ claimed: 0 });
    clock.advance(1);
    await expect(scheduler.runDue()).resolves.toMatchObject({ claimed: 2, healthy: 2 });
  });

  it("applies capped exponential retry to ambiguous observations", async () => {
    const jobStore = new InMemoryPayoutFinalityJobStore();
    await schedule(jobStore, "intent-1", "quote-secret-1");
    const clock = mutableClock(2_000_000_000);
    const scheduler = createScheduler(
      jobStore,
      new FakeSupervisor(() => healthy("UNKNOWN")),
      clock,
      { retryBaseSeconds: 10, maximumRetrySeconds: 25 },
    );

    await expect(scheduler.runDue()).resolves.toMatchObject({ claimed: 1, ambiguous: 1 });
    clock.advance(9);
    await expect(scheduler.runDue()).resolves.toMatchObject({ claimed: 0 });
    clock.advance(1);
    await expect(scheduler.runDue()).resolves.toMatchObject({ claimed: 1, ambiguous: 1 });
    clock.advance(19);
    await expect(scheduler.runDue()).resolves.toMatchObject({ claimed: 0 });
    clock.advance(1);
    await expect(scheduler.runDue()).resolves.toMatchObject({ claimed: 1, ambiguous: 1 });
    clock.advance(24);
    await expect(scheduler.runDue()).resolves.toMatchObject({ claimed: 0 });
    clock.advance(1);
    await expect(scheduler.runDue()).resolves.toMatchObject({ claimed: 1, ambiguous: 1 });
  });

  it("isolates one failed check and continues the bounded batch", async () => {
    const jobStore = new InMemoryPayoutFinalityJobStore();
    await schedule(jobStore, "intent-1", "quote-secret-failure");
    await schedule(jobStore, "intent-2", "quote-secret-healthy");
    const scheduler = createScheduler(
      jobStore,
      new FakeSupervisor((quoteId) => {
        if (quoteId === "quote-secret-failure") {
          throw new Error(`private provider for ${quoteId}`);
        }
        return healthy("FINAL");
      }),
      mutableClock(2_000_000_000),
    );

    const result = await scheduler.runDue();

    expect(result).toEqual({ claimed: 2, healthy: 1, ambiguous: 0, incidents: 0, failed: 1 });
    expect(JSON.stringify(result)).not.toContain("quote-secret");
  });

  it("bounds a supervisor callback that never returns and retries it as an error", async () => {
    const jobStore = new InMemoryPayoutFinalityJobStore();
    await schedule(jobStore, "intent-1", "quote-secret-timeout");
    const scheduler = createScheduler(
      jobStore,
      new FakeSupervisor(() => new Promise<PayoutFinalitySupervision>(() => undefined)),
      mutableClock(2_000_000_000),
      { batchSize: 1, callbackTimeoutMilliseconds: 5 },
    );

    const result = await scheduler.runDue();

    expect(result).toEqual({ claimed: 1, healthy: 0, ambiguous: 0, incidents: 0, failed: 1 });
    expect(JSON.stringify(result)).not.toContain("quote-secret-timeout");
  });

  it("closes an incident watch and delivers one quote-free idempotent alert", async () => {
    const jobStore = new InMemoryPayoutFinalityJobStore();
    await schedule(jobStore, "intent-1", "quote-secret-1");
    const clock = mutableClock(2_000_000_000);
    const scheduler = createScheduler(
      jobStore,
      new FakeSupervisor(() => incident("intent-1")),
      clock,
    );
    const sink = new RecordingAlertSink();
    const dispatcher = createDispatcher(jobStore, sink, clock);

    const checked = await scheduler.runDue();
    const delivered = await dispatcher.runDue();

    expect(checked).toEqual({ claimed: 1, healthy: 0, ambiguous: 0, incidents: 1, failed: 0 });
    expect(delivered).toEqual({ claimed: 1, delivered: 1, failed: 0 });
    expect(sink.alerts).toHaveLength(1);
    expect(sink.alerts[0]).toMatchObject({
      alertId: expect.stringMatching(/^payout_incident_[0-9a-f]{64}$/),
      pause: { reason: "PAYOUT_FINALITY_REORGED", intentId: "intent-1" },
    });
    expect(
      JSON.stringify(sink.alerts, (_key, value) =>
        typeof value === "bigint" ? value.toString(10) : value,
      ),
    ).not.toContain("quote-secret-1");
    await expect(scheduler.runDue()).resolves.toMatchObject({ claimed: 0 });
    await expect(dispatcher.runDue()).resolves.toMatchObject({ claimed: 0 });
  });

  it("retries alert delivery with the same alert ID after a sink failure", async () => {
    const jobStore = new InMemoryPayoutFinalityJobStore();
    await schedule(jobStore, "intent-1", "quote-secret-1");
    const clock = mutableClock(2_000_000_000);
    await createScheduler(jobStore, new FakeSupervisor(() => incident("intent-1")), clock).runDue();
    const sink = new RecordingAlertSink();
    sink.failuresRemaining = 1;
    const dispatcher = createDispatcher(jobStore, sink, clock, { retryBaseSeconds: 10 });

    await expect(dispatcher.runDue()).resolves.toEqual({ claimed: 1, delivered: 0, failed: 1 });
    clock.advance(9);
    await expect(dispatcher.runDue()).resolves.toMatchObject({ claimed: 0 });
    clock.advance(1);
    await expect(dispatcher.runDue()).resolves.toEqual({ claimed: 1, delivered: 1, failed: 0 });

    expect(sink.alerts).toHaveLength(2);
    expect(sink.alerts[0]?.alertId).toBe(sink.alerts[1]?.alertId);
  });

  it("retries the same alert ID after a delivery response deadline", async () => {
    const jobStore = new InMemoryPayoutFinalityJobStore();
    await schedule(jobStore, "intent-1", "quote-secret-1");
    const clock = mutableClock(2_000_000_000);
    await createScheduler(jobStore, new FakeSupervisor(() => incident("intent-1")), clock).runDue();
    let timedOutAlertId: string | undefined;
    const timedOut = createDispatcher(
      jobStore,
      {
        async deliverPayoutIncidentAlert(alert) {
          timedOutAlertId = alert.alertId;
          return new Promise<void>(() => undefined);
        },
      },
      clock,
      { batchSize: 1, callbackTimeoutMilliseconds: 5 },
    );

    await expect(timedOut.runDue()).resolves.toEqual({ claimed: 1, delivered: 0, failed: 1 });
    clock.advance(10);
    const recoveredSink = new RecordingAlertSink();
    await expect(createDispatcher(jobStore, recoveredSink, clock).runDue()).resolves.toEqual({
      claimed: 1,
      delivered: 1,
      failed: 0,
    });

    expect(recoveredSink.alerts[0]?.alertId).toBe(timedOutAlertId);
  });

  it("redelivers the same alert after sink success when its acknowledgement is lost", async () => {
    const jobStore = new FailingAlertCompletionStore();
    await schedule(jobStore, "intent-1", "quote-secret-1");
    const clock = mutableClock(2_000_000_000);
    await createScheduler(jobStore, new FakeSupervisor(() => incident("intent-1")), clock).runDue();
    const sink = new RecordingAlertSink();
    const dispatcher = createDispatcher(jobStore, sink, clock);

    await expect(dispatcher.runDue()).rejects.toEqual(
      new PayoutFinalitySchedulerDependencyError(
        "job_store_unavailable",
        "Payout finality job store is unavailable",
      ),
    );
    expect(sink.alerts).toHaveLength(1);
    clock.advance(60);
    await expect(dispatcher.runDue()).resolves.toEqual({ claimed: 1, delivered: 1, failed: 0 });

    expect(sink.alerts).toHaveLength(2);
    expect(sink.alerts[0]?.alertId).toBe(sink.alerts[1]?.alertId);
  });

  it("does not acknowledge a sink delivery that finishes after its lease expires", async () => {
    const jobStore = new InMemoryPayoutFinalityJobStore();
    await schedule(jobStore, "intent-1", "quote-secret-1");
    const clock = mutableClock(2_000_000_000);
    await createScheduler(jobStore, new FakeSupervisor(() => incident("intent-1")), clock).runDue();
    const sink = new RecordingAlertSink();
    sink.advanceClockOnce = () => clock.advance(60);
    const dispatcher = createDispatcher(jobStore, sink, clock);

    await expect(dispatcher.runDue()).resolves.toEqual({ claimed: 1, delivered: 0, failed: 1 });
    await expect(dispatcher.runDue()).resolves.toEqual({ claimed: 1, delivered: 1, failed: 0 });

    expect(sink.alerts).toHaveLength(2);
    expect(sink.alerts[0]?.alertId).toBe(sink.alerts[1]?.alertId);
  });

  it("reclaims expired leases and rejects a stale worker", async () => {
    const jobStore = new InMemoryPayoutFinalityJobStore();
    await schedule(jobStore, "intent-1", "quote-secret-1");
    const first = await jobStore.claimDuePayoutFinalityWatches({
      leaseId: "lease-first",
      now: 100,
      leaseExpiresAt: 110,
      limit: 1,
    });
    await expect(
      jobStore.claimDuePayoutFinalityWatches({
        leaseId: "lease-early",
        now: 109,
        leaseExpiresAt: 119,
        limit: 1,
      }),
    ).resolves.toEqual([]);
    const reclaimed = await jobStore.claimDuePayoutFinalityWatches({
      leaseId: "lease-second",
      now: 110,
      leaseExpiresAt: 120,
      limit: 1,
    });

    await expect(
      jobStore.completePayoutFinalityWatch({
        intentId: first[0]?.intentId ?? "",
        leaseId: "lease-first",
        checkedAt: 110,
        nextCheckAt: 200,
        status: "FINAL",
      }),
    ).rejects.toThrow("Payout finality watch lease is not active");
    await expect(
      jobStore.completePayoutFinalityWatch({
        intentId: reclaimed[0]?.intentId ?? "",
        leaseId: "lease-second",
        checkedAt: 111,
        nextCheckAt: 200,
        status: "FINAL",
      }),
    ).resolves.toBeUndefined();
  });

  it("does not acknowledge a check that finishes after its lease expires", async () => {
    const jobStore = new InMemoryPayoutFinalityJobStore();
    await schedule(jobStore, "intent-1", "quote-secret-1");
    const clock = mutableClock(2_000_000_000);
    let delayFirstCheck = true;
    const scheduler = createScheduler(
      jobStore,
      new FakeSupervisor(() => {
        if (delayFirstCheck) {
          delayFirstCheck = false;
          clock.advance(60);
        }
        return healthy("FINAL");
      }),
      clock,
    );

    await expect(scheduler.runDue()).resolves.toMatchObject({ claimed: 1, failed: 1 });
    await expect(scheduler.runDue()).resolves.toMatchObject({ claimed: 1, healthy: 1 });
  });

  it("rejects a clock rollback during an external check", async () => {
    const jobStore = new InMemoryPayoutFinalityJobStore();
    await schedule(jobStore, "intent-1", "quote-secret-1");
    const clock = mutableClock(2_000_000_000);
    const scheduler = createScheduler(
      jobStore,
      new FakeSupervisor(() => {
        clock.advance(-1);
        return healthy("FINAL");
      }),
      clock,
    );

    await expect(scheduler.runDue()).rejects.toBeInstanceOf(PayoutFinalitySchedulerIntegrityError);
  });

  it("redacts job-store failures and rejects malformed configuration", async () => {
    const jobStore = new FailingClaimStore();
    const scheduler = createScheduler(
      jobStore,
      new FakeSupervisor(() => healthy("FINAL")),
      mutableClock(2_000_000_000),
    );

    await expect(scheduler.runDue()).rejects.toEqual(
      new PayoutFinalitySchedulerDependencyError(
        "job_store_unavailable",
        "Payout finality job store is unavailable",
      ),
    );
    expect(() =>
      createScheduler(
        {} as PayoutFinalityJobStore,
        new FakeSupervisor(() => healthy("FINAL")),
        mutableClock(2_000_000_000),
      ),
    ).toThrowError(PayoutFinalitySchedulerConfigurationError);
    expect(() =>
      createScheduler(
        new InMemoryPayoutFinalityJobStore(),
        new FakeSupervisor(() => healthy("FINAL")),
        mutableClock(2_000_000_000),
        { callbackTimeoutMilliseconds: 6_000 },
      ),
    ).toThrowError(PayoutFinalitySchedulerConfigurationError);
    expect(() =>
      createDispatcher(
        new InMemoryPayoutFinalityJobStore(),
        new RecordingAlertSink(),
        mutableClock(2_000_000_000),
        { callbackTimeoutMilliseconds: 6_000 },
      ),
    ).toThrowError(PayoutFinalitySchedulerConfigurationError);
    const hostileStore = new Proxy({} as PayoutFinalityJobStore, {
      get() {
        throw new Error("private configuration value");
      },
    });
    expect(() =>
      createScheduler(
        hostileStore,
        new FakeSupervisor(() => healthy("FINAL")),
        mutableClock(2_000_000_000),
      ),
    ).toThrowError(PayoutFinalitySchedulerConfigurationError);
  });

  it("maps a hostile claimed collection to a value-free integrity error", async () => {
    const scheduler = createScheduler(
      new HostileClaimStore(),
      new FakeSupervisor(() => healthy("FINAL")),
      mutableClock(2_000_000_000),
    );

    await expect(scheduler.runDue()).rejects.toEqual(
      new PayoutFinalitySchedulerIntegrityError(
        "Payout finality job store returned an invalid watch batch",
      ),
    );
  });
});

async function schedule(
  store: PayoutFinalityJobStore,
  intentId: string,
  quoteId: string,
): Promise<void> {
  await store.scheduleTerminalPayout({ intentId, quoteId, profile: PROFILE, nextCheckAt: 0 });
}

function healthy(status: "FINAL" | "REVERTED" | "UNKNOWN"): PayoutFinalitySupervision {
  return { profile: PROFILE, status, paused: false };
}

function incident(intentId: string): PayoutFinalitySupervision {
  const pause: SettlementPauseRecord = {
    profile: PROFILE,
    reason: "PAYOUT_FINALITY_REORGED",
    intentId,
    submissionId: `submission-${intentId}`,
    transactionReference: "0xabc",
    originalInclusion: { blockHash: "0xdef", blockNumber: 42n },
    detectedAt: "2026-09-01T10:00:00.000Z",
    observerVersion: "observer-v1",
  };
  return { profile: PROFILE, status: "REORGED", paused: true, pause };
}

class FakeSupervisor implements PayoutFinalitySupervisorRunner {
  readonly calls: string[] = [];

  constructor(
    readonly result: (
      quoteId: string,
    ) => PayoutFinalitySupervision | Promise<PayoutFinalitySupervision> | never,
  ) {}

  async checkAndPause(quoteId: string): Promise<PayoutFinalitySupervision> {
    this.calls.push(quoteId);
    return await this.result(quoteId);
  }
}

class RecordingAlertSink implements PayoutIncidentAlertSink {
  readonly alerts: Parameters<PayoutIncidentAlertSink["deliverPayoutIncidentAlert"]>[0][] = [];
  failuresRemaining = 0;
  advanceClockOnce: (() => void) | undefined;

  async deliverPayoutIncidentAlert(
    alert: Parameters<PayoutIncidentAlertSink["deliverPayoutIncidentAlert"]>[0],
  ): Promise<void> {
    this.alerts.push(structuredClone(alert));
    this.advanceClockOnce?.();
    this.advanceClockOnce = undefined;
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error(`private sink for ${alert.pause.intentId}`);
    }
  }
}

class FailingAlertCompletionStore extends InMemoryPayoutFinalityJobStore {
  failuresRemaining = 1;

  override async completePayoutIncidentAlert(
    input: Parameters<PayoutFinalityJobStore["completePayoutIncidentAlert"]>[0],
  ): Promise<void> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("private database path and quote-secret");
    }
    await super.completePayoutIncidentAlert(input);
  }
}

class FailingClaimStore extends InMemoryPayoutFinalityJobStore {
  override async claimDuePayoutFinalityWatches(): Promise<never> {
    throw new Error("private database path and quote-secret");
  }
}

class HostileClaimStore extends InMemoryPayoutFinalityJobStore {
  override async claimDuePayoutFinalityWatches(): Promise<readonly never[]> {
    return new Proxy([], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          throw new Error("private claimed value");
        }
        return Reflect.get(target, property, receiver);
      },
    });
  }
}

function createScheduler(
  jobStore: PayoutFinalityJobStore,
  supervisor: PayoutFinalitySupervisorRunner,
  clock: ReturnType<typeof mutableClock>,
  change: Partial<{
    batchSize: number;
    callbackTimeoutMilliseconds: number;
    leaseSeconds: number;
    retryBaseSeconds: number;
    maximumRetrySeconds: number;
  }> = {},
): PayoutFinalityScheduler {
  let lease = 0;
  const createLeaseId = () => {
    lease += 1;
    return `watch-lease-${lease}`;
  };
  return new PayoutFinalityScheduler({
    supervisor,
    jobStore,
    batchSize: change.batchSize ?? 10,
    leaseSeconds: change.leaseSeconds ?? 60,
    callbackTimeoutMilliseconds: change.callbackTimeoutMilliseconds ?? 5_000,
    healthyCheckIntervalSeconds: 300,
    retryBaseSeconds: change.retryBaseSeconds ?? 10,
    maximumRetrySeconds: change.maximumRetrySeconds ?? 60,
    now: clock.now,
    createLeaseId,
  });
}

function createDispatcher(
  jobStore: PayoutFinalityJobStore,
  sink: PayoutIncidentAlertSink,
  clock: ReturnType<typeof mutableClock>,
  change: Partial<{
    batchSize: number;
    callbackTimeoutMilliseconds: number;
    leaseSeconds: number;
    retryBaseSeconds: number;
    maximumRetrySeconds: number;
  }> = {},
): PayoutIncidentAlertDispatcher {
  let lease = 0;
  const createLeaseId = () => {
    lease += 1;
    return `alert-lease-${lease}`;
  };
  return new PayoutIncidentAlertDispatcher({
    sink,
    jobStore,
    batchSize: change.batchSize ?? 10,
    leaseSeconds: change.leaseSeconds ?? 60,
    callbackTimeoutMilliseconds: change.callbackTimeoutMilliseconds ?? 5_000,
    retryBaseSeconds: change.retryBaseSeconds ?? 10,
    maximumRetrySeconds: change.maximumRetrySeconds ?? 60,
    now: clock.now,
    createLeaseId,
  });
}

function mutableClock(initial: number): {
  readonly now: () => Date;
  advance(seconds: number): void;
} {
  let value = initial;
  return {
    now: () => new Date(value * 1_000),
    advance(seconds: number) {
      value += seconds;
    },
  };
}
