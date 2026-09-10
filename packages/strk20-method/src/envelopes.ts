import type { AttributionProfile, StarknetNetwork } from "./constants.js";

export interface MethodEnvelopeBase {
  readonly version: 1;
  readonly network: StarknetNetwork;
  readonly token_contract: string;
  readonly amount: number;
  readonly amount_base_units: string;
  readonly expires_at: number;
  readonly destination: Readonly<Record<string, unknown>>;
}

export interface MintPaymentEnvelope extends MethodEnvelopeBase {
  readonly kind: "mint";
  readonly payment_request_id: string;
  readonly attribution_profile: AttributionProfile;
}

export interface MeltPaymentEnvelope extends MethodEnvelopeBase {
  readonly kind: "melt";
}

export type Strk20MethodEnvelope = MintPaymentEnvelope | MeltPaymentEnvelope;

export const PAYMENT_OBSERVATION_STATUSES = ["PENDING", "FINAL", "REORGED", "CONFLICTED"] as const;

export type PaymentObservationStatus = (typeof PAYMENT_OBSERVATION_STATUSES)[number];

export interface PaymentObservation {
  readonly network: StarknetNetwork;
  readonly pool_contract: string;
  readonly sender_address: string;
  readonly recipient_address: string;
  readonly token_contract: string;
  readonly amount_base_units: bigint;
  readonly payment_request_id: string;
  readonly attribution_profile: AttributionProfile;
  readonly destination: Readonly<Record<string, unknown>>;
  readonly evidence_id: string;
  readonly note_reference: string;
  readonly transaction_reference: string;
  readonly block_hash: string;
  readonly block_number: bigint;
  readonly status: PaymentObservationStatus;
  readonly finality_policy: string;
  readonly verifier_version: string;
}
