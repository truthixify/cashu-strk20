import {
  ATTRIBUTION_PROFILES,
  type AttributionProfile,
  type MeltPaymentEnvelope,
  type PaymentObservation,
  type StarknetNetwork,
} from "@cashu-strk20/strk20-method";
import type { VerifiedPayerBinding } from "./payer-bindings.js";

export interface FundingRequestInput {
  readonly paymentRequestId: string;
  readonly network: StarknetNetwork;
  readonly poolContract: string;
  readonly tokenContract: string;
  readonly amountBaseUnits: bigint;
  readonly expiresAt: Date;
  readonly attributionProfile: AttributionProfile;
}

export interface FundingInstructionRequest extends FundingRequestInput {
  readonly verifiedPayerBinding?: VerifiedPayerBinding;
}

export interface FundingInstructions {
  readonly paymentRequestId: string;
  readonly destination: Readonly<Record<string, unknown>>;
}

export interface FundingEvidenceReference {
  readonly evidenceId: string;
  readonly noteReference: string;
  readonly transactionReference: string;
  readonly blockHash: string;
  readonly blockNumber: bigint;
}

export interface FundingDiscoveryInput {
  readonly paymentRequestId: string;
  readonly verifiedPayerBinding?: VerifiedPayerBinding;
  /** Full persisted observations that must be re-observed without reconstructing their identity. */
  readonly knownEvidence: readonly PaymentObservation[];
  /** Untrusted lookup accelerator. It never changes the expected payment identity. */
  readonly transactionHint?: string;
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
  /** Attribution profiles this gateway can implement without falling back to another identity. */
  readonly supportedAttributionProfiles: readonly AttributionProfile[];
  /** Repeating this call for one payment request ID must return the same instructions. */
  createFundingInstructions(input: FundingInstructionRequest): Promise<FundingInstructions>;
  /** Discover independently verified candidates; a wallet hint is never payment evidence. */
  findFundingPayments(input: FundingDiscoveryInput): Promise<readonly PaymentObservation[]>;
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

export type PrivateFundingGateway = Pick<
  PrivateSettlementGateway,
  "supportedAttributionProfiles" | "createFundingInstructions" | "findFundingPayments"
>;

export type PrivatePayoutGateway = Pick<
  PrivateSettlementGateway,
  "preparePayout" | "submitPayout" | "getPayoutStatus"
>;

export class PrivateSettlementGatewayConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivateSettlementGatewayConfigurationError";
  }
}

export class CompositePrivateSettlementGateway implements PrivateSettlementGateway {
  readonly supportedAttributionProfiles: readonly AttributionProfile[];

  constructor(
    readonly funding: PrivateFundingGateway,
    readonly payouts: PrivatePayoutGateway,
  ) {
    assertGatewayMethods(
      funding,
      ["createFundingInstructions", "findFundingPayments"],
      "funding gateway",
    );
    assertGatewayMethods(
      payouts,
      ["preparePayout", "submitPayout", "getPayoutStatus"],
      "payout gateway",
    );
    this.supportedAttributionProfiles = fundingGatewayAttributionProfiles(funding);
  }

  createFundingInstructions(input: FundingInstructionRequest): Promise<FundingInstructions> {
    return this.funding.createFundingInstructions(input);
  }

  findFundingPayments(input: FundingDiscoveryInput): Promise<readonly PaymentObservation[]> {
    return this.funding.findFundingPayments(input);
  }

  preparePayout(input: PayoutPreparationInput): Promise<PayoutAttempt> {
    return this.payouts.preparePayout(input);
  }

  submitPayout(submissionId: string): Promise<PayoutAttempt> {
    return this.payouts.submitPayout(submissionId);
  }

  getPayoutStatus(submissionId: string): Promise<PayoutAttempt> {
    return this.payouts.getPayoutStatus(submissionId);
  }
}

export function fundingGatewayAttributionProfiles(
  gateway: PrivateFundingGateway,
): readonly AttributionProfile[] {
  const profiles: unknown = gateway.supportedAttributionProfiles;
  if (!Array.isArray(profiles) || profiles.length === 0) {
    throw new PrivateSettlementGatewayConfigurationError(
      "Configured funding gateway attribution profiles are invalid",
    );
  }
  const snapshot: unknown[] = Array.from(profiles);
  if (
    snapshot.some((profile) => !isAttributionProfile(profile)) ||
    new Set(snapshot).size !== snapshot.length
  ) {
    throw new PrivateSettlementGatewayConfigurationError(
      "Configured funding gateway attribution profiles are invalid",
    );
  }
  return Object.freeze(snapshot) as readonly AttributionProfile[];
}

function assertGatewayMethods(value: unknown, methods: readonly string[], label: string): void {
  if (
    typeof value !== "object" ||
    value === null ||
    methods.some((method) => typeof (value as Record<string, unknown>)[method] !== "function")
  ) {
    throw new PrivateSettlementGatewayConfigurationError(`Configured ${label} is invalid`);
  }
}

function isAttributionProfile(value: unknown): value is AttributionProfile {
  return typeof value === "string" && ATTRIBUTION_PROFILES.includes(value as AttributionProfile);
}
