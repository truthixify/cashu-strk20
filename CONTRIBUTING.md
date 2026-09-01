# Contributing

This project is pre-audit payment infrastructure. Small, reviewable changes with explicit failure
behavior are more useful than broad feature branches.

## Before changing code

1. Read the public architecture, method spec, threat model, roadmap, and applicable ADRs.
2. If you have the maintainer's protected local context, also read `AGENTS.md`,
   `research/PROJECT_GUIDE.md`, and the current task brief.
3. Confirm the work belongs to the current roadmap workstream.
4. Open a design issue before changing amount semantics, quote attribution, finality, recovery,
   privacy claims, custody boundaries, or a public wire model.

Protected local research files are not contribution artifacts. Do not stage them.

## Local checks

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

Changes that touch Starknet integration also need the applicable testnet suite. Never substitute a
mocked receipt for testnet evidence while describing a flow as end to end.

## Pull requests

A pull request should explain:

- the user or protocol behavior that changed;
- security and privacy implications;
- failure and retry behavior;
- tests and exact commands run;
- dependency or schema changes;
- testnet evidence, if applicable;
- known limitations.

Keep generated output, private transaction data, bearer proofs, secrets, local research, and
unrelated cleanup out of the change.

## Compatibility

Protocol changes need fixtures covering old and new behavior. Dependency upgrades need upstream
release notes, a compatibility statement, and focused regression tests. Release candidates are not
adopted automatically.

## Reporting security issues

Follow `SECURITY.md`. Do not disclose a custody, double-spend, payout-duplication, proof-handling, or
privacy issue in a public issue before maintainers have a chance to respond.
