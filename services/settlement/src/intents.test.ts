import { describe, expect, it } from "vitest";

import {
  assertSameIntent,
  InMemorySettlementIntentStore,
  IntentConflictError,
  IntentIntegrityError,
} from "./intents.js";

const intent = {
  quoteId: "quote-1",
  network: "SN_SEPOLIA",
  tokenContract: "0x123",
  amountBaseUnits: "10000",
  expiresAt: 2_000_000_000,
  destination: { recipient: "0xabc", pool: "0xdef" },
} as const;

describe("settlement intent identity", () => {
  it("accepts an idempotent retry with the same immutable fields", () => {
    expect(() =>
      assertSameIntent(intent, {
        ...intent,
        destination: {
          pool: "0xdef",
          recipient: "0xabc",
        },
      }),
    ).not.toThrow();
  });

  it("compares nested destination data structurally", () => {
    const nested = {
      ...intent,
      destination: { route: { pool: "0xdef", recipient: "0xabc" } },
    };

    expect(() =>
      assertSameIntent(nested, {
        ...nested,
        destination: { route: { recipient: "0xabc", pool: "0xdef" } },
      }),
    ).not.toThrow();
  });

  it.each([
    { quoteId: "quote-2" },
    { network: "SN_MAIN" },
    { tokenContract: "0x456" },
    { amountBaseUnits: "20000" },
    { expiresAt: 2_000_000_001 },
    { destination: { recipient: "0xattacker", pool: "0xdef" } },
  ])("rejects changed payout identity: %o", (change) => {
    expect(() => assertSameIntent(intent, { ...intent, ...change })).toThrowError(
      IntentConflictError,
    );
  });

  it("keeps the first prepared submission under competing attachments", async () => {
    const store = new InMemorySettlementIntentStore();
    const created = await store.createOrGet({ intentId: "intent-1", identity: intent });

    const [first, second] = await Promise.all([
      store.attachSubmission(created.intentId, "submission-1"),
      store.attachSubmission(created.intentId, "submission-2"),
    ]);

    expect(first.submissionId).toBe("submission-1");
    expect(second.submissionId).toBe("submission-1");
  });

  it("does not expose mutable destination or lineage references", async () => {
    const store = new InMemorySettlementIntentStore();
    const created = await store.createOrGet({ intentId: "intent-1", identity: intent });
    const attached = await store.attachSubmission(created.intentId, "submission-1");
    const pending = await store.recordAttempt({
      intentId: attached.intentId,
      submissionId: "submission-1",
      status: "PENDING",
      transactionReference: "0xtx",
    });

    (pending.identity.destination as { recipient: string }).recipient = "0xmutated";
    (pending.transactionReferences as string[]).push("0xmutated");

    const loaded = await store.createOrGet({ intentId: "unused", identity: intent });
    expect(loaded.identity.destination).toEqual(intent.destination);
    expect(loaded.transactionReferences).toEqual(["0xtx"]);
  });

  it("ignores stale non-terminal observations after payment is final", async () => {
    const store = new InMemorySettlementIntentStore();
    const created = await store.createOrGet({ intentId: "intent-1", identity: intent });
    await store.attachSubmission(created.intentId, "submission-1");
    await store.recordAttempt({
      intentId: created.intentId,
      submissionId: "submission-1",
      status: "PENDING",
    });
    await store.recordAttempt({
      intentId: created.intentId,
      submissionId: "submission-1",
      status: "PAID",
      transactionReference: "0xtx-final",
    });

    const afterStalePending = await store.recordAttempt({
      intentId: created.intentId,
      submissionId: "submission-1",
      status: "PENDING",
    });

    expect(afterStalePending.state).toBe("PAID");
    await expect(
      store.recordAttempt({
        intentId: created.intentId,
        submissionId: "submission-1",
        status: "FAILED",
      }),
    ).rejects.toBeInstanceOf(IntentIntegrityError);
  });
});
