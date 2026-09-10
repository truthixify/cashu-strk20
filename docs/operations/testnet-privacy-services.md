# Testnet Privacy Services

Status: active shared Integration Sepolia profile observed read-only. It is not approved for funded
use and this is not a transaction runbook.

The pinned Starknet Privacy release publishes compatible service images and a pool class hash, but
its release-owned configuration does not publish a reusable Sepolia deployment. A later
[official-repository demo preview](https://github.com/starkware-libs/starknet-privacy/pull/951)
built from commit
[`42bc24b18166f8a685ec2c0c0f8d9cd6dfb585f6`](https://github.com/starkware-libs/starknet-privacy/commit/42bc24b18166f8a685ec2c0c0f8d9cd6dfb585f6)
does expose an active shared Integration Sepolia pool, prover, and discovery service. That preview
and its private deployment configuration are mutable and are not an owner-signed deployment
manifest.

The tracked demo examples contain placeholder values, while its documented preview flow pulls real
configuration from a private Vercel project. On 2026-09-10, the public preview bundle built from the
commit above exposed the same pool and Sepolia chain plus anonymous RPC, discovery, and proving
proxy routes. Those public client values are useful corroboration, not an authenticated service
manifest. The bundle still names the pool's original class rather than its current upgraded RC.6
class, and its displayed token catalog contains only 18-decimal demo assets; it does not include
canonical six-decimal Sepolia USDC.

The upstream Integration Sepolia test also requires account credentials from a shared team document
and uses an administrator account as the demo-token minter. The active public pool, prover, and
discovery endpoints therefore do not by themselves provide a public signer, funded account, USDC
source, proof-interceptor configuration attestation, or reusable token-mint path for this project.

The shared profile is suitable for credential-free compatibility research. A funded settlement
spike still requires either explicit approval and provenance for that profile or an operator-owned
Sepolia deployment. Its pool, token, settlement account, prover, discovery service, proof
interceptor, screening provider, and RPC providers must be recorded and verified before any test
transaction. A matching current class hash alone is not deployment approval.

## Shared Integration Sepolia observation

Run the fixed, credential-free observer:

```bash
pnpm --silent testnet:observe-integration
```

The observer uses no `.env` file and has no signer or transaction-submission capability. It asks the
shared discovery service for one fresh head, requires PublicNode and Cartridge to identify
`SN_SEPOLIA` and agree on that block, then reads all profile state at the exact block hash. It
requires:

- pool address
  `0x254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91` with current RC.6 class
  `0x7e2bbd7ccc1e68b2695caef70aeb2a3be6cd017b5d5159278ba08f2d8de33f`;
- pool version `2.1`, nonzero auditor and screener keys, proof-validity window `450`, and a coherent
  fee and collector pair;
- the original pool deployment through Starknet's UDC, including deterministic address derivation,
  exact deployment event, accepted receipt and block inclusion, initial pool class, constructor
  calldata, and historical UDC class;
- every pinned `replace_to` transaction and before/after class transition, plus the complete filtered
  `ImplementationReplaced` event inventory from the deployment block through the discovery head;
- all `RoleGranted`, `RoleGrantedWithDelay`, `RoleRevoked`, and `RoleAdminChanged` events over the
  same range, with the exact 21-event inventory pinned by SHA-256, plus current membership in all ten
  common roles for every account named by a grant or revocation;
- the canonical Starknet Sepolia USDC address
  `0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080`
  from the pinned
  [Starknet address registry](https://github.com/starknet-io/starknet-addresses/blob/e46241a806dd2d85cdf89dfb5c076855ff1e512e/bridged_tokens/sepolia.json),
  its observed class hash, and exactly six decimals; and
- prover JSON-RPC API version `0.10.3-rc.2` plus a fresh discovery health response.

The upgrade and authority histories are fetched as one bounded union-selector inventory per RPC.
The two verifiers receive exact filtered views and independently enforce their expected counts,
ordering, fields, and fingerprints.

On 2026-09-10 at `00:29:01Z`, the command passed at block `14,823,590`, hash
`0x67aece584b7f66274d620e543a741121fc164605c73f7a014006aa7cb9a805f`, with both RPCs returning
accepted chain state. It verified the original UDC deployment transaction
`0x76faebc727e97725d5dc7b8aa1d058ce412249e36b4f922923411cf9edffbab` at L1-accepted block
`8,271,125`. The event, derived address, block inclusion, initial class
`0x715b22abfb60815623f4127ba64bd2f93613d8a5c1e519841eaab444659d2af`, and historical UDC class
all matched the fixed profile.

The observer then found exactly these five standard upgrades and verified every transaction, event,
canonical block, L1 finality result, and class transition through RC.6:

| Block | Transaction | Replacement class |
|---:|---|---|
| `10,829,820` | `0x4762b69680119e186dd3f9e1666c2e9b540ea17d39334ae6870c691ed2dab18` | `0x30b8c540cf04d8ef0f4db2a9098d9cc0e35e83af1cb3325f5a4f40144b4b30b` |
| `11,111,946` | `0x5bb9632c45ae060ab33ab10871d5f3d1ff65fdf4d611962ef169cf29500675d` | `0x1a78d2daee64d1da6e7903b32676c92fcc301d4c03f688cd64e731f46033d18` |
| `11,612,079` | `0x284a3bf9aa86e8487dd485f9325b45bbe32b6c06bac0749cc5d7ae2767e01e1` | `0x67dddd89d80fedadc06b6f160798f94800a4a70164e5a24301cd0d6076b554d` |
| `12,932,675` | `0x59f76fec2b924279e475d94c3b0d01f56cff857dfd730e25e05f1fcfe4344f2` | `0x56ab118a8a6e38efc93ad758cefe909fee421fa931ce3cf72df624d345623b2` |
| `14,339,893` | `0xfe78bf11c285dd2b0110ad96f79b9d4693c7e39179f83e965e022e414e57f8` | `0x7e2bbd7ccc1e68b2695caef70aeb2a3be6cd017b5d5159278ba08f2d8de33f` |

The same provider pair agreed on 21 standard AccessControl events with canonical inventory SHA-256
`c3f2bc120b4debbd20a01d75f9726a52f042591d93ab51b9cd67aef2d51678eb`. Role identifiers and
administrator relationships are pinned to
[`starkware-starknet-utils` revision `3e2fd53d99e16c87f6cf2ced53b8c842a2d54a18`](https://github.com/starkware-libs/starkware-starknet-utils/blob/3e2fd53d99e16c87f6cf2ced53b8c842a2d54a18/packages/utils/src/components/roles/interface.cairo).
At the observed head, `has_role` returned these active assignments for the two accounts named by the
standard grant history:

| Account | Active common roles |
|---|---|
| `0x48baf3ed1f0a03840186bd95063f63824d93bafd456439bfe667533437d9c91` | `APP_GOVERNOR`, `APP_ROLE_ADMIN`, `GOVERNANCE_ADMIN`, `UPGRADE_GOVERNOR`, `SECURITY_ADMIN` |
| `0x3e6c6f41d833ec5e7d38e6007df5b0ab6b48bc4c2d3dbeac1ed665456ae4766` | `APP_GOVERNOR`, `APP_ROLE_ADMIN`, `GOVERNANCE_ADMIN`, `UPGRADE_GOVERNOR`, `SECURITY_ADMIN`, `SECURITY_GOVERNOR` |

This dated result is only a reproducible observation; rerun the command for current state. The
output omits endpoint URLs and carries explicit verification fields and blockers. The deployment
check proves on-chain UDC origin, not whether the deployer was an approved project operator. The
event inventory proves the standard `ImplementationReplaced` history returned by both providers; it
does not prove that no historical implementation could use an unlogged class-replacement path. The
role inventory and membership calls prove the reviewed standard history and contract-reported state
for event-discovered accounts; they cannot enumerate a membership written directly to storage
without a standard event. The command does not authenticate the authority controllers, obtain their
approval, attest historical class sources or remote service images, inspect the proof interceptor,
prove fail-closed screening configuration or activity, configure a settlement account, submit a
transaction, or approve funded use. The services and RPCs can still observe source-network metadata
and request timing.

## Canonical test USDC funding

The canonical Starknet address registry maps Sepolia USDC to Ethereum Sepolia token
`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` and Starknet Sepolia token
`0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080`, both with six decimals,
and publishes their StarkGate bridge addresses. A reproducible no-custom-token path is therefore:

1. create a clearly test-only Ethereum Sepolia wallet and a separate Starknet Sepolia account;
2. obtain Ethereum Sepolia ETH and test USDC through reviewed faucets, including the
   [Circle faucet flow](https://developers.circle.com/stablecoins/quickstarts/transfer-usdc-evm);
3. bridge only the capped test amount through the
   [Sepolia StarkGate UI](https://sepolia.starkgate.starknet.io/); and
4. obtain a minimal Starknet Sepolia STRK gas balance through the faucet linked by the
   [Starknet quick start](https://docs.starknet.io/build/starkzap/quick-start).

This is an operator preparation route, not an automated project command. Faucet availability,
bridge completion, account deployment, token balance, and fees must be rechecked immediately before
the spike. The L1 faucet and bridge create public address, amount, and timing links, so the resulting
account is test-only evidence and must not be presented as a private funding origin. No mainnet asset
or funded production key belongs in this flow.

## Reviewed images

The [RC.6 compatibility matrix](https://github.com/starkware-libs/starknet-privacy/blob/4db755b9512f00b540126737b605472ea2275e15/README.md#compatibility-matrix)
selects transaction prover RC.2, discovery service RC.2, and an optional screening interceptor RC.6.
The CairoCash fail-closed profile makes that interceptor mandatory. On 2026-09-02, their release
tags resolved to these multi-platform OCI indexes:

| Component | Version | Immutable image |
|---|---|---|
| Transaction prover | `PRIVACY-0.14.3-RC.2` | `ghcr.io/starkware-libs/starknet-privacy/transaction-prover@sha256:a2f71d7139069fa566c4f44bdd66b79cac992c0cbc20ddf0af3a3558c6cabd64` |
| Discovery service | `PRIVACY-0.14.3-RC.2` | `ghcr.io/starkware-libs/starknet-privacy/discovery-service@sha256:29c3be4422a0471039e87e3318173153c4e9484d6c185404390916fee7ce3bae` |
| Proof interceptor | `PRIVACY-0.14.3-RC.6` | `ghcr.io/starkware-libs/starknet-privacy/proof-interceptor@sha256:a9082f75b378b2f01f817dbfbb7c28333ca7210e8b2b95ca311e6f364f0c6456` |

Verify that the mutable tags still resolve to the reviewed indexes and Linux platform manifests and
that each immutable index still carries the reviewed source declarations:

```bash
pnpm --silent privacy-services:verify-images
```

The command uses `docker buildx imagetools inspect`. It resolves each mutable tag once, then reads
BuildKit metadata through the reviewed immutable reference so a tag move cannot mix the checked
manifest with another index's declaration. It requires both Linux platforms to declare the reviewed
source repository, revision, Dockerfile path, builder ID, and completeness flags. It emits only
those allowlisted fields, does not pull an image or start a container, and passes the Docker client
only `HOME`, `DOCKER_CONFIG`, a fixed `PATH`, and `LANG`; package tokens, RPC settings, signer keys,
and viewing material are not forwarded.

The transaction prover declares sequencer revision
`e6b6fd2e9932909107833579e5b6efd6c75fa0af` but no builder identity. Discovery declares privacy
revision `9bfeb8dd35565a2915a0617dff3f649bd5bb891a`, and the interceptor declares RC.6 revision
`4db755b9512f00b540126737b605472ea2275e15`; those two name GitHub Actions run URLs as builders. All
three declarations mark resolved dependencies incomplete. These are statement-content checks, not
signature or builder-identity verification. The evidence therefore leaves provenance and source
reproducibility unverified and does not approve a deployment.

## Unsigned operator-owned pool plan

Use the local planner before considering any operator-owned pool transaction:

```bash
cp .env.pool-deployment.example .env.pool-deployment
pnpm --silent testnet:plan-pool-deployment
```

It accepts public configuration only and does not construct an account, load a signer, estimate a
fee, call an RPC, declare a class, or submit a transaction. The planner pins Sepolia, the RC.6 source
and class, Starknet.js `10.5.0`, and the current UDC. It requires unique deployment with a fresh
nonzero salt, validates that the auditor and screener values are distinct Stark-curve public keys,
rejects settlement-account reuse, and emits the exact constructor order:

```text
governance_admin, auditor_public_key, screener_public_key, proof_validity_blocks
```

The resulting account payload and normalized UDC calldata must derive the same predicted address.
The offline command validates that the salt is nonzero but cannot determine whether it was used
before; check the predicted address against Sepolia immediately before an authorized deployment.
The JSON output deliberately retains blockers for class declaration, salt freshness, authority
control, privacy service binding, signing, submission, and approval. Do not attach a private key to
this command or treat its output as a deployment manifest. A separately reviewed signer/broadcaster
is later work and requires explicit testnet authorization.

## Deployment inputs

An authorized Sepolia deployment still needs all of the following:

- A pool deployed from RC.6 screening-v3 class
  `0x7e2bbd7ccc1e68b2695caef70aeb2a3be6cd017b5d5159278ba08f2d8de33f`, with the governance
  admin, auditor and screener public keys, proof-validity window, raw constructor calldata,
  deployment transaction, and accepted block recorded. The
  [exact RC.6 contract](https://github.com/starkware-libs/starknet-privacy/blob/4db755b9512f00b540126737b605472ea2275e15/packages/privacy/src/privacy.cairo#L142-L158)
  takes four constructor fields. The same commit's package README and demo deployment hook omit the
  screener key and are stale for this class.
- An address-pinned six-decimal Sepolia USDC test token. Symbol and display name are insufficient
  identity. The class hash, deployment transaction, mint authority, and test-only supply policy
  must be recorded.
- The RC.2 prover on `SN_SEPOLIA`, backed by a JSON-RPC v0.10 node that can serve the selected
  finalized state. The pinned image reports proving API `0.10.3-rc.2`, accepts only Invoke V3, and
  needs a concrete historical block for reproducible evidence. See its
  [source-revision documentation](https://github.com/starkware-libs/sequencer/blob/e6b6fd2e9932909107833579e5b6efd6c75fa0af/crates/starknet_transaction_prover/README.md).
- The RC.2 discovery service with separately recorded HTTP RPC and WebSocket data sources. Its
  [deployment documentation](https://github.com/starkware-libs/starknet-privacy/blob/9bfeb8dd35565a2915a0617dff3f649bd5bb891a/deploy/discovery-service/README.md)
  does not supply a hosted Sepolia endpoint.
- An explicit screening policy. RC.6 screening is not satisfied by running a no-op interceptor.
  A screening-enabled deployment needs the RC.6 sidecar, a real signing screener, correct pool and
  RPC pins, and fail-closed configuration. Any test-only admin exemption changes the trust and
  compliance model and must be separately approved, recorded, and removed after the experiment.
- Two genuinely independent read-only RPC providers for deployment and finality evidence. Two URLs
  backed by one operator are not independent evidence.

Publish an immutable JSON deployment manifest for the pool and token before recording either
profile. Each manifest should identify its format version, Sepolia chain ID, contract kind, address,
class hash, release or source commit, deployment transaction and accepted block, deployer,
and reviewed constructor values. The pool record includes the governance admin, auditor and screener
public keys, and proof-validity window. The token record includes symbol, decimals, mint authority,
and capped test-supply policy. Public keys and addresses are expected; private keys, RPC credentials,
screening credentials, and unpublished transaction payloads are not. Use the canonical
[manifest specification](../specs/testnet-deployment-manifest.md) and vector rather than inventing a
new object shape.

Set each `*_DEPLOYMENT_MANIFEST_URL` to a public HTTPS object with no credentials, query, or
fragment. Set `*_DEPLOYMENT_MANIFEST_SHA256` to the lowercase, unprefixed SHA-256 of the exact bytes
retrieved from that URL, and set `*_DEPLOYMENT_TRANSACTION_REFERENCE` to the canonical nonzero
Starknet transaction hash. A pool and token may share a manifest only when that one immutable object
contains complete records for both contracts; in that case both configured hashes are identical.

The pinned interceptor's
[configuration loader](https://github.com/starkware-libs/starknet-privacy/blob/4db755b9512f00b540126737b605472ea2275e15/proof-interceptor/src/config.ts)
silently passes proofs through when `SCREENING_URL` is absent. Its
[screening path](https://github.com/starkware-libs/starknet-privacy/blob/4db755b9512f00b540126737b605472ea2275e15/proof-interceptor/src/screening-interceptor.ts)
also has its own fail-open control. Production evidence must therefore cover the actual runtime
values corresponding to `SCREENING_URL`, `SCREENING_BLOCK_NON_POOL_TX=true`, interceptor fail-open
disabled, prover blocking-check fail-open disabled, and the reviewed pool and RPC bindings. The
local `fail_closed_v1` profile records the intended values but cannot attest the remote process.
The SDK ABI must also match the deployed pool: the upstream handler allows a pool call when its
deposit action cannot be decoded, so version labels alone are insufficient runtime evidence.

## Read-only compatibility probe

Start from `.env.deployment.example` and keep the completed `.env.deployment` local. It may contain
confidential endpoint locations or access parameters, but it must not contain signer keys, viewing
keys, screening credentials, private notes, or transaction payloads. The service pins are fixed to
RC.2 for prover and discovery and RC.6 for the proof interceptor; changing a pin requires a new
compatibility review. The public profile also requires the declared screening pool to equal the
deployment pool, selects one named RPC, and requires non-pool blocking plus fail-closed interceptor
and prover settings. Pool and token deployment transaction references, manifest URLs, and manifest
hashes are public evidence fields. The read-only deployment and combined context commands fetch each
distinct manifest, verify its exact SHA-256 and canonical content, reject any public manifest field
that reuses the private settlement account address, and verify the declared UDC deployment origin
through every configured RPC. This is chain observation, not publisher authentication or deployment
approval, and it says nothing about the running privacy-service containers.

Run:

```bash
pnpm --silent testnet:verify-services
```

For the final read-only gate immediately before scenario execution, run both deployment and service
verification through the shared-profile command instead:

```bash
pnpm --silent testnet:verify-context
```

The combined command constructs each configured RPC provider once, runs the contract check first,
then the service check, and emits one context only after both pass. Use the service-only command when
diagnosing that half of a failed context gate.

The command validates the complete read-only Sepolia profile, then performs three service requests:

- JSON-RPC `starknet_specVersion` with no parameters against the transaction prover, requiring
  `0.10.3-rc.2`;
- `GET /health` against the discovery service, requiring `OK`, a canonical nonzero block hash, and a
  head timestamp and reported lag inside the configured age policy;
- `GET /health` against the RC.6 proof interceptor, requiring the exact `{ "status": "ok" }`
  response shape.

After all three pass, each configured RPC provider receives `starknet_chainId` and a block-by-number
lookup for that discovery head. Every provider must identify Sepolia and return the exact reported
block number, hash, and timestamp with an accepted L2 or L1 status. The evidence records the weakest
accepted status seen. This is a chain-state cross-check, not satisfaction of the configured
settlement finality policy. The pinned service
[subscribes to confirmed latest heads](https://github.com/starkware-libs/starknet-privacy/blob/9bfeb8dd35565a2915a0617dff3f649bd5bb891a/crates/discovery-service/src/indexer.rs),
and its [health handler](https://github.com/starkware-libs/starknet-privacy/blob/9bfeb8dd35565a2915a0617dff3f649bd5bb891a/crates/discovery-service/src/api/handlers.rs)
reports that in-memory head without a finality field.

All service requests use a ten-second deadline, reject redirects, omit browser credentials and
referrers, and accept at most 64 KiB of `application/json`. RPC calls use the profile timeout capped
at sixty seconds. The evidence is rebuilt from an allowlist and
includes the existing sanitized deployment profile so its service observations and freshness policy
remain reviewable together. It omits service URLs, the settlement account address, and response
bodies. The command loads only `.env.deployment`; it neither reads funded keys nor sends Cashu, note,
recipient, or transaction data.

The services still see the endpoint request, source-network metadata, and timing. A credential in a
prover URL is sent to that endpoint even though it is omitted from output; prefer a local access
proxy. Discovery, proof-interceptor, and screening-provider base URLs cannot contain a query,
fragment, or trailing slash because the verifier appends `/health` and the interceptor appends
`/screen` directly.

A passing record proves only that the endpoints exposed the reviewed public response shapes and that
the reported discovery head matched Sepolia across the configured RPC set at the recorded time. The
interceptor health response is liveness-only: it does not reveal whether `SCREENING_URL` is set,
non-pool transactions are blocked, either fail-open setting is disabled, or the running pool and RPC
match the profile. The command deliberately sends no known-allowed or known-blocked address, so it
also does not prove screening activity. Such a probe would disclose address and policy-test metadata
to an external service and requires a separately authorized test plan. No response identifies a
runtime component version, image digest, operator, backend, or contract deployment. These limits are
explicit blockers in the emitted JSON.

The deployment command fetches both manifests before constructing RPC providers. It requires
canonical UTF-8 JSON no larger than 64 KiB, disables redirects and credentials, requests identity
encoding, recomputes SHA-256, matches contract identity and transaction declarations, and checks the
four-field pool constructor against the pinned ABI. It derives each address using the pinned
Starknet.js UDC semantics, then requires every provider to agree on the declared receipt identity
and successful status, exact UDC event fields, finality, declared canonical block and transaction
membership, deployed class, and the pinned UDC class
at that block. It separately proves that the configured addresses have the configured class hashes
at one agreed recent block and rejects manifest accepted-block numbers after that block.

Before publication or funded use, a reviewer must still authenticate the manifest sources, confirm
the selected pool and token source, authorities, and supply policy, establish that the configured
providers are independently controlled, and explicitly approve the deployment. Matching source
claims, bytes, UDC origin, and class hashes do not complete those reviews.

## Readiness gate

Before an authorized funded test, retain the image verification record, the pool and token
deployment manifests and hash calculations, the sanitized `testnet:preflight` record, the
multi-provider `testnet:verify-deployment` record, the `testnet:verify-services` compatibility
record, and a fresh
`testnet:verify-context` record. Then
record how each remote service was bound to its reviewed image digest. A healthy endpoint and a
matching public head are not proof that it runs the claimed image or that its operator labels are
correct. Separately retain reviewed runtime configuration showing the interceptor and prover are
fail closed, then run an authorized known-good deposit envelope through the prover/interceptor for
allowed and blocked subjects and confirm screening metrics are nonzero before claiming screening is
active. Do not publish those test subjects or provider credentials.

No mainnet endpoint, real-value token, screening credential, funded key, or private note belongs in
this repository or its public evidence.
