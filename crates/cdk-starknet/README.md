# cdk-starknet

Rust boundary for CDK custom payment method `strk20` and unit `usdc`.

The production crate contains only security-critical constants, exact amount conversion, and state
rules. Its test target pins `cdk-common` `0.17.6` to verify the public custom-method wire and payment
option surface. The `MintPayment` implementation and production CDK dependency remain outside this
foundation boundary until the running-adapter workstream.

Run the exact compatibility contract with:

```bash
cargo test -p cdk-starknet --test cdk_0_17_6_compatibility
```

See the [compatibility record](../../docs/compatibility/cdk-0.17.6.md) and its published
[wire vector](../../docs/specs/vectors/cdk-0.17.6-strk20.json).
