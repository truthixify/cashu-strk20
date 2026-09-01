# Cashu Payment Method: `strk20`

Status: Draft 0.1, not implemented, not a Cashu NUT.

## Abstract

This document defines the stable core of a Cashu custom payment method named `strk20`. A Cashu mint
uses private STRK20 assets on Starknet for incoming reserve funding and outgoing redemption. The
initial unit is `usdc`, represented in integer US-cent minor units.

This method does not alter Cashu blind signatures or STRK20 cryptography. It specifies how a CDK
payment processor validates amounts, correlates quotes, observes private settlement, reports
asynchronous states, and prevents duplicate payouts.

## Requirement language

The key words `MUST`, `MUST NOT`, `REQUIRED`, `SHOULD`, `SHOULD NOT`, and `MAY` are to be interpreted
as normative requirements within this project draft. They do not imply external standardization.

## Scope

Version 0.1 covers:

- Starknet testnet and mainnet identifiers, with testnet as the only enabled profile;
- STRK20 USDC mint quotes and melt quotes;
- CDK custom payment method fields;
- exact unit conversion;
- quote correlation and idempotency;
- conservative asynchronous settlement;
- two experimental incoming-payment attribution profiles.

It does not cover wallet transport UX, bridge funding, strkBTC, swaps, general offline finality,
screening policy, reserve attestations, or mint federation.

## Terms

| Term | Meaning |
|---|---|
| Cashu quote ID | Secret identifier created by the mint for NUT-04 or NUT-05 |
| Payment request ID | Independently random method identifier used to observe one funding request |
| Settlement intent ID | Durable internal identifier for one outgoing payout |
| Funding request | Method envelope telling a wallet how much and where to send STRK20 |
| Payout request | Method envelope identifying the intended STRK20 redemption |
| Final | Canonical under the operator's configured and documented Starknet finality policy |
| Hint | Untrusted wallet data that may accelerate discovery but cannot authorize settlement |

## Method and unit identifiers

- Payment method name: `strk20`
- Initial Cashu unit: `usdc`
- Cashu `usdc` minor unit: 2 decimal places
- STRK20 token decimals for initial USDC profile: 6
- Conversion factor: `1 Cashu usdc = 10,000 ERC-20 base units`

All Cashu amounts MUST be positive integers. All STRK20 token amounts MUST be non-negative integer
base units represented losslessly. Implementations MUST NOT use IEEE-754 numbers for token base
units in JavaScript or JSON.

The exact conversion is:

```text
strk20_base_units = cashu_usdc_units * 10^(6 - 2)
                   = cashu_usdc_units * 10,000
```

Reverse conversion MUST reject an amount that is not divisible by 10,000. Silent rounding is
forbidden. Overflow MUST be detected before multiplication.

Examples:

| Cashu amount | User value | STRK20 base units |
|---:|---:|---:|
| 1 | 0.01 USDC | 10,000 |
| 100 | 1.00 USDC | 1,000,000 |
| 2,000 | 20.00 USDC | 20,000,000 |

Network or proving fees that are smaller than one cent cannot be charged exactly in this unit. The
mint MUST publish a cent-denominated fee policy and MUST NOT hide fractional rounding.

## Versioned method envelopes

The `request` string returned or consumed by CDK is an opaque method envelope. Draft 0.1 uses:

```text
strk20:<base64url-no-padding(UTF-8 canonical JSON)>
```

The decoded JSON object MUST contain:

```json
{
  "version": 1,
  "kind": "mint",
  "network": "SN_SEPOLIA",
  "token_contract": "0x...",
  "amount": 2000,
  "amount_base_units": "20000000",
  "expires_at": 1788264000,
  "payment_request_id": "opaque-random-id",
  "attribution_profile": "quote_channel",
  "destination": {}
}
```

For a payout, `kind` is `melt`, `payment_request_id` is omitted, and `destination` identifies the
registered STRK20 recipient. `destination` is profile-specific structured data; its final schema is
deferred until the Privacy SDK spike. Implementations MUST reject unknown envelope versions and
unknown required fields rather than guessing.

The canonical JSON rules will be fixed before interoperability testing. Until then, envelopes are
opaque and MUST NOT be independently signed based on byte serialization.

The Cashu quote ID MUST NOT appear in this envelope. Payment request IDs MUST be generated
independently from quote IDs, carry at least 128 bits of entropy, be single-use, and expire.

## Mint capabilities

A compatible mint advertises custom method `strk20` and unit `usdc` through NUT-06's NUT-04 and
NUT-05 method lists. It SHOULD advertise min and max amounts and any method fee that can be
represented in cents.

Testnet MUST be the only enabled network until production controls are explicitly accepted.

## Incoming mint quotes

### Request

The wallet requests:

```http
POST /v1/mint/quote/strk20
```

The standard fields are:

```json
{
  "amount": 2000,
  "unit": "usdc",
  "description": "optional",
  "pubkey": "NUT-20 quote-lock public key",
  "network": "SN_SEPOLIA",
  "attribution": {
    "profile": "quote_channel"
  }
}
```

`pubkey` SHOULD be supplied and the mint SHOULD require the corresponding NUT-20 signature at
issuance. NUT-20 protects redemption of the Cashu quote; it does not prove control of a Starknet
payer account.

The method fields `network` and `attribution` are passed through CDK's flattened custom JSON. The
mint MUST reject unsupported networks, units, profiles, malformed addresses, out-of-policy amounts,
and duplicate client idempotency keys before creating settlement instructions.

### Response

The response uses the standard custom NUT-04 fields and method-specific flattened fields:

```json
{
  "quote": "secret-cashu-quote-id",
  "request": "strk20:...",
  "amount": 2000,
  "amount_paid": 0,
  "amount_issued": 0,
  "unit": "usdc",
  "expiry": 1788264000,
  "pubkey": "...",
  "network": "SN_SEPOLIA",
  "token_contract": "0x...",
  "amount_base_units": "20000000",
  "payment_request_id": "opaque-random-id",
  "attribution_profile": "quote_channel"
}
```

The mint MUST derive `amount_base_units` with checked integer arithmetic. It MUST bind the payment
request ID to the network, token contract, amount, expiry, and selected attribution profile in
durable storage.

### Funding

The wallet decodes the opaque request through a compatible method client and executes a private
STRK20 payment. A wallet MAY submit a transaction hash or SDK result as a discovery hint. Hints MUST
NOT be treated as proof and MUST NOT change the expected network, token, amount, or destination.

The payment processor reports the quote paid only after independent discovery verifies:

- the exact configured Starknet network and privacy-pool deployment;
- the expected token contract;
- the exact base-unit amount under the active overpayment policy;
- the quote-specific destination or payer binding;
- an unexpired payment request at observation time;
- canonical execution under the finality policy;
- no prior use of the payment evidence for another quote.

The processor MUST NOT infer payment from a successful wallet callback alone.

### Issuance

Once the incoming payment is final, the processor emits the CDK payment event and the Cashu quote
becomes `PAID`. Cashu issuance remains subject to standard blinded-output validation and, when
configured, NUT-20 quote signature verification. The processor never signs Cashu outputs itself.

Replayed issuance requests MUST follow Cashu's standard idempotent quote accounting and MUST NOT
issue beyond the paid amount.

## Experimental attribution profiles

Quote attribution is the highest-risk unresolved integration detail. Draft 0.1 defines two candidate
profiles so the spike can compare them without pretending both are production-ready.

### `quote_channel`

The settlement service creates a destination or discovery channel that is unique to one payment
request ID. A payment discovered through that channel can be attributed without identifying a
specific payer.

This profile is preferred if the Privacy SDK can create and later discover a quote-unique channel
without exposing the Cashu quote ID or creating unbounded onchain identities.

The spike MUST demonstrate uniqueness, discovery after restart, reorg handling, expiry behavior,
and resistance to a second quote claiming the same note.

### `signed_payer`

The wallet binds a Starknet payer address to the requested network, token, amount, client nonce, and
a mint-issued challenge through Starknet typed-data signing. The settlement service then verifies a
discovered payment from the bound payer context.

This profile requires a method challenge endpoint before quote creation. The typed-data domain,
hashing rules, signature representation, and replay cache are intentionally not normative until the
spike validates the current wallet and SDK APIs.

A wallet-supplied transaction hash alone is never a valid attribution profile.

## Late, partial, and incorrect incoming payments

- Partial payment MUST remain unpaid unless a future version explicitly supports accumulation.
- Overpayment MUST NOT increase issuance automatically. The exact-amount policy is REQUIRED for the
  first implementation.
- Wrong-token, wrong-network, or wrong-destination payments MUST NOT pay the quote.
- A payment first observed after expiry enters `LATE_PAYMENT` and requires a documented refund or
  operator process.
- A payment observed before expiry but finalized after expiry MAY pay the quote only if the request
  explicitly promises that policy and observation is durably recorded.
- Reorged payment evidence MUST be revoked before issuance. If issuance already occurred, the mint
  enters an incident state and MUST stop affected minting.

## Outgoing melt quotes

### Request

The wallet requests:

```http
POST /v1/melt/quote/strk20
```

with:

```json
{
  "unit": "usdc",
  "request": "strk20:...",
  "network": "SN_SEPOLIA"
}
```

The payout envelope fixes network, token, recipient, amount, and expiry. The recipient MUST be valid
for the active STRK20 pool and MUST satisfy any registration prerequisite before the mint accepts
proofs.

The adapter MUST parse the request structurally and reject mismatches between the envelope, custom
fields, and configured network. The quote response reports amount and an optional cent-denominated
fee reserve.

### Execution

When CDK calls `make_payment`, the adapter MUST use the CDK melt quote ID as its stable idempotency
key. The settlement service MUST persist one payout intent before submitting a transaction.

Repeated calls for the same quote MUST return or reconcile the existing intent. They MUST NOT create
a second independent payout.

The initial response SHOULD be `PENDING` unless the payout was already final. The adapter polls or
receives replayable events until one of these outcomes is established:

- `PAID`: the private payout is canonical and final;
- `PENDING`: execution or finality is still in progress;
- `UNKNOWN`: the chain or provider cannot establish whether execution occurred;
- `FAILED`: non-execution is proven and recovery of pending Cashu proofs is safe.

A timeout is not `FAILED`. An unavailable RPC is not `FAILED`. A missing receipt immediately after
submission is not `FAILED`.

On `PAID`, `total_spent` is authoritative and includes the represented payout and charged fee under
CDK semantics. Before `PAID`, total spent MUST be zero. A transaction hash MAY be returned as the
private payment proof to the requesting wallet but MUST be redacted from general analytics.

## Finality policy

The operator MUST configure and publish a Starknet finality policy. The implementation MUST verify
canonical block ancestry or an equivalent trusted finality signal and MUST distinguish transaction
acceptance from final settlement.

The Privacy SDK's proving-base age requirement is separate from payout finality and MUST NOT be
misrepresented as the finality rule. Exact receipt statuses and confirmation depth remain a testnet
spike decision.

## Idempotency and uniqueness

- Incoming payment request ID: unique and single-use.
- Incoming chain evidence: unique across Cashu quotes.
- Outgoing CDK quote ID: unique key for a payout intent.
- Settlement transaction: at most one effective payout per quote.
- Event: replayable without duplicating state transitions.
- Operator retry: references the existing intent; it never constructs an unrelated payout.

Uniqueness MUST be enforced by durable constraints, not only an in-memory check.

## Error vocabulary

Method errors SHOULD expose a stable machine code and a redacted human message. Initial codes:

| Code | Meaning |
|---|---|
| `unsupported_network` | Network is not enabled |
| `unsupported_unit` | Unit is not `usdc` |
| `amount_out_of_range` | Amount is zero, overflows, or violates policy |
| `invalid_payment_request` | Envelope or destination is malformed |
| `quote_expired` | Funding or payout request expired |
| `payment_mismatch` | Observed payment does not match quote |
| `payment_already_claimed` | Chain evidence is bound to another quote |
| `recipient_not_ready` | STRK20 recipient prerequisite is missing |
| `settlement_pending` | Existing intent has no final result |
| `settlement_unknown` | Execution cannot currently be determined |
| `settlement_failed` | Permanent non-execution has been proven |
| `operator_required` | Late or exceptional value requires intervention |

Errors MUST NOT include Cashu proofs, quote secrets, private note bodies, signer data, or viewing
keys.

## Security and privacy requirements

- The adapter MUST NOT have access to Cashu wallet proof secrets beyond what CDK inherently owns.
- The settlement service MUST NOT receive bearer proofs.
- Signer and viewing keys MUST be isolated from public API and general logging paths.
- Public metrics MUST use opaque labels with bounded cardinality.
- The method MUST disclose mint custody and offline double-spend limits.
- A viewing-key disclosure MUST be scoped to the Starknet edges only.
- Reserve publication MUST NOT be called proof of liabilities.

See the [threat model](../security/threat-model.md).

## Conformance gates

An implementation cannot call itself draft-0.1 conformant until it passes:

- all amount test vectors in both Rust and TypeScript;
- quote-ID and payment-ID separation tests;
- exact token/network/destination matching tests;
- duplicate deposit evidence tests;
- NUT-20 quote theft tests;
- payout retry and crash-recovery tests;
- timeout-after-submit ambiguity tests;
- reorg before and after payment observation tests;
- late and wrong-token payment tests;
- redaction tests;
- one reproducible testnet mint-in and melt-out.

## Open questions before Draft 0.2

1. Can Privacy SDK `0.14.3-rc.6` create a practical quote-unique discovery channel?
2. Which note and transaction fields provide authoritative attribution after restart?
3. If signed payer binding is needed, what typed-data schema works across target wallets?
4. Which receipt status and block policy is sufficiently conservative for mint issuance and payout?
5. How are late deposits refunded without creating a new privacy leak?
6. Which `usdc` wallets render and transfer the custom unit correctly?
7. Does CDK `0.17.6` expose every custom field required, or is a stable `0.18` feature necessary?
8. What fee policy is understandable when actual network costs are sub-cent or volatile?
