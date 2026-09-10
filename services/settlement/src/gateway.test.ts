import type { AttributionProfile, PaymentObservation } from "@cashu-strk20/strk20-method";
import { describe, expect, it } from "vitest";

import {
  CompositePrivateSettlementGateway,
  type FundingDiscoveryInput,
  type FundingInstructionRequest,
  type FundingInstructions,
  fundingGatewayAttributionProfiles,
  type PayoutAttempt,
  type PayoutPreparationInput,
  type PrivateFundingGateway,
  type PrivatePayoutGateway,
  PrivateSettlementGatewayConfigurationError,
} from "./gateway.js";

describe("private settlement gateway configuration", () => {
  it("returns a frozen snapshot of supported funding attribution profiles", () => {
    const source: AttributionProfile[] = ["signed_payer"];
    const snapshot = fundingGatewayAttributionProfiles(fundingGateway(source));

    source[0] = "quote_channel";

    expect(snapshot).toEqual(["signed_payer"]);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it.each([
    { name: "missing", profiles: undefined },
    { name: "non-array", profiles: "signed_payer" },
    { name: "empty", profiles: [] },
    { name: "sparse", profiles: Array(1) },
    { name: "unknown", profiles: ["wallet_hint"] },
    { name: "duplicate", profiles: ["signed_payer", "signed_payer"] },
  ])("rejects a $name funding capability declaration", ({ profiles }) => {
    expect(() => fundingGatewayAttributionProfiles(fundingGateway(profiles))).toThrowError(
      PrivateSettlementGatewayConfigurationError,
    );
  });

  it("copies the funding capability into a composite gateway", () => {
    const source: AttributionProfile[] = ["signed_payer"];
    const gateway = new CompositePrivateSettlementGateway(fundingGateway(source), payoutGateway());

    source[0] = "quote_channel";

    expect(gateway.supportedAttributionProfiles).toEqual(["signed_payer"]);
    expect(Object.isFrozen(gateway.supportedAttributionProfiles)).toBe(true);
  });
});

function fundingGateway(profiles: unknown): PrivateFundingGateway {
  return {
    supportedAttributionProfiles: profiles as readonly AttributionProfile[],
    async createFundingInstructions(
      input: FundingInstructionRequest,
    ): Promise<FundingInstructions> {
      return { paymentRequestId: input.paymentRequestId, destination: {} };
    },
    async findFundingPayments(
      _input: FundingDiscoveryInput,
    ): Promise<readonly PaymentObservation[]> {
      return [];
    },
  };
}

function payoutGateway(): PrivatePayoutGateway {
  return {
    async preparePayout(input: PayoutPreparationInput): Promise<PayoutAttempt> {
      return { intentId: input.intentId, submissionId: "submission-1", status: "PREPARED" };
    },
    async submitPayout(_submissionId: string): Promise<PayoutAttempt> {
      return { intentId: "intent-1", submissionId: "submission-1", status: "PENDING" };
    },
    async getPayoutStatus(_submissionId: string): Promise<PayoutAttempt> {
      return { intentId: "intent-1", submissionId: "submission-1", status: "PENDING" };
    },
  };
}
