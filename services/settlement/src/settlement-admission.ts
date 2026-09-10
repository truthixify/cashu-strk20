import {
  cloneSettlementPauseRecord,
  cloneSettlementProfile,
  type SettlementPauseRecord,
  type SettlementPauseStore,
  type SettlementProfile,
} from "./settlement-pauses.js";

export interface SettlementAdmissionChecker {
  assertActive(profile: SettlementProfile): Promise<void>;
}

export class SettlementAdmissionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementAdmissionConfigurationError";
  }
}

export class SettlementAdmissionUnavailableError extends Error {
  constructor() {
    super("Settlement admission state is unavailable");
    this.name = "SettlementAdmissionUnavailableError";
  }
}

export class SettlementAdmissionIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementAdmissionIntegrityError";
  }
}

export class SettlementProfilePausedError extends Error {
  readonly code = "settlement_profile_paused" as const;

  constructor() {
    super("Settlement profile is paused for operator review");
    this.name = "SettlementProfilePausedError";
  }
}

export class SettlementAdmissionController implements SettlementAdmissionChecker {
  readonly #store: SettlementPauseStore;

  constructor(store: SettlementPauseStore) {
    if (
      typeof store !== "object" ||
      store === null ||
      typeof store.getPause !== "function" ||
      typeof store.pause !== "function"
    ) {
      throw new SettlementAdmissionConfigurationError(
        "Configured settlement pause store is invalid",
      );
    }
    this.#store = store;
  }

  async assertActive(profileValue: SettlementProfile): Promise<void> {
    let profile: SettlementProfile;
    try {
      profile = cloneSettlementProfile(profileValue);
    } catch {
      throw new SettlementAdmissionIntegrityError("Settlement admission profile is invalid");
    }

    let pauseValue: Awaited<ReturnType<SettlementPauseStore["getPause"]>>;
    try {
      pauseValue = await this.#store.getPause(profile);
    } catch {
      throw new SettlementAdmissionUnavailableError();
    }
    if (pauseValue === null) {
      return;
    }
    let pause: SettlementPauseRecord;
    try {
      pause = cloneSettlementPauseRecord(pauseValue);
    } catch {
      throw new SettlementAdmissionIntegrityError(
        "Settlement pause store returned an invalid pause record",
      );
    }
    if (
      pause.profile.method !== profile.method ||
      pause.profile.network !== profile.network ||
      pause.profile.tokenContract !== profile.tokenContract
    ) {
      throw new SettlementAdmissionIntegrityError(
        "Settlement pause store returned a different profile",
      );
    }
    throw new SettlementProfilePausedError();
  }
}
