# cdk-starknet

Rust boundary for CDK custom payment method `strk20` and unit `usdc`.

The foundation crate contains only security-critical constants, exact amount conversion, and state
rules. The `MintPayment` implementation and CDK `0.17.6` dependency enter scope after the STRK20
settlement spike proves quote attribution and payout recovery.
