import { describe, expect, it } from "vitest";

import {
  InProcessSettlementActivityGate,
  SettlementActivityGateIntegrityError,
  SettlementFundingFinalizationBlockedError,
  SettlementSubmissionBlockedError,
} from "./settlement-activity-gate.js";
import type { SettlementProfile } from "./settlement-pauses.js";

const PROFILE = {
  method: "strk20",
  network: "SN_SEPOLIA",
  tokenContract: "0x456",
} as const;
const OTHER_PROFILE = { ...PROFILE, tokenContract: "0x789" } as const;

describe("in-process settlement activity gate", () => {
  it("blocks new value actions and persists a pause only after every action drains", async () => {
    const gate = new InProcessSettlementActivityGate();
    const firstRelease = deferred<void>();
    const secondRelease = deferred<void>();
    const events: string[] = [];
    const first = gate.runSubmission(PROFILE, async () => {
      events.push("first:start");
      await firstRelease.promise;
      events.push("first:end");
      return "first-result";
    });
    const second = gate.runFundingFinalization(PROFILE, async () => {
      events.push("second:start");
      await secondRelease.promise;
      events.push("second:end");
      return "second-result";
    });

    const pause = gate.quiesceForPause(PROFILE, async () => {
      events.push("pause:persist");
      return "pause-result";
    });
    await Promise.resolve();

    expect(gate.snapshot(PROFILE)).toEqual({
      state: "QUIESCING",
      activeFundingFinalizations: 1,
      activeSubmissions: 1,
      pauseOperationInProgress: true,
    });
    await expect(gate.runSubmission(PROFILE, async () => "late-result")).rejects.toBeInstanceOf(
      SettlementSubmissionBlockedError,
    );
    await expect(
      gate.runFundingFinalization(PROFILE, async () => "late-result"),
    ).rejects.toBeInstanceOf(SettlementFundingFinalizationBlockedError);
    expect(events).not.toContain("pause:persist");

    firstRelease.resolve();
    await expect(first).resolves.toBe("first-result");
    await Promise.resolve();
    expect(events).not.toContain("pause:persist");

    secondRelease.resolve();
    await expect(second).resolves.toBe("second-result");
    await expect(pause).resolves.toBe("pause-result");
    expect(events).toEqual([
      "first:start",
      "second:start",
      "first:end",
      "second:end",
      "pause:persist",
    ]);
    expect(gate.snapshot(PROFILE)).toEqual({
      state: "PAUSED",
      activeFundingFinalizations: 0,
      activeSubmissions: 0,
      pauseOperationInProgress: false,
    });
  });

  it("serializes concurrent pause persistence and preserves each caller result", async () => {
    const gate = new InProcessSettlementActivityGate();
    const firstRelease = deferred<void>();
    const events: string[] = [];
    const first = gate.quiesceForPause(PROFILE, async () => {
      events.push("first:start");
      await firstRelease.promise;
      events.push("first:end");
      return "first";
    });
    const second = gate.quiesceForPause(PROFILE, async () => {
      events.push("second");
      return "second";
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual(["first:start"]);
    firstRelease.resolve();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(events).toEqual(["first:start", "first:end", "second"]);
    expect(gate.snapshot(PROFILE).state).toBe("PAUSED");
  });

  it("remains quiescing after persistence failure and allows an idempotent retry", async () => {
    const gate = new InProcessSettlementActivityGate();
    const secret = "private-pause-store-error";

    await expect(
      gate.quiesceForPause(PROFILE, async () => {
        throw new Error(secret);
      }),
    ).rejects.toThrow(secret);
    expect(gate.snapshot(PROFILE)).toEqual({
      state: "QUIESCING",
      activeFundingFinalizations: 0,
      activeSubmissions: 0,
      pauseOperationInProgress: false,
    });
    await expect(gate.runSubmission(PROFILE, async () => undefined)).rejects.toBeInstanceOf(
      SettlementSubmissionBlockedError,
    );
    await expect(
      gate.runFundingFinalization(PROFILE, async () => undefined),
    ).rejects.toBeInstanceOf(SettlementFundingFinalizationBlockedError);

    await expect(gate.quiesceForPause(PROFILE, async () => "persisted")).resolves.toBe("persisted");
    expect(gate.snapshot(PROFILE).state).toBe("PAUSED");
  });

  it("releases a failed submission while preserving its original error", async () => {
    const gate = new InProcessSettlementActivityGate();
    const secret = "private-submission-error";

    await expect(
      gate.runSubmission(PROFILE, async () => {
        throw new Error(secret);
      }),
    ).rejects.toThrow(secret);
    await expect(gate.quiesceForPause(PROFILE, async () => "paused")).resolves.toBe("paused");
    expect(gate.snapshot(PROFILE).activeSubmissions).toBe(0);
  });

  it("releases a failed funding finalization while preserving its original error", async () => {
    const gate = new InProcessSettlementActivityGate();
    const secret = "private-finalization-error";

    await expect(
      gate.runFundingFinalization(PROFILE, async () => {
        throw new Error(secret);
      }),
    ).rejects.toThrow(secret);
    await expect(gate.quiesceForPause(PROFILE, async () => "paused")).resolves.toBe("paused");
    expect(gate.snapshot(PROFILE).activeFundingFinalizations).toBe(0);
  });

  it("isolates activity by settlement profile", async () => {
    const gate = new InProcessSettlementActivityGate();
    await gate.quiesceForPause(PROFILE, async () => undefined);

    await expect(gate.runSubmission(OTHER_PROFILE, async () => "submitted")).resolves.toBe(
      "submitted",
    );
    await expect(gate.runFundingFinalization(OTHER_PROFILE, async () => "finalized")).resolves.toBe(
      "finalized",
    );
    expect(gate.snapshot(PROFILE).state).toBe("PAUSED");
    expect(gate.snapshot(OTHER_PROFILE).state).toBe("ACTIVE");
  });

  it("rejects malformed profiles and callbacks without exposing their values", async () => {
    const gate = new InProcessSettlementActivityGate();
    const malformed = { ...PROFILE, tokenContract: "private-value" } as SettlementProfile;

    await expect(gate.runSubmission(malformed, async () => undefined)).rejects.toEqual(
      new SettlementActivityGateIntegrityError("Settlement activity gate input is invalid"),
    );
    await expect(gate.runFundingFinalization(malformed, async () => undefined)).rejects.toEqual(
      new SettlementActivityGateIntegrityError("Settlement activity gate input is invalid"),
    );
    expect(() =>
      gate.quiesceForPause(PROFILE, undefined as unknown as () => Promise<void>),
    ).toThrow(
      new SettlementActivityGateIntegrityError("Settlement activity gate input is invalid"),
    );
  });
});

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
    resolve: (value) => requiredValue(resolveValue)(value),
  };
}

function requiredValue<Value>(value: Value | undefined): Value {
  if (value === undefined) {
    throw new Error("Test fixture is incomplete");
  }
  return value;
}
