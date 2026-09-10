import { describe, expect, it } from "vitest";

import { type PayoutFinalityCheck, PayoutFinalityMonitorError } from "./payout-finality.js";
import {
  type PayoutFinalityChecker,
  PayoutFinalitySupervisor,
  PayoutFinalitySupervisorCheckError,
  PayoutFinalitySupervisorConfigurationError,
  PayoutFinalitySupervisorDependencyError,
  PayoutFinalitySupervisorIntegrityError,
} from "./payout-finality-supervisor.js";
import {
  InProcessSettlementActivityGate,
  type SettlementPauseQuiescer,
} from "./settlement-activity-gate.js";
import {
  InMemorySettlementPauseStore,
  type SettlementPauseCandidate,
  type SettlementPauseRecord,
  type SettlementPauseStore,
  type SettlementProfile,
} from "./settlement-pauses.js";

const QUOTE_ID = "quote-secret-1";
const PROFILE = {
  method: "strk20",
  network: "SN_SEPOLIA",
  tokenContract: "0x456",
} as const;

describe("payout finality supervisor", () => {
  it.each([
    { status: "REORGED", reason: "PAYOUT_FINALITY_REORGED" },
    { status: "CONFLICTED", reason: "PAYOUT_FINALITY_CONFLICTED" },
  ] as const)(
    "pauses the affected profile for a confirmed $status incident",
    async ({ status, reason }) => {
      const checker = new FakeChecker(finalityCheck(status));
      const pauseStore = new InMemorySettlementPauseStore();
      const supervisor = new PayoutFinalitySupervisor({
        checker,
        pauseStore,
        pauseQuiescer: new InProcessSettlementActivityGate(),
      });

      const result = await supervisor.checkAndPause(QUOTE_ID);

      expect(result).toEqual({
        profile: PROFILE,
        status,
        paused: true,
        pause: {
          profile: PROFILE,
          reason,
          intentId: "intent-1",
          submissionId: "submission-1",
          transactionReference: "0xabc",
          originalInclusion: { blockHash: "0xdef", blockNumber: 42n },
          detectedAt: "2026-09-01T10:00:00.000Z",
          observerVersion: "observer-v1",
        },
      });
      expect(checker.calls).toEqual([QUOTE_ID]);
      await expect(pauseStore.getPause(PROFILE)).resolves.toEqual(result.pause);
      expect(
        JSON.stringify(result, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
      ).not.toContain(QUOTE_ID);
    },
  );

  it.each(["FINAL", "REVERTED", "UNKNOWN"] as const)(
    "does not pause a profile for a healthy or ambiguous $status observation",
    async (status) => {
      const pauseStore = new InMemorySettlementPauseStore();
      const supervisor = new PayoutFinalitySupervisor({
        checker: new FakeChecker(finalityCheck(status)),
        pauseStore,
        pauseQuiescer: new InProcessSettlementActivityGate(),
      });

      await expect(supervisor.checkAndPause(QUOTE_ID)).resolves.toEqual({
        profile: PROFILE,
        status,
        paused: false,
      });
      await expect(pauseStore.getPause(PROFILE)).resolves.toBeNull();
    },
  );

  it("waits for active submissions before persisting an incident pause", async () => {
    const gate = new InProcessSettlementActivityGate();
    const submissionRelease = deferred<void>();
    const submission = gate.runSubmission(PROFILE, async () => {
      await submissionRelease.promise;
    });
    const pauseStore = new InMemorySettlementPauseStore();
    const supervisor = new PayoutFinalitySupervisor({
      checker: new FakeChecker(finalityCheck("REORGED")),
      pauseStore,
      pauseQuiescer: gate,
    });

    const supervision = supervisor.checkAndPause(QUOTE_ID);
    await Promise.resolve();
    await Promise.resolve();

    expect(gate.snapshot(PROFILE)).toEqual({
      state: "QUIESCING",
      activeFundingFinalizations: 0,
      activeSubmissions: 1,
      pauseOperationInProgress: true,
    });
    await expect(pauseStore.getPause(PROFILE)).resolves.toBeNull();

    submissionRelease.resolve();
    await submission;
    await expect(supervision).resolves.toMatchObject({ paused: true });
    expect(gate.snapshot(PROFILE)).toEqual({
      state: "PAUSED",
      activeFundingFinalizations: 0,
      activeSubmissions: 0,
      pauseOperationInProgress: false,
    });
  });

  it("recovers when pause persistence succeeds but its response is lost", async () => {
    const delegate = new InMemorySettlementPauseStore();
    const pauseStore = new ThrowAfterPauseStore(delegate);
    const supervisor = new PayoutFinalitySupervisor({
      checker: new FakeChecker(finalityCheck("REORGED")),
      pauseStore,
      pauseQuiescer: new InProcessSettlementActivityGate(),
    });

    await expect(supervisor.checkAndPause(QUOTE_ID)).rejects.toMatchObject({
      name: PayoutFinalitySupervisorDependencyError.name,
      code: "pause_store_unavailable",
      message: "Settlement pause store is unavailable",
    });
    await expect(supervisor.checkAndPause(QUOTE_ID)).resolves.toMatchObject({
      status: "REORGED",
      paused: true,
      pause: { reason: "PAYOUT_FINALITY_REORGED" },
    });
    await expect(delegate.getPause(PROFILE)).resolves.toMatchObject({
      intentId: "intent-1",
    });
  });

  it("rejects a pause quiescer that skips or repeats persistence", async () => {
    const skippedStore = new InMemorySettlementPauseStore();
    const skipped = {
      async quiesceForPause() {
        return undefined;
      },
    } as unknown as SettlementPauseQuiescer;
    const skippedSupervisor = new PayoutFinalitySupervisor({
      checker: new FakeChecker(finalityCheck("REORGED")),
      pauseStore: skippedStore,
      pauseQuiescer: skipped,
    });

    await expect(skippedSupervisor.checkAndPause(QUOTE_ID)).rejects.toMatchObject({
      name: PayoutFinalitySupervisorIntegrityError.name,
      message: "Settlement pause quiescer did not complete pause persistence",
    });
    await expect(skippedStore.getPause(PROFILE)).resolves.toBeNull();

    const repeatedStore = new CountingPauseStore();
    const repeated: SettlementPauseQuiescer = {
      async quiesceForPause(_profile, persistPause) {
        await persistPause();
        return persistPause();
      },
    };
    const repeatedSupervisor = new PayoutFinalitySupervisor({
      checker: new FakeChecker(finalityCheck("REORGED")),
      pauseStore: repeatedStore,
      pauseQuiescer: repeated,
    });

    await expect(repeatedSupervisor.checkAndPause(QUOTE_ID)).rejects.toMatchObject({
      name: PayoutFinalitySupervisorIntegrityError.name,
      message: "Settlement pause quiescer invoked persistence more than once",
    });
    expect(repeatedStore.pauseCalls).toBe(1);
  });

  it.each([
    {
      name: "incident status mismatch",
      mutate: (check: PayoutFinalityCheck) => ({
        ...check,
        status: "CONFLICTED" as const,
      }),
    },
    {
      name: "missing incident",
      mutate: (check: PayoutFinalityCheck) => {
        const { incident: _incident, ...withoutIncident } = check;
        return withoutIncident;
      },
    },
    {
      name: "malformed profile",
      mutate: (check: PayoutFinalityCheck) => ({ ...check, tokenContract: "0x0456" }),
    },
    {
      name: "malformed inclusion",
      mutate: (check: PayoutFinalityCheck) => ({
        ...check,
        inclusion: { ...check.inclusion, blockNumber: -1n },
      }),
    },
    {
      name: "malformed healthy inclusion",
      mutate: (_check: PayoutFinalityCheck) => ({
        ...finalityCheck("FINAL"),
        inclusion: { blockHash: "0xdef", blockNumber: -1n },
      }),
    },
  ])("rejects $name without creating a pause", async ({ mutate }) => {
    const pauseStore = new InMemorySettlementPauseStore();
    const checker = new FakeChecker(mutate(finalityCheck("REORGED")) as PayoutFinalityCheck);
    const supervisor = new PayoutFinalitySupervisor({
      checker,
      pauseStore,
      pauseQuiescer: new InProcessSettlementActivityGate(),
    });

    await expect(supervisor.checkAndPause(QUOTE_ID)).rejects.toBeInstanceOf(
      PayoutFinalitySupervisorIntegrityError,
    );
    await expect(pauseStore.getPause(PROFILE)).resolves.toBeNull();
  });

  it("rejects a pause-store response for another profile", async () => {
    const supervisor = new PayoutFinalitySupervisor({
      checker: new FakeChecker(finalityCheck("REORGED")),
      pauseStore: new MismatchedPauseStore(),
      pauseQuiescer: new InProcessSettlementActivityGate(),
    });

    await expect(supervisor.checkAndPause(QUOTE_ID)).rejects.toMatchObject({
      name: PayoutFinalitySupervisorIntegrityError.name,
      message: "Settlement pause store returned a different profile",
    });
  });

  it("redacts checker failures and does not create a pause", async () => {
    const pauseStore = new InMemorySettlementPauseStore();
    const supervisor = new PayoutFinalitySupervisor({
      checker: {
        async checkTerminalPayout() {
          throw new Error(`private endpoint and ${QUOTE_ID}`);
        },
      },
      pauseStore,
      pauseQuiescer: new InProcessSettlementActivityGate(),
    });

    await expect(supervisor.checkAndPause(QUOTE_ID)).rejects.toMatchObject({
      name: PayoutFinalitySupervisorDependencyError.name,
      code: "checker_unavailable",
      message: "Payout finality checker is unavailable",
    });
    await expect(pauseStore.getPause(PROFILE)).resolves.toBeNull();
  });

  it("preserves a monitor rejection code without preserving its message", async () => {
    const supervisor = new PayoutFinalitySupervisor({
      checker: {
        async checkTerminalPayout() {
          throw new PayoutFinalityMonitorError("integrity_failure", QUOTE_ID);
        },
      },
      pauseStore: new InMemorySettlementPauseStore(),
      pauseQuiescer: new InProcessSettlementActivityGate(),
    });

    await expect(supervisor.checkAndPause(QUOTE_ID)).rejects.toMatchObject({
      name: PayoutFinalitySupervisorCheckError.name,
      code: "integrity_failure",
      message: "Payout finality check was rejected",
    });
  });

  it("rejects malformed dependencies during construction", () => {
    expect(
      () =>
        new PayoutFinalitySupervisor({
          checker: {} as PayoutFinalityChecker,
          pauseStore: new InMemorySettlementPauseStore(),
          pauseQuiescer: new InProcessSettlementActivityGate(),
        }),
    ).toThrowError(PayoutFinalitySupervisorConfigurationError);
    expect(
      () =>
        new PayoutFinalitySupervisor({
          checker: new FakeChecker(finalityCheck("FINAL")),
          pauseStore: {} as SettlementPauseStore,
          pauseQuiescer: new InProcessSettlementActivityGate(),
        }),
    ).toThrowError(PayoutFinalitySupervisorConfigurationError);
    expect(
      () =>
        new PayoutFinalitySupervisor({
          checker: new FakeChecker(finalityCheck("FINAL")),
          pauseStore: new InMemorySettlementPauseStore(),
          pauseQuiescer: {} as InProcessSettlementActivityGate,
        }),
    ).toThrowError(PayoutFinalitySupervisorConfigurationError);
  });
});

function finalityCheck(status: PayoutFinalityCheck["status"]): PayoutFinalityCheck {
  return {
    intentId: "intent-1",
    submissionId: "submission-1",
    transactionReference: "0xabc",
    network: "SN_SEPOLIA",
    tokenContract: "0x456",
    inclusion: { blockHash: "0xdef", blockNumber: 42n },
    status,
    ...(status === "REORGED" || status === "CONFLICTED"
      ? {
          incident: {
            status,
            detectedAt: "2026-09-01T10:00:00.000Z",
            observerVersion: "observer-v1",
          },
        }
      : {}),
  };
}

class FakeChecker implements PayoutFinalityChecker {
  readonly calls: string[] = [];

  constructor(readonly result: PayoutFinalityCheck) {}

  async checkTerminalPayout(quoteId: string): Promise<PayoutFinalityCheck> {
    this.calls.push(quoteId);
    return {
      ...this.result,
      inclusion: { ...this.result.inclusion },
      ...(this.result.incident === undefined ? {} : { incident: { ...this.result.incident } }),
    };
  }
}

class ThrowAfterPauseStore implements SettlementPauseStore {
  #throwAfterPause = true;

  constructor(readonly delegate: SettlementPauseStore) {}

  getPause(profile: SettlementProfile) {
    return this.delegate.getPause(profile);
  }

  async pause(candidate: SettlementPauseCandidate): Promise<SettlementPauseRecord> {
    const stored = await this.delegate.pause(candidate);
    if (this.#throwAfterPause) {
      this.#throwAfterPause = false;
      throw new Error("Pause response lost");
    }
    return stored;
  }
}

class MismatchedPauseStore implements SettlementPauseStore {
  async getPause(_profile: SettlementProfile): Promise<SettlementPauseRecord | null> {
    return null;
  }

  async pause(candidate: SettlementPauseCandidate): Promise<SettlementPauseRecord> {
    return {
      ...candidate,
      profile: { ...candidate.profile, tokenContract: "0x789" },
    };
  }
}

class CountingPauseStore extends InMemorySettlementPauseStore {
  pauseCalls = 0;

  override pause(candidate: SettlementPauseCandidate): Promise<SettlementPauseRecord> {
    this.pauseCalls += 1;
    return super.pause(candidate);
  }
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolveValue: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolveValue = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      if (resolveValue === undefined) {
        throw new Error("Test fixture is incomplete");
      }
      resolveValue(value);
    },
  };
}
