# ADR 0001: Two-Layer Private Payments

- Status: Accepted
- Date: 2026-09-01

## Context

STRK20 provides private programmable settlement on Starknet. Cashu provides blind bearer ecash that
can move quickly through QR, links, NFC, and application messages. Reimplementing either protocol
would add cryptographic risk without improving the product.

The privacy scopes differ. STRK20 covers the onchain edges and scoped viewing. Cashu covers bearer
circulation but introduces mint custody and does not make offchain hops visible to a STRK20 viewer.

## Decision

Use STRK20 as the funding, reserve, and redemption layer. Use standard Cashu as the high-frequency
payment layer between those edges. Integrate through CDK's custom payment processor interface.

Describe the result as edge-auditable private settlement with cash-like circulation, not as one
end-to-end traceable or trustless privacy system.

## Consequences

- The product gains instant bearer payments and batching without duplicating STRK20 transfers.
- The mint is custodial while Cashu liabilities are outstanding.
- STRK20 viewing keys cannot trace Cashu peer-to-peer transfers.
- Wallet and merchant UX must disclose offline and custody limits.
- Solvency evidence needs both reserve and liability views.
