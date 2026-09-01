# ADR 0005: Pin Stable CDK and Isolate the Privacy SDK RC

- Status: Accepted
- Date: 2026-09-01

## Context

CDK `0.17.6` is the current stable target with custom payment JSON, quote correlation, and async
payment events. CDK `0.18.0-rc.2` is available but not stable. The Starknet Privacy SDK's current
integration target is `0.14.3-rc.6` and requires Node 24 plus GitHub Packages authentication.

Both APIs can change quickly. Silent upgrades could alter quote schemas, status mapping, discovery,
or transaction construction.

## Decision

Target CDK `0.17.6` exactly for the first adapter. Pin the Privacy SDK to the exact approved release
tag or commit when network work starts and isolate it inside the settlement service. Do not add the
private-registry dependency to the foundation lockfile before a developer has authorized package
access and reviewed its source.

Move to CDK `0.18` only after a stable release or a documented requirement that cannot be met on
`0.17.6`.

## Consequences

- Foundation checks remain installable without a GitHub token.
- The spike has a reproducible compatibility baseline.
- New upstream fixes are not adopted automatically.
- Upgrade work needs changelog review and conformance tests.
