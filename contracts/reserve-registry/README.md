# Reserve Registry Placeholder

No Cairo contract is implemented in the minting or redemption path.

This directory reserves a future workstream for anchoring reserve configuration or signed liability
commitments after the core settlement adapter is reliable. Before adding a Scarb package, require:

- a public statement that the contract can actually support;
- an ADR showing why an onchain component adds integrity;
- a separate protocol specification and threat model;
- exact Scarb, Cairo, OpenZeppelin, and Starknet Foundry pins;
- unit, integration, property, and upgrade/governance tests;
- an external review plan.

A reserve balance alone must never be labeled proof of Cashu liabilities or solvency.
