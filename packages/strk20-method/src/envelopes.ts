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

export interface PaymentObservation {
  readonly network: StarknetNetwork;
  readonly pool_contract: string;
  readonly token_contract: string;
  readonly amount_base_units: bigint;
  readonly payment_request_id: string;
  readonly evidence_id: string;
  readonly block_hash: string;
  readonly block_number: bigint;
}
