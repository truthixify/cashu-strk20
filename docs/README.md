# Documentation Map

Start with these documents:

1. [Product scope](product-scope.md) explains the user problem, intended use cases, and non-goals.
2. [Roadmap](roadmap.md) orders work by risk and defines delivery gates.
3. [Architecture](architecture.md) defines component ownership and trust boundaries.
4. [STRK20 Cashu method](specs/strk20-payment-method.md) is the draft wire and behavior spec.
5. [State machines](specs/state-machines.md) defines conservative quote and settlement transitions.
6. [Testnet deployment manifest](specs/testnet-deployment-manifest.md) defines canonical public
   deployment claims, UDC-origin verification, and remaining approval limits.
7. [Threat model](security/threat-model.md) inventories assets, actors, attacks, and controls.
8. [Custody and privacy](operations/custody-and-privacy.md) is the disclosure baseline.
9. [Testnet privacy services](operations/testnet-privacy-services.md) records the shared Integration
   Sepolia observer, operator-owned deployment prerequisites, immutable service image pins, and
   read-only compatibility probe.
10. [CDK compatibility](compatibility/cdk-0.17.6.md) records the exact stable custom payment surface
   and transport constraints.
11. [Privacy SDK compatibility](compatibility/privacy-sdk-0.14.3-rc.6.md) records the exact upstream
   surface, gaps, and integration gates.
12. [Development](development.md) covers local tooling and verification.
13. [Grant evidence](grants/seed-grant-evidence.md) lists proof required before an application.

Architecture decisions live under [`adr/`](adr/).

## Document status

| Document class | Meaning |
|---|---|
| Draft spec | Proposed behavior; not an interoperability promise |
| Accepted ADR | Current engineering decision until explicitly superseded |
| Operations guide | Required disclosure or runbook baseline |
| Research | Local evidence and planning, not release material |
