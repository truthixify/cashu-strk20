# Cashu x STRK20

Working name: **CairoCash**.

This repository is building a reusable Cashu payment processor that accepts private STRK20 USDC
for mint funding and settles Cashu redemptions back to STRK20. Cashu is the fast bearer-payment
layer; STRK20 is the private reserve and settlement layer.

The project is in foundation and testnet-spike status. It is not a production mint, has not been
audited, and must not hold real user funds.

## Why this exists

This is not a second implementation of STRK20 transfers. It adds payment modes that an onchain
private transfer does not provide by itself:

- instant Cashu payment requests for point of sale, links, NFC, and machine payments;
- low-connectivity handoff with explicit acceptance risk;
- accountless bearer value between a mint-in and a later private redemption;
- aggregation of many small payments into fewer STRK20 settlement transactions;
- an open CDK integration surface that other Cashu mints can reuse.

## Trust model

The two privacy systems cover different edges.

- STRK20 hides the Starknet deposit and redemption details according to its protocol and viewing-key
  model.
- Blind Cashu issuance prevents the mint from cryptographically linking issued outputs to later
  proofs, subject to network, timing, amount, denomination, and operational metadata.
- The Cashu mint is custodial while value is in cash mode. It can censor, freeze, lose, or steal the
  reserve.
- A STRK20 viewing key does not reveal offchain Cashu hops.
- A visible reserve balance is not proof that Cashu liabilities are fully backed.
- Offline Cashu receipt is provisional unless the receiver accepts double-spend risk or uses a
  purpose-built risk protocol.

Read [the custody and privacy disclosure](docs/operations/custody-and-privacy.md) before describing
the product externally.

## Architecture

```text
Cashu wallet / merchant POS
          |
          | NUT-04, NUT-05, NUT-18, NUT-20
          v
       CDK mint
          |
          | MintPayment
          v
  cdk-starknet adapter  <---->  settlement service
                                   |
                                   | Starknet Privacy SDK
                                   v
                     STRK20 pool, prover, and discovery
```

The Rust adapter owns CDK protocol semantics. The TypeScript settlement service owns the rapidly
changing STRK20 SDK integration. A Cairo reserve registry is intentionally deferred; minting and
redemption do not require a new anonymizer contract.

See [architecture](docs/architecture.md), the draft
[`strk20` Cashu method](docs/specs/strk20-payment-method.md), and the
[state machines](docs/specs/state-machines.md).

## Repository layout

```text
crates/cdk-starknet/          CDK-facing Rust payment processor boundary
packages/strk20-method/      Shared method constants, types, and amount rules
services/settlement/         STRK20 settlement domain boundary
contracts/reserve-registry/  Deferred reserve-evidence contract scope
docs/                        Product, protocol, security, and architecture docs
research/                    Protected local planning and source material
```

## Current target

The first risk-retirement milestone is one reproducible Starknet testnet flow:

1. Request a Cashu `strk20` mint quote denominated in `usdc`.
2. Fund it with a real private STRK20 USDC transfer.
3. Prove the exact incoming payment belongs to that quote.
4. Mint Cashu after conservative finality.
5. Melt the Cashu and settle once to a private STRK20 recipient.
6. Recover correctly across timeout, retry, reorg, and ambiguous-result cases.

Wallet polish, offline claims, reserve contracts, strkBTC, bridges, and mainnet custody are later
workstreams. See the [public roadmap](docs/roadmap.md) for the phased delivery gates.

## Toolchain baseline

| Component | Baseline | Rationale |
|---|---:|---|
| Node.js | 24.13.0 | Privacy SDK requires Node 24 or newer |
| pnpm | 10.28.2 | Deterministic JavaScript workspace installs |
| TypeScript | 5.9.3 | Matches the Privacy SDK release line |
| Rust | 1.93.1 | Pinned build, formatting, and lint toolchain |
| CDK | 0.17.6 | Latest stable line selected for the first adapter |
| Starknet Privacy SDK | 0.14.3-rc.6 | Experimental integration target, pinned before use |

CDK `0.18.0-rc.2` exists, but the first spike stays on stable `0.17.6` unless a required API is only
available in the release candidate. The Privacy SDK is distributed through GitHub Packages; its
dependency is deliberately not installed until the settlement spike and must be pinned exactly.

## Development

Prerequisites: Node 24, pnpm 10, and Rust 1.93.1.

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

Copy the names from `.env.example` into a local `.env` only when testnet integration starts. Never
put a funded signer, viewing key, prover credential, or registry token in source or fixtures.

More detail is in [development](docs/development.md) and [contributing](CONTRIBUTING.md).

## Status and safety

- Testnet only.
- No real-value mint.
- No external security review yet.
- No claim of full offline finality.
- No claim that onchain reserves prove Cashu liabilities.
- No grant application until the end-to-end settlement risk is demonstrated.

Security assumptions and required tests live in [the threat model](docs/security/threat-model.md).

## License

Unless noted otherwise, code and tracked documentation are available under either the MIT License
or the Apache License 2.0, at your option. Research sources retain their original licenses and are
not part of a release artifact.
