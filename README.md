# CairoCash

[![CI](https://github.com/truthixify/cashu-strk20/actions/workflows/ci.yml/badge.svg)](https://github.com/truthixify/cashu-strk20/actions/workflows/ci.yml)

Cashu payment infrastructure for private USDC settlement on Starknet.

CairoCash is an experimental integration between [Cashu](https://cashu.space/) and Starknet's
STRK20 privacy stack. It adds a Cashu payment method named `strk20`, allowing a mint to accept
private STRK20 funding and settle redemptions to private Starknet recipients.

> [!WARNING]
> This project is under active development, testnet-only, and unaudited. It is not ready to hold
> real funds or operate as a public mint.

## Status

The repository currently contains the settlement domain, protocol models, recovery storage, and
pinned Starknet adapter boundaries. It also contains a credential-free observer for StarkWare's
active shared Integration Sepolia profile. It does not yet contain a runnable Cashu mint or a
demonstrated funded Sepolia settlement.

| Component | State |
| --- | --- |
| `strk20` method models and exact USDC amount conversion | Implemented |
| Note-bound signed-payer funding, attribution, and finality state machine | Implemented; wallet and testnet evidence pending |
| RC.6 next-note prediction and wallet-local operation coordinator | Implemented against pinned source; wallet integration pending |
| SNIP-12/SNIP-6 payer authorization and block-pinned account verification | Implemented; live account classes pending |
| Multi-provider Starknet receipt, finality, and reorg observation | Implemented |
| Multi-provider accepted proving-block selection and pool validity checks | Implemented; testnet policy pending |
| Idempotent private payout coordination | Implemented |
| RC.6 private payout signing, encrypted recovery, and exact rebroadcast | Implemented against pinned source; testnet pending |
| Canonical reverted-payout non-execution proof | Implemented; testnet policy pending |
| Post-finality incident, admission, runtime health evaluation, alert outbox, and local submit quiescence | Implemented; external process supervision and alarm delivery, alert sink, multi-process coordination, CDK issuance gate, and resume pending |
| Testnet preflight, sequential scenario runner, sanitized evidence, and contract/service context binding | Implemented; live run pending |
| Canonical manifest, UDC deployment-origin, and multi-provider class-hash verification | Implemented; shared profile observed, publisher authentication and approval pending |
| Unsigned RC.6 pool deployment planning with four-field constructor and deterministic UDC address | Implemented; declaration, signing, broadcast, and service binding intentionally absent |
| RC.6 source-declaration compatibility gate for local SDK ports | Implemented and live-verified; authenticated package pending |
| Authenticated SDK artifact, declaration-port, and independent source-build verifiers | Implemented; scoped-token runs and dependency remediation pending |
| Privacy prover, discovery, and screening image/source-declaration verifier | Implemented; signatures, reproducibility, remote runtime identity, and funded profile pending |
| Read-only prover, discovery, and screening-interceptor compatibility verification | Implemented; shared prover/discovery observed, screening runtime pending |
| Local SQLite crash and restart recovery | Implemented |
| Starknet Privacy SDK note/history adapter | Implemented against pinned source; testnet pending |
| CDK `0.17.6` custom wire and quote correlation | Source- and compile-verified; running mint pending |
| CDK `MintPayment` integration | Scaffolded |
| End-to-end Starknet Sepolia flow | Not yet demonstrated |
| Wallet and merchant interfaces | Not started |

The current integration targets are CDK `0.17.6` and Starknet Privacy SDK `0.14.3-rc.6`.

## Architecture

```text
Cashu client
    |
    v
CDK mint  <-->  cdk-starknet  <-->  settlement service  <-->  STRK20 / Starknet
```

- `cdk-starknet` owns the Cashu and CDK payment-method boundary.
- The settlement service owns funding verification, payout coordination, finality, and recovery.
- The Starknet Privacy SDK remains the STRK20 integration boundary; this project does not
  reimplement its privacy protocol or contracts.

## Repository layout

```text
crates/cdk-starknet/          Rust boundary for the CDK payment backend
packages/strk20-method/      Shared TypeScript method models and amount rules
services/settlement/         Funding, payout, finality, and persistence logic
contracts/reserve-registry/  Reserved for later reserve-evidence work
docs/                        Architecture, specifications, decisions, and operations
```

## Getting started

### Requirements

- Node.js `24.13.0`
- pnpm `10.28.2`
- Rust `1.93.1` with `rustfmt` and `clippy`

### Install

```bash
git clone https://github.com/truthixify/cashu-strk20.git
cd cashu-strk20
pnpm install --frozen-lockfile
```

### Verify

```bash
pnpm check
pnpm build
```

`pnpm check` runs formatting, linting, TypeScript type checks and tests, Rust formatting, Clippy and
tests, and documentation link validation. The current test suite is deterministic and does not
require RPC credentials or funded accounts.

Environment variable names for later testnet integration are documented in [`.env.example`](.env.example).
Never commit signer keys, viewing material, RPC credentials, or Cashu proofs.

### Shared Integration Sepolia

Inspect the active shared STRK20 profile without an environment file, account, or transaction:

```bash
pnpm --silent testnet:observe-integration
```

The command asks the public discovery service for one fresh block, confirms that block through
PublicNode and Cartridge, and reads the pool class and configuration plus canonical six-decimal
Sepolia USDC at that exact block. It also checks the public prover API version. Output is rebuilt
from an allowlist and omits endpoint URLs. This is live compatibility evidence, not permission to
fund or use the deployment. It verifies the pool's original UDC deployment and every observed
`replace_to` transition through RC.6 against both RPCs, including a complete filtered
`ImplementationReplaced` event inventory. It also pins the 21-event standard AccessControl history
and checks all ten common roles for both event-discovered authority accounts at the same block.
Each RPC performs one bounded union-selector event scan; the upgrade and authority verifiers receive
separate exact views of that inventory and retain their own completeness and fingerprint checks.
Authority identity and approval, source authenticity for historical classes, remote runtime images,
fail-closed screening configuration, screening activity, and funded execution remain explicit
blockers.

### Unsigned Sepolia pool plan

An operator-owned pool remains an alternative when the shared Integration Sepolia profile cannot be
approved. Create only its public, unsigned deployment plan with:

```bash
cp .env.pool-deployment.example .env.pool-deployment
pnpm --silent testnet:plan-pool-deployment
```

The command accepts no signer, makes no network request, and cannot submit a transaction. It pins
the RC.6 class and source, requires the governance admin plus distinct valid auditor and screener
public keys, constructs the exact four-field Cairo constructor, forces a deployer-bound unique UDC
deployment, and cross-checks Starknet.js call assembly against an independently derived address.
The settlement account is read only to reject custody-role reuse and is omitted from output.

The result is a review artifact, not a transaction runbook or deployment approval. It explicitly
leaves class declaration, salt freshness, authority control, prover/discovery/screening bindings,
signing, broadcast, and deployment approval unresolved. Deploying a pool also does not create or
fund USDC; the spike continues to use canonical six-decimal Sepolia USDC.

### Testnet preflight

After filling a local `.env` with a test-only Sepolia profile, validate the configuration and print
its sanitized deployment record:

```bash
pnpm --silent testnet:preflight
```

The command does not contact Starknet, a prover, or an indexer and does not submit a transaction. It
fails closed on missing or inconsistent values and omits account addresses, endpoint URLs, signer
keys, viewing keys, and screening credentials from stdout. See
[development guidance](docs/development.md#testnet-preflight)
before using the record as testnet evidence.

Pool and token profiles include public deployment transaction and content-hashed manifest
declarations. Preflight records those claims without retrieving them. The read-only deployment gate
checks their exact bytes and content, then binds each declared transaction to its configured address
through deterministic UDC derivation and canonical chain evidence.

To check the configured chain, accepted block, and pool, token, and account class hashes through both
RPC providers without submitting a transaction, copy `.env.deployment.example` to the ignored
`.env.deployment`, fill only its read-only profile values, and run:

```bash
pnpm --silent testnet:verify-deployment
```

This command never loads the funded `.env` and its parser does not read signer, viewing, or screening
credential variables. It first retrieves and hashes the public canonical manifests, then contacts
the configured RPC endpoints. It does not construct an account, call the prover or discovery
service, or use any write method.

For the normal pre-run gate, execute both read-only checks through one command:

```bash
pnpm --silent testnet:verify-context
```

This parses `.env.deployment` once, verifies deployment manifests, constructs each RPC provider once,
verifies UDC deployment origins and current contract classes, then probes service compatibility
through the same in-memory public profile and provider instances. It emits only the combined context
and no partial stdout when any check fails. The individual deployment and service commands remain
useful for diagnosis.

The combined context can then be bound to a sanitized scenario run. The two checks
must have the same sanitized public configuration, may have different observation timestamps, and
must both be no older at run start than the configured block-age window. Their verified contract and
discovery blocks cannot be after the run's first observed block. Because endpoints are deliberately
omitted, public-profile equality does not prove that both commands contacted the same private URL.
The envelope lists missing, failed, and skipped scenarios rather than presenting partial coverage as
a completed testnet run. Its machine-readable verification section explicitly keeps execution
attestation, artifact authentication, and funded-execution approval false. These structural checks do
not make the artifact grant-ready.

The package also provides a one-shot scenario runner for the eight canonical spike cases. It runs
operator-supplied callbacks sequentially, measures their duration, stops after the first non-passing
result, and emits the context-bound envelope. It rejects late or stale verification before reading a
block or invoking a scenario callback. The runner cannot sign or submit transactions; live callbacks
and an authorized capped Sepolia account are still required.

Serialize a completed envelope with `serializeTestnetVerifiedRunEvidence`, then check a saved public
artifact offline before publication:

```bash
pnpm --silent testnet:validate-evidence < verified-run.json
```

The validator accepts only the canonical UTF-8 JSON form: schema property order, two-space
indentation, and one trailing newline. It rejects duplicate keys, undeclared fields, alternate
encodings, and altered derived claims, and writes the same canonical bytes to stdout on success. It
does not read the environment or network, authenticate the file, or prove that a scenario ran.

With Docker available, verify that the exact public RC.6 source still emits declarations assignable
to the local discovery, channel, viewing-key, and private-transfer ports:

```bash
pnpm --silent privacy-sdk:verify-source-ports
```

This credential-free check uses the exact upstream commit and lockfile in a pinned, resource-bounded
container. It mounts only hashed compatibility inputs, runs no install lifecycle scripts, and does
not execute the SDK runtime. A pass is source compatibility evidence, not authentication of the
published package or approval to install it.

The credentialed SDK artifact is deliberately outside the normal install. With a read-only GitHub
Packages token supplied only through the process environment, check its declared source commit,
manifest, archive members, and registry digests without installing it:

```bash
pnpm --silent privacy-sdk:verify-artifact
```

The command requires `NODE_AUTH_TOKEN` and never loads it from a repository file. Passing this check
does not prove a reproducible source build or approve the SDK for installation; source comparison
and the current `starknet-devnet` production dependency remain separate supply-chain gates.

With the same process-only token and Docker available, type-check the authenticated package's public
declarations against the local SDK ports:

```bash
pnpm --silent privacy-sdk:verify-artifact-ports
```

This command completes the artifact integrity and archive-structure gate before Docker starts. The
container receives the verified archive and hashed compatibility inputs read-only, but not the
package token, RPC configuration, or workspace. It uses the exact RC.6 source lockfile only for the
compiler and declaration dependencies, runs no lifecycle or SDK runtime code, and retains the
source-build and vulnerable-dependency blockers.

With Docker available, run the stronger source comparison:

```bash
pnpm --silent privacy-sdk:verify-source-build
```

That command authenticates and validates the published artifact first, then rebuilds the exact
source commit in a pinned, resource-bounded container. It emits success only when the rebuilt and
published archives are byte-identical. The package token and host workspace are never mounted into
the container. A match still does not approve installation while `starknet-devnet` remains an
unresolved production dependency.

Before operating an authorized testnet stack, verify that the upstream privacy-service release tags
still resolve to the reviewed OCI indexes:

```bash
pnpm --silent privacy-services:verify-images
```

This reads the reviewed image manifests and their publisher-attached BuildKit source declarations;
it does not pull or run the prover. Matching declarations are not authenticated provenance or a
reproducible build. The shared Integration Sepolia observer establishes a usable public research
surface, but it does not identify the remote images or approve funded use. An operator-owned profile
or explicit approval and provenance for the shared profile is still required for the funded spike.
See the [testnet privacy services guide](docs/operations/testnet-privacy-services.md).

Once that read-only profile names operator-owned services, the combined command above is the normal
gate. To probe only their public compatibility surface for diagnosis, run:

```bash
pnpm --silent testnet:verify-services
```

This sends only the fixed prover API-version request, discovery health request, and proof-interceptor
health request, then confirms the reported discovery block against every configured Sepolia RPC. It
submits no transaction and sends no Cashu, note, address, or transaction payload. Its sanitized
result proves neither a service's runtime version nor the interceptor's screening configuration or
activity. Those remain explicit blockers until an authorized deployment test verifies them.

## Documentation

- [Product scope](docs/product-scope.md)
- [Architecture](docs/architecture.md)
- [Development guide](docs/development.md)
- [Roadmap](docs/roadmap.md)
- [Draft `strk20` payment method](docs/specs/strk20-payment-method.md)
- [Settlement state machines](docs/specs/state-machines.md)
- [Testnet deployment manifest](docs/specs/testnet-deployment-manifest.md)
- [CDK compatibility](docs/compatibility/cdk-0.17.6.md)
- [Privacy SDK compatibility](docs/compatibility/privacy-sdk-0.14.3-rc.6.md)
- [Testnet privacy services](docs/operations/testnet-privacy-services.md)
- [Threat model](docs/security/threat-model.md)

See [Contributing](CONTRIBUTING.md) before submitting a change. Security reports should follow the
[security policy](SECURITY.md).

## License

Licensed under either the [MIT License](LICENSE-MIT) or the
[Apache License 2.0](LICENSE-APACHE), at your option.
