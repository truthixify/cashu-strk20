# Development

## Prerequisites

- macOS or Linux
- Node.js `24.13.0`
- pnpm `10.28.2`
- Rust `1.93.1` with `rustfmt` and `clippy`
- Docker for the optional Privacy SDK declaration-port and source-build checks

The repository pins Node and Rust. The current Cairo placeholder has no build target. When reserve
contract work starts, align Scarb and Starknet Foundry with the pinned Privacy SDK release instead
of using an older global installation.

## Install

```bash
pnpm install --frozen-lockfile
```

The STRK20 Privacy SDK is published to GitHub Packages and is not installed by the normal workspace
install. Its RC.6 note/history surface is represented by a local structural interface and tested
against the pinned upstream source. A live integration must provide a read-only GitHub Packages
token through `NODE_AUTH_TOKEN`, resolve the dependency audit gate, and add only the exact approved
release. Never write the token to the repository's `.npmrc`.

The source-port check needs no package credential:

```bash
pnpm --silent privacy-sdk:verify-source-ports
```

It checks out the exact public RC.6 commit and installs its lockfile inside a digest-pinned,
resource-bounded Linux/AMD64 container with install lifecycle scripts disabled. It builds the SDK's
public declarations, then compiles assignability checks against the emitted local port declaration
under strict consumer settings. Only those two hashed compatibility inputs are mounted read-only;
the repository and package token are not mounted. GitHub, npm, the pinned build image, and the local
Docker daemon remain trust dependencies. A pass neither authenticates the registry artifact nor
executes or approves the SDK runtime.

After a secret manager or current shell supplies a token with `read:packages`, verify the published
artifact without installing it:

```bash
pnpm --silent privacy-sdk:verify-artifact
```

The command does not load `.env`, run lifecycle scripts, or add the package to a lockfile. It checks
the registry `gitHead`, approved manifest and exports, archive member types and paths, and both
published digests before printing sanitized evidence. A successful result still records
`sourceBuildMatchVerified: false` and `productionInstallApproved: false` until an isolated build is
compared and the unused vulnerable `starknet-devnet` production subtree is removed or explicitly
remediated.

To verify the authenticated package declarations against the same local ports, run:

```bash
pnpm --silent privacy-sdk:verify-artifact-ports
```

This command repeats the artifact integrity and structure checks before invoking Docker. It stages
only the validated archive, local port declaration, and compatibility fixture in a private temporary
directory. The mount is read-only, and only `HOME` and `DOCKER_CONFIG` are passed to the Docker
client; `NODE_AUTH_TOKEN`, RPC values, and the workspace do not cross into the container. The exact
RC.6 source lockfile supplies TypeScript and declaration dependencies with lifecycle scripts
disabled. A pass verifies type assignability only. It does not execute the SDK, prove a source-build
match, or approve the vulnerable dependency tree.

For an independent source comparison, run:

```bash
pnpm --silent privacy-sdk:verify-source-build
```

This command first passes the authenticated artifact gate. It then fetches the exact public source
commit and locked npm dependencies inside a pinned Linux/AMD64 Node `24.0.2` container, disables
install lifecycle scripts, rebuilds all declared exports, and compares the resulting npm archive
byte for byte. It mounts neither the repository nor a host output directory and does not forward
`NODE_AUTH_TOKEN`. The build container retains network access for GitHub and npm, so Docker, those
services, and the pinned build tools remain trust dependencies. Docker is not invoked by
`pnpm check`.

## Commands

```bash
pnpm format          # format TypeScript workspace files
pnpm format:check    # verify formatting
pnpm lint            # run Biome lint rules
pnpm typecheck       # type-check each package
pnpm test            # run TypeScript tests
pnpm check:rust      # rustfmt, clippy, and Rust tests
pnpm check           # all required local checks
pnpm build           # build all packages
pnpm privacy-sdk:verify-source-ports # type-check local ports against exact public RC.6 source
pnpm privacy-sdk:verify-artifact # verify the authenticated SDK tarball without installing it
pnpm privacy-sdk:verify-artifact-ports # type-check the authenticated SDK declarations
pnpm privacy-sdk:verify-source-build # rebuild RC.6 and require an exact authenticated match
```

Before a commit, also run:

```bash
scripts/check-protected-paths.sh
git status --short
git diff --cached
git diff --cached --name-only
```

## Test layers

### Unit

Pure, deterministic tests cover amount conversion, parsing, state transitions, idempotency, and
mapping to Cashu semantics. They do not need secrets or network services.

The settlement persistence tests use Node's built-in SQLite module and intentionally exercise real
temporary database files. Node `24.13.0` prints an `ExperimentalWarning` when that isolated test
module loads; the warning is expected and does not mean the suite was skipped.

Prepared payout tests use a separate SQLite file and an in-memory test keyring. A real encryption
key must come from a secret manager or hardware-backed key service; it must never be stored beside
the database, in `.env.example`, or in test fixtures.

### Component

The adapter and settlement service run against scripted fakes that can return success, timeout,
ambiguous success, reorg, provider disagreement, malformed SNIP-6 responses, wrong token, wrong
recipient, malformed receipts and blocks, and permanent failure. Transaction-observer tests also
cover explicit L1/L2 policies, canonical block membership, public note-value commitments, invoke
sender attribution, bounded batches, and restart-time reorg classification. The note-source tests
include the pinned Cairo note-ID and encrypted-value vectors. Payout tests cover exact calldata and
proof binding, bigint fee caps, encrypted payload tampering, signer-nonce conflicts, response loss,
concurrent durable submission leases, delayed ambiguous exact rebroadcast, write-once inclusion
recovery, pre-finality reorgs, and close/reopen recovery without a second proof. The composed payout
recovery test closes both SQLite stores after a lost submission response and binds the restarted
observer, encrypted artifact, and quote-keyed intent to one transaction without another broadcast,
proof, or signer call. Proving-block tests cover provider head lag, historical block
agreement, pool validity-window agreement, freshness, remaining margin, and bounded request failure.
Payout mutation tests reject proof facts that name a different base block. Post-finality tests cover
immutable terminal accounting, read-only canonicality checks, exact original-inclusion matching,
unanimous policy-final reversion, restart recovery of reverted inclusions, contradictory terminal
outcomes, write-once reorg/conflict incidents, provider ambiguity, and incident-write response loss.
Supervisor and pause-store tests cover incident-only pause creation, first-writer profile ownership,
quote-ID omission, malformed checker and store responses, response-loss recovery, restart
persistence, semantic row corruption, and safe settlement schema version 2 through version 4
migration. Scheduler and alert tests cover bounded claims, capped retry, healthy rescheduling,
terminal-row backfill, lease expiry and stale workers, slow callbacks, clock rollback, incident
closure, quote-free alerts, at-least-once response loss, sink idempotency keys, restart recovery, and
hostile dependency values. They also cover response deadlines, lease/batch budget rejection, and a
late alert response retried under the same idempotency key. Runtime tests cover ordered
non-overlapping cycles, fixed redacted health, immediate and periodic invocation, malformed
summaries, clock rollback, graceful shutdown, timer failure, and restart rejection while shutdown is
incomplete.
Admission tests cover paused and unavailable stores, value-free hostile responses, blocked funding
instructions, retained final evidence, operator escalation, blocked payout preparation and
broadcast, continued submitted-payout reconciliation, and transactional SQLite enforcement for new
records, first submission attachment, and funding finalization. Activity-gate tests cover concurrent
funding-finalization and submission drain, both sides of the pause ordering, profile isolation,
failed-persistence retry, and skipped or repeated protected callbacks.
The signed-payer vector test reconstructs the public SNIP-12 fixture and mutates every authorization
field plus the outer account address to prove they change the pinned message hash. The wallet-side
note-reference helper is checked against the pinned Cairo note-ID vector and reused by the incoming
note verifier so the prediction and verification formulas cannot drift independently. Its focused
tests also prove same-scope FIFO execution, post-failure queue release, derivation after lock
acquisition, immutable value-minimized leases, and rejection when the channel nonce changes before
compilation. These tests do not model a second process, device, or SDK instance over shared storage.
Funding-gateway tests join the verified binding to fresh note evidence, treat hints only as fresh
filters, preserve wrong-payment identity across restart, reject duplicate or identity-changing
evidence, and exercise coordinator recovery from pending to paid without a payout stub. The composed
recovery test uses the actual SQLite binding and funding stores, closes the database after pending
evidence, reconstructs every process-local boundary, and reaches paid only after canonical
reobservation. It remains deterministic and is not live-chain evidence.
The Rust CDK compatibility test pins the published `cdk-common` `0.17.6` crate as a dev dependency,
serializes the public custom NUT-04/NUT-05 vector through its exact types, and proves that stored melt
quotes restore the mint-created quote ID and processor response metadata. It does not implement
`MintPayment` or exercise a running CDK HTTP or gRPC server. See the
[compatibility record](compatibility/cdk-0.17.6.md) for the source-verified transport constraints.
Artifact-verifier tests cover source and manifest drift, registry-integrity mismatch, lifecycle
scripts, missing exports, path traversal, linked archive members, hostile metadata, missing package
scope, and token-free output and subprocess boundaries.

The privacy-service image verifier separately pins the official RC.2 transaction prover, RC.2
discovery service, and RC.6 screening sidecar OCI indexes plus their Linux/AMD64 and Linux/ARM64
manifests. It also validates the publisher-attached BuildKit source, revision, Dockerfile path,
builder declaration, and completeness flags for both platforms. It does not need package or chain
credentials:

```bash
pnpm --silent privacy-services:verify-images
```

This is a network-dependent registry metadata check and is intentionally outside `pnpm check`. It
uses the mutable tag only for the digest check and reads source declarations from the reviewed
immutable reference. It does not pull or run containers, authenticate the declarations, verify image
signatures or reproducible builds, or establish a Sepolia deployment. See the
[testnet privacy services guide](operations/testnet-privacy-services.md) before assigning the output
to deployment evidence.

### Testnet

The integration suite uses pinned contracts and SDK versions. Evidence must record:

- chain ID and block range;
- pool, token, and relevant service versions;
- exact commands and test filters;
- transaction hashes that are safe to disclose;
- expected and observed states;
- proving and settlement timing;
- fees and retries;
- any skipped scenario.

No funded key, screening credential, or private note data may enter the evidence bundle.

### Shared Integration Sepolia observation

Run the built-in public profile without configuring an environment:

```bash
pnpm --silent testnet:observe-integration
```

The command builds the TypeScript packages, probes the shared transaction prover and discovery
service, confirms one fresh discovery block through PublicNode and Cartridge, and reads the pinned
pool and canonical six-decimal Sepolia USDC at that exact block hash. It writes one allowlisted JSON
record without endpoint URLs. It never loads `.env` or `.env.deployment`, constructs an account,
invokes a screening subject, or submits a transaction.

A pass confirms current public compatibility, the original UDC deployment event and address, and all
five observed `replace_to` transitions through RC.6. The verifier also requires both providers to
return the same complete filtered `ImplementationReplaced` inventory from deployment through the
discovery head. It pins the complete 21-event standard AccessControl inventory, decodes the ten
common roles from the exact upstream dependency revision, and checks current membership for both
event-discovered authority accounts at that block. Each provider is scanned once with the union of
the five event selectors; bounded cached results are filtered back into exact upgrade and authority
views before their independent completeness and fingerprint checks. The shared deployment can be
upgraded or have roles changed again, the RPC operator labels are not an independence attestation,
and the check does
not discover a storage mutation that emits no standard event. It also does not authenticate
authority identity or approval, source-to-class provenance, remote runtime images,
service-to-contract binding, fail-closed screening configuration, screening activity, or permission
to fund the pool. Use the operator-owned gates below before any authorized transaction.

### Unsigned pool deployment planning

If the shared pool cannot be approved for the funded spike, prepare an operator-owned RC.6 plan
without a signer or RPC connection:

```bash
cp .env.pool-deployment.example .env.pool-deployment
pnpm --silent testnet:plan-pool-deployment
```

The local file contains public deployment values only. Supply explicit Sepolia chain and RC.6 pins,
the deployer, a fresh nonzero salt, governance admin, valid auditor and screener Stark-curve public
keys, proof-validity window, and the settlement account address. The command requires
`STRK20_POOL_DEPLOYMENT_UNIQUE=true`, rejects reuse of the settlement account as a deployment or
authority value, and does not read signer, viewing-key, or screening-secret variables.

The output contains the `Account.deployContract` payload, canonical UDC call, and predicted address.
It uses the exact RC.6 constructor order
`governance_admin, auditor_public_key, screener_public_key, proof_validity_blocks`; do not use the
three-field constructor still present in older upstream examples. Starknet.js independently builds
the UDC call, and its address must equal the planner's derivation before output is emitted.

This is an unsigned plan, not evidence that the class is declared, the salt has never been used, any
authority controls its key, the transaction was estimated or submitted, or privacy services are
bound to the resulting pool. Check the predicted address for existing state, review the remaining
blockers, and obtain explicit testnet authorization before introducing a signing tool. After a
successful authorized deployment, record the receipt and canonical block in the deployment manifest
and run the existing read-only context gates.

The `@cashu-strk20/settlement/testnet-evidence` subpath provides the public-record boundary. It
validates exact component pins, public deployment identities, asserted provider independence,
finality/proving policy, fail-closed screening declarations, and secret shapes without returning
secrets or endpoint URLs. Pool and token identity includes a public deployment transaction
reference, immutable HTTPS manifest URL, and lowercase SHA-256 declaration. Run records use fixed
scenario/result vocabularies and include a transaction hash only when that entry has explicit
disclosure approval. Verified deployment evidence also carries bounded canonical manifest
verification, its pinned pool-constructor check, UDC address derivation, and multi-provider receipt,
deployment-event, canonical-inclusion, historical deployed-class, and historical UDC-class
verification. The nested manifest record retains its component-scoped receipt blocker; the combined
record replaces it with publisher-authentication and deployment-approval blockers. A verified context
reconstructs the contract-deployment and privacy-service records and requires their sanitized public
configuration to match. Their independent observation timestamps may differ. A verified-run
envelope requires both checks before the run, no older than the configured block-age window, and
requires both checked block heads not to exceed the run's first observed block. It reports incomplete
or non-passing scenario coverage. Because endpoint URLs are omitted, public-profile equality does not
prove private endpoint identity. Its verification section keeps `executionAttested`,
`artifactAuthenticated`, and `fundedExecutionApproved` false. The envelope does not attest provider
independence or screening behavior and is not grant-ready. The module performs no network calls or
file writes.

Use `serializeTestnetVerifiedRunEvidence` when writing the envelope. It produces the only accepted
artifact representation: UTF-8 JSON in schema property order, two-space indentation, and one trailing
newline. Validate a saved artifact without credentials or network access with:

```bash
pnpm --silent testnet:validate-evidence < verified-run.json
```

The command rejects duplicate keys, undeclared fields, noncanonical whitespace or encodings, and
altered derived claims. A successful structural check neither authenticates the bytes nor attests
that the recorded chain activity occurred.

Deployment evidence schema `v4` and verified-context schema `v3` add canonical UDC
deployment-origin evidence. Verified-run schema `v5` also makes its non-attestation,
non-authentication, and funded-use limitation machine-readable. Earlier records fail closed and are
not migrated implicitly. Privacy-service verification schema `v3` names the unresolved remote
service-to-contract binding explicitly; its earlier generic deployment blocker is not upgraded by
guessing.

The `@cashu-strk20/settlement/testnet-scenario-runner` subpath sequences the eight required scenarios
and builds that envelope. Supply the combined verified contract/service context, a safe public
command, one definition for every scenario in exported canonical order, an accepted-block reader,
and scenario callbacks. The runner validates structural configuration during construction and
rejects late or stale context at run start before calling the block reader or a scenario. It runs
only one scenario at a time, measures durations with a monotonic clock, and stops on the first failed
or skipped result. It fills the remaining coverage with explicit `operator_stopped` skips. Expected
states are fixed by the evidence module and are not supplied by callbacks or operators.

Each callback owns the actual wallet, prover, RPC, submission, persistence, and reconciliation work.
It must apply its own deadlines and return only after durable state is conservative about unknown or
late execution. The runner deliberately does not cancel callbacks and cannot sign, prove, submit,
or reclassify a transaction. Callback exceptions and malformed output are reduced to fixed public
failure evidence without carrying raw errors. `COMPLETED` describes runner execution only; require
all `scenarioCoverage` entries to pass before treating the run as complete evidence. A fake-backed
runner result is a unit-test artifact, not a live Sepolia run.

### Testnet preflight

Copy the variable names from `.env.example` into a local `.env`, supply only testnet credentials,
and set both safety acknowledgements to the exact value `true` only after confirming that the
account is test-only and its funds are capped. Then run:

```bash
pnpm --silent testnet:preflight
```

The command builds the two TypeScript packages, loads `.env` when it exists, validates the named
Sepolia configuration, and writes one sanitized deployment-evidence JSON document to stdout. It
does not make network requests, inspect balances, invoke a prover, or submit a transaction. Missing
and invalid values fail with value-free errors on stderr.

For both pool and token, configure a nonzero canonical deployment transaction reference, a public
HTTPS manifest URL without credentials, query, or fragment, and the lowercase unprefixed SHA-256 of
the exact manifest bytes. These fields are emitted publicly and bind later context and run evidence.
See the [testnet privacy services guide](operations/testnet-privacy-services.md#deployment-inputs)
for the minimum manifest contents and independent review procedure.

After separately confirming the pool, token, and account class-hash pins against primary deployment
sources, copy `.env.deployment.example` to the ignored `.env.deployment` and fill only the read-only
deployment profile. Do not put signer, viewing, or screening credentials in that file. Then verify
the pins through the configured RPC providers:

```bash
pnpm --silent testnet:verify-deployment
```

Before constructing a provider, the command retrieves each distinct manifest once, requires the
declared SHA-256 and canonical schema, checks contract identity, source and constructor claims, and
rejects public deployment fields equal to the settlement account address. It then derives each
declared address with the pinned UDC profile and requires all providers to agree on receipt identity
and successful status, the deployment event, canonical block inclusion, finality, the deployed
class, and the pinned UDC class at the deployment block. Finally, it reads policy-accepted heads,
rejects providers outside the configured lag, re-reads the lowest common height, and requires
agreement on its block identity and all three
current class hashes. The result omits endpoint URLs and the settlement account address. Upstream
errors are reduced to value-free or provider-ID-only messages.

This is a read-only network check, not a settlement test. It contacts the public manifest hosts and
configured RPC endpoints. Manifest requests omit credentials and referrers, reject redirects and
content encoding, request identity bytes, use a ten-second timeout, and accept at most 64 KiB of
`application/json`. The wrapper never loads the funded `.env`, its parser does not access signer,
viewing, or screening credential variables, and it does not construct a Starknet account, call the
prover or discovery service, inspect private notes, or submit a transaction. Do not run it against
untrusted endpoints from a network location whose metadata must remain private.

With the same read-only profile, check that the transaction prover, discovery service, and proof
interceptor expose the surface selected by the pinned Privacy SDK release:

```bash
pnpm --silent testnet:verify-services
```

The command requires prover and discovery pins `PRIVACY-0.14.3-RC.2` and proof-interceptor pin
`PRIVACY-0.14.3-RC.6`. It sends the fixed JSON-RPC `starknet_specVersion` request to the prover and
header-minimal `GET /health` requests to discovery and the interceptor. It requires prover API
`0.10.3-rc.2`, applies the profile's block-age policy to the discovery head, and requires exact
interceptor response `{ "status": "ok" }`. Requests have a ten-second timeout, reject redirects,
and accept only bounded JSON. All probes settle before a deterministic error is returned.

After those probes pass, every configured RPC receives `starknet_chainId` and
`starknet_getBlockWithTxHashes` for the reported discovery block number. Each must identify Sepolia
and return that exact block number, hash, and timestamp with `ACCEPTED_ON_L2` or
`ACCEPTED_ON_L1`. The record reports the weakest accepted status seen across the provider set. This
confirms one discovery head against independent state; it does not apply or satisfy the settlement
finality policy. RPC calls use the profile deadline, capped at sixty seconds, and failures expose
only the configured public provider ID.

The wrapper loads `.env.deployment`, never `.env`, and the parser does not access signer, viewing, or
screening credential variables. No Cashu proof, quote, private note, recipient, address, or
transaction payload is sent. The configured endpoint, any credential embedded in its URL, request
timing, and source-network metadata are necessarily visible to that service and to network
intermediaries. Prefer a local authenticated proxy to URL credentials. Discovery and interceptor
base URLs must have no query, fragment, or trailing slash because the verifier appends `/health`.
The screening-provider base URL has the same restriction because the RC.6 interceptor appends
`/screen`.

Successful output binds the observations to the sanitized deployment profile and independently
confirms the discovery head on Sepolia. It remains compatibility evidence only. The interceptor's
health route proves liveness, not whether screening is configured or exercised; the command sends no
test address. No response identifies its service's runtime component version or container, and the
prover response does not identify its chain. The record therefore leaves all runtime versions,
screening runtime configuration, screening activity, prover chain identity, remote image identity,
remote service-to-contract bindings, and deployment approval explicitly false. Run the
contract-deployment verifier, bind remote services to reviewed image digests and contracts, inspect
the actual fail-closed runtime configuration, and obtain authorization before sending allowed/blocked
screening test traffic.

Before a scenario run, produce the required combined context directly:

```bash
pnpm --silent testnet:verify-context
```

This command parses `.env.deployment` once, verifies manifests before constructing an RPC provider,
constructs one instance for each configured RPC, runs contract verification, then checks service
compatibility through the same in-memory public profile and provider instances. It writes only the
reconstructed context after every check passes and emits no partial stdout after a manifest,
deployment, or service failure. It never loads `.env` or funded secret variables and has no signer
or transaction-submission capability. The separate deployment and service commands remain useful
for isolating a failed gate.

Treat the preflight output as configuration validation, the deployment output as UDC-origin and
class agreement by the selected RPC set, the service output as a bounded compatibility and
discovery-chain observation, and the combined output as a structural binding of those two read-only
checks. The deployment verifier binds transaction references to deterministic addresses and
canonical receipts, but it does not authenticate manifest publishers, establish provider
independence, or approve the source and authorities. The service record's
`service_contract_bindings_unverified` blocker remains component-scoped: it means those probes do not
attest the remote services' pool or token configuration, not that the combined context omitted
contract verification. An operator must still verify versions and service image and contract
bindings against primary sources, confirm that RPC operators are independently controlled, review
every public label, and authorize any later transaction reference before publishing evidence. Never
redirect unsanitized shell diagnostics, `.env`, or `.env.deployment` into a public artifact.

## Environment

`.env.example` lists funded-runtime variable names. `.env.pool-deployment.example` contains the
public-only unsigned planner inputs, while `.env.deployment.example` contains the post-deployment
read-only verification profile. Keep real secret values in a local `.env` or secret manager.
`STRK20_SCREENING_PARTNER_NAME` and `STRK20_SCREENING_PARTNER_SECRET` belong only in the funded
environment or secret manager, never `.env.deployment` or public evidence. The service must fail
closed when a network, pool, token, signer, screening, or finality configuration is missing or
inconsistent.

Use test-only accounts with minimal funds. Mainnet endpoints and writes are forbidden during the
initial workstreams.

## Logging

Structured logs may include an opaque internal intent ID, state name, network, token identifier,
and coarse timing. They must not include:

- Cashu proofs or blinded messages;
- Cashu quote IDs in public telemetry;
- signer, viewing, or screening credentials;
- decrypted note data;
- full wallet-supplied payloads;
- private recipient details;
- credentials or authentication headers.

Tests should assert redaction on security-sensitive error paths once network clients are added.

## Dependency changes

Use exact versions for CDK and the Privacy SDK during the spike. A dependency upgrade requires the
upstream changelog, compatibility impact, regenerated lockfile, and focused tests. Do not upgrade to
a release candidate merely because it is newer.

## Generated files

Do not hand-edit generated protocol clients, ABIs, or contract artifacts. Check in generated output
only when the project can reproduce it with a pinned command and the task explicitly includes it.
