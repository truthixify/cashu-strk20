import { cloneSettlementProfile, type SettlementProfile } from "./settlement-pauses.js";

export type SettlementActivityGateState = "ACTIVE" | "PAUSED" | "QUIESCING";

export interface SettlementActivityGateSnapshot {
  readonly state: SettlementActivityGateState;
  readonly activeFundingFinalizations: number;
  readonly activeSubmissions: number;
  readonly pauseOperationInProgress: boolean;
}

export interface SettlementFundingFinalizationGate {
  runFundingFinalization<Result>(
    profile: SettlementProfile,
    finalization: () => Promise<Result>,
  ): Promise<Result>;
}

export interface SettlementSubmissionGate {
  runSubmission<Result>(
    profile: SettlementProfile,
    submission: () => Promise<Result>,
  ): Promise<Result>;
}

export interface SettlementPauseQuiescer {
  quiesceForPause<Result>(
    profile: SettlementProfile,
    persistPause: () => Promise<Result>,
  ): Promise<Result>;
}

export type SettlementActivityGate = SettlementFundingFinalizationGate &
  SettlementPauseQuiescer &
  SettlementSubmissionGate;

export class SettlementActivityGateIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementActivityGateIntegrityError";
  }
}

export class SettlementSubmissionBlockedError extends Error {
  readonly code = "settlement_submission_blocked" as const;

  constructor() {
    super("Settlement submission is blocked for operator review");
    this.name = "SettlementSubmissionBlockedError";
  }
}

export class SettlementFundingFinalizationBlockedError extends Error {
  readonly code = "settlement_funding_finalization_blocked" as const;

  constructor() {
    super("Settlement funding finalization is blocked for operator review");
    this.name = "SettlementFundingFinalizationBlockedError";
  }
}

type SettlementActivityKind = "funding_finalization" | "submission";

interface ProfileActivity {
  state: SettlementActivityGateState;
  activeFundingFinalizations: number;
  activeSubmissions: number;
  readonly drainWaiters: Set<() => void>;
  pauseTail: Promise<void> | undefined;
}

/** Coordinates value-state actions and pause persistence within one JavaScript process. */
export class InProcessSettlementActivityGate implements SettlementActivityGate {
  readonly #profiles = new Map<string, ProfileActivity>();

  runFundingFinalization<Result>(
    profile: SettlementProfile,
    finalization: () => Promise<Result>,
  ): Promise<Result> {
    return this.#runActivity(profile, finalization, "funding_finalization");
  }

  runSubmission<Result>(
    profileValue: SettlementProfile,
    submission: () => Promise<Result>,
  ): Promise<Result> {
    return this.#runActivity(profileValue, submission, "submission");
  }

  async #runActivity<Result>(
    profileValue: SettlementProfile,
    operation: () => Promise<Result>,
    kind: SettlementActivityKind,
  ): Promise<Result> {
    const profile = validatedProfile(profileValue);
    if (typeof operation !== "function") {
      throw invalidGateInput();
    }
    const activity = this.#activity(profile);
    if (activity.state !== "ACTIVE") {
      throw kind === "submission"
        ? new SettlementSubmissionBlockedError()
        : new SettlementFundingFinalizationBlockedError();
    }
    if (activeActivityCount(activity) >= Number.MAX_SAFE_INTEGER) {
      throw new SettlementActivityGateIntegrityError("Settlement activity count is out of range");
    }
    if (kind === "submission") {
      activity.activeSubmissions += 1;
    } else {
      activity.activeFundingFinalizations += 1;
    }
    try {
      return await operation();
    } finally {
      this.#release(activity, kind);
    }
  }

  quiesceForPause<Result>(
    profileValue: SettlementProfile,
    persistPause: () => Promise<Result>,
  ): Promise<Result> {
    const profile = validatedProfile(profileValue);
    if (typeof persistPause !== "function") {
      throw invalidGateInput();
    }
    const activity = this.#activity(profile);
    if (activity.state === "ACTIVE") {
      activity.state = "QUIESCING";
    }

    const preceding = activity.pauseTail ?? Promise.resolve();
    const attempt = this.#persistAfterDrain(activity, preceding, persistPause);
    const tail = attempt.then(
      () => undefined,
      () => undefined,
    );
    activity.pauseTail = tail;
    void tail.then(() => {
      if (activity.pauseTail === tail) {
        activity.pauseTail = undefined;
      }
    });
    return attempt;
  }

  snapshot(profileValue: SettlementProfile): SettlementActivityGateSnapshot {
    const profile = validatedProfile(profileValue);
    const activity = this.#profiles.get(profileKey(profile));
    if (activity === undefined) {
      return {
        state: "ACTIVE",
        activeFundingFinalizations: 0,
        activeSubmissions: 0,
        pauseOperationInProgress: false,
      };
    }
    return {
      state: activity.state,
      activeFundingFinalizations: activity.activeFundingFinalizations,
      activeSubmissions: activity.activeSubmissions,
      pauseOperationInProgress: activity.pauseTail !== undefined,
    };
  }

  async #persistAfterDrain<Result>(
    activity: ProfileActivity,
    preceding: Promise<void>,
    persistPause: () => Promise<Result>,
  ): Promise<Result> {
    await preceding;
    await drained(activity);
    const result = await persistPause();
    activity.state = "PAUSED";
    return result;
  }

  #activity(profile: SettlementProfile): ProfileActivity {
    const key = profileKey(profile);
    const existing = this.#profiles.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created: ProfileActivity = {
      state: "ACTIVE",
      activeFundingFinalizations: 0,
      activeSubmissions: 0,
      drainWaiters: new Set(),
      pauseTail: undefined,
    };
    this.#profiles.set(key, created);
    return created;
  }

  #release(activity: ProfileActivity, kind: SettlementActivityKind): void {
    const active =
      kind === "submission" ? activity.activeSubmissions : activity.activeFundingFinalizations;
    if (active < 1) {
      throw new SettlementActivityGateIntegrityError("Settlement activity count is inconsistent");
    }
    if (kind === "submission") {
      activity.activeSubmissions -= 1;
    } else {
      activity.activeFundingFinalizations -= 1;
    }
    if (activeActivityCount(activity) !== 0) {
      return;
    }
    const waiters = [...activity.drainWaiters];
    activity.drainWaiters.clear();
    for (const resolve of waiters) {
      resolve();
    }
  }
}

function drained(activity: ProfileActivity): Promise<void> {
  if (activeActivityCount(activity) === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    activity.drainWaiters.add(resolve);
  });
}

function activeActivityCount(activity: ProfileActivity): number {
  const count = activity.activeFundingFinalizations + activity.activeSubmissions;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new SettlementActivityGateIntegrityError("Settlement activity count is out of range");
  }
  return count;
}

function validatedProfile(value: SettlementProfile): SettlementProfile {
  try {
    return cloneSettlementProfile(value);
  } catch {
    throw invalidGateInput();
  }
}

function profileKey(profile: SettlementProfile): string {
  return JSON.stringify([profile.method, profile.network, profile.tokenContract]);
}

function invalidGateInput(): SettlementActivityGateIntegrityError {
  return new SettlementActivityGateIntegrityError("Settlement activity gate input is invalid");
}
