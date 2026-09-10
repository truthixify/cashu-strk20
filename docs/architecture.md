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

- opaque funding instructions and payment-attribution evidence;
- private note and channel discovery;
- canonical payment verification;
- private payout construction and submission;
- receipt, finality, and reorg observation;
- post-finality payout canonicality incident recording;
- signer and viewing-key access;
- fail-closed screening configuration and screening-partner credential access;
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
receipt, finality policy, quote expiry, and single-use attribution. The RC.6 adapter recomputes the
note ID and encrypted event value from the discovered witness. Independent providers then require
that exact note event and payer invoke sender in the accepted transaction.

Before persistence, the funding coordinator independently recomputes the stable evidence ID from
the canonical network, pool, and public note ID. A gateway cannot relabel the same note to evade the
durable global evidence claim; an inconsistent ID is a protocol error and leaves the request
unchanged.

The RC.6 source review found no public receiver-created quote channel or note memo, so
`quote_channel` cannot currently produce honest quote-unique instructions. The remaining testnet
candidate is a signed Starknet payer binding plus independent note discovery. The wallet transaction
hash is only an optional per-scan lookup filter. The concrete funding gateway emits the pool,
recipient, and signed expected note ID, maps only independently discovered evidence for that exact
note and verified payer, and reobserves the full persisted observation identity after restart. It
does not persist an unauthenticated hint. The v2 challenge note-binds sequential requests and the
store reserves a verified `(network, pool, note)` tuple permanently; open unsigned challenges do not
reserve it. A local compatibility helper reproduces the pinned RC.6 next-note formula from a wallet
channel snapshot without returning the private channel key. A wallet-local coordinator can
serialize the full authorization and settlement callback for one stable SDK operation scope and
reject a channel snapshot whose nonce changed before compilation. It does not reserve the nonce,
coordinate separate runtimes or shared-storage SDK instances, close an on-chain race, or make the
settlement service a wallet-state custodian. This profile does not become normative until the
typed-data challenge, wallet note-ID precomputation and unused-note flow, and durable replay path are
validated against target wallets and account classes, and restart-time attribution is demonstrated
on testnet.

Funding gateways declare the attribution profiles they actually implement. The coordinator validates
and snapshots that capability list before accepting configuration, and refuses any configured
profile the gateway does not advertise. The RC.6 gateway advertises only `signed_payer`;
`quote_channel` remains reserved in the protocol vocabulary for a future gateway with an honest
quote-unique discovery mechanism.

The local Starknet transaction observer implements two selectable candidate policies. Both require
multiple providers to agree on a successful receipt, its accepted canonical block, membership of
the transaction in that block, and the public note evidence used for funding. First observation also
checks the invoke sender against the signed payer. The L2 policy accepts `ACCEPTED_ON_L2` or
stronger; the L1 policy waits until every receipt and block reports `ACCEPTED_ON_L1`. No policy is
selected for deployment until the Sepolia experiment measures provider lag and reorg behavior.

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

Before proving, the settlement service compares accepted heads from independent providers, chooses
a configured historical block behind the lowest head, and requires unanimous block-hash agreement.
It reads the pool's proof-validity window at that exact hash and retains an explicit block margin for
proving and submission. This keeps the prover base block concrete and reviewable; testnet evidence
must still calibrate the offset and margin.
The returned RC.6 proof facts must identify that exact base block hash and number before the account
may sign the payout transaction.

## Durable data

The local settlement spike now has a transactional SQLite store for:

- incoming quote attribution records;
- single-use, note-bound payer challenges and block-pinned verification evidence;
- observed and finalized deposit evidence;
- outgoing settlement intents keyed uniquely by CDK quote ID;
- submitted transaction identifiers and transaction lineage;
- first-writer `strk20` network/token profile pauses linked to terminal payout incidents;
- leased post-terminal finality watches and a profile-scoped incident alert outbox.

It supports close/reopen recovery and atomic ownership of evidence, quote, intent, and submission
identifiers across store instances. It is isolated behind the settlement package's `sqlite-store`
subpath because Node's built-in SQLite API is experimental. The local database is synchronous,
mode `0600`, and unencrypted; it is not a production datastore.

The current settlement schema is version 4. Version 3 migrates by adding the watch and alert tables
and backfilling every existing terminal payout as immediately due. Version 2 first adds an empty
pause table and then performs the version 3 backfill; neither migration reinterprets value state.
Version 1 payer-binding rows have no signed expected note ID, so the store rejects that schema rather
than inventing attribution data during migration. An operator must migrate or discard only confirmed
non-value test data through a separately reviewed procedure.

Exact signed payout transactions live in a separate SQLite store. The adapter encrypts each payload
with AES-256-GCM under an external keyring, binds its intent, request digest, signer, nonce, and
transaction hash as associated data, and commits it before broadcast. The store atomically enforces
one payload per intent and unique submission, transaction, and signer-nonce ownership. Recovery
decrypts and re-hashes the artifact, then claims an expiring durable lease before exact broadcast.
Concurrent workers cannot broadcast while that lease is active, and ambiguous failures retain the
lease until expiry. Recovery never recompiles an ambiguous private transfer. The first accepted
block hash and number are stored write-once beside the artifact
so restart-time observation checks the original inclusion for a pre-finality reorg. For a terminal
`PAID` or `FAILED` intent, the finality monitor can reobserve that same inclusion without proving,
signing, submitting, or replacing a transaction. A confirmed `REORGED` or contradictory execution
result is stored as a separate write-once incident; terminal accounting is not rewritten.
The finality supervisor can then persist the first pause for that method, network, and token profile
in the settlement store. Because the incident and pause are in separate databases, the operation is
recoverable rather than atomic: a rerun reads the already stored incident and idempotently obtains
the existing or newly written pause. Neither component has payout submission capability.

The admission controller reads that pause before funding instructions, funding finalization, new
payout intents, payout preparation, and prepared payout submission. The SQLite store repeats its
checks transactionally for new funding records, payout intents, first submission attachment, and
incoming `PAID` transitions. Evidence collection and submitted-payout reconciliation remain enabled
while paused. A final matching deposit becomes `OPERATOR_REQUIRED`, and unavailable pause state
cannot authorize payment. CDK must independently gate `PAID -> ISSUED`; that integration is not yet
implemented.

Within one process, an activity gate coordinates both incoming funding finalization and final payout
submission with incident pause persistence. A funding finalization holds a profile slot across its
last admission read and durable `OBSERVED -> PAID` transition; a payout holds a separate slot kind
across its final admission read and submission callback. A confirmed incident first moves that
profile to `QUIESCING`, blocks both kinds of new slot, waits for active callbacks, and then persists
the pause. Persistence failure leaves the profile quiescing, and the gate has no resume path. The
funding coordinator, payout coordinator, and finality supervisor must share one instance. This
cannot coordinate a second process or survive a crash before the pause is durable, so multi-process
deployments still need shared coordination or external worker quiescence. CDK must still gate
`PAID -> ISSUED`; the prepared-payout lease fences duplicate broadcasters for one submission but
does not provide profile-wide pause coordination.

Terminal payout transitions create their finality watch in the same SQLite transaction. A
pull-based scheduler leases due watches in bounded batches, reschedules healthy observations,
retries ambiguity and dependency failure with capped backoff, and closes an incident watch while
atomically creating a profile-scoped alert. A separate bounded dispatcher delivers that outbox at
least once under a stable `alertId`; the sink must deduplicate it. Quote IDs stay inside the
supervisor lookup and never enter scheduler summaries or alerts. These workers have no signer,
prover, payout submission, replacement, or resume capability. A non-overlapping runtime invokes the
scheduler before the dispatcher on a bounded interval, exposes only fixed health summaries and
timestamps, and waits for an active cycle during shutdown. It does not force-cancel a stuck callback
or start another cycle while one remains unresolved. A read-only evaluator validates each runtime
snapshot and classifies startup, stopped or stopping state, stale completion, a stalled active
cycle, and consecutive degraded cycles using configured thresholds and fixed reason codes. It does
not poll the runtime, deliver an alarm, or supervise the process that produced the snapshot.

Supervisor checks and alert deliveries have configured response deadlines. The worst-case
sequential callback budget for a batch must be strictly shorter than its durable lease. A deadline
does not cancel the underlying promise: a late supervisor result must remain idempotent, and a late
alert delivery is retried under the same sink idempotency key.

The production persistence design still needs:

- state-transition journal entries;
- event-delivery checkpoints;
- operator interventions and late-payment disposition;
- prepared-payload key rotation, backup restoration, and hardware-backed key custody;
- independent health polling, process supervision, alarm delivery, calibrated health and
  callback/lease budgets, an idempotent production
  alert sink, and an alert-retention policy;
- coordinated submit quiescence, CDK issuance admission, and a reviewed resume workflow.

Signer keys, viewing keys, Cashu proofs, and decrypted private-note bodies do not belong in general
application tables. Store only the minimum encrypted material required for recovery.

## Failure model

The architecture assumes every external call can time out after succeeding. Therefore:

- quote creation is retryable under a client idempotency key;
- deposit observation is derived from chain discovery, not callback delivery;
- transaction finality is checked against matching receipts and canonical block contents;
- payout creation commits a durable intent before submission;
- the exact signed payout is encrypted and committed before its first broadcast;
- payout retries poll the existing intent before considering replacement;
- finality and reorg checks are repeatable;
- permanent payout failure requires a canonical, policy-final reversion of the exact prepared
  transaction rather than absence or nonce inference;
- post-finality ambiguity remains unknown, while confirmed canonicality incidents are retained
  separately from terminal accounting;
- event delivery uses an outbox or replayable cursor;
- ambiguous outcomes remain non-final until reconciled.

See [state machines](specs/state-machines.md) for the normative transition rules.

## Version boundary

The initial adapter targets stable CDK `0.17.6`. The settlement spike targets Starknet Privacy SDK
`0.14.3-rc.6`, exact tag, and a contract deployment profile recorded with evidence. A shared
Integration Sepolia profile is now observed read-only but is not approved for funded use. Because
the SDK is a release candidate distributed through GitHub Packages, it is isolated behind a local
port.
The published CDK custom wire and quote recovery surface is compile-tested through a dev dependency;
the production crate still has no CDK dependency. The first `MintPayment` adapter runs in process.
The stock `0.17.6` HTTP boundary does not bind a custom melt body method to its route method, and its
gRPC transport drops custom method names, so either boundary requires an explicit `strk20` binding
before it can be used for value handling.
The structural RC.6 note/history and prepared-payout adapters are implemented, but the credentialed
package remains excluded from the repository dependency graph until its live deployment and
supply-chain gates pass.
Their upstream-facing shapes are consolidated in one dependency-light port module. A separate
credential-free container check builds the exact RC.6 source declarations and compiles explicit
assignability checks for discovery, channel state, viewing keys, and private transfers. It proves
source-level type compatibility only, not published-package authenticity or runtime behavior.
The credentialed artifact verifier checks the publisher-declared RC.6 source commit, embedded
package manifest, runtime dependency set, export targets, safe regular-file archive layout, and
registry SHA-512 and SHA-1 digests without installing or executing the package. Its basic evidence
identifies the commit declared by the publisher but does not claim a source-build match.

The authenticated-artifact port verifier first completes that integrity and archive-structure check,
then mounts an owned archive copy plus the hashed local compatibility inputs read-only into the
pinned container. Only Docker client configuration crosses the host boundary; the package token,
RPC configuration, and workspace do not. The exact source lockfile supplies the compiler and type
dependencies with lifecycle scripts disabled. A pass binds the local structural ports to the
authenticated declarations, but does not execute the SDK or establish a reproducible build.

A separate source-build verifier fetches that authenticated artifact first and then rebuilds the
exact public commit in a pinned Linux/AMD64 container. The package token and host workspace never
enter the container, install lifecycle scripts are disabled, and only byte-identical archives can
produce `sourceBuildMatchVerified: true`. Production installation remains explicitly unapproved
while the `starknet-devnet` dependency gate is open. Testnet preflight separately requires the RC.6
screening-v3 pool class hash. The fixed shared-profile observer confirms one active pool address and
canonical six-decimal Sepolia USDC through two public RPC operators. It verifies the original UDC
deployment plus all five observed `replace_to` transitions and inventories the matching events from
deployment through the selected discovery head. That establishes on-chain origin and standard
upgrade history. A bounded per-provider cache retrieves the upgrade and four standard AccessControl
selectors in one historical scan, then exposes exact filtered views to the independent upgrade and
authority verifiers. The authority verifier pins its complete inventory and queries every common
role for the two event-discovered authority accounts at the same head. These checks establish the
reviewed standard role history and those accounts' current contract-reported memberships, not
controller identity or approval, silent storage changes, historical class source authenticity,
runtime identity, or screening activity.

The compatible RC.2 transaction prover, RC.2 discovery service, and RC.6 screening sidecar are also
pinned by OCI index and platform-manifest digest. A read-only command checks that their mutable
release tags still resolve to those reviewed bytes without pulling or starting them. It then reads
each immutable index and checks the publisher-attached BuildKit source revision, Dockerfile path,
builder declaration, and completeness flags for both Linux platforms. That evidence does not
authenticate the publisher or builder, verify a signature, reproduce the images, select a screening
policy, or identify a Sepolia deployment.

## Deployment profiles

### Local deterministic

Uses in-memory fakes for chain observation and payout submission. State can use deterministic
in-memory stores or the local SQLite recovery store. This profile exercises conversion, state,
idempotency, and restart recovery without secrets or a network.

### Testnet integration

Uses test-only Starknet accounts, an approved pinned pool deployment, controlled USDC, and a capped
proving budget. Before network execution, the offline preflight validates exact component and class-hash
pins, contract and account identities, asserted-independent provider operators and origins,
finality/proving policy, fail-closed screening declarations, and secret shapes. Its public profile
also carries operator-declared pool and token deployment transaction references plus immutable
manifest URLs and content hashes; those public declarations are preserved through verified context
and run evidence. It omits endpoints, the account address, and credentials. Before RPC construction,
the read-only deployment path retrieves each distinct manifest once, verifies its exact hash and
canonical schema, checks pool constructor calldata against the pinned four-field ABI, binds both
contract profiles, and excludes the non-published settlement address from public manifest fields. It
then derives both addresses with the pinned UDC profile and requires every RPC to agree on each
deployment receipt's identity and successful status, exact UDC event, canonical inclusion,
configured finality, deployed class, and pinned UDC class at the declared block. It also pins both
RPCs to one recent
policy-accepted block and requires their pool, token, and account class hashes to match the profile.
Evidence constructors then rebuild only allowlisted JSON fields and require per-transaction
disclosure approval. Verified-run evidence explicitly records that execution is not attested, the
artifact is not authenticated, and funded execution is not approved. A second
read-only service check requires the pinned prover API, validates discovery health and freshness,
checks proof-interceptor liveness, and asks every RPC to confirm that exact discovery block on
Sepolia. This identifies one accepted discovery chain state and a live interceptor route, not a
service runtime, prover chain, screening configuration or activity, remote service-to-contract
binding, or settlement finality. These checks do not establish that an operator label, version claim,
provider-independence claim, or disclosure choice is true; the testnet review must verify them
independently. Deterministic UDC origin does not authenticate the manifest publisher, approve the
token source or authorities, or make nominally distinct RPCs independent. Before scenario execution,
a verified context reconstructs both records, compares all sanitized public configuration except
their independent observation timestamps, and requires both checks to remain within the configured
block-age window at run start. The runner rejects invalid
chronology before callbacks and requires both checked block heads not to exceed its first observed
block. Since endpoint URLs are omitted, this binding does not prove that the checks contacted an
identical private endpoint.
The pinned release does not publish a reusable release-owned Sepolia profile. A later official demo
preview exposes a mutable shared Integration Sepolia profile used by the credential-free observer;
the funded profile remains operator-owned unless that shared deployment receives explicit ownership,
provenance, screening, and use approval. Mainnet pool and prover services cannot be substituted for
the testnet experiment.

### Production

Out of scope. It requires external audit, legal analysis, key isolation, encrypted durable storage,
monitoring, incident response, backup and restore tests, capped exposure, and explicit operator
governance.
