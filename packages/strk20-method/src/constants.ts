export const STRK20_PAYMENT_METHOD = "strk20" as const;
export const STRK20_INITIAL_CASHU_UNIT = "usdc" as const;
export const STRK20_METHOD_VERSION = 1 as const;
export const PAYMENT_REQUEST_ID_MINIMUM_ENTROPY_BITS = 128 as const;

export const STARKNET_NETWORKS = ["SN_SEPOLIA", "SN_MAIN"] as const;
export type StarknetNetwork = (typeof STARKNET_NETWORKS)[number];

export const ATTRIBUTION_PROFILES = ["quote_channel", "signed_payer"] as const;
export type AttributionProfile = (typeof ATTRIBUTION_PROFILES)[number];
