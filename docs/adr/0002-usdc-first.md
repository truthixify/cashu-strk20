# ADR 0002: USDC First

- Status: Accepted
- Date: 2026-09-01

## Context

The first integration should minimize market and unit complexity while proving the cross-protocol
settlement path. Stable value is easier for merchant checkout, fees, metrics, and a capped pilot.
Cashu explicitly supports stablecoin currency codes in their minor units.

## Decision

Support only `usdc` in the first implementation. One Cashu amount unit is one US cent. For a
six-decimal USDC token, multiply by 10,000 with checked integer arithmetic.

Require exact payments during the spike. Do not accumulate partial payments or issue extra Cashu for
overpayment.

## Consequences

- Standard Cashu amount integers map naturally to merchant pricing.
- The minimum represented value is one cent.
- Sub-cent fees or machine payments need an explicit future unit, not hidden decimals.
- Wallet compatibility with `usdc` must be tested.
- strkBTC and additional stablecoins remain later decisions.
