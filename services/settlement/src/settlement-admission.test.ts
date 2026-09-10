import { describe, expect, it } from "vitest";

import {
  SettlementAdmissionConfigurationError,
  SettlementAdmissionController,
  SettlementAdmissionIntegrityError,
  SettlementAdmissionUnavailableError,
  SettlementProfilePausedError,
} from "./settlement-admission.js";
import {
  InMemorySettlementPauseStore,
  type SettlementPauseCandidate,
  type SettlementPauseRecord,
  type SettlementPauseStore,
  type SettlementProfile,
} from "./settlement-pauses.js";

const PROFILE = {
  method: "strk20",
  network: "SN_SEPOLIA",
  tokenContract: "0x456",
} as const;

describe("settlement admission", () => {
  it("admits a profile without a pause", async () => {
    const admission = new SettlementAdmissionController(new InMemorySettlementPauseStore());

    await expect(admission.assertActive(PROFILE)).resolves.toBeUndefined();
  });

  it("rejects a paused profile without exposing incident identifiers", async () => {
    const store = new InMemorySettlementPauseStore();
    await store.pause(pauseRecord());
    const admission = new SettlementAdmissionController(store);

    await expect(admission.assertActive(PROFILE)).rejects.toMatchObject({
      name: SettlementProfilePausedError.name,
      code: "settlement_profile_paused",
      message: "Settlement profile is paused for operator review",
    });
  });

  it("fails closed with a value-free error when pause lookup fails", async () => {
    const admission = new SettlementAdmissionController(new ThrowingPauseStore());

    await expect(admission.assertActive(PROFILE)).rejects.toEqual(
      new SettlementAdmissionUnavailableError(),
    );
  });

  it("rejects a pause-store response for another profile", async () => {
    const admission = new SettlementAdmissionController(new MismatchedPauseStore());

    await expect(admission.assertActive(PROFILE)).rejects.toBeInstanceOf(
      SettlementAdmissionIntegrityError,
    );
  });

  it("maps a time-varying pause response to a value-free integrity error", async () => {
    const admission = new SettlementAdmissionController(new HostilePauseStore());

    await expect(admission.assertActive(PROFILE)).rejects.toEqual(
      new SettlementAdmissionIntegrityError(
        "Settlement pause store returned an invalid pause record",
      ),
    );
  });

  it("rejects malformed configuration and profiles", async () => {
    expect(() => new SettlementAdmissionController({} as SettlementPauseStore)).toThrowError(
      SettlementAdmissionConfigurationError,
    );
    const admission = new SettlementAdmissionController(new InMemorySettlementPauseStore());
    await expect(
      admission.assertActive({ ...PROFILE, tokenContract: "0x0456" }),
    ).rejects.toBeInstanceOf(SettlementAdmissionIntegrityError);
  });
});

function pauseRecord(): SettlementPauseRecord {
  return {
    profile: PROFILE,
    reason: "PAYOUT_FINALITY_REORGED",
    intentId: "intent-1",
    submissionId: "submission-1",
    transactionReference: "0xabc",
    originalInclusion: { blockHash: "0xdef", blockNumber: 42n },
    detectedAt: "2026-09-01T10:00:00.000Z",
    observerVersion: "observer-v1",
  };
}

class ThrowingPauseStore implements SettlementPauseStore {
  async getPause(_profile: SettlementProfile): Promise<SettlementPauseRecord | null> {
    throw new Error("private-store-path");
  }

  async pause(_candidate: SettlementPauseCandidate): Promise<SettlementPauseRecord> {
    throw new Error("not used");
  }
}

class MismatchedPauseStore implements SettlementPauseStore {
  async getPause(_profile: SettlementProfile): Promise<SettlementPauseRecord | null> {
    return {
      ...pauseRecord(),
      profile: { ...PROFILE, tokenContract: "0x789" },
    };
  }

  async pause(candidate: SettlementPauseCandidate): Promise<SettlementPauseRecord> {
    return candidate;
  }
}

class HostilePauseStore implements SettlementPauseStore {
  async getPause(_profile: SettlementProfile): Promise<SettlementPauseRecord | null> {
    let profileReads = 0;
    return {
      ...pauseRecord(),
      get profile() {
        profileReads += 1;
        if (profileReads > 1) {
          throw new Error("private-store-value");
        }
        return PROFILE;
      },
    };
  }

  async pause(candidate: SettlementPauseCandidate): Promise<SettlementPauseRecord> {
    return candidate;
  }
}
