import {
  type FinalPayoutCanonicalStatus,
  type PayoutFinalityCheck,
  PayoutFinalityMonitorError,
  type PayoutFinalityMonitorErrorCode,
} from "./payout-finality.js";
import type { SettlementPauseQuiescer } from "./settlement-activity-gate.js";
import {
  assertSettlementPauseRecord,
  assertSettlementPayoutReference,
  assertSettlementProfile,
  cloneSettlementPauseRecord,
  SETTLEMENT_METHOD,
  type SettlementPauseCandidate,
  type SettlementPauseRecord,
  type SettlementPauseStore,
  type SettlementProfile,
} from "./settlement-pauses.js";

export interface PayoutFinalityChecker {
  checkTerminalPayout(quoteId: string): Promise<PayoutFinalityCheck>;
}

export interface PayoutFinalitySupervision {
  readonly profile: SettlementProfile;
  readonly status: FinalPayoutCanonicalStatus;
  readonly paused: boolean;
  readonly pause?: SettlementPauseRecord;
}

export interface PayoutFinalitySupervisorConfig {
  readonly checker: PayoutFinalityChecker;
  readonly pauseStore: SettlementPauseStore;
  readonly pauseQuiescer: SettlementPauseQuiescer;
}

export class PayoutFinalitySupervisorConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayoutFinalitySupervisorConfigurationError";
  }
}

export class PayoutFinalitySupervisorIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayoutFinalitySupervisorIntegrityError";
  }
}

export class PayoutFinalitySupervisorCheckError extends Error {
  readonly code: PayoutFinalityMonitorErrorCode;

  constructor(code: PayoutFinalityMonitorErrorCode) {
    super("Payout finality check was rejected");
    this.name = "PayoutFinalitySupervisorCheckError";
    this.code = code;
  }
}

export type PayoutFinalitySupervisorDependencyErrorCode =
  | "checker_unavailable"
  | "pause_store_unavailable";

export class PayoutFinalitySupervisorDependencyError extends Error {
  readonly code: PayoutFinalitySupervisorDependencyErrorCode;

  constructor(code: PayoutFinalitySupervisorDependencyErrorCode, message: string) {
    super(message);
    this.name = "PayoutFinalitySupervisorDependencyError";
    this.code = code;
  }
}

/** Converts a persisted terminal-payout incident into a profile pause without transaction access. */
export class PayoutFinalitySupervisor {
  readonly #checker: PayoutFinalityChecker;
  readonly #pauseStore: SettlementPauseStore;
  readonly #pauseQuiescer: SettlementPauseQuiescer;

  constructor(config: PayoutFinalitySupervisorConfig) {
    if (
      typeof config?.checker !== "object" ||
      config.checker === null ||
      typeof config.checker.checkTerminalPayout !== "function"
    ) {
      throw new PayoutFinalitySupervisorConfigurationError(
        "Configured payout finality checker is invalid",
      );
    }
    if (
      typeof config.pauseStore !== "object" ||
      config.pauseStore === null ||
      typeof config.pauseStore.pause !== "function" ||
      typeof config.pauseStore.getPause !== "function"
    ) {
      throw new PayoutFinalitySupervisorConfigurationError(
        "Configured settlement pause store is invalid",
      );
    }
    if (
      typeof config.pauseQuiescer !== "object" ||
      config.pauseQuiescer === null ||
      typeof config.pauseQuiescer.quiesceForPause !== "function"
    ) {
      throw new PayoutFinalitySupervisorConfigurationError(
        "Configured settlement pause quiescer is invalid",
      );
    }
    this.#checker = config.checker;
    this.#pauseStore = config.pauseStore;
    this.#pauseQuiescer = config.pauseQuiescer;
  }

  async checkAndPause(quoteId: string): Promise<PayoutFinalitySupervision> {
    let checkedValue: PayoutFinalityCheck;
    try {
      checkedValue = await this.#checker.checkTerminalPayout(quoteId);
    } catch (error) {
      if (error instanceof PayoutFinalityMonitorError) {
        throw new PayoutFinalitySupervisorCheckError(error.code);
      }
      throw new PayoutFinalitySupervisorDependencyError(
        "checker_unavailable",
        "Payout finality checker is unavailable",
      );
    }
    const checked = validatedCheck(checkedValue);
    const pauseCandidate = checked.pauseCandidate;
    if (pauseCandidate === undefined) {
      return {
        profile: { ...checked.profile },
        status: checked.status,
        paused: false,
      };
    }

    let pausePersistenceEntered = false;
    let storedValue: unknown;
    try {
      await this.#pauseQuiescer.quiesceForPause(checked.profile, async () => {
        if (pausePersistenceEntered) {
          throw new PayoutFinalitySupervisorIntegrityError(
            "Settlement pause quiescer invoked persistence more than once",
          );
        }
        pausePersistenceEntered = true;
        storedValue = await this.#pauseStore.pause(pauseCandidate);
      });
    } catch (error) {
      if (error instanceof PayoutFinalitySupervisorIntegrityError) {
        throw error;
      }
      throw new PayoutFinalitySupervisorDependencyError(
        "pause_store_unavailable",
        "Settlement pause store is unavailable",
      );
    }
    if (!pausePersistenceEntered || storedValue === undefined) {
      throw new PayoutFinalitySupervisorIntegrityError(
        "Settlement pause quiescer did not complete pause persistence",
      );
    }
    let stored: SettlementPauseRecord;
    try {
      assertSettlementPauseRecord(storedValue);
      stored = cloneSettlementPauseRecord(storedValue);
    } catch {
      throw new PayoutFinalitySupervisorIntegrityError(
        "Settlement pause store returned an invalid pause record",
      );
    }
    if (!sameProfile(stored.profile, checked.profile)) {
      throw new PayoutFinalitySupervisorIntegrityError(
        "Settlement pause store returned a different profile",
      );
    }
    return {
      profile: { ...checked.profile },
      status: checked.status,
      paused: true,
      pause: stored,
    };
  }
}

function validatedCheck(value: unknown): {
  readonly profile: SettlementProfile;
  readonly status: FinalPayoutCanonicalStatus;
  readonly pauseCandidate?: SettlementPauseCandidate;
} {
  if (typeof value !== "object" || value === null) {
    throw invalidCheck();
  }
  let check: Partial<PayoutFinalityCheck>;
  try {
    const incident = (value as PayoutFinalityCheck).incident;
    check = {
      intentId: (value as PayoutFinalityCheck).intentId,
      submissionId: (value as PayoutFinalityCheck).submissionId,
      transactionReference: (value as PayoutFinalityCheck).transactionReference,
      network: (value as PayoutFinalityCheck).network,
      tokenContract: (value as PayoutFinalityCheck).tokenContract,
      inclusion: (value as PayoutFinalityCheck).inclusion,
      status: (value as PayoutFinalityCheck).status,
      ...(incident === undefined ? {} : { incident }),
    };
  } catch {
    throw invalidCheck();
  }
  if (!FINAL_PAYOUT_STATUSES.has(check.status as FinalPayoutCanonicalStatus)) {
    throw invalidCheck();
  }
  const profile = {
    method: SETTLEMENT_METHOD,
    network: check.network,
    tokenContract: check.tokenContract,
  };
  try {
    assertSettlementProfile(profile);
    assertSettlementPayoutReference({
      intentId: check.intentId,
      submissionId: check.submissionId,
      transactionReference: check.transactionReference,
      originalInclusion: check.inclusion,
    });
  } catch {
    throw invalidCheck();
  }

  if (check.incident === undefined) {
    if (check.status === "CONFLICTED" || check.status === "REORGED") {
      throw invalidCheck();
    }
    return {
      profile,
      status: check.status as FinalPayoutCanonicalStatus,
    };
  }
  if (
    (check.incident.status !== "CONFLICTED" && check.incident.status !== "REORGED") ||
    check.incident.status !== check.status
  ) {
    throw invalidCheck();
  }
  const pauseCandidate = {
    profile,
    reason:
      check.incident.status === "REORGED"
        ? ("PAYOUT_FINALITY_REORGED" as const)
        : ("PAYOUT_FINALITY_CONFLICTED" as const),
    intentId: check.intentId,
    submissionId: check.submissionId,
    transactionReference: check.transactionReference,
    originalInclusion: check.inclusion,
    detectedAt: check.incident.detectedAt,
    observerVersion: check.incident.observerVersion,
  };
  try {
    assertSettlementPauseRecord(pauseCandidate);
  } catch {
    throw invalidCheck();
  }
  return {
    profile,
    status: check.status,
    pauseCandidate: cloneSettlementPauseRecord(pauseCandidate),
  };
}

function sameProfile(left: SettlementProfile, right: SettlementProfile): boolean {
  return (
    left.method === right.method &&
    left.network === right.network &&
    left.tokenContract === right.tokenContract
  );
}

function invalidCheck(): PayoutFinalitySupervisorIntegrityError {
  return new PayoutFinalitySupervisorIntegrityError(
    "Payout finality checker returned an invalid result",
  );
}

const FINAL_PAYOUT_STATUSES: ReadonlySet<FinalPayoutCanonicalStatus> = new Set([
  "CONFLICTED",
  "FINAL",
  "REORGED",
  "REVERTED",
  "UNKNOWN",
]);
