import { describe, expect, it } from "vitest";

import {
  AmountError,
  MAX_CASHU_AMOUNT,
  baseUnitsToCashuUsdc,
  cashuUsdcToBaseUnits,
} from "./amount.js";

describe("USDC amount conversion", () => {
  it.each([
    [1n, 10_000n],
    [100n, 1_000_000n],
    [2_000n, 20_000_000n],
  ])("maps %s Cashu units to exact token base units", (cashuAmount, baseUnits) => {
    expect(cashuUsdcToBaseUnits(cashuAmount)).toBe(baseUnits);
    expect(baseUnitsToCashuUsdc(baseUnits)).toBe(cashuAmount);
  });

  it("supports the full Cashu unsigned 64-bit range without JavaScript number loss", () => {
    const baseUnits = cashuUsdcToBaseUnits(MAX_CASHU_AMOUNT);
    expect(baseUnitsToCashuUsdc(baseUnits)).toBe(MAX_CASHU_AMOUNT);
  });

  it.each([0n, -1n])("rejects non-positive Cashu amount %s", (amount) => {
    expect(() => cashuUsdcToBaseUnits(amount)).toThrowError(AmountError);
  });

  it("rejects a Cashu amount above the unsigned 64-bit range", () => {
    expect(() => cashuUsdcToBaseUnits(MAX_CASHU_AMOUNT + 1n)).toThrowError(
      expect.objectContaining({ code: "amount_overflow" }),
    );
  });

  it("rejects an inexact reverse conversion", () => {
    expect(() => baseUnitsToCashuUsdc(10_001n)).toThrowError(
      expect.objectContaining({ code: "amount_not_exact" }),
    );
  });
});
