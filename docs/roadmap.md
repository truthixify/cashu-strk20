# Roadmap

Work is ordered by risk. Each stage has an exit gate; later product surfaces do not begin merely
because they are easier to demonstrate.

## Foundation

Establish the monorepo, architecture, protocol draft, state machines, threat model, custody
disclosure, exact amount rules, CI, and contributor discipline.

Gate: a clean install, all deterministic checks passing, and an independently reviewable first task
brief.

## Testnet settlement validation

Use one pinned STRK20 USDC testnet profile to answer the two hard questions:

- Can a private payment be attributed to one opaque Cashu funding request without trusting a client
  transaction hash or exposing the Cashu quote ID?
- Can a private payout survive timeout, retry, restart, and reorg without paying twice or releasing
  pending proofs early?

Gate: reproducible mint-in observation and payout evidence, recovery tests, and a revised method
draft selecting an attribution and finality policy.

## Reusable CDK processor

Implement CDK's `MintPayment` interface, custom NUT-04 and NUT-05 behavior, NUT-20 quote protection,
durable intent and evidence storage, reconciliation, replayable events, health, metrics, and
redaction.

Gate: end-to-end CDK testnet mint-in and melt-out with crash injection and no duplicate issuance or
payout.

## Wallet and merchant reference flow

Build the focused PWA for cash-mode funding, NUT-18 checkout, send/receive, and private redemption.
Validate `usdc` proof handling with an independent Cashu implementation. Treat low-connectivity
receipt as provisional unless online spentness is established.

Gate: a new user can complete the flagship flow without manual state edits and sees custody,
privacy, and offline limits at the relevant decisions.

## Reserve and liability evidence

Publish reserve snapshots and a separately scoped liability commitment. Add a minimal Cairo
registry only if it materially improves integrity and has its own specification, tests, threat
model, governance, and review plan.

Gate: users can verify what each evidence source proves, and no surface equates reserve balance with
full solvency.

## Capped pilot readiness

Complete independent security review, key isolation, backup/restore and incident drills, legal
scoping, liability limits, monitoring, and operator governance.

Gate: no unresolved critical or high finding, recovery drills pass, and stakeholders approve a
tightly limited scope. This gate does not imply general mainnet readiness.

## Later work

strkBTC, HTTP 402, hardware/NFC transports, bridge funding, private DeFi redemption, federation, and
stronger liability proofs remain optional extensions after the core USDC path is reliable.
