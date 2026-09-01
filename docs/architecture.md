# Architecture

Status: accepted foundation design. Wire details remain draft until the testnet spike completes.

## Design goals

- Reuse Cashu and STRK20 rather than reproduce either protocol.
- Isolate two fast-moving upstream APIs behind small typed boundaries.
- Make issuance and payout decisions deterministic, idempotent, and recoverable.
- Keep private note data and bearer proofs out of logs and unnecessary services.
- Make trust, custody, finality, and solvency limits visible.
- Produce a reusable CDK integration before product-specific wallet work.

## System context

```text
                            online Cashu protocol
  customer wallet  ------------------------------------+
       |                                                |
       | private STRK20 funding                         v
       |                                           +----------+
       |                                           | CDK mint |
       |                                           +----+-----+
       |                                                |
       v                                                | MintPayment
  STRK20 privacy pool                                   v
       ^                                        +---------------+
       |                                        | cdk-starknet  |
       | private payout                         +-------+-------+
       |                                                |
       |                                      typed internal API
       |                                                |
       +----------------------------------------+-------v--------+
                                                | settlement     |
                                                | service        |
                                                +----------------+
```

Cashu peer-to-peer circulation happens between the funding and payout edges and does not touch
Starknet. That is the product's speed and batching benefit. It is also why STRK20 viewing keys cannot
trace the intermediate Cashu hops.

## Component ownership

### CDK mint

The upstream mint owns blind issuance, proof verification, swaps, NUT state, pending-proof handling,
and wallet-facing Cashu endpoints. This project does not fork Cashu cryptography.

### `cdk-starknet`

The Rust adapter implements CDK's `MintPayment` contract for custom method `strk20`. It owns:

- validation of supported method and unit;
- mapping Cashu quotes to internal settlement identifiers;
- CDK incoming and outgoing status semantics;
- idempotency keys and method-specific response fields;
- event delivery to the mint;
- conservative translation of settlement outcomes to Cashu quote states.

The adapter must not hold a Starknet private key or implement note cryptography.

### Settlement service

The TypeScript service wraps the Starknet Privacy SDK. It owns:

- quote-specific funding instructions;
- private note and channel discovery;
- canonical payment verification;
- private payout construction and submission;
- receipt, finality, and reorg observation;
- signer and viewing-key access;
- durable payout intents and reconciliation.

The service must not receive Cashu bearer proofs. It acts on opaque quote and payout intent IDs.

### Method package

`packages/strk20-method` contains dependency-light wire types, constants, amount conversion, and
state vocabulary shared by TypeScript components. Rust mirrors security-critical constants and is
checked with common fixtures as the implementation grows.

### Wallet and merchant reference app

The later PWA uses standard Cashu wallet libraries where possible. It owns UX, local proof storage,
NUT-18 payment requests, quote signatures, and disclosure. It does not decide whether a mint-in is
paid.

### Reserve registry

The later Cairo component can anchor reserve configuration or signed liability commitments. It is
not in the minting or redemption transaction path and cannot by itself prove solvency.

## Mint-in sequence

```text
Wallet          CDK mint       Adapter       Settlement       STRK20
  | quote request  |              |               |              |
  |--------------->| create       |               |              |
  |                 |------------->| instructions |              |
  |                 |              |-------------->|              |
  |<----------------| opaque payment request       |              |
  | private transfer|              |               |              |
  |-------------------------------------------------------------->|
  |                 |              | discover and verify          |
  |                 |              |<--------------|<-------------|
  |                 | event: paid  |               |              |
  |                 |<-------------|               |              |
  | mint outputs    |              |               |              |
  |---------------->|              |               |              |
```

The wallet may submit a transaction hash as an acceleration hint. It is never authoritative. The
settlement service independently verifies token, amount, destination/channel, network, canonical
receipt, finality policy, quote expiry, and single-use attribution.

The first spike compares two attribution profiles:

1. A quote-specific recipient or discovery channel, preferred because it avoids payer identity
   binding.
2. A signed Starknet payer binding plus transaction hint, used only if the current SDK cannot
   provide a unique recipient/channel that the mint can verify.

Only one profile will become normative after testnet evidence.

## Cashu circulation

After issuance, wallets exchange standard Cashu proofs and use standard swaps or NUT-18 payment
requests. The adapter is not involved. Online receipt checks proof state at the mint. A receiver that
accepts proofs without contacting the mint assumes double-spend risk until later verification.

## Melt-out sequence

```text
Wallet          CDK mint       Adapter       Settlement       STRK20
  | melt quote     |              |               |              |
  |--------------->| quote        |               |              |
  |                 |------------->| validate      |              |
  |<----------------| UNPAID       |               |              |
  | submit proofs   |              |               |              |
  |---------------->| payout       |               |              |
  |                 |------------->| intent        |              |
  |                 |              |-------------->| private tx   |
  |                 |              |               |------------->|
  |                 | PENDING      |               |              |
  |                 |<-------------|               |              |
  |                 |              | reconcile until final        |
  |                 | PAID + proof |<--------------|<-------------|
  |<----------------|<-------------|               |              |
```

The CDK quote ID is the stable idempotency key. Repeated `make_payment` calls return the same intent.
An RPC timeout or unknown transaction status remains `PENDING` or `UNKNOWN`; it never triggers a
second payout. `PAID` is emitted only after the configured canonical finality rule.

## Durable data

Before multi-process or crash-recovery testing, the implementation needs transactional storage for:

- incoming quote attribution records;
- observed and finalized deposit evidence;
- outgoing settlement intents keyed uniquely by CDK quote ID;
- submitted transaction identifiers and replacement lineage;
- state-transition journal entries;
- event-delivery checkpoints;
- operator interventions and late-payment disposition.

Signer keys, viewing keys, Cashu proofs, and decrypted private-note bodies do not belong in general
application tables. Store only the minimum encrypted material required for recovery.

## Failure model

The architecture assumes every external call can time out after succeeding. Therefore:

- quote creation is retryable under a client idempotency key;
- deposit observation is derived from chain discovery, not callback delivery;
- payout creation commits a durable intent before submission;
- payout retries poll the existing intent before considering replacement;
- finality and reorg checks are repeatable;
- event delivery uses an outbox or replayable cursor;
- ambiguous outcomes remain non-final until reconciled.

See [state machines](specs/state-machines.md) for the normative transition rules.

## Version boundary

The initial adapter targets stable CDK `0.17.6`. The settlement spike targets Starknet Privacy SDK
`0.14.3-rc.6`, exact tag and contract deployment profile to be recorded with evidence. Because the
SDK is a release candidate distributed through GitHub Packages, it is isolated behind a local port
and excluded from the dependency graph until the network spike begins.

## Deployment profiles

### Local deterministic

Uses in-memory fakes for chain observation and payout submission. It exercises conversion, state,
idempotency, and recovery without secrets or a network.

### Testnet integration

Uses test-only Starknet accounts, a pinned pool deployment, controlled USDC, and a capped proving
budget. It records reproducible public evidence without Cashu bearer proofs or viewing keys.

### Production

Out of scope. It requires external audit, legal analysis, key isolation, encrypted durable storage,
monitoring, incident response, backup and restore tests, capped exposure, and explicit operator
governance.
