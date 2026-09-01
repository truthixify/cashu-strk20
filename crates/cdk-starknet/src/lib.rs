//! CDK payment method boundary for private STRK20 settlement.

#![forbid(unsafe_code)]

mod amount;
mod state;

pub use amount::{AmountError, CashuUsdcAmount, USDC_BASE_UNITS_PER_CASHU_UNIT};
pub use state::{IncomingState, OutgoingState};

/// Cashu custom payment method identifier.
pub const PAYMENT_METHOD: &str = "strk20";

/// Initial Cashu currency unit.
pub const CURRENCY_UNIT: &str = "usdc";
