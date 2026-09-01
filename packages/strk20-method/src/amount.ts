export const CASHU_USDC_MINOR_UNIT = 2 as const;
export const STRK20_USDC_TOKEN_DECIMALS = 6 as const;
export const USDC_BASE_UNITS_PER_CASHU_UNIT = 10_000n;
export const MAX_CASHU_AMOUNT = (1n << 64n) - 1n;

export type AmountErrorCode = "amount_not_positive" | "amount_not_exact" | "amount_overflow";

export class AmountError extends Error {
  readonly code: AmountErrorCode;

  constructor(code: AmountErrorCode, message: string) {
    super(message);
    this.name = "AmountError";
    this.code = code;
  }
}

export function cashuUsdcToBaseUnits(amount: bigint): bigint {
  assertCashuAmount(amount);
  return amount * USDC_BASE_UNITS_PER_CASHU_UNIT;
}

export function baseUnitsToCashuUsdc(baseUnits: bigint): bigint {
  if (baseUnits <= 0n) {
    throw new AmountError("amount_not_positive", "USDC base units must be positive");
  }

  if (baseUnits % USDC_BASE_UNITS_PER_CASHU_UNIT !== 0n) {
    throw new AmountError(
      "amount_not_exact",
      "USDC base units must be exactly divisible by 10,000",
    );
  }

  const amount = baseUnits / USDC_BASE_UNITS_PER_CASHU_UNIT;
  assertCashuAmount(amount);
  return amount;
}

export function assertCashuAmount(amount: bigint): void {
  if (amount <= 0n) {
    throw new AmountError("amount_not_positive", "Cashu amount must be positive");
  }

  if (amount > MAX_CASHU_AMOUNT) {
    throw new AmountError("amount_overflow", "Cashu amount exceeds the unsigned 64-bit range");
  }
}
