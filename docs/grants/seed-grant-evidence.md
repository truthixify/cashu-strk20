# Seed Grant Evidence Plan

The grant thesis is stronger after the hardest integration risk is retired. Do not apply with only
an architecture diagram or simulated transfers.

## Application gate

Before applying, produce a reproducible testnet artifact showing:

1. A custom Cashu `strk20`/`usdc` quote from CDK.
2. A real private STRK20 USDC funding transaction.
3. Deterministic quote attribution independent of a trusted client callback.
4. Cashu issuance only after the documented finality rule.
5. A NUT-18 transfer or compatible wallet-to-wallet proof handoff.
6. An asynchronous Cashu melt to a registered STRK20 recipient.
7. Safe retry after a deliberately injected ambiguous settlement result.
8. Public architecture, state-machine, custody, and threat-model documentation.

## Evidence bundle

- Pinned source revision and dependency locks.
- Setup script or exact commands from a clean machine.
- Network, chain ID, pool, token, SDK, CDK, prover, and indexer versions.
- Sanitized transaction hashes and block references.
- Canonical content-hashed pool and token deployment manifests plus the read-only origin-verifier
  record binding each declared transaction to its deterministic UDC address, exact event, canonical
  inclusion, configured finality, and historical class through the configured RPC set.
- A machine-readable verified-run envelope built by the sequential scenario runner through the
  allowlisted testnet-evidence schema and bound to recent contract and service verification records.
- The exact canonical envelope bytes accepted by
  `pnpm --silent testnet:validate-evidence < verified-run.json`.
- Automated test summary with failure-path counts.
- End-to-end timing and fee measurements.
- A two-minute demo recording with no hidden manual state edits.
- A known-limitations page using the custody and privacy disclosure.
- A small compatibility matrix for CDK and one Cashu wallet library.

Do not publish viewing keys, bearer proofs, signer material, private note plaintext, registry tokens,
or credentials in the evidence bundle.

The envelope is a consistency check, not an execution attestation. Before application review, its
deployment profile must match, its chronology and block-bound checks must pass, and scenario coverage
must contain every required scenario with no failed or skipped result. Reviewers must still
authenticate manifest sources, review the disclosed transactions and selected contract authorities,
establish provider independence, verify the privacy-service deployment, and review the demo.
Runner state `COMPLETED` is not sufficient, and output from fake or simulated callbacks does not meet
this gate. Canonical validation catches parser ambiguity and derived-field tampering but does not
authenticate the artifact or replace independent transaction and deployment review.

## Proposed grant deliverables

### Reusable backend

- `cdk-starknet` payment processor for incoming and outgoing custom quotes.
- Versioned `strk20` method draft and conformance fixtures.
- TypeScript settlement service wrapping the pinned Privacy SDK.
- Durable idempotency, reconciliation, and event delivery.

### Reference product

- Wallet cash-mode flow for funding, balance, send, receive, and redeem.
- Merchant NUT-18 point-of-sale request and online finality.
- Honest offline/provisional and custody disclosure.

### Evidence and transparency

- Failure-path and integration test suite.
- Reproducible benchmark methodology for proving and settlement latency.
- Reserve snapshot and liability-commitment prototype with explicit limits.
- Operations and threat-model documentation.

## Success metrics

- 100 percent exact conversion across published amount vectors.
- Zero duplicate payouts across retry and crash-injection tests.
- Zero issuance from wrong-token, wrong-network, expired, or duplicate evidence.
- At least 100 automated behavior and failure-path tests by grant completion.
- One Cashu library or wallet beyond the reference app can parse and move `usdc` proofs.
- Reproducible testnet mint-in and melt-out from a clean environment.
- Documented p50/p95 proving, finality, and end-to-end settlement times.
- No critical or high unresolved finding before a capped pilot.

## Stop conditions

Pause or narrow the application if:

- quote attribution requires exposing a Cashu quote ID onchain;
- the SDK cannot recover note attribution after restart;
- safe payout idempotency cannot be demonstrated;
- wallet support for non-`sat` units makes the reference flow misleading;
- legal scoping rules out the proposed public mint model;
- reserve and liability language cannot be presented honestly.

## Funding narrative

The defensible claim is not "more private transfers." It is an open payment backend that combines
private Starknet settlement with instant bearer payments, while preserving explicit custody,
auditability, and recovery boundaries. The adapter, method spec, failure evidence, and wallet demo
are ecosystem infrastructure that other Starknet and Cashu teams can reuse.
