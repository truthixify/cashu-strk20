# Development

## Prerequisites

- macOS or Linux
- Node.js `24.13.0`
- pnpm `10.28.2`
- Rust `1.93.1` with `rustfmt` and `clippy`

The repository pins Node and Rust. The current Cairo placeholder has no build target. When reserve
contract work starts, align Scarb and Starknet Foundry with the pinned Privacy SDK release instead
of using an older global installation.

## Install

```bash
pnpm install --frozen-lockfile
```

The STRK20 Privacy SDK is not installed during foundation work. It is published to GitHub Packages.
When the settlement spike begins, provide a read-only GitHub Packages token through
`NODE_AUTH_TOKEN` in the shell and add the exact approved release to the settlement package. Never
write the token to the repository's `.npmrc`.

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

### Component

The adapter and settlement service run against scripted fakes that can return success, timeout,
ambiguous success, reorg, wrong token, wrong recipient, and permanent failure.

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

No funded key or private note data may enter the evidence bundle.

## Environment

`.env.example` lists required variable names. Keep real values in a local `.env` or secret manager.
The service must fail closed when a network, pool, token, signer, or finality configuration is
missing or inconsistent.

Use test-only accounts with minimal funds. Mainnet endpoints and writes are forbidden during the
initial workstreams.

## Logging

Structured logs may include an opaque internal intent ID, state name, network, token identifier,
and coarse timing. They must not include:

- Cashu proofs or blinded messages;
- Cashu quote IDs in public telemetry;
- signer or viewing keys;
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
