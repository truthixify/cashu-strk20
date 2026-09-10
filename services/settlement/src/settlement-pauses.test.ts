import { describe, expect, it } from "vitest";

import {
  InMemorySettlementPauseStore,
  SettlementPauseIntegrityError,
  type SettlementPauseRecord,
} from "./settlement-pauses.js";

const PROFILE = {
  method: "strk20",
  network: "SN_SEPOLIA",
  tokenContract: "0x456",
} as const;

describe("settlement pause store", () => {
  it("retains the first pause for one method, network, and token profile", async () => {
    const store = new InMemorySettlementPauseStore();
    const first = pauseRecord();
    const second = pauseRecord({
      reason: "PAYOUT_FINALITY_CONFLICTED",
      intentId: "intent-2",
      submissionId: "submission-2",
      transactionReference: "0x999",
      detectedAt: "2026-09-01T11:00:00.000Z",
    });

    await expect(store.pause(first)).resolves.toEqual(first);
    await expect(store.pause(second)).resolves.toEqual(first);
    await expect(store.getPause(PROFILE)).resolves.toEqual(first);
  });

  it("returns detached records and keeps distinct profiles independent", async () => {
    const store = new InMemorySettlementPauseStore();
    const first = await store.pause(pauseRecord());
    const other = pauseRecord({
      profile: { ...PROFILE, tokenContract: "0x789" },
      intentId: "intent-2",
      submissionId: "submission-2",
      transactionReference: "0x999",
    });
    await store.pause(other);

    (first.originalInclusion as { blockHash: string }).blockHash = "0x999";
    await expect(store.getPause(PROFILE)).resolves.toMatchObject({
      originalInclusion: { blockHash: "0xdef" },
    });
    await expect(store.getPause(other.profile)).resolves.toEqual(other);
  });

  it.each([
    { name: "wrong method", value: { profile: { ...PROFILE, method: "bolt11" } } },
    { name: "wrong network", value: { profile: { ...PROFILE, network: "SN_UNKNOWN" } } },
    { name: "non-canonical token", value: { profile: { ...PROFILE, tokenContract: "0x0456" } } },
    {
      name: "oversized token",
      value: { profile: { ...PROFILE, tokenContract: `0x${"1".repeat(10_000)}` } },
    },
    { name: "zero token", value: { profile: { ...PROFILE, tokenContract: "0x0" } } },
    { name: "unknown reason", value: { reason: "RPC_FAILURE" } },
    { name: "malformed transaction", value: { transactionReference: "0Xabc" } },
    {
      name: "malformed inclusion",
      value: { originalInclusion: { blockHash: "0xdef", blockNumber: -1n } },
    },
    { name: "non-canonical time", value: { detectedAt: "2026-09-01T10:00:00Z" } },
    { name: "control character", value: { observerVersion: "observer\nsecret" } },
  ])("rejects $name", async ({ value }) => {
    const store = new InMemorySettlementPauseStore();
    await expect(
      store.pause({ ...pauseRecord(), ...value } as SettlementPauseRecord),
    ).rejects.toBeInstanceOf(SettlementPauseIntegrityError);
  });

  it("rejects a profile that changes after its first validation read", async () => {
    const store = new InMemorySettlementPauseStore();
    let tokenReads = 0;
    const profile = {
      method: "strk20" as const,
      network: "SN_SEPOLIA" as const,
      get tokenContract(): string {
        tokenReads += 1;
        return tokenReads === 1 ? "0x456" : "0x0456";
      },
    };

    await expect(store.getPause(profile)).rejects.toBeInstanceOf(SettlementPauseIntegrityError);
  });
});

function pauseRecord(overrides: Partial<SettlementPauseRecord> = {}): SettlementPauseRecord {
  return {
    profile: PROFILE,
    reason: "PAYOUT_FINALITY_REORGED",
    intentId: "intent-1",
    submissionId: "submission-1",
    transactionReference: "0xabc",
    originalInclusion: { blockHash: "0xdef", blockNumber: 42n },
    detectedAt: "2026-09-01T10:00:00.000Z",
    observerVersion: "observer-v1",
    ...overrides,
  };
}
