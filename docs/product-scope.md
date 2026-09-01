# Product Scope

## Product statement

Cashu x STRK20 gives private Starknet assets a cash mode. A user privately funds a Cashu mint with
STRK20 USDC, transfers ecash through a QR code, link, NFC transport, or application message, and
later redeems aggregate value to a private Starknet recipient.

It is an integration product, not a replacement for STRK20. Native STRK20 remains the better path
for self-custodial onchain private transfers. Cashu is useful when a payment needs instant bearer
handoff, accountless receipt, low-connectivity ergonomics, or batching.

## Initial users

- Cashu mint operators who want private stablecoin settlement on Starknet.
- Starknet wallet teams that want an optional fast cash balance.
- Merchant and payment developers building QR or link checkout.
- API and machine-payment developers that need small bearer payments.
- A tightly capped merchant pilot after legal and security review.

## Product surfaces

### Reusable payment processor

`cdk-starknet` implements CDK's custom payment backend for method `strk20` and unit `usdc`. This is
the primary open-source deliverable.

### Settlement service

The service wraps the Starknet Privacy SDK, verifies incoming notes, creates private payouts, tracks
finality, and reconciles ambiguous results. It does not mint Cashu and cannot independently declare
a quote issued.

### Reference wallet and merchant flow

A later PWA demonstrates funding, NUT-18 payment requests, ecash receipt, and private redemption.
It is evidence that the backend is usable, not the core moat.

### Reserve evidence

A later read-only surface publishes reserve snapshots and signed liability commitments. It must
label the difference between reserves and liabilities and must not imply a full solvency proof.

## First proof

The first implementation has one asset, network profile, mint, wallet, and redemption path:

- USDC only;
- Starknet testnet only;
- Cashu integer-cent amounts;
- one private mint-in per quote;
- direct online Cashu payment request;
- one asynchronous private melt-out;
- deterministic recovery tests.

The core question is whether a settlement service can attribute a discovered STRK20 payment to one
Cashu quote without exposing the quote ID onchain or trusting a wallet-supplied transaction hash.

## Ranked use cases

1. Private stablecoin merchant checkout with instant Cashu receipt and batched settlement.
2. Wallet-to-wallet cash links and QR payments between private Starknet edges.
3. Low-connectivity merchant acceptance with explicit limits and later spentness verification.
4. HTTP 402 and machine payments in stablecoin cents.
5. Private payroll or creator payouts where recipients redeem on their own schedule.
6. Cross-chain private USDC funding after the bridge and core adapter are mature.
7. strkBTC-backed cash after USDC settlement is reliable.

## Non-goals for the first release

- Reimplementing STRK20 transfer cryptography or contracts.
- Building a mixer, bridge, or custom anonymizer.
- Claiming self-custody while Cashu proofs are outstanding.
- Trustless or fully decentralized mint operation.
- Guaranteed offline finality for generic bearer proofs.
- A complete proof of Cashu liabilities.
- Mainnet or real-value custody.
- Multiple stablecoins, strkBTC, swaps, DeFi routing, or cross-chain funding.
- Broad wallet compatibility before the custom unit and method are validated.
- Screening or compliance policy presented as legal advice.

## Product success gates

The project is worth expanding when it can show:

- deterministic quote attribution on testnet;
- no issuance before verified finality;
- no duplicate payout under retries and crashes;
- successful async redemption with conservative unknown-state handling;
- interoperable Cashu payment-request transfer using `usdc`;
- honest custody and privacy disclosures in the reference flow;
- reproducible evidence suitable for independent review.
