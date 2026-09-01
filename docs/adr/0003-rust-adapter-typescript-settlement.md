# ADR 0003: Rust Adapter and TypeScript Settlement Service

- Status: Accepted
- Date: 2026-09-01

## Context

CDK's `MintPayment` interface and reference payment-processor server are Rust. The Starknet Privacy
SDK is TypeScript, requires Node 24, is distributed through GitHub Packages, and is moving through
release candidates. Implementing STRK20 cryptography again in Rust is not justified.

A direct TypeScript reimplementation of CDK's gRPC protocol would reduce one process but would also
vendor an evolving Rust-owned wire contract and make upstream integration harder.

## Decision

Keep CDK protocol behavior in a thin Rust `cdk-starknet` adapter. Put note discovery, private transfer
construction, signer use, and finality observation in a TypeScript settlement service behind a small
typed internal port.

Defer the internal transport choice until the spike identifies the minimum calls and recovery data.
The domain interface is specified before HTTP, gRPC, or a Unix socket is selected.

## Consequences

- Each upstream stack is used in its native language.
- CDK state mapping can be upstream-friendly and compile against stable crates.
- The Privacy SDK can be upgraded without contaminating mint protocol code.
- An additional process and authenticated boundary require health checks, backpressure, and durable
  reconciliation.
- Cross-language amount and state fixtures are mandatory.
