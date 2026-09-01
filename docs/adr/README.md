# Architecture Decision Records

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-two-layer-private-payments.md) | Use Cashu circulation over STRK20 settlement | Accepted |
| [0002](0002-usdc-first.md) | Start with USDC integer cents | Accepted |
| [0003](0003-rust-adapter-typescript-settlement.md) | Split CDK semantics from Privacy SDK integration | Accepted |
| [0004](0004-defer-cairo-contracts.md) | Do not add a Cairo anonymizer for mint/redeem | Accepted |
| [0005](0005-pin-stable-cdk-and-privacy-rc.md) | Pin stable CDK and isolate the Privacy SDK RC | Accepted |
| [0006](0006-conservative-async-settlement.md) | Use durable intents and conservative async states | Accepted |
| [0007](0007-dual-open-source-license.md) | Use MIT or Apache-2.0 for project-owned code | Accepted |

An accepted ADR describes the current direction, not an immutable choice. Supersede a decision with
a new ADR; do not rewrite the history after implementation depends on it.
