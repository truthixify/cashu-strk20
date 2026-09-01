# ADR 0004: Defer Cairo Contracts

- Status: Accepted
- Date: 2026-09-01

## Context

STRK20 already supplies private transfer contracts. A Cashu mint can receive and send through those
contracts using the official SDK. Adding a custom anonymizer or mixer to the minting path would
expand the audit surface and distract from quote attribution and payout recovery.

A future reserve registry or commitment anchor may improve transparency, but it cannot prove Cashu
liabilities by inspecting an address balance.

## Decision

Do not create a Cairo contract for mint-in or melt-out. Keep `contracts/reserve-registry` as a design
placeholder until the core settlement path is reliable and the liability statement is defined.

## Consequences

- The first spike has no custom onchain security surface.
- Grant evidence focuses on useful integration rather than novel cryptography.
- Reserve commitments are delayed.
- If later contract work begins, it requires a separate specification, threat-model update, tests,
  and audit plan.
