# ADR 0006: Conservative Asynchronous Settlement

- Status: Accepted
- Date: 2026-09-01

## Context

A private payout crosses a database, signer, prover, RPC, sequencer, and finality boundary. Any call
can succeed while its response is lost. Retrying by constructing a fresh transfer can pay twice.
Conversely, declaring failure too early can release Cashu proofs while the original payout later
lands.

## Decision

Create a durable settlement intent keyed uniquely by the CDK melt quote ID before external
submission. Treat timeouts and unavailable providers as pending or unknown. Mark paid only after
canonical finality. Mark failed only when non-execution is proven and CDK recovery is safe.

Persist state before emitting events and deliver events through a replayable outbox or equivalent.

## Consequences

- Payout completion is asynchronous by default.
- Users may see pending states for longer than a simple RPC receipt suggests.
- Durable storage and reconciliation are required before a meaningful end-to-end demo.
- Crash and ambiguity injection are first-class tests.
- Operational tools cannot include an unaudited force-paid shortcut.
