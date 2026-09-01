use std::error::Error;
use std::fmt::{Display, Formatter};

/// Number of six-decimal USDC base units represented by one Cashu US-cent unit.
pub const USDC_BASE_UNITS_PER_CASHU_UNIT: u128 = 10_000;

/// A positive Cashu `usdc` amount in integer cents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CashuUsdcAmount(u64);

impl CashuUsdcAmount {
    /// Creates a positive Cashu USDC amount.
    ///
    /// # Errors
    ///
    /// Returns [`AmountError::NotPositive`] when `value` is zero.
    pub const fn new(value: u64) -> Result<Self, AmountError> {
        if value == 0 {
            return Err(AmountError::NotPositive);
        }

        Ok(Self(value))
    }

    /// Returns the integer Cashu minor-unit value.
    #[must_use]
    pub const fn value(self) -> u64 {
        self.0
    }

    /// Converts the amount to six-decimal USDC base units without precision loss.
    #[must_use]
    pub fn to_base_units(self) -> u128 {
        u128::from(self.0) * USDC_BASE_UNITS_PER_CASHU_UNIT
    }

    /// Converts exact six-decimal USDC base units to Cashu US-cent units.
    ///
    /// # Errors
    ///
    /// Returns an error for zero, a sub-cent remainder, or a value above the Cashu unsigned 64-bit
    /// range.
    pub fn from_base_units(base_units: u128) -> Result<Self, AmountError> {
        if base_units == 0 {
            return Err(AmountError::NotPositive);
        }

        if !base_units.is_multiple_of(USDC_BASE_UNITS_PER_CASHU_UNIT) {
            return Err(AmountError::NotExact);
        }

        let cashu_units = base_units / USDC_BASE_UNITS_PER_CASHU_UNIT;
        let value = u64::try_from(cashu_units).map_err(|_| AmountError::Overflow)?;
        Ok(Self(value))
    }
}

/// Exact amount-conversion failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AmountError {
    /// Amount is zero.
    NotPositive,
    /// Base units contain a fraction smaller than one Cashu cent.
    NotExact,
    /// Converted amount exceeds the Cashu unsigned 64-bit range.
    Overflow,
}

impl Display for AmountError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotPositive => formatter.write_str("amount must be positive"),
            Self::NotExact => formatter.write_str("base units are not exactly divisible by 10,000"),
            Self::Overflow => formatter.write_str("amount exceeds the unsigned 64-bit Cashu range"),
        }
    }
}

impl Error for AmountError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_known_amounts_exactly() {
        for (cashu, base_units) in [(1, 10_000), (100, 1_000_000), (2_000, 20_000_000)] {
            let amount = CashuUsdcAmount::new(cashu).expect("known amount is positive");
            assert_eq!(amount.to_base_units(), base_units);
            assert_eq!(CashuUsdcAmount::from_base_units(base_units), Ok(amount));
        }
    }

    #[test]
    fn supports_the_full_cashu_u64_range() {
        let amount = CashuUsdcAmount::new(u64::MAX).expect("maximum is positive");
        assert_eq!(
            CashuUsdcAmount::from_base_units(amount.to_base_units()),
            Ok(amount)
        );
    }

    #[test]
    fn rejects_zero_in_both_directions() {
        assert_eq!(CashuUsdcAmount::new(0), Err(AmountError::NotPositive));
        assert_eq!(
            CashuUsdcAmount::from_base_units(0),
            Err(AmountError::NotPositive)
        );
    }

    #[test]
    fn rejects_sub_cent_base_units() {
        assert_eq!(
            CashuUsdcAmount::from_base_units(10_001),
            Err(AmountError::NotExact)
        );
    }

    #[test]
    fn rejects_reverse_conversion_above_u64() {
        let base_units = (u128::from(u64::MAX) + 1) * USDC_BASE_UNITS_PER_CASHU_UNIT;
        assert_eq!(
            CashuUsdcAmount::from_base_units(base_units),
            Err(AmountError::Overflow)
        );
    }
}
