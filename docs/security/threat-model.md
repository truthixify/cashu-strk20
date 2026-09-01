# Threat Model

Status: foundation baseline. Update whenever a trust boundary, key, external service, or state
transition changes.

## Scope

The model covers a CDK mint using custom method `strk20`, its Rust payment adapter, the TypeScript
settlement service, Starknet RPC/proving/discovery dependencies, and a reference wallet. It focuses
on reserve funding and redemption. Standard Cashu cryptography and STRK20 internals are upstream
dependencies, not re-audited here.

## Assets

- STRK20 reserve notes and USDC backing.
- Cashu mint signing keys and outstanding bearer liabilities.
- Settlement signer and viewing keys.
- Spendable Cashu proofs held by users or the mint.
- Quote secrets, payment request IDs, and NUT-20 keys.
- Payout intents and pending-proof recovery state.
- Decrypted private note and recipient metadata.
- Operator, database, RPC, prover, indexer, and package-registry credentials.
- Accuracy of custody, privacy, reserve, and settlement claims.

## Actors

- Honest wallet user.
- Malicious wallet or API client.
- Merchant accepting Cashu.
- Mint and settlement operator.
- Compromised operator or insider.
- RPC, indexer, or prover provider.
- Dependency or build-system attacker.
- Network observer.
- Starknet reorg or availability event.
- Cashu or STRK20 protocol adversary.

## Trust boundaries

```text
untrusted wallet
      |
      v
public Cashu API ---- CDK mint ---- Rust adapter
                                      |
                              authenticated internal boundary
                                      |
                                      v
                              settlement service
                               /      |       \
                         signer    database   RPC/indexer/prover
                                                   |
                                                   v
                                                Starknet
```

Wallet fields, transaction hashes, callbacks, RPC responses, indexer results, package downloads,
and operator input are untrusted until validated for their specific purpose.

## Security objectives

1. Mint no Cashu without an exact, canonical, single-use STRK20 payment.
2. Pay at most once for each accepted Cashu melt quote.
3. Do not destroy or release pending proofs while payout execution is ambiguous.
4. Preserve exact integer value across Cashu and ERC-20 units.
5. Keep bearer proofs, signers, viewing keys, and private-note data confidential.
6. Make finality, custody, offline, and solvency limits truthful.
7. Recover deterministically after crashes, timeouts, reorgs, and dependency outages.

## Threat inventory

| Threat | Severity | Required controls | Residual risk / required evidence |
|---|---|---|---|
| Quote theft after another user funds it | Critical | NUT-20 quote lock; secret quote ID; single-use issuance accounting | Test attempted mint with wrong NUT-20 key |
| Wallet claims another deposit | Critical | Quote-specific attribution; independently discovered evidence; unique evidence constraint | Test two quotes racing for one payment |
| Mint issues on a forged transaction hash | Critical | Hash is hint only; verify canonical note, token, amount, destination, network | Test forged, unrelated, and wrong-chain hashes |
| Reorg after observation | Critical | Separate observed/final states; persist block identity; canonicality recheck | Test reorg before issuance and incident path after issuance |
| Duplicate payout after timeout | Critical | Durable intent before submit; unique quote key; poll existing lineage; unknown state | Crash and timeout after successful submission |
| Payout to attacker-chosen recipient | Critical | Parse signed/encoded payout request; bind quote; immutable intent destination | Mutation tests across quote and execution calls |
| Wrong token or decimal conversion | Critical | Address allowlist; checked integer conversion; no floats; exact reverse conversion | Cross-language amount and overflow vectors |
| Pending proofs released while tx may execute | Critical | `UNKNOWN` is non-final; fail only on proven non-execution; CDK saga tests | Provider disagreement and long outage tests |
| Mint reserve theft | Critical | Key isolation, capped testnet funds, later multisig/policy, monitoring | Custodial risk remains by design |
| Mint signs liabilities beyond reserves | Critical | Issuance accounting, reserve alarms, later liability commitments | Reserve balance alone cannot prevent dishonest issuance |
| Cashu proof leakage in logs or telemetry | Critical | Structured allowlist logging; redaction; no body dumps; access controls | Redaction tests and log review |
| Settlement signer or viewing-key theft | Critical | Secret manager/HSM path, least privilege, process isolation, rotation plan | Initial local test setup remains weaker |
| Malicious or compromised Privacy SDK package | High | Exact tag/commit, GitHub registry auth hygiene, lockfile, source review, CI checks | Release-candidate dependency remains material risk |
| CDK protocol drift | High | Stable exact version, compatibility fixtures, changelog review | Custom method API may change in 0.18 |
| RPC or indexer lies about payment | High | Canonical RPC verification; optionally independent providers; block identity | Provider concentration until multi-source validation |
| Prover returns invalid or privacy-leaking output | High | Verify chain acceptance; authenticated endpoint; minimize inputs; vendor review | Prover observes timing and request metadata |
| Payment request replay | High | 128-bit random single-use ID, expiry, durable uniqueness | Denial-of-service through repeated invalid payments |
| Signed-payer challenge replay | High | Server challenge, typed domain, nonce, expiry, one-time use | Profile not accepted until wallet interoperability tests |
| Late payment strands user value | High | Explicit late state, operator refund policy, visible expiry UX | Refund may create metadata or custody risk |
| Offline double spend against merchant | High | Online spentness check by default; limits and delayed-finality label | Generic offline acceptance cannot eliminate risk |
| Network metadata links Cashu activity | High | TLS, proxy strategy where appropriate, minimal logs, denomination policy | Timing and amount correlation remain possible |
| STRK20 viewing key presented as full traceability | High | Scope disclosure to funding/redemption edges | Offchain Cashu hops remain outside the key's view |
| Reserve dashboard overstates solvency | High | Show reserves and liabilities as separate evidence; qualified wording | Liability commitment may still be incomplete or dishonest |
| Database rollback or split brain | High | Transactional constraints, append-only transition journal, single writer/consensus | Storage architecture not yet implemented |
| Event loss between settlement and CDK | High | Transactional outbox, replay cursor, idempotent consumer | Delay remains during outage |
| Denial of service through quote creation | Medium | Rate limits, amount bounds, expiry, optional auth at admission | Privacy-preserving abuse control is a product tradeoff |
| Dependency install leaks registry token | High | Environment token only; scoped read token; no debug auth logs | Developer machine compromise remains |
| Operator forces paid state | Critical | No force-paid path; auditable actions; separation of duties later | A fully compromised operator can still steal reserve |

## Privacy analysis

### What STRK20 protects

STRK20 is intended to protect private deposit, transfer, and withdrawal data on Starknet while
supporting scoped viewing. Exact guarantees depend on the pinned pool, prover, discovery, wallet,
and SDK versions.

### What blind Cashu issuance protects

The mint does not learn the blinded outputs it signs, so it cannot cryptographically map a funding
quote directly to the later proofs derived from those outputs. The mint still sees online swaps and
redemptions and may correlate IP address, timing, amount, denomination, wallet behavior, or unique
error patterns.

### What neither layer automatically protects

- Network identity and application telemetry.
- A compromised wallet or endpoint.
- Timing and amount correlation at system edges.
- Mint censorship or reserve theft.
- Recipient disclosure during Cashu melt-out to the mint operator.
- Offchain Cashu hops under a STRK20 viewing key.
- User mistakes when copying or displaying payment data.

## Key separation

At minimum, use distinct credentials for:

- Cashu mint signing;
- STRK20 payout signing;
- STRK20 viewing/discovery;
- database access;
- RPC, prover, and indexer access;
- package registry access;
- operator administration.

The public Cashu process must not directly read the settlement signer or viewing key. The settlement
service must not receive user bearer proofs. Development keys must be test-only and capped.

## Supply-chain controls

- Pin GitHub Actions by full commit SHA.
- Pin CDK stable versions and Privacy SDK release tags/commits exactly.
- Commit lockfiles for implementation dependencies.
- Review install scripts, build scripts, generated code, and transitive native dependencies.
- Use a read-only, scope-limited GitHub Packages token.
- Run dependency audits, but do not treat an audit command as proof of safety.
- Record upstream source and license for vendored protocol files.

## Required abuse tests

Before a public demo, automate at least:

- wrong unit, token, network, amount, recipient, and pool;
- zero, fractional, negative, maximum, and overflowing amounts;
- stolen quote ID and wrong NUT-20 signature;
- duplicate payment evidence and quote replay;
- payment immediately before and after expiry;
- timeout before submit, during submit, and after successful submit;
- restart after every durable state write;
- reorged incoming and outgoing transactions;
- RPC/indexer disagreement;
- duplicate event delivery;
- log redaction on all failures;
- unavailable prover, RPC, database, and event consumer.

## Review triggers

Re-run this threat model when adding an asset, network, wallet transport, offline mode, bridge, swap,
screening service, reserve contract, operator API, new signer, hosted deployment, or real-value pilot.
