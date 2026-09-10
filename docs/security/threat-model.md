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
- Screening partner credentials and fail-closed policy configuration.
- Wallet-side STRK20 channel keys and next-note nonce state.
- Spendable Cashu proofs held by users or the mint.
- Quote secrets, payment request IDs, and NUT-20 keys.
- Payout intents and pending-proof recovery state.
- Original payout inclusions, post-terminal canonicality incidents, affected-profile pauses,
  finality-watch leases, and the incident alert outbox.
- Encrypted signed-payout artifacts and their encryption keys.
- Sanitized testnet deployment, read-only verification, and run evidence intended for public release.
- Sanitized authenticated-package integrity, declaration-port compatibility, and independent
  source-build evidence intended for public release.
- Sanitized privacy-service image-resolution and read-only compatibility evidence intended for
  public release.
- Decrypted private note and recipient metadata.
- Operator, database, RPC, prover, indexer, screening-provider, and package-registry credentials.
- Accuracy of custody, privacy, reserve, and settlement claims.

## Actors

- Honest wallet user.
- Malicious wallet or API client.
- Merchant accepting Cashu.
- Mint and settlement operator.
- Compromised operator or insider.
- RPC, indexer, prover, or screening provider.
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

CDK custom-method routing and flattened JSON are part of the public API trust boundary. The custom
melt body method must equal the route method and the configured adapter method before value handling.
Processor response metadata must be an allowlisted object disjoint from standard NUT fields. A
remote payment-processor transport must preserve or explicitly bind the method; an empty method is
not evidence that the caller selected `strk20`.

The next-note compatibility helper is a wallet-side boundary even though it is distributed from the
settlement package during the spike. It may inspect an RC.6 channel key and token nonce only in the
wallet process and returns only the nonce and public note ID. The channel snapshot and key must not
cross into the mint API, logs, analytics, or payer challenge. The wallet-local coordinator queues
callbacks sharing one stable SDK operation scope and can reject a changed nonce before compilation.
It does not reserve the nonce or coordinate other runtimes; wallets must keep the callback open
until the transaction lands or the shared state is authoritatively advanced.

Testnet evidence is a one-way public-release boundary. The preflight executable reads only named
environment variables into an internal, non-exported secret-bearing config. This includes the
screening partner credential only for funded preflight validation. Deployment and service verifiers
use the separate public profile and never access signer, viewing, or screening credential material.
Evidence constructors must rebuild output from an allowlist and must never spread or serialize the
environment, config, provider response, or scenario objects directly. Expected failures may identify
a variable or public provider ID, but never a value, endpoint, or upstream error. The verified-run
envelope revalidates nested records, rejects sparse arrays, binds the run to a recent verified
contract/service context with matching sanitized public configuration, checks both verified block
bounds, and reports missing or non-passing scenarios. It is not a signature, endpoint-identity or
execution attestation, or grant-readiness claim.

Published verified-run artifacts have one accepted UTF-8 JSON representation: schema property
order, two-space indentation, and one trailing newline. The offline validator reconstructs all
allowlisted fields and requires byte equality, rejecting duplicate keys, alternate number or string
encodings, whitespace variants, extra fields, and changed derived claims. This prevents consumers
from disagreeing about parsed content but provides no origin authentication, freshness beyond the
embedded checks, or evidence that the recorded actions occurred.

The testnet scenario runner crosses operator-supplied callback, accepted-block source, wall-clock,
and monotonic-clock boundaries. It reconstructs the combined verified context, rejects late or stale
checks before callbacks, requires one dense canonical scenario sequence with fixed expected states,
bounds callback metrics and disclosed transaction collections, and reduces callback exceptions or
malformed values to fixed public failure evidence. It is one-shot and sequential, and it marks all
remaining scenarios as operator-stopped after a non-pass. Its
`COMPLETED` state is not a claim that scenarios passed. It has no transaction capability and does not
cancel a stuck callback; each callback must own deadlines, durable idempotency, and authoritative
reconciliation so ambiguity cannot be mistaken for non-execution. Synthetic callbacks cannot
produce live-chain attestation even when the resulting envelope is structurally valid.

Source-build evidence crosses a separate Docker and public dependency boundary. The command validates
the authenticated package before starting Docker, passes the container no package token, signer,
viewing material, RPC configuration, host workspace, or host output directory, and accepts only a
base64 archive on stdout. The container uses a digest-pinned image, exact source commit and lockfile,
fixed Linux/AMD64 platform, disabled install lifecycle scripts, reduced privileges, bounded
resources, and a fixed build script. It still has network access to GitHub and npm, and the local
Docker daemon remains privileged infrastructure. Only exact equality with the already authenticated
archive can produce positive source-build evidence.

Source-port evidence crosses the same Docker, GitHub, and npm boundaries but makes a narrower claim.
It checks out the exact public commit, builds the SDK's declarations under its pinned configuration,
and compiles explicit assignability checks under strict consumer settings. A private temporary
directory containing only the generated port declaration and compatibility fixture is mounted
read-only and both inputs are hashed in the output; the host workspace and package credential are
not mounted. The check executes build tooling but not the SDK runtime. A pass does not authenticate
the published package, prove runtime behavior, or make the installed dependency tree acceptable.

Authenticated-artifact port evidence crosses the package registry before the Docker boundary. The
command snapshots and validates the registry metadata, archive integrity, manifest, member types,
and paths before the container starts. It then mounts only the owned archive copy, generated port
declaration, and compatibility fixture read-only. The Docker client receives only allowlisted
`HOME` and `DOCKER_CONFIG`; the package token, RPC configuration, and workspace are not forwarded.
The container verifies the mounted archive hash, installs the exact public source lockfile with
lifecycle scripts disabled, extracts the already validated archive, and parses declarations under
strict consumer settings. It does not execute package or SDK runtime code. Docker, GitHub, npm, the
registry, and TypeScript remain trusted, and assignability does not establish a reproducible build
or make the dependency tree acceptable.

Privacy-service image evidence crosses the local Docker daemon and public container registries. The
verifier invokes only fixed `buildx imagetools inspect` arguments for three allowlisted tags and
their reviewed immutable references, passes an allowlisted Docker client environment, and
reconstructs output from exact OCI index, platform digest, and source-declaration fields. Reading
provenance by immutable reference prevents a mutable-tag race between the digest and declaration
checks. It never pulls or starts the images. The Docker daemon, registry resolution, publisher and
builder authenticity, image signatures, complete build provenance, and reproducibility remain
outside this claim, and an image match says nothing about which bytes a remote hosted service
actually runs.

Read-only service compatibility evidence crosses operator-configured prover, discovery, proof
interceptor, and RPC endpoints. The command loads only the credential-free deployment profile,
validates it before network access, sends fixed version and health requests, rejects redirects and
unbounded responses, then asks every configured RPC to identify Sepolia and confirm the exact
discovery block number, hash, timestamp, and accepted status. It binds allowlisted fields to the
sanitized deployment profile and freshness policy, reconstructs output without endpoints, the
settlement account address, credentials, or response bodies, and sends no Cashu, note, address,
recipient, or transaction data. Services, RPCs, and the network can still observe endpoint
credentials, source metadata, block lookup, and timing. No response reveals its runtime component
version or attests the remote image or operator; the prover response does not identify its chain.
Interceptor health is only liveness and cannot distinguish active screening from silent
pass-through.

The shared Integration Sepolia observer crosses fixed public demo, prover, discovery, and RPC
boundaries without loading an operator profile. It accepts a discovery block only when two named RPC
operators agree on its Sepolia identity and accepted state, then pins all pool and token reads to
that block hash. It also checks the pool's UDC receipt, address derivation, canonical inclusion,
historical class and UDC class, then inventories and verifies every standard `replace_to` event and
transition through that head. It rebuilds a bounded public record and has no signer or submission
capability. The shared deployment is mutable, its upgrade authority and service operator remain
privileged, the two RPC labels do not prove infrastructure independence, and compatible chain state
does not prove owner approval, source authenticity, absence of an unlogged class-replacement path,
runtime image identity, screening behavior, or permission to fund the pool.

The unsigned pool planner crosses a public operator-input and review-output boundary. It reads only
named public deployment values, uses the settlement account solely to reject role reuse, and omits
that account from output. It accepts no signer material and owns no RPC, class declaration, fee
estimation, or broadcast capability. Its pinned Starknet.js call assembly and independent address
derivation establish only a deterministic candidate transaction. Without a chain read it cannot
prove that the class is declared, the salt and predicted address are unused, authorities control
their keys, privacy services are bound, or any deployment is approved or complete.

The testnet scenario context reconstructs both the deployment and service records, matches their
sanitized public configuration, including pool and token deployment declarations, without requiring
equal observation timestamps, and rejects either
check when it is future-dated or older at run start than the configured block-age window. Both
checked block heads must be no later than the run's first observed block. This validation happens
before a scenario callback. It cannot compare omitted endpoint URLs or attest endpoint, operator,
runtime-image, prover-chain, screening-configuration, or screening-activity identity.
The combined context command reduces accidental profile drift by parsing `.env.deployment` once and
reusing one provider instance per configured RPC across both checks. It runs contract verification
before contacting services and emits no partial stdout. A compromised provider, endpoint, host,
configuration file, or operator label remains outside that structural guarantee.

The payout finality supervisor is a one-way safety boundary from a read-only, already persisted
terminal incident to durable pause state. It receives a Cashu quote ID only to perform the internal
monitor lookup, never stores or returns that quote ID, and has no signer, prover, transaction
submission, replacement, or resume capability. Incident and pause writes span separate databases;
retries must recover from either write succeeding with its response lost. Funding and payout
coordinators consult a value-free admission controller, and the settlement SQLite store repeats
new-record, first-submission, and incoming-finalization checks transactionally. Evidence collection
and submitted-payout reconciliation remain available. A process-local activity gate places the
incoming final admission plus `OBSERVED -> PAID` write and the final payout admission plus submission
inside distinct profile slot kinds. Incident handling blocks both kinds, waits for active callbacks,
and then persists the pause; failed persistence remains quiesced and has no automated resume. The
funding coordinator, payout coordinator, and supervisor guard their protected callbacks against
omission and repetition. Terminal transitions also schedule a watch in the same transaction. A
bounded pull worker keeps the quote ID inside the supervisor lookup and a
separate at-least-once dispatcher emits only the durable pause record under a stable alert ID.
One non-overlapping runtime invokes those workers in order, exposes only fixed counters and
timestamps, waits for an active cycle during shutdown, and stops its loop if its clock loses
monotonicity. A read-only evaluator validates those snapshots and maps startup, stopped, stopping,
stale, stalled, and degraded states to fixed quote-free health results. It does not poll or attest
the process, deliver an alarm, or force-cancel a stuck callback. None of these components has
signing, proving, submission, replacement, or resume capability. CDK issuance is still a separate
unchecked boundary. The activity gate cannot coordinate another process or survive a crash before
durable pause persistence, so it is not a distributed transaction with Starknet.

## Security objectives

1. Mint no Cashu without an exact, canonical, single-use STRK20 payment.
2. Pay at most once for each accepted Cashu melt quote.
3. Do not destroy or release pending proofs while payout execution is ambiguous.
4. Preserve exact integer value across Cashu and ERC-20 units.
5. Keep bearer proofs, signers, viewing keys, and private-note data confidential.
6. Make finality, custody, offline, and solvency limits truthful.
7. Recover deterministically after crashes, timeouts, reorgs, and dependency outages.
8. Never replay a terminal payout or rewrite terminal accounting to conceal a later canonicality
   incident.

## Threat inventory

| Threat | Severity | Required controls | Residual risk / required evidence |
|---|---|---|---|
| Quote theft after another user funds it | Critical | NUT-20 quote lock; secret quote ID; single-use issuance accounting | Test attempted mint with wrong NUT-20 key |
| Wallet claims another deposit | Critical | Sign the expected note ID with the payer binding; independently recompute and observe that exact note; require the payment block strictly after binding verification; reserve `(network, pool, note)` once; atomically exclude overlapping indistinguishable bindings | RC.6 wallet note precomputation, unused-note cancellation, and live sender discovery need testnet evidence |
| Gateway relabels one privacy note as distinct evidence | Critical | Derive the evidence ID independently from canonical network, pool, and note; reject mismatches before persistence; globally own the derived ID | Hash collision remains theoretical; a compromised verifier can still fabricate the underlying observation unless independent chain checks hold |
| Configuration enables an attribution profile the funding gateway cannot implement | Critical | Require a dense, duplicate-free gateway capability declaration; snapshot it at construction; reject configured profiles outside that declaration before issuing instructions | A compromised gateway implementation can still lie about its behavior; live deployment wiring needs independent review |
| Mint issues on a forged transaction hash | Critical | Hash is a per-scan fresh-evidence filter only; verify the signed note ID, token, amount, destination, network, and canonical transaction; always reobserve known evidence | An unauthenticated hint is not persisted; note-bound wallet interoperability still needs live evidence |
| Restart rewrites a rejected payment into a matching payment | Critical | Persist and pass the complete original observation; reduce it to immutable chain references only for canonical reobservation; permit status changes only | Test wrong-amount evidence before and after restart plus fresh/known identity collisions |
| Reorg after observation | Critical | Separate observed/final states; persist block identity write-once; recheck terminal payouts without submission capability; retain the first incident separately from terminal accounting; atomically own the first affected-profile pause; gate funding and payout admission; coordinate local incoming finalization, payout submission, and pause persistence through one fail-closed activity gate; repeat local value-state checks in SQLite | Live runtime operation, CDK issuance admission, multi-process coordination, resume governance, and live incident exercise remain |
| Terminal payout is never reobserved | Critical | Create one watch in the terminal-state transaction; backfill schema-3 terminal intents; lease bounded batches; reject stale workers; bound each callback response and require the worst-case batch budget below the lease; reschedule healthy outcomes and retry ambiguity with capped backoff; invoke one non-overlapping runtime cycle immediately and periodically; expose fixed progress timestamps; validate snapshots and classify stale, stalled, stopped, and degraded runtime state with bounded policy | Independent polling, process supervision, alarm delivery, threshold and deadline calibration, retention policy, and production multi-process behavior remain |
| Incident alert is lost, duplicated, or leaks private settlement data | High | Atomically create a quote-free profile alert with the incident; use a deterministic alert ID; lease and retry an at-least-once outbox; bound delivery responses without claiming cancellation; require sink idempotency; run alerts after finality in the same non-overlapping cycle; expose only fixed worker summaries and errors | Production sink behavior, network and timing metadata, deadline calibration, retention, and operator response need live evidence |
| Duplicate payout after timeout | Critical | Durable intent; encrypt and own one exact signed transaction before submit; unique quote, transaction, and signer-nonce keys; claim one expiring durable broadcaster lease; retain the lease after ambiguous failure; exact rebroadcast only; unknown state | Multi-process unit coverage exists; live crash and timeout after successful submission remain |
| Payout to attacker-chosen recipient | Critical | Parse signed/encoded payout request; bind quote; immutable intent destination | Mutation tests across quote and execution calls |
| Signer returns a different call | Critical | Independently compile expected account calldata; require dense bounded calldata, signature, and proof-fact arrays; bind sender, proof, proof facts, chain, and transaction hash before persistence | Custom account/plugin compatibility still needs testnet evidence |
| Excessive payout transaction fee | High | Bigint-only maximum resource-fee and priority-tip policy checked before persistence | Operator must set and monitor deployment-specific caps |
| Prepared payout payload theft or tampering | Critical | Dedicated AES-256-GCM store; context-bound associated data; mode `0600`; external keyring; authenticate and re-hash before submit | Host or keyring compromise can expose or replay an already signed transaction |
| Wrong token or decimal conversion | Critical | Address allowlist; checked integer conversion; no floats; exact reverse conversion | Cross-language amount and overflow vectors |
| Pending proofs released while tx may execute | Critical | `UNKNOWN` is non-final; fail only when every provider verifies the exact transaction's canonical, policy-final `REVERTED` inclusion; persist inclusion before failure; monitor failed outcomes without replay | Live reverted-transaction, provider-independence, contradiction, and reorg evidence |
| Mint reserve theft | Critical | Key isolation, capped testnet funds, later multisig/policy, monitoring | Custodial risk remains by design |
| Mint signs liabilities beyond reserves | Critical | Issuance accounting, reserve alarms, later liability commitments | Reserve balance alone cannot prevent dishonest issuance |
| Cashu proof leakage in logs or telemetry | Critical | Structured allowlist logging; redaction; no body dumps; access controls | Redaction tests and log review |
| Testnet preflight, scenario orchestration, or evidence leaks private configuration, accepts an incomplete record, or overstates coverage | Critical | Read only named variables; keep credentials internal; use a credential-free verification profile; reconstruct and bound public records; require dense canonical scenario order; run callbacks sequentially; stop and mark remaining cases after a non-pass; reduce callback failures to value-free evidence; bind deployment and run chronology; require explicit transaction disclosure approval | Callbacks, clocks, block sources, labels, disclosure decisions, execution claims, provider independence, and grant readiness still require independent review; a stuck callback is not cancelled |
| Privacy-service release tag is moved or a hosted service misstates its version | Critical | Resolve allowlisted tags through Docker; require exact reviewed OCI index and Linux platform digests; read source declarations through immutable references; require exact source revision, Dockerfile, builder declaration, and completeness flags; use immutable digest references in deployment; require exact configured component labels and prover API; validate bounded discovery and interceptor health; confirm the discovery head and Sepolia chain ID through independent RPCs | Publisher-attached declarations are not authenticated; the prover declares no builder identity and no image declares complete dependency resolution; no probe exposes its runtime component version; the prover API exposes no chain identity; image signatures, reproducible builds, and remote image attestation are not yet verified |
| Shared Integration Sepolia pool, authorities, or services change between observations | Critical | Pin the expected pool and token classes plus pool configuration; verify the exact UDC deployment origin; inventory all standard `ImplementationReplaced` events; verify every declared `replace_to` call, event, block inclusion, L1 finality, and before/after class; pin the four standard AccessControl event selectors and exact inventory digest; decode the ten common roles from the locked upstream revision; query every role for each event-discovered authority account; select one fresh discovery block; require two named RPC operators to agree on chain, block, event histories, and current state; fail closed on drift; submit no transaction | The profile is derived from a mutable official-repository demo preview, not an owner-signed manifest; controller identity and approval, a role or class mutation without its standard event, historical class source authenticity, service-to-contract binding, RPC independence, screening behavior, and funded-use approval remain unverified |
| Unsigned pool plan is mistaken for a safe or completed deployment | Critical | Pin Sepolia and the exact RC.6 source/class; require explicit unique UDC deployment, nonzero salt, four-field constructor, valid distinct auditor and screener curve keys, and settlement-role separation; compare Starknet.js call assembly with independent address derivation; accept no signer and expose no RPC or broadcast method; emit unresolved salt-freshness, declaration, authority, service, transaction, and approval blockers | The planner cannot prove the salt or predicted address is unused, key control, class declaration, fee safety, successful deployment, service bindings, screening behavior, or operator approval; a separate chain check, authorized signing path, and post-deployment manifest verification are still required |
| Screening is absent, fail open, ABI-incompatible, bound to the wrong pool/RPC, or silently passes deposits through | Critical | Require the RC.6 interceptor and `fail_closed_v1` declarations; match the configured screening pool and named RPC to the deployment profile; require non-pool blocking and both fail-open controls disabled; inspect deployed runtime configuration; exercise a known-good deposit envelope with authorized allowed/blocked subjects and confirm metrics before claiming activity | `/health` proves only liveness; no runtime configuration attestation or screening-activity test exists yet, and test subjects leak policy-test metadata |
| Operator declares a false deployment manifest or an unrelated transaction | Critical | Require a canonical transaction reference, public HTTPS manifest URL, and lowercase SHA-256 for both value-bearing contracts; fetch bounded identity-encoded canonical JSON without credentials or redirects; recompute hashes; pin the RC.6 pool source and four-field constructor; independently derive each UDC address; require multi-provider agreement on the successful receipt, exact deployment event, canonical inclusion, finality, historical deployed class, and pinned UDC class; preserve normalized origin evidence across context/run records | Publisher identity, token source and authorities, provider independence, and deployment approval remain external review gates; mutually compromised providers can attest an internally consistent false chain view |
| Public deployment evidence reveals the non-published settlement account | Critical | Omit the account address from the profile; before RPC construction, reject manifest contract, deployer, authority, public-key, and constructor-calldata values equal to that address; reconstruct evidence from an allowlist | Other public or onchain relationships, timing, RPC access, and operator reuse can still identify the account; the check does not discover alternate encodings outside the typed fields |
| RPC providers agree on an unintended or substituted deployment | Critical | Reject sparse or unbounded provider collections; verify Sepolia chain ID; pin the RC.6 screening-v3 pool class plus explicit token and account classes; derive UDC addresses; require receipt identity/status, exact event, inclusion, finality, and historical-class consensus; bound provider lag; re-read one recent accepted block and require current block/class consensus | Deterministic deployment origin does not prove that the project intended or approved that deployment; the observed shared profile has no authenticated owner manifest; nominally distinct endpoints may share an operator or compromised upstream |
| Settlement signer or viewing-key theft | Critical | Secret manager/HSM path, least privilege, process isolation, rotation plan | Initial local test setup remains weaker |
| Screening partner credential theft | High | Secret manager, least privilege, no read-only-profile or evidence exposure, rotation and provider-side monitoring | The local preflight validates shape only; provider-specific abuse, correlation, billing, and revocation behavior still require review |
| Malicious or compromised Privacy SDK package | High | Exact tag/commit; scoped registry auth; check publisher-declared `gitHead`, embedded manifest, dependencies, exports, regular-file archive paths, and registry digests before install; require exact equality with an independent controlled source build; source review; local commitment checks | Authenticated registry and exact source comparison runs are pending; RC package has unresolved transitive advisories and remains outside the workspace graph |
| Compromised source-build image, dependency, or Docker daemon | High | Digest-pinned Node image; exact commit and lockfile; no install scripts, host mounts, or forwarded package token; reduced container privileges and resources; fixed-value errors; accept only bounded base64; require equality with the separately authenticated package | Build retains GitHub/npm egress; Docker and registry infrastructure remain trusted; exact comparison cannot make the vulnerable production dependency acceptable |
| Source declarations drift away from local SDK ports | High | Build the exact source commit with its lockfile; mount only hashed compatibility inputs; compile explicit discovery, channel, viewing-key, and private-transfer assignments under strict consumer settings; emit fixed-value failures | Source compatibility does not authenticate registry bytes, execute runtime paths, or resolve the vulnerable production dependency |
| Authenticated package declarations differ from the reviewed source or local SDK ports | High | Validate registry integrity and archive structure before Docker; snapshot the archive; mount it and hashed compatibility inputs read-only; verify its mounted SHA-256; compile explicit assignments with the exact source lockfile; forward no package token or RPC configuration | Declaration compatibility does not establish full source equality, execute the SDK, or resolve the vulnerable production dependency; Docker, registry, GitHub, npm, and compiler remain trusted |
| CDK protocol drift | High | Stable exact version, compatibility fixtures, changelog review | Custom method API may change in 0.18 |
| Custom method confusion or flattened response collision | Critical | Require route, body, configured processor, and envelope method agreement before deployment; expose no other custom method as defense in depth; use an in-process adapter first; reject empty remote method context; allowlist object-valued response metadata and reject every standard NUT field | Running CDK HTTP, trait, and event-replay tests remain; the stock 0.17.6 HTTP and gRPC boundaries do not enforce all controls |
| RPC or indexer lies about payment | High | Recompute note ID and packed value; reject sparse note, history, receipt-event, and finality collections; require matching pool event and invoke sender; use a dense bounded independent-provider quorum; persist block identity | Provider independence and recipient discovery still need live validation |
| Account-verification RPCs correlate a payer | High | Independent operators, self-hosted endpoints where practical, request deadlines, minimal logs | Every selected provider sees payer address, message hash, signature, and timing |
| Prover returns invalid or privacy-leaking output | High | Verify chain acceptance; authenticated endpoint; minimize inputs; vendor review | Prover observes timing and request metadata |
| Stale or disputed prover base block | High | Independent accepted heads; bounded provider lag; unanimous historical hash; pool validity read at that hash; remaining-block margin; bind returned proof facts to the selected hash and number | Governance can change the validity window after selection; margin needs live calibration |
| Payment request replay | High | 128-bit random single-use ID, expiry, durable uniqueness | Denial-of-service through repeated invalid payments |
| Signed-payer challenge or note replay | High | Server challenge, typed domain, expiry, durable one-time use; dense bounded signature and provider collections; exact note ID in the signed message; permanent note uniqueness within one network and pool | Target wallets do not yet consume the local compatibility helper; unused signed note identities need a cancellation or advancement flow |
| Wallet note-nonce race | High | Derive from the current RC.6 channel snapshot inside the wallet; return no channel key; queue the full operation under one stable SDK scope; synchronously reject a changed nonce before compilation; hold the scope until transaction landing or authoritative state advance | The local coordinator does not reserve SDK state or coordinate processes, devices, or SDK instances over shared storage; expired-instruction behavior needs live wallet evidence |
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
- Payer account and signature metadata disclosed during SNIP-6 RPC verification.
- The expected note ID is a public chain identifier, not secret note material. Before settlement it
  is also a request-to-chain correlation handle visible to the wallet, mint, and account-verification
  providers; request leakage can reveal the matching future pool event.
- Mint censorship or reserve theft.
- Recipient disclosure during Cashu melt-out to the mint operator.
- Offchain Cashu hops under a STRK20 viewing key.
- User mistakes when copying or displaying payment data.

## Key separation

At minimum, use distinct credentials for:

- Cashu mint signing;
- STRK20 payout signing;
- prepared-payout payload encryption;
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
- Keep package tokens process-local; never pass them to archive tools or include registry URLs in evidence.
- Keep source rebuilds separate from normal checks; mount no host workspace or package credential and
  require exact authenticated archive equality.
- Keep source-port checks separate from normal checks; mount only hashed public compatibility inputs
  and retain the authenticated-package and runtime gates.
- Validate authenticated archives before declaration checks; mount only owned inputs read-only and
  forward neither the package token nor project RPC configuration into Docker.
- Resolve privacy-service release tags separately and deploy by reviewed OCI digest, not mutable tag.
- Run dependency audits, but do not treat an audit command as proof of safety.
- Record upstream source and license for vendored protocol files.

The pinned RC.6 manifest currently places `starknet-devnet` in production dependencies even though
the SDK source uses it only from its testing entry point. A 2026-09-10 `npm audit --omit=dev` of the
pinned source reported four vulnerable production packages: one critical, two high, and one
moderate. They include archive-extraction issues in `decompress` and HTTP client issues in
`axios`/`form-data`. Upstream `main` at `ce65fd6a5ab01ecab3358160c5eba102246ce826` retained the exact
RC.6 SDK manifest and lockfile. Do not add the package to the service until the published artifact
or an approved override removes that unused production attack surface.
The artifact verifier does not install the package or run lifecycle scripts. It rejects dependency,
export, source-commit, digest, archive-path, and member-type drift. The separate source-build command
uses the exact commit and lockfile in a constrained container, disables install scripts, and requires
complete archive equality with the authenticated package. Until a scoped-token comparison succeeds,
source-build matching remains unverified. Production installation remains unapproved even after a
match while the dependency gate is open. The source-port command independently verifies public
declaration assignability. The authenticated-artifact port command can bind those assignments to the
registry bytes, but it does not change either the source-build or installation conclusion.

## Required abuse tests

Before a public demo, automate at least:

- wrong unit, token, network, amount, recipient, and pool;
- zero, fractional, negative, maximum, and overflowing amounts;
- stolen quote ID and wrong NUT-20 signature;
- duplicate payment evidence and quote replay;
- payment immediately before and after expiry;
- timeout before submit, during submit, and after successful submit;
- restart after every durable state write;
- prepared-payload tampering, missing encryption keys, nonce conflicts, and fee-cap rejection;
- reorged incoming and outgoing transactions;
- wrong-payment identity preserved across restart and fresh/known evidence collisions;
- post-finality reorg, conflict, provider outage, and incident-write response loss without payout replay;
- finality-watch lease expiry, stale-worker acknowledgement, restart backfill, alert response loss,
  duplicate alert delivery, quote-ID omission, and runtime-health threshold, malformed snapshot,
  hostile clock, stopped-loop, stale-completion, and stalled-cycle behavior;
- RPC/indexer disagreement;
- sparse provider quorums, signatures, note/history batches, receipt events, proof facts, and finality
  collections;
- duplicate event delivery;
- testnet evidence and scenario runs with injected extra fields, endpoints, secrets, raw errors,
  unsafe commands, sparse or oversized collections, reordered definitions, callback exceptions,
  invalid clocks or block bounds, contract/service public-profile substitution, mismatched discovery
  state, reordered providers, inflated attestation claims, missing blockers, late or stale context,
  incomplete coverage, and unapproved transaction references;
- deployment verification with wrong chain, class substitution, provider lag, block disagreement,
  stale/future blocks, timeout, malformed responses, and injected upstream errors;
- privacy-service verification with wrong component or API versions, fail-open declarations,
  incompatible endpoints, invalid interceptor health, redirects, stale discovery heads, oversized
  or malformed bodies, hostile accessors, simultaneous failures, wrong RPC chain, discovery/RPC
  block mismatch, mixed accepted status, timeout, and injected upstream errors;
- package metadata and manifest drift, integrity mismatch, missing exports, path traversal, linked
  archive members, oversized responses, access failure, hostile values, and token redaction;
- source-port input drift, malformed hashes and timestamps, hostile accessors, Docker failure,
  unexpected success output, workspace or credential forwarding, and temporary-input cleanup;
- authenticated-declaration validation ordering, archive/hash substitution, malformed compatibility
  output, package-token or RPC forwarding, hostile accessors, and temporary-input cleanup;
- log redaction on all failures;
- unavailable prover, RPC, database, and event consumer.

## Review triggers

Re-run this threat model when adding an asset, network, wallet transport, offline mode, bridge, swap,
screening service, reserve contract, operator API, new signer, hosted deployment, or real-value pilot.
