# ADR 0005: Pin Stable CDK and Isolate the Privacy SDK RC

- Status: Accepted
- Date: 2026-09-01

## Context

CDK `0.17.6` is the current stable target with custom payment JSON, quote correlation, and async
payment events. CDK `0.18.0-rc.2` is available but not stable. The Starknet Privacy SDK's current
integration target is `0.14.3-rc.6` and requires Node 24 plus GitHub Packages authentication.
The RC.6 release notes publish a screening-v3 privacy-pool class hash that supersedes the older RC.0
class still shown in the tag's compatibility table. Neither source publishes a reusable Sepolia
deployment address.

Both APIs can change quickly. Silent upgrades could alter quote schemas, status mapping, discovery,
or transaction construction.

## Decision

Target CDK `0.17.6` exactly for the first adapter. Pin the Privacy SDK to the exact approved release
tag or commit when network work starts and isolate it inside the settlement service. Do not add the
private-registry dependency to the foundation lockfile before a developer has authorized package
access and reviewed its source.

Pin testnet preflight to RC.6 pool class
`0x7e2bbd7ccc1e68b2695caef70aeb2a3be6cd017b5d5159278ba08f2d8de33f`. Treat the pool address,
token deployment, services, and account class as unresolved until a deployment owner publishes a
versioned profile. Before installation, authenticate with a read-only package token and verify the
published tarball's registry integrity, declared source commit, embedded manifest, exports,
dependency set, and archive structure without running its code. Do not treat publisher-declared
`gitHead` as a reproducible source-build match.

Type-check the authenticated artifact's declarations against the local SDK ports in a separate
bounded container after the archive gate passes. Mount only owned compatibility inputs read-only,
forward no package credential or project RPC configuration, disable lifecycle scripts, and do not
treat declaration assignability as SDK runtime evidence.

A later official-repository demo preview may be pinned as a mutable, non-authoritative read-only
observation target. Matching its live pool, token, and public service surfaces does not resolve the
owner-profile requirement or authorize a funded transaction.

For that read-only target, verify the original UDC deployment and the ordered standard
`replace_to` history through the selected discovery head. Treat this as on-chain origin evidence,
not as owner authorization, source authentication for historical classes, or proof that a custom
implementation could never replace its class without emitting the standard event.

Verify a source-build match separately. Fetch and validate the authenticated package before starting
the build, rebuild the exact commit with a digest-pinned Node `24.0.2` image on Linux/AMD64, disable
install lifecycle scripts, mount no host workspace or package credential, and require exact archive
byte equality. Keep installation unapproved while the production dependency gate remains open.

Move to CDK `0.18` only after a stable release or a documented requirement that cannot be met on
`0.17.6`.

The source review and exact-crate conformance test are recorded in the
[CDK compatibility report](../compatibility/cdk-0.17.6.md). They confirm the required in-process
custom field and quote-correlation surface. Running-mint conformance remains a separate gate, and
the stock `0.17.6` custom HTTP and gRPC transports require the method-binding controls described in
that report.

## Consequences

- Foundation checks remain installable without a GitHub token.
- The spike has a reproducible compatibility baseline.
- The exact published CDK boundary is compile-tested without adding CDK to the production crate.
- The first adapter remains in process until custom method binding is preserved across a remote
  transport.
- A stale RC.0 pool class cannot be mislabeled as the RC.6 screening-v3 deployment.
- Artifact provenance can be checked without adding registry credentials or the SDK to the workspace.
- Source output can be compared without exposing the package token to upstream build code.
- Artifact verification does not waive dependency audit or live deployment evidence gates.
- New upstream fixes are not adopted automatically.
- Upgrade work needs changelog review and conformance tests.
