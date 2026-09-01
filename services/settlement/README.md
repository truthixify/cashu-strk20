# Settlement Service

This package defines the domain boundary around the Starknet Privacy SDK. The SDK itself is not yet
installed: network integration starts only in the settlement spike, with exact release and contract
pins plus authorized GitHub Packages access.

The reviewed SDK source target is tag
[`PRIVACY-0.14.3-RC.6`](https://github.com/starkware-libs/starknet-privacy/tree/PRIVACY-0.14.3-RC.6)
at commit
[`4db755b9512f00b540126737b605472ea2275e15`](https://github.com/starkware-libs/starknet-privacy/commit/4db755b9512f00b540126737b605472ea2275e15).
This package does not install or import that release yet; the source pin records the adapter target
while keeping credentialed package access separate.

The service will own private note discovery, payout submission, finality, and reconciliation. It
must not receive Cashu bearer proofs.

`PayoutCoordinator` implements the deterministic payout boundary. It records one intent per Cashu
melt quote, records an opaque prepared-submission ID before broadcast, and reconciles that same
submission after retry or restart. Gateway timeouts after the submission boundary become `UNKNOWN`;
only an explicit gateway `FAILED` result may prove non-execution.

The coordinator requires explicit minimum and maximum Cashu amounts and currently accepts only
`SN_SEPOLIA`. A gateway must make repeated submission of one prepared ID idempotent and may report
`PAID` only after the configured canonical-finality policy is satisfied.

`InMemorySettlementIntentStore` exists only for deterministic tests and local spikes. It is not
durable and must not be used for a funded or multi-process service. A production store must provide
the same atomic uniqueness and transition behavior with transactional persistence.
