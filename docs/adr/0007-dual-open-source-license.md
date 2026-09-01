# ADR 0007: Dual Open-Source License

- Status: Accepted
- Date: 2026-09-01

## Context

The main deliverable is reusable infrastructure for Rust, TypeScript, Cashu, and Starknet projects.
Permissive licensing improves integration compatibility. Rust ecosystem projects commonly offer MIT
or Apache-2.0, with Apache-2.0 adding an explicit patent grant.

Third-party research sources, upstream code, generated protocol files, and vendored artifacts may
have different licenses and must preserve their notices.

## Decision

Offer project-owned code and tracked documentation under `MIT OR Apache-2.0`. Keep both license
texts at the repository root. Review this choice with the project owner before the first external
release or package publication.

## Consequences

- Downstream users can choose either permissive license.
- Contributions are expected under the same terms unless stated otherwise.
- Third-party material needs explicit provenance and cannot be assumed covered by this decision.
