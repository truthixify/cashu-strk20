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

export interface PayoutPreparationInput {
  readonly intentId: string;
  readonly request: MeltPaymentEnvelope;
}

export type PayoutAttemptStatus = "PREPARED" | "PENDING" | "UNKNOWN" | "PAID" | "FAILED";

export interface PayoutAttempt {
  readonly intentId: string;
  readonly submissionId: string;
  readonly status: PayoutAttemptStatus;
  readonly transactionReference?: string;
}

export interface PrivateSettlementGateway {
  createFundingInstructions(input: FundingRequestInput): Promise<FundingInstructions>;
  findFundingPayment(paymentRequestId: string): Promise<PaymentObservation | null>;
  /** Prepare a uniquely identified transaction attempt without broadcasting it. */
  preparePayout(input: PayoutPreparationInput): Promise<PayoutAttempt>;
  /**
   * Broadcast the prepared attempt. Repeating this call for one submission ID must not create a
   * different transaction or a second effective payout.
   */
  submitPayout(submissionId: string): Promise<PayoutAttempt>;
  /** `PAID` means canonical finality; `FAILED` means non-execution is proven and recovery is safe. */
  getPayoutStatus(submissionId: string): Promise<PayoutAttempt>;
}
