# Settlement Service

This package contains CairoCash's incoming-payment verification, payout coordination, Starknet
finality adapters, and local recovery store. It is testnet-only. A fixed shared Integration Sepolia
profile is available for read-only observation but is not approved for funded settlement.

The reviewed SDK source target is tag
[`PRIVACY-0.14.3-RC.6`](https://github.com/starkware-libs/starknet-privacy/tree/PRIVACY-0.14.3-RC.6)
at commit
[`4db755b9512f00b540126737b605472ea2275e15`](https://github.com/starkware-libs/starknet-privacy/commit/4db755b9512f00b540126737b605472ea2275e15).
The package is not installed in this repository. `StarknetPrivacySdkNoteSource` and
`StarknetPrivacySdkPayoutAdapter` instead target small structural subsets of RC.6 so package
credentials stay outside normal development and the settlement domain does not depend on SDK
internals. The concrete RC.6 interfaces compile against those ports in the compatibility checks
recorded below.

The public RC.6 release also names the screening-v3 privacy-pool class hash
`0x7e2bbd7ccc1e68b2695caef70aeb2a3be6cd017b5d5159278ba08f2d8de33f`. Testnet preflight rejects a
different pool class or release label. The shared-profile observer confirms one active Sepolia pool
currently uses that class, verifies its original UDC deployment, and verifies all five observed
`replace_to` transitions through RC.6. It also pins the 21-event standard AccessControl history and
checks all common-role memberships for both event-discovered authority accounts. Authority identity
and approval, silent storage mutations, and historical class source authenticity remain unverified.
One bounded union-selector scan per RPC is shared between the upgrade and authority checks; each
verifier still receives only its requested events and independently enforces completeness.
The package remains uninstalled until the authenticated artifact and dependency gates pass.

The compatible transaction prover RC.2, discovery service RC.2, and screening sidecar RC.6 are
separately pinned by OCI digest. `pnpm --silent privacy-services:verify-images` checks their public
release-tag resolution and the source revision declared for both Linux platforms without pulling or
running the images. The declarations are not authenticated provenance or reproducible-build proof.
The command does not identify or approve a Sepolia deployment; the operator prerequisites are in the
[testnet privacy services guide](../../docs/operations/testnet-privacy-services.md).

The reviewed API surface, attribution limitation, and payout recovery requirements are recorded in
the [Privacy SDK compatibility note](../../docs/compatibility/privacy-sdk-0.14.3-rc.6.md).

`StarknetPrivacySdkNoteSource` discovers RC.6 incoming notes, pins history lookup to the discovery
block hash, and keeps SDK cursors in memory only. It validates the SDK `AddressMap`, rejects open
notes, recomputes each note ID and encrypted `EncNoteCreated.packed_value` from the SDK witness, and
enforces separate request, response, cumulative-history, note, page, and deadline bounds.

`IncomingPrivacyEvidenceCollector` joins that snapshot to indexer history and independent chain
observation. It rejects duplicate or missing notes, snapshot drift, inconsistent transaction
blocks, unknown statuses, and results outside the configured pool, recipient, and token. A
digest of network, pool, and note reference becomes the stable evidence ID; note and transaction
references remain explicit for restart reconciliation. `FundingCoordinator` recomputes that digest
at its gateway boundary and rejects a relabeled note before it can enter either funding store.

`StarknetTransactionObserver` implements the transaction-finality side with exact
`starknet@10.5.0`. It requires a dense list of two to sixteen named provider instances, verifies the chain ID,
matches successful receipts to accepted canonical blocks that contain the transaction, and supports
explicit L2-final and L1-final candidate policies. For new privacy evidence, every provider must
also see the expected pool note ID and encrypted value in the receipt and the expected payer as the
invoke sender. A pre-confirmed or unindexed transaction remains retryable because it has no accepted
block identity. Persisted evidence becomes `REORGED` only when every provider agrees the canonical
hash at its original height changed; mixed canonical views become `CONFLICTED`. Batch size,
concurrency, receipt events, and request deadlines are bounded.

`CompositePrivacyEvidenceSource` joins the Privacy SDK note source to that observer without putting
RPC finality logic into the SDK adapter.

`toSignedPayerPaymentObservation` maps that evidence into the settlement protocol only when the
observed note ID, sender, and recipient match an already verified request binding. It does not verify
a wallet signature or create that binding; those responsibilities belong to the payer-binding
components. A wallet transaction hash can narrow the result but cannot override the note, payer, or
recipient checks. The payment inclusion block must also be strictly newer than the accepted block
used to verify the binding, so an unclaimed historical note cannot fund a later request.

`SignedPayerPrivacyFundingGateway` is the concrete incoming join. It emits the configured pool,
privacy recipient, and signed expected note ID in the profile-specific destination, then combines a
verified payer binding with fresh collector evidence. On reconciliation, it passes only immutable
chain references to the collector but carries the complete persisted observation across the gateway
boundary, so a wrong note, amount, or other recorded identity cannot be reconstructed as a matching
payment after restart. Known evidence is always reobserved; a wallet transaction hint filters only
fresh candidates. The hint is neither payment proof nor durable authenticated state. Persisted
evidence is checked against the same binding-block lower bound before reobservation, so restart
cannot bypass the causality rule. A deterministic integration test closes and reopens
`SqliteSettlementStore`, reconstructs the coordinator, gateway, admission controller, and activity
gate, and finalizes only by reobserving the persisted note reference. This proves local composition
and crash-recovery data flow, not live Privacy SDK discovery or Sepolia behavior.

Every funding gateway declares its supported attribution profiles. `FundingCoordinator` validates
and snapshots that declaration before value handling, so configuration cannot enable a profile the
concrete gateway does not implement. `SignedPayerPrivacyFundingGateway` advertises only
`signed_payer`; `quote_channel` remains a reserved experiment profile and is not an RC.6 deployment
option.

`PayerBindingCoordinator` now defines the v2 candidate challenge boundary. It reconstructs one
SNIP-12 revision 1 message containing the payer, payment request, pool, recipient, token, expected
RC.6 note ID, exact amount, funding expiry, challenge expiry, and a 256-bit server challenge. The
verifier port must call the payer account's SNIP-6 `is_valid_signature`; it deliberately does not
assume a raw ECDSA key or a two-felt signature. Only a final, pinned verifier result can consume the
challenge. The durable store permanently reserves the verified note ID within its network and pool,
and atomically rejects a second verified binding when its funding window overlaps another binding
with the same payer, pool, recipient, token, and amount. Unsigned open challenges reserve neither
scope. RC.6 exposes the channel key and next note nonce through its public channel model, but its
package export map does not expose `compute_note_id`; wallet interoperability remains open.

`deriveStarknetPrivacySdkExpectedNoteReference` is the local wallet-side compatibility helper. It
uses the same pinned formula as incoming note verification and returns only the next nonce and
public note ID. `StarknetPrivacySdkNoteReferenceCoordinator` adds a wallet-local exclusive scope
around derivation and the operation that consumes it:

```ts
import { StarknetPrivacySdkNoteReferenceCoordinator } from "@cashu-strk20/settlement/starknet-privacy-sdk-note-reference";

const noteReferences = new StarknetPrivacySdkNoteReferenceCoordinator();

await noteReferences.withExpectedNoteReference(
  { operationScope: privateTransfers, channel, tokenContract },
  async ({ expected, assertCurrent }) => {
    const authorization = await authorize(expected.noteReference);
    assertCurrent();
    return compileSubmitAndSettle({ authorization, expected });
  },
);
```

The `channel` contains private key material. Run this helper inside the wallet and send only
`expected.noteReference` to the challenge API. Reuse one coordinator and one stable
`operationScope` for every operation sharing an RC.6 registry or wallet store. Keep the callback
open through compilation, submission, and either transaction landing or an authoritative local
state advance; call `assertCurrent()` synchronously immediately before compilation. The callback
must not reenter the coordinator with the same scope because the nested operation would be queued
behind its own caller.

The coordinator releases queued work after either success or failure and derives the second note
only after the first callback settles. It does not mutate or reserve `noteNonce`, coordinate a
second process or device, make two SDK instances over shared storage safe, or close the on-chain
discovery-to-submission race. The deterministic vector and local queue tests are not a live RC.6
wallet compatibility claim.

`StarknetPayerBindingVerifier` implements that port with exact `starknet@10.5.0` SNIP-12 hashing.
It requires a dense list of two to sixteen named provider instances to agree on one fresh accepted block, calls every
account at that exact block hash, and recognizes only SNIP-6 `VALID`, legacy `1`, or explicit `0`.
Finality, block age, future-clock tolerance, and RPC deadline are required configuration. Provider
failure, stale state, malformed replies, and mixed signature results do not consume the challenge.
Import the adapter through `@cashu-strk20/settlement/starknet-payer-binding-verifier` so consumers
that only need domain types do not load Starknet.js.

The [public SNIP-12 candidate vector](../../docs/specs/vectors/signed-payer-snip12-v2.json) can be
reconstructed from its builder inputs. It includes the typed data, outer account address, and exact
`starknet@10.5.0` hash, but no account-specific signature or live-wallet compatibility claim.

`IncomingPrivacyEvidenceCollector.reobserve` checks persisted transaction inclusions directly,
without depending on the note still appearing in a fresh unspent-note scan. The funding coordinator
passes the gateway each complete recorded observation; the gateway reduces it to its evidence,
note, transaction, and original block references only for canonical reobservation. A finality
adapter must classify that original inclusion as `REORGED` or `CONFLICTED` instead of silently
replacing its block identity.

The service owns private note discovery, payout submission, finality, and reconciliation. It
must not receive Cashu bearer proofs.

`FundingCoordinator` implements the deterministic incoming boundary. A caller supplies an opaque
payment request ID generated independently from the secret Cashu quote ID; `generatePaymentRequestId`
provides a 256-bit CSPRNG implementation. Funding instructions are idempotent by that public request
ID and bind the configured network, pool, token, exact amount, expiry, attribution profile,
destination, and named finality policy.

Discovery may use a wallet transaction hash only as an untrusted lookup hint. Every returned
candidate is checked against the durable request identity, and an evidence ID is atomically owned by
at most one request. Provider disagreement becomes `OPERATOR_REQUIRED`, pre-finality reorgs revoke
the observation, post-payment reorgs escalate, and a payment first discovered after expiry becomes
`LATE_PAYMENT` rather than authorizing issuance.

`PayoutCoordinator` implements the deterministic payout boundary. It records one intent per Cashu
melt quote, records an opaque prepared-submission ID before broadcast, and reconciles that same
submission after retry or restart. Gateway timeouts after the submission boundary become `UNKNOWN`;
only an explicit gateway `FAILED` result may prove non-execution. The concrete Starknet adapter
returns that result only for the exact prepared transaction after every provider confirms the same
canonical, policy-final `REVERTED` inclusion.

The coordinator requires explicit minimum and maximum Cashu amounts and currently accepts only
`SN_SEPOLIA`. A gateway must make repeated submission of one prepared ID idempotent and may report
`PAID` only after the configured canonical-finality policy is satisfied.

`StarknetPrivacySdkPayoutAdapter` implements the RC.6 payout side without calling SDK `execute()`
again after an ambiguous submission. It refreshes private state at a concrete proving block,
compiles one transfer, rejects every SDK privacy warning, and asks `starknet@10.5.0` to build a signed
V3 invoke transaction without broadcasting it. Before accepting the result, it independently checks
the signing account, exact `apply_actions` calldata, proof and proof facts, Sepolia chain, transaction
shape, and operator-configured resource-fee and tip caps. The proof facts must name the exact block
hash and number returned by the proving-block selector.

The adapter calculates the transaction hash locally, encrypts the exact signed RPC transaction with
AES-256-GCM, and atomically owns it by intent, submission ID, transaction hash, and account nonce
before broadcast. Submission decrypts, authenticates, and re-hashes that artifact before sending the
same bytes through `invokeSignedTx`. Immediately before that call, the prepared store atomically
claims an expiring submission lease whose configured duration must outlive the RPC timeout. A
competing worker returns `UNKNOWN`, and neither an RPC failure nor a lost store response releases the
lease. After expiry, a missing transaction may be rebroadcast exactly; an unavailable or disagreeing
provider remains unknown. The first accepted block identity is write-once in the
prepared store and is supplied to the multi-provider observer after restart, allowing a displaced
pre-finality inclusion to become `UNKNOWN`. A unanimously reverted inclusion is also persisted
before the adapter reports `FAILED`. Receipt absence, provider disagreement, timeout, and nonce
movement are not permanent-failure evidence.

A composed deterministic recovery test loses the first submission response, closes both the
quote-keyed settlement database and encrypted prepared-payout database, reconstructs the coordinator
and adapter, and observes the exact original transaction as final. It asserts one broadcast, no
second proof compilation or signer call, and the same transaction reference in both stores. This is
local crash-recovery evidence, not a live RPC or Sepolia result.

`PayoutFinalityMonitor` checks a terminal `PAID` or `FAILED` intent against its single prepared
transaction and write-once original inclusion. It uses the adapter's read-only reobservation path
and persists the first post-finality `REORGED` or `CONFLICTED` incident separately, without changing
terminal accounting or calling the prover, signer, or submitter. A successful transaction after
`FAILED`, or a reverted transaction after `PAID`, is a conflict. `UNKNOWN` never creates an incident.

`PayoutFinalitySupervisor` converts only a persisted `REORGED` or `CONFLICTED` result into a durable
pause for the affected `strk20` network/token profile. The first pause owns the profile and binds the
triggering intent, submission, transaction, original inclusion, detection time, and observer
version. It stores no Cashu quote ID and has no signer, prover, submission, replacement, or resume
capability. If incident or pause persistence succeeds but its response is lost, rerunning completes
idempotently from the first stored records. `FINAL`, `REVERTED`, `UNKNOWN`, malformed results, and
dependency failures cannot create a pause.

`SettlementAdmissionController` turns that store into a mandatory fail-closed gate. Funding checks
it before returning or creating instructions and again before a final observation may become
`PAID`. A pause preserves the final evidence but sends the funding request to `OPERATOR_REQUIRED`;
an unavailable pause store leaves it `OBSERVED` for retry. Payouts check admission before a new
intent, preparation, prepared-submission attachment, and broadcast. Already submitted or terminal
payouts remain observable so a pause cannot suppress canonical status evidence.

`InProcessSettlementActivityGate` closes the final admission races for components sharing one
JavaScript process. `FundingCoordinator` holds a profile activity slot across its final admission
read and durable `OBSERVED -> PAID` transition. `PayoutCoordinator` holds a separate activity kind
across its final admission read and invokes the payout callback exactly once. On a confirmed
incident, `PayoutFinalitySupervisor` moves the same profile to `QUIESCING`, rejects both kinds of new
slot, waits for active funding finalizations and submission callbacks to settle, and only then
persists the pause. Failed or hung pause persistence leaves the profile quiescing and there is no
resume method. The supervisor, funding coordinator, and payout coordinator guard their protected
callbacks against omission or repetition.

`SqliteSettlementStore` repeats the value-changing checks inside the same `BEGIN IMMEDIATE`
transaction that creates a funding request or payout intent, attaches the first submission, or
changes incoming funding from `OBSERVED` to `PAID`. Existing records and already completed
transitions remain readable and idempotent during a pause. Import the admission boundary explicitly
through `@cashu-strk20/settlement/settlement-admission`.

Every SQLite transition to terminal `PAID` or `FAILED` creates one durable finality watch in the same
transaction. `PayoutFinalityScheduler` leases due watches in bounded batches. A healthy result is
scheduled again, an ambiguous or failed check is retried with capped exponential backoff, and a
confirmed incident closes the watch while atomically retaining a profile-scoped alert. The
scheduler passes the private Cashu quote ID only to the supervisor lookup; its run summary and the
alert contain no quote ID, amount, recipient, proof, signer, or viewing material.

`PayoutIncidentAlertDispatcher` leases the alert outbox in bounded batches and retries failed
delivery with capped backoff. Delivery is at least once, so a production sink must treat `alertId`
as its idempotency key. Both worker configurations require a callback response deadline and reject
a worst-case sequential callback budget that is not strictly shorter than the lease. A deadline is
not cancellation: the supervisor may still finish idempotently, and a sink may still deliver before
the stable `alertId` is retried.

`PayoutFinalityRuntime` invokes the scheduler and then the dispatcher on one
non-overlapping interval, starts immediately, reports only fixed summaries and timestamps, and waits
for an active cycle during shutdown. A dependency failure degrades the cycle without exposing its
error; an unresolved worker or job-store operation remains visibly in progress and is never
overlapped or force-cancelled.
`PayoutFinalityRuntimeHealthEvaluator` validates that quote-free snapshot and returns one of
`STARTING`, `HEALTHY`, `DEGRADED`, or `UNHEALTHY` with fixed reason codes. The runtime start
timestamp makes a missing first cycle detectable; configured exact boundaries detect a stalled
active cycle, stale completion, and repeated degraded cycles. Invalid or future-dated snapshots and
hostile policy or clock values fail with fixed errors. The evaluator is read-only: it does not poll,
serve an endpoint, persist an alarm, restart a process, or prove that the process exposing a snapshot
is alive.
These components have no signer, prover, transaction submission, replacement, or resume capability.
A deployment still needs an independent poller, process supervision and alarm delivery, calibrated
health, callback, and lease budgets, a reviewed idempotent alert sink and retention policy, a
separately reviewed operator resume procedure, and the same pause check at the CDK `PAID -> ISSUED`
boundary.
The activity gate is deliberately in-memory. The funding coordinator, payout coordinator, and
finality supervisor need the same instance, and every broadcaster and incoming finalizer for the
profile needs to live behind it. A second process, a process crash before durable pause persistence,
or a value-changing component outside the gate can still race the pause. Multi-process deployment
therefore needs shared coordination or external worker quiescence. The prepared-payout lease
prevents duplicate broadcasts of one submission but does not replace profile-wide coordination.

`SqlitePreparedPayoutStore` is the dedicated local store for those encrypted artifacts. It must use
a different database file from `SqliteSettlementStore`; the encryption key comes from an external
`PreparedPayoutKeyring` and is never stored in SQLite. Prepared-payout schema version 4 adds the
submission lease columns; versions 1 through 3 migrate forward without changing encrypted
artifacts, accepted inclusions, or finality incidents. Import the payout components through their
explicit subpaths:

```ts
import { AesGcmPreparedPayoutCipher } from "@cashu-strk20/settlement/prepared-payout-cipher";
import { PayoutFinalityMonitor } from "@cashu-strk20/settlement/payout-finality";
import {
  PayoutFinalityScheduler,
  PayoutIncidentAlertDispatcher,
} from "@cashu-strk20/settlement/payout-finality-scheduler";
import { PayoutFinalityRuntime } from "@cashu-strk20/settlement/payout-finality-runtime";
import { PayoutFinalityRuntimeHealthEvaluator } from "@cashu-strk20/settlement/payout-finality-runtime-health";
import { PayoutFinalitySupervisor } from "@cashu-strk20/settlement/payout-finality-supervisor";
import { InProcessSettlementActivityGate } from "@cashu-strk20/settlement/settlement-activity-gate";
import { SqlitePreparedPayoutStore } from "@cashu-strk20/settlement/sqlite-prepared-payout-store";
import { StarknetPayoutStatusSource } from "@cashu-strk20/settlement/starknet-payout-status-source";
import { StarknetProvingBlockSelector } from "@cashu-strk20/settlement/starknet-proving-block-selector";
import { StarknetPrivacySdkPayoutAdapter } from "@cashu-strk20/settlement/starknet-privacy-sdk-payout";
```

`StarknetProvingBlockSelector` supplies the adapter's proving-block callback. It reads accepted heads
from a dense list of two to sixteen independent Sepolia providers, bounds their lag, selects a configured number of
blocks behind the lowest head, and requires every provider to return the same historical block. At
that exact block hash it calls the configured pool's `get_proof_validity_blocks` view through every
provider and rejects a selection that does not retain the configured submission margin.

The local payout implementation has deterministic compatibility and crash tests, not a live Sepolia
proof. A deployment still needs a protected keyring, the pinned SDK package, configured independent
providers, a testnet-calibrated proving-block margin, and a tested operator fee policy.

The SDK-facing discovery, channel, viewing-key, and payout shapes live in the dependency-light
`starknet-privacy-sdk-ports` boundary. The credential-free
`privacy-sdk:verify-source-ports` command checks out the exact RC.6 commit in a pinned Linux/AMD64
container, installs its locked dependencies with lifecycle scripts disabled, builds its public
declarations, and compiles explicit assignability checks against the emitted local port declaration.
It mounts only those hashed compatibility inputs. This verifies source-level type compatibility; it
does not authenticate the published package, execute the SDK runtime, or approve installation.

`createPrivacySdkArtifactEvidence` validates the exact RC.6 registry manifest, publisher-declared
source `gitHead`, runtime dependency set, export targets, archive paths, and SHA-512/SHA-1 registry
digests. The workspace `privacy-sdk:verify-artifact` command fetches and inspects the tarball under a
private temporary directory without installing it or running package scripts. It reads
`NODE_AUTH_TOKEN`
only from the process environment, gives the archive subprocess no token, rejects linked members,
and emits no registry URL or credential. Its evidence explicitly leaves production installation
unapproved and source-build matching unverified while `starknet-devnet` remains a production
dependency. Registry `gitHead` is publisher-declared provenance, not reproducible-build proof.

`createPrivacySdkArtifactPortCompatibilityEvidence` combines that validated artifact boundary with
the same explicit discovery, channel, viewing-key, and private-transfer assignments. The workspace
`privacy-sdk:verify-artifact-ports` command validates the archive before Docker starts, then mounts
only an owned archive copy and the two hashed compatibility inputs read-only. The package token,
RPC configuration, and workspace are not forwarded. The pinned source lockfile supplies the
compiler and declaration dependencies with lifecycle scripts disabled; neither package code nor the
SDK runtime is executed. Its evidence leaves source-build matching and production installation
false and retains the `starknet-devnet` blocker.

`createPrivacySdkSourceBuildEvidence` promotes that one field only after an independent, controlled
build produces the exact authenticated archive bytes. The `privacy-sdk:verify-source-build` command
uses the pinned RC.6 commit, Node image, npm version, Linux/AMD64 platform, and lockfile; disables
install lifecycle scripts; and mounts neither the host workspace nor the package token into Docker.
It does not approve installation or remove the `starknet-devnet` blocker.

`createTestnetDeploymentEvidence` validates a single Sepolia profile before an authorized network
run. It requires the exact SDK, source commit, Starknet.js, and CDK pins; six-decimal test USDC;
explicit pool, token, and account class-hash pins; distinct contract and account identities; two or
more asserted-independent RPC operators and origins; explicit finality and proving policies;
fail-closed screening declarations bound to the same pool and a named RPC; valid signer, viewing-key,
and screening-credential shapes; public pool/token deployment transaction, immutable manifest URL,
and manifest SHA-256 declarations; and test-only, capped-funds acknowledgements. Its returned record
omits service URLs, the settlement account address, and all secret material. The declarations are
preserved across verified context and run evidence. Configuration equality does not attest the
running interceptor or prover.

`StarknetDeploymentVerifier` checks that profile without transaction capability. It selects the
lowest policy-accepted head within the configured provider-lag bound, requires every provider to
return the same block at that height, and reads the pool, token, and settlement-account class hashes
at the agreed block hash. Every observed class must match its configured pin. Provider errors are
redacted, calls are bounded, and the result carries no endpoint or account address. Import it through
`@cashu-strk20/settlement/starknet-deployment-verifier`.

The surrounding testnet command first uses `verifyTestnetDeploymentManifests` to retrieve bounded
canonical JSON, recompute SHA-256, match both contract profiles, and check the pool's four-field
constructor calldata against the pinned ABI. `StarknetDeploymentOriginVerifier` then derives both
addresses with the `starknet@10.5.0` UDC profile and requires every configured provider to agree on
the declared receipt identity and successful status, exact UDC event, canonical block inclusion,
configured finality, deployed class, and pinned UDC class at the deployment block. The evidence
constructor repeats address derivation while rebuilding the allowlisted record. Import this boundary
through
`@cashu-strk20/settlement/starknet-deployment-origin-verifier`.

These checks establish deterministic UDC origin for the declared transactions under the configured
provider set. They do not authenticate manifest publishers, approve the selected token source or
authorities, prove provider independence, or approve a deployment for funded use.

`createTestnetRunEvidence` reconstructs that profile field by field and emits only JSON-safe run
data. It accepts fixed scenario and result vocabularies, canonical integer fees and block ranges,
safe command arguments, and transaction references carrying explicit disclosure approval. It has no
network, signer, filesystem, logging, or transaction-submission capability. Provider independence,
component version strings, disclosure approval, and capped funding still require operator review.
`createTestnetVerifiedContextEvidence` reconstructs the contract-deployment and privacy-service
verification records, requires the same sanitized public configuration while allowing their
independent observation timestamps, and retains every service non-attestation blocker.
`createTestnetVerifiedRunEvidence` then requires both checks before the run and no older than the
profile's configured block-age window. Neither the verified contract block nor the independently
confirmed discovery block may be after the run's first observed block. It reports required, present,
passed, missing, and non-passing scenarios. Endpoint URLs are intentionally absent, so public-profile
equality does not establish private endpoint identity. Its verification section explicitly keeps
`executionAttested`, `artifactAuthenticated`, and `fundedExecutionApproved` false. The envelope does
not convert partial coverage into grant-ready evidence.

`serializeTestnetVerifiedRunEvidence` reconstructs the complete envelope and emits its canonical
UTF-8 JSON representation with schema property order, two-space indentation, and one trailing
newline. `pnpm --silent testnet:validate-evidence < verified-run.json` validates that exact form
offline. The command rejects duplicate keys, extra fields, alternate JSON encodings, and inconsistent
derived claims without echoing rejected content. Success establishes canonical structure only; the
artifact remains unsigned and unauthenticated.

`TestnetScenarioRunner` is the one-shot orchestration boundary for the eight canonical spike
scenarios. It validates the combined contract/service context, safe public command, dense scenario
order, accepted block source, and clocks before producing a verified-run envelope. At run start it
rejects future or stale context before reading a block or invoking a callback. It invokes callbacks
sequentially, measures duration itself, stops after the first failed or skipped result, and records
the remaining scenarios as `SKIPPED` with `operator_stopped`. Callback exceptions and malformed
outputs become value-free `FAILED`/`OPERATOR_REQUIRED` evidence. Runner state `COMPLETED` means the
orchestration returned an envelope; only `scenarioCoverage` establishes whether every scenario
passed.

Expected states are part of the evidence schema rather than caller input: incoming attribution and
restart must reach `PAID`, reuse must reach `OPERATOR_REQUIRED`, normal and response-loss payouts
must reach `PAID`, provider outage must remain `UNKNOWN`, proven reversion must reach `FAILED`, and a
reorg exercise must report `REORGED`. A caller cannot redefine those criteria to manufacture a pass.

The runner has no signer, prover, payout submitter, wallet, RPC implementation, filesystem, or
logging capability. The supplied callbacks own transaction execution, durable reconciliation, and
request deadlines. A callback must not resolve with a permanent failure while execution remains
ambiguous. The runner does not cancel a stuck callback because returning without authoritative
reconciliation could conceal a late transaction. Output backed by fakes or local callbacks is test
coverage, not live Sepolia evidence.
Import this boundary explicitly:

```ts
import {
  createTestnetDeploymentEvidence,
  createTestnetRunEvidence,
  createTestnetVerifiedContextEvidence,
  createTestnetVerifiedRunEvidence,
  serializeTestnetVerifiedRunEvidence,
} from "@cashu-strk20/settlement/testnet-evidence";

import { TestnetScenarioRunner } from "@cashu-strk20/settlement/testnet-scenario-runner";
```

The credential-free shared-profile command performs a current compatibility observation without an
environment file:

```bash
pnpm --silent testnet:observe-integration
```

`observeStarkwareIntegrationSepolia` confirms a fresh discovery head through PublicNode and
Cartridge, then reads the exact RC.6 pool configuration and canonical six-decimal Sepolia USDC at
that block hash. It also checks prover API `0.10.3-rc.2`. The output omits endpoints and explicitly
records the original UDC deployment, every observed `replace_to` transition, and a complete filtered
`ImplementationReplaced` inventory. It records the pinned standard AccessControl history and current
common-role state for every event-discovered authority account. A bounded event-inventory cache
performs one union-selector scan per provider and returns exact filtered views to the two independent
verifiers. Authority identity and approval,
non-event storage changes, historical class source authenticity, runtime identity, screening
configuration and activity, settlement-account setup, and funded execution remain unverified.
Import the reusable boundary through
`@cashu-strk20/settlement/integration-sepolia-observer`.

For an operator-owned alternative, the unsigned planner constructs the exact RC.6 pool constructor
and unique UDC call without a signer or network client:

```bash
cp .env.pool-deployment.example .env.pool-deployment
pnpm --silent testnet:plan-pool-deployment
```

`createTestnetPoolDeploymentPlan` validates the pinned class and source, curve-valid auditor and
screener keys, proof-validity value, nonzero explicit salt, and separation from the settlement
account. It cannot establish that the salt is fresh. It compares `starknet@10.5.0` call assembly
with the independently calculated address and emits unresolved salt-freshness, declaration,
key-control, service-binding, signing, submission, and approval blockers. Import the pure boundary
through `@cashu-strk20/settlement/testnet-pool-deployment-plan`. The command is not a broadcaster or
a deployment manifest.

The workspace command below loads a local `.env`, constructs the secret-bearing internal config,
and prints only the sanitized deployment record:

```bash
pnpm --silent testnet:preflight
```

The environment parser is intentionally not exported from this package. It owns signer, viewing,
and screening-partner credentials only long enough to validate the profile and must remain behind
the executable boundary. The command performs no network call or transaction submission;
configuration labels, runtime screening behavior, and provider independence still require operator
verification.

The pool and token deployment transaction references, manifest URLs, and manifest hashes are public
fields. Use public HTTPS manifest URLs without credentials, queries, or fragments and lowercase,
unprefixed SHA-256 values over the exact bytes. The required contents and receipt review are
documented in the
[testnet privacy services guide](../../docs/operations/testnet-privacy-services.md#deployment-inputs).

The separate command below performs the read-only multi-provider check and emits a reconstructed
verification record. It loads `.env.deployment` when present, never the funded `.env`. Start from
`.env.deployment.example` and do not add signer, viewing, or screening credentials:

```bash
pnpm --silent testnet:verify-deployment
```

It contacts the public manifest hosts before the configured RPC endpoints. Manifest requests omit
credentials and referrers, reject redirects and content encoding, and accept at most 64 KiB of
canonical `application/json`. The read-only-profile parser does not read signer, viewing, or
screening credential variables, construct an account, call the prover or discovery service, or
submit a transaction. The RPC phase verifies UDC address derivation, successful policy-final
receipts, exact deployment events, canonical block membership, historical deployed and UDC classes,
and a recent common class-hash view. Agreement between two configured endpoints is not proof that
their operators are actually independent.

The same local read-only profile can drive a bounded compatibility probe for the pinned RC.2
transaction prover and discovery service plus the RC.6 proof interceptor:

```bash
pnpm --silent testnet:verify-services
```

`verifyTestnetPrivacyServices` validates the full public profile, requires the exact service pins,
checks prover API `0.10.3-rc.2`, checks discovery `/health` plus freshness, and requires exact
interceptor health `{ "status": "ok" }`. `StarknetDiscoveryHeadVerifier` then requires every
configured RPC to identify Sepolia and return that exact block number, hash, and timestamp as L2-
or L1-accepted; the weakest observed status is evidence, not settlement finality. The command sends
no Cashu, address, or transaction data and binds observations to the sanitized deployment profile
without endpoint URLs, the account address, credentials, or raw responses. Endpoint authentication
and network metadata remain visible to the services. Interceptor health does not prove its runtime
screening configuration or activity, and no test address is sent. A pass also does not verify a
service runtime version, the prover's chain, image bytes, or which contracts the remote services use.
Import the boundaries through `@cashu-strk20/settlement/starknet-discovery-head-verifier` and
`@cashu-strk20/settlement/testnet-service-verifier`.

For the pre-run gate, use the combined command:

```bash
pnpm --silent testnet:verify-context
```

It parses `.env.deployment` once, verifies both deployment manifests, constructs each RPC provider
once, completes contract verification, then probes services and reconstructs one
`TestnetVerifiedContextEvidence` record. A failure emits no partial stdout. The command remains
read-only and never loads funded signer, viewing, or screening-partner variables. It does not
strengthen the service record's explicit non-attestation flags or prove that a public operator label
identifies an independently controlled backend. Its `service_contract_bindings_unverified` blocker
means the remote service probes do not attest their pool or token configuration; it does not negate
the separate canonical contract-deployment verification in the same context.

`InMemoryFundingRequestStore`, `InMemoryPayerBindingChallengeStore`,
`InMemorySettlementIntentStore`, and `InMemorySettlementPauseStore` exist only for deterministic
tests. They are not durable and must not be used for a funded service.

`SqliteSettlementStore` provides local crash and restart recovery for funding requests, payer
challenges, verification evidence, payment evidence, payout intents, submission IDs, states,
transaction lineage, first-writer profile pauses, terminal-payout watch leases, and the incident
alert outbox. It uses strict tables, transactional uniqueness, `BEGIN IMMEDIATE` writes, full
synchronous commits, WAL journaling, and mode `0600` for the database and its journal files. New
funding records, payout intents, first submission attachments, and funding finalization fail
transactionally while their profile is paused. Schema version 4 adds finality watches and alerts;
migration from version 3 backfills every existing terminal payout as immediately due. Version 2
migrates first through the empty profile-pause schema and then through that backfill. Version 1 is
rejected because its payer-binding rows cannot be migrated without inventing security-critical
expected-note attribution data.
Import it through the explicit subpath so the normal settlement package does not load Node's
experimental SQLite API:

```ts
import { SqliteSettlementStore } from "@cashu-strk20/settlement/sqlite-store";

const store = new SqliteSettlementStore("./private/settlement.sqlite");
```

This is a testnet-spike store, not the production persistence design. The built-in `node:sqlite`
API is experimental in the pinned Node release, operations are synchronous, and the database is not
encrypted. The store must contain no signer keys, viewing keys, decrypted notes, or Cashu bearer
proofs. It does contain private settlement metadata, including Cashu quote IDs, so its directory,
backups, and host still require private access. General settlement transition journaling, CDK event
delivery, alert retention, operator workflow, backup recovery, encrypted storage, and production
multi-process testing remain open.
