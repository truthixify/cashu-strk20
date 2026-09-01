import type {
  MeltPaymentEnvelope,
  PaymentObservation,
  StarknetNetwork,
} from "@cashu-strk20/strk20-method";

export interface FundingRequestInput {
  readonly paymentRequestId: string;
  readonly network: StarknetNetwork;
  readonly tokenContract: string;
  readonly amountBaseUnits: bigint;
  readonly expiresAt: Date;
  readonly attributionProfile: "quote_channel" | "signed_payer";
}

export interface FundingInstructions {
  readonly paymentRequestId: string;
  readonly destination: Readonly<Record<string, unknown>>;
}

export interface PayoutIntentInput {
  readonly quoteId: string;
  readonly request: MeltPaymentEnvelope;
}

export interface PayoutSubmission {
  readonly intentId: string;
  readonly status: "PENDING" | "UNKNOWN" | "PAID" | "FAILED";
  readonly transactionReference?: string;
}

export interface PrivateSettlementGateway {
  createFundingInstructions(input: FundingRequestInput): Promise<FundingInstructions>;
  findFundingPayment(paymentRequestId: string): Promise<PaymentObservation | null>;
  ensurePayoutIntent(input: PayoutIntentInput): Promise<PayoutSubmission>;
  getPayoutStatus(intentId: string): Promise<PayoutSubmission>;
}
