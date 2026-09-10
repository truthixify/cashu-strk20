# CDK `0.17.6` compatibility

Status: source-reviewed and compile-tested; running-mint integration pending.

## Reviewed target

- crates.io package: [`cdk-common` `0.17.6`](https://crates.io/crates/cdk-common/0.17.6)
- crates.io checksum: `b67475b79db0e001bfe0843697f177e44be8cd589f48c3f993e76a5317b6fac1`
- upstream tag: [`v0.17.6`](https://github.com/cashubtc/cdk/tree/v0.17.6)
- source commit: `43129596752412ed4b30f8fb8f49ec63650a5f6e`
- payment-processor protocol constant: `3.0.0`
- review date: 2026-09-02

The Rust compatibility test pins the published `cdk-common` crate exactly with default features
disabled and the `mint` feature enabled. It is a dev dependency only. The production
`cdk-starknet` library does not yet depend on CDK or implement `MintPayment`.
The registry crate and exact tag checkout were tested separately. This record does not claim a
reproducible byte-for-byte build or cryptographic binding between the registry artifact and source
commit.

## Result

CDK `0.17.6` exposes the fields required for the first in-process `strk20` adapter. No stable
`0.18`-only field requirement was found. This is not yet runtime conformance: the mint trait,
database restart, event replay, HTTP routing, and a real wallet remain untested in this repository.

The [candidate wire vector](../specs/vectors/cdk-0.17.6-strk20.json) is serialized in the Rust test
through CDK's own public NUT-04 and NUT-05 types. Its quote IDs and addresses are fixed non-secret
fixtures. It freezes the outer CDK JSON only; it does not finalize method-envelope canonicalization,
prove wallet interoperability, or represent a funded transaction.

## Confirmed surface

| Boundary | Pinned behavior | Adapter consequence |
|---|---|---|
| Unit | `CurrencyUnit::from_str("usdc")` produces a custom unit that displays and serializes as `usdc`. | The initial unit does not require a CDK enum change. |
| NUT-04 request | Unknown fields are flattened into `MintQuoteCustomRequest.extra` and forwarded as `CustomIncomingPaymentOptions.extra_json`. | `network` and `attribution` reach an in-process processor. |
| NUT-04 response | `CreateIncomingPaymentResponse.extra_json` is persisted and flattened into `MintQuoteCustomResponse`. | The processor can return the public STRK20 funding fields. |
| Incoming quote ID | CDK creates the Cashu quote ID before calling the processor but does not include it in `CustomIncomingPaymentOptions`. | The processor does not receive the Cashu quote secret through this trait call; it must correlate incoming payment through its independent lookup ID. |
| NUT-05 request | `MeltQuoteCustomRequest` contains `method`, `request`, `unit`, and flattened extra JSON. | The body must include `"method": "strk20"` even though `strk20` is also in the route. |
| Outgoing quote ID | CDK creates one quote ID before `get_payment_quote`, stores it as the melt quote ID, and restores it for `make_payment`. | The adapter can use the exact CDK quote ID as its payout idempotency key. |
| Outgoing metadata | The backend's `PaymentQuoteResponse.extra_json` is persisted and restored for `make_payment`. The wallet's original flattened extra JSON is not what CDK restores. | Any processor metadata needed after quote creation must be returned in the quote response; authoritative payout facts remain in the opaque request envelope. |
| States | `UNPAID`, `PENDING`, `UNKNOWN`, `PAID`, and `FAILED` are public custom melt states. | The conservative asynchronous mapping fits the draft state machine. |
| Payout result | `MakePaymentResponse` exposes lookup ID, optional payment proof, status, and typed total spent, with no method-specific JSON. | Optional transaction reference belongs in `payment_proof`; the adapter must not rely on payout response extras. |
| Events | `MintPayment` exposes incoming status checks, outgoing status checks, a payment-event stream, and outgoing success/failure events carrying quote IDs. | The required polling and stream hooks exist, but the adapter must implement replay and prove restart behavior. |

CDK applies a 1,024-byte limit to the serialized flattened custom request fields for both mint and
melt quote creation. Rust `String::len` counts UTF-8 bytes. The adapter must keep the public custom
request metadata bounded and reject an oversized request before creating settlement state.

## Response field safety

CDK flattens processor response JSON without reserving the standard response names for the
processor. The adapter must return an object containing only its allowlisted method fields and must
reject collisions with these standard fields:

- NUT-04 response: `quote`, `request`, `amount`, `amount_paid`, `amount_issued`, `unit`, `expiry`,
  and `pubkey`;
- NUT-05 response: `quote`, `amount`, `fee_reserve`, `state`, `expiry`, `payment_preimage`, `change`,
  `request`, and `unit`.

Scalar, array, duplicate, or reserved response metadata is invalid. This prevents flattened data
from producing ambiguous JSON or replacing a wallet-visible standard field.

## HTTP and gRPC constraints

The `0.17.6` custom melt handler deserializes the method from the body and does not bind it to the
`{method}` route segment. A normal CDK wallet derives both from the same value, but a raw client can
send different values. A running mint is blocked until its HTTP boundary is wrapped or patched to
compare them and reject any body method other than exactly `strk20` before value handling. Exposing
no other custom method is useful defense in depth, but it is not a substitute for the comparison.

The stock `cdk-payment-processor` gRPC transport does not carry the custom method name. Its server
reconstructs both incoming and outgoing custom options with an empty `method`. It also declares an
`extra_json` field on the payout response but the conversion to and from CDK's
`MakePaymentResponse` drops it. Therefore the first adapter should run in process. A later gRPC
deployment needs an explicitly method-bound processor instance or a reviewed transport change; it
must not infer `strk20` from an empty field.

## Evidence

The source review covered:

- `crates/cashu/src/nuts/nut00/mod.rs`, `nut04.rs`, and `nut05.rs`;
- `crates/cdk-common/src/payment.rs` and `mint.rs`;
- `crates/cdk/src/mint/issue/mod.rs`, `mint/melt/mod.rs`, and the melt saga;
- `crates/cdk-axum/src/custom_handlers.rs`;
- `crates/cdk-payment-processor/src/proto/` client, server, conversion, and schema files;
- the upstream custom quote and quote-ID integration tests.

Repository conformance command:

```bash
cargo test -p cdk-starknet --test cdk_0_17_6_compatibility
```

The test proves the published crate can serialize the vector, reconstruct the exact custom melt
quote ID and response metadata, represent `usdc`, and expose every required asynchronous state. It
does not compile or exercise `cdk`, `cdk-axum`, or `cdk-payment-processor`; those findings remain
source evidence until the running adapter workstream.

The exact upstream tag also passed these focused checks on 2026-09-02:

```bash
cargo test -p cashu custom_mint_quote_response_flattens_extra_on_wire
cargo test -p cdk-payment-processor payment_quote_response_extra_json_roundtrip
cargo test -p cdk-integration-tests test_custom_melt_quote
```

The commands ran one flattened NUT-04 response test, one payment-quote gRPC metadata round-trip test,
and two in-memory custom-melt integration tests for response metadata persistence and quote-ID
propagation. All four selected tests passed. They are upstream implementation evidence, not a test
of this project's future adapter or a live mint deployment.
