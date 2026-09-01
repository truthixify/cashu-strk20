# Documentation Map

Start with these documents:

1. [Product scope](product-scope.md) explains the user problem, intended use cases, and non-goals.
2. [Roadmap](roadmap.md) orders work by risk and defines delivery gates.
3. [Architecture](architecture.md) defines component ownership and trust boundaries.
4. [STRK20 Cashu method](specs/strk20-payment-method.md) is the draft wire and behavior spec.
5. [State machines](specs/state-machines.md) defines conservative quote and settlement transitions.
6. [Threat model](security/threat-model.md) inventories assets, actors, attacks, and controls.
7. [Custody and privacy](operations/custody-and-privacy.md) is the disclosure baseline.
8. [Development](development.md) covers local tooling and verification.
9. [Grant evidence](grants/seed-grant-evidence.md) lists proof required before an application.

Architecture decisions live under [`adr/`](adr/). Exploratory research and the current roadmap are
protected local files under `research/`; they are intentionally separate from publishable product
documentation.

## Document status

| Document class | Meaning |
|---|---|
| Draft spec | Proposed behavior; not an interoperability promise |
| Accepted ADR | Current engineering decision until explicitly superseded |
| Operations guide | Required disclosure or runbook baseline |
| Research | Local evidence and planning, not release material |
