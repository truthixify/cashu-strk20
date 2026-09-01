import { isDeepStrictEqual } from "node:util";

import type { MeltPaymentEnvelope } from "@cashu-strk20/strk20-method";

export interface SettlementIntentIdentity {
  readonly quoteId: string;
  readonly network: string;
  readonly tokenContract: string;
  readonly amountBaseUnits: string;
  readonly destination: Readonly<Record<string, unknown>>;
}

export class IntentConflictError extends Error {
  constructor() {
    super("An existing quote ID is bound to different payout instructions");
    this.name = "IntentConflictError";
  }
}

export function intentIdentity(
  quoteId: string,
  request: MeltPaymentEnvelope,
): SettlementIntentIdentity {
  return {
    quoteId,
    network: request.network,
    tokenContract: request.token_contract,
    amountBaseUnits: request.amount_base_units,
    destination: request.destination,
  };
}

export function assertSameIntent(
  existing: SettlementIntentIdentity,
  requested: SettlementIntentIdentity,
): void {
  if (!isDeepStrictEqual(existing, requested)) {
    throw new IntentConflictError();
  }
}
