# Specifications

These are project drafts, not accepted Cashu NUTs or Starknet standards.

- [STRK20 payment method](strk20-payment-method.md) defines the Cashu custom method and stable
  invariants.
- [State machines](state-machines.md) defines quote, deposit, and payout transitions.
- [Testnet deployment manifest](testnet-deployment-manifest.md) defines the canonical public
  pool/token deployment claim and UDC-origin checks committed by testnet evidence.
- [CDK 0.17.6 wire vector](vectors/cdk-0.17.6-strk20.json) freezes the candidate flattened custom
  NUT-04 and NUT-05 JSON checked against the exact published Rust types.
- [Signed-payer SNIP-12 vector](vectors/signed-payer-snip12-v2.json) freezes the current candidate
  typed data and its `starknet@10.5.0` message hash.
- [Superseded signed-payer v1 vector](vectors/signed-payer-snip12-v1.json) preserves the incompatible
  pre-note-binding schema for review only.

The testnet spike must resolve quote attribution and exact Privacy SDK compatibility before the
payment-method draft can become an interoperability proposal.
