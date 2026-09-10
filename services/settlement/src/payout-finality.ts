import {
  assertIntentIdentifier,
  type SettlementIntentRecord,
  type SettlementIntentStore,
} from "./intents.js";
import {
  assertPreparedPayoutRecord,
  type PreparedPayoutFinalityIncident,
  type PreparedPayoutFinalityIncidentStatus,
  type PreparedPayoutInclusion,
  type PreparedPayoutRecord,
  type PreparedPayoutStore,
} from "./prepared-payouts.js";

export type FinalPayoutCanonicalStatus =
  | PreparedPayoutFinalityIncidentStatus
  | "FINAL"
  | "REVERTED"
  | "UNKNOWN";

export interface FinalPayoutCanonicalObservation {
  readonly intentId: string;
  readonly submissionId: string;
  readonly transactionReference: string;
  readonly inclusion: PreparedPayoutInclusion;
  readonly status: FinalPayoutCanonicalStatus;
}

export interface FinalPayoutCanonicalitySource {
  /** Reobserve one stored inclusion without signing, submitting, or replacing a transaction. */
  reobserveFinalPayout(submissionId: string): Promise<FinalPayoutCanonicalObservation>;
}

export interface PayoutFinalityCheck {
  readonly intentId: string;
  readonly submissionId: string;
  readonly transactionReference: string;
  readonly network: string;
  readonly tokenContract: string;
  readonly inclusion: PreparedPayoutInclusion;
  readonly status: FinalPayoutCanonicalStatus;
  readonly incident?: PreparedPayoutFinalityIncident;
}

export interface PayoutFinalityMonitorConfig {
  readonly intentStore: SettlementIntentStore;
  readonly preparedStore: PreparedPayoutStore;
  readonly source: FinalPayoutCanonicalitySource;
  readonly observerVersion: string;
  readonly now?: () => Date;
}

export type PayoutFinalityMonitorErrorCode = "integrity_failure" | "invalid_input" | "not_terminal";

export class PayoutFinalityMonitorConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayoutFinalityMonitorConfigurationError";
  }
}

export class PayoutFinalityMonitorError extends Error {
  readonly code: PayoutFinalityMonitorErrorCode;

  constructor(code: PayoutFinalityMonitorErrorCode, message: string) {
    super(message);
    this.name = "PayoutFinalityMonitorError";
    this.code = code;
  }
}

/** Records canonicality incidents separately so terminal accounting remains monotonic. */
export class PayoutFinalityMonitor {
  readonly #intentStore: SettlementIntentStore;
  readonly #preparedStore: PreparedPayoutStore;
  readonly #source: FinalPayoutCanonicalitySource;
  readonly #observerVersion: string;
  readonly #now: () => Date;

  constructor(config: PayoutFinalityMonitorConfig) {
    assertConfiguredMethods(config?.intentStore, ["getByQuoteId"], "settlement intent store");
    assertConfiguredMethods(
      config?.preparedStore,
      ["getBySubmissionId", "recordFinalityIncident"],
      "prepared payout store",
    );
    assertConfiguredMethods(config?.source, ["reobserveFinalPayout"], "finality source");
    try {
      assertMonitorIdentifier(config.observerVersion, "observer version");
    } catch {
      throw new PayoutFinalityMonitorConfigurationError(
        "Configured payout finality observer version is invalid",
      );
    }
    if (config.now !== undefined && typeof config.now !== "function") {
      throw new PayoutFinalityMonitorConfigurationError(
        "Configured payout finality clock is invalid",
      );
    }
    this.#intentStore = config.intentStore;
    this.#preparedStore = config.preparedStore;
    this.#source = config.source;
    this.#observerVersion = config.observerVersion;
    this.#now = config.now ?? (() => new Date());
  }

  async checkTerminalPayout(quoteIdValue: string): Promise<PayoutFinalityCheck> {
    try {
      assertIntentIdentifier(quoteIdValue, "Quote ID");
    } catch {
      throw new PayoutFinalityMonitorError("invalid_input", "Cashu quote ID is invalid");
    }
    const intent = await this.#intentStore.getByQuoteId(quoteIdValue);
    if (intent === null) {
      throw new PayoutFinalityMonitorError("invalid_input", "Settlement intent does not exist");
    }
    if (intent.identity.quoteId !== quoteIdValue) {
      throw integrityFailure("Settlement intent store returned a different quote identity");
    }
    if (intent.state !== "PAID" && intent.state !== "FAILED") {
      throw new PayoutFinalityMonitorError(
        "not_terminal",
        "Only a paid or failed settlement intent can be monitored for a finality incident",
      );
    }
    if (intent.submissionId === undefined) {
      throw integrityFailure("Terminal settlement intent has no submission identity");
    }

    const preparedValue = await this.#preparedStore.getBySubmissionId(intent.submissionId);
    const prepared = validatedPreparedPayout(preparedValue);
    if (
      prepared.intentId !== intent.intentId ||
      intent.transactionReferences.length !== 1 ||
      intent.transactionReferences[0] !== prepared.transactionReference
    ) {
      throw integrityFailure("Terminal settlement identity does not match its prepared payout");
    }
    const inclusion = prepared.inclusion;
    if (inclusion === undefined) {
      throw integrityFailure("Terminal settlement has no accepted payout inclusion");
    }
    if (prepared.finalityIncident !== undefined) {
      return finalityCheck(
        intent,
        prepared,
        inclusion,
        prepared.finalityIncident.status,
        prepared.finalityIncident,
      );
    }

    const observed = validatedObservation(
      await this.#source.reobserveFinalPayout(prepared.submissionId),
      prepared,
      inclusion,
    );
    if (
      observed.status === "UNKNOWN" ||
      (intent.state === "PAID" && observed.status === "FINAL") ||
      (intent.state === "FAILED" && observed.status === "REVERTED")
    ) {
      return finalityCheck(intent, prepared, inclusion, observed.status);
    }

    const detectedAt = canonicalNow(this.#now);
    const incidentStatus = observed.status === "REORGED" ? "REORGED" : "CONFLICTED";
    const updatedValue = await this.#preparedStore.recordFinalityIncident({
      intentId: prepared.intentId,
      submissionId: prepared.submissionId,
      transactionReference: prepared.transactionReference,
      status: incidentStatus,
      detectedAt,
      observerVersion: this.#observerVersion,
    });
    const updated = validatedPreparedPayout(updatedValue);
    const updatedInclusion = updated.inclusion;
    if (
      updated.intentId !== prepared.intentId ||
      updated.submissionId !== prepared.submissionId ||
      updated.transactionReference !== prepared.transactionReference ||
      updatedInclusion === undefined ||
      !sameInclusion(updatedInclusion, inclusion) ||
      updated.finalityIncident === undefined
    ) {
      throw integrityFailure("Prepared payout store returned an invalid finality incident");
    }
    return finalityCheck(
      intent,
      updated,
      updatedInclusion,
      updated.finalityIncident.status,
      updated.finalityIncident,
    );
  }
}

function validatedPreparedPayout(value: PreparedPayoutRecord | null): PreparedPayoutRecord {
  if (value === null) {
    throw integrityFailure("Terminal settlement has no prepared payout artifact");
  }
  try {
    assertPreparedPayoutRecord(value);
  } catch {
    throw integrityFailure("Prepared payout artifact is invalid");
  }
  return value;
}

function validatedObservation(
  value: FinalPayoutCanonicalObservation,
  prepared: PreparedPayoutRecord,
  inclusion: PreparedPayoutInclusion,
): FinalPayoutCanonicalObservation {
  if (typeof value !== "object" || value === null) {
    throw integrityFailure("Finality source returned a mismatched payout observation");
  }
  const intentId = value.intentId;
  const submissionId = value.submissionId;
  const transactionReference = value.transactionReference;
  const status = value.status;
  const observedInclusion = value.inclusion;
  if (
    intentId !== prepared.intentId ||
    submissionId !== prepared.submissionId ||
    transactionReference !== prepared.transactionReference ||
    !FINAL_PAYOUT_STATUSES.has(status) ||
    typeof observedInclusion !== "object" ||
    observedInclusion === null ||
    !sameInclusion(observedInclusion, inclusion)
  ) {
    throw integrityFailure("Finality source returned a mismatched payout observation");
  }
  return {
    intentId,
    submissionId,
    transactionReference,
    inclusion: { ...inclusion },
    status,
  };
}

function finalityCheck(
  intent: SettlementIntentRecord,
  record: PreparedPayoutRecord,
  inclusion: PreparedPayoutInclusion,
  status: FinalPayoutCanonicalStatus,
  incident?: PreparedPayoutFinalityIncident,
): PayoutFinalityCheck {
  return {
    intentId: record.intentId,
    submissionId: record.submissionId,
    transactionReference: record.transactionReference,
    network: intent.identity.network,
    tokenContract: intent.identity.tokenContract,
    inclusion: { ...inclusion },
    status,
    ...(incident === undefined ? {} : { incident: { ...incident } }),
  };
}

function sameInclusion(left: PreparedPayoutInclusion, right: PreparedPayoutInclusion): boolean {
  return left.blockHash === right.blockHash && left.blockNumber === right.blockNumber;
}

function canonicalNow(now: () => Date): string {
  let value: Date;
  try {
    value = now();
  } catch {
    throw integrityFailure("Payout finality clock failed");
  }
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw integrityFailure("Payout finality clock returned an invalid time");
  }
  return value.toISOString();
}

function assertMonitorIdentifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAXIMUM_IDENTIFIER_LENGTH ||
    containsControlCharacter(value)
  ) {
    throw new PayoutFinalityMonitorError("invalid_input", `${label} is invalid`);
  }
}

function assertConfiguredMethods(value: unknown, methods: readonly string[], label: string): void {
  if (
    typeof value !== "object" ||
    value === null ||
    methods.some((method) => typeof (value as Record<string, unknown>)[method] !== "function")
  ) {
    throw new PayoutFinalityMonitorConfigurationError(`Configured ${label} is invalid`);
  }
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

function integrityFailure(message: string): PayoutFinalityMonitorError {
  return new PayoutFinalityMonitorError("integrity_failure", message);
}

const FINAL_PAYOUT_STATUSES: ReadonlySet<FinalPayoutCanonicalStatus> = new Set([
  "CONFLICTED",
  "FINAL",
  "REORGED",
  "REVERTED",
  "UNKNOWN",
]);
const MAXIMUM_IDENTIFIER_LENGTH = 512;
