# Settlement Service

This package defines the domain boundary around the Starknet Privacy SDK. The SDK itself is not yet
installed: network integration starts only in the settlement spike, with exact release and contract
pins plus authorized GitHub Packages access.

The service will own private note discovery, payout submission, finality, and reconciliation. It
must not receive Cashu bearer proofs.
