import { describe, expect, it } from "vitest";

import { IntentConflictError, assertSameIntent } from "./intents.js";

const intent = {
  quoteId: "quote-1",
  network: "SN_SEPOLIA",
  tokenContract: "0x123",
  amountBaseUnits: "10000",
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
    { destination: { recipient: "0xattacker", pool: "0xdef" } },
  ])("rejects changed payout identity: %o", (change) => {
    expect(() => assertSameIntent(intent, { ...intent, ...change })).toThrowError(
      IntentConflictError,
    );
  });
});
