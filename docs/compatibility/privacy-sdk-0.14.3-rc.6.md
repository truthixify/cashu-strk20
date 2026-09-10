# Starknet Privacy SDK Compatibility

Status: source-reviewed, structurally compiled adapter target with a passing read-only shared
Integration Sepolia observation. No funded testnet compatibility claim yet.

## Source pin

| Item | Pinned value |
|---|---|
| Repository | [`starkware-libs/starknet-privacy`](https://github.com/starkware-libs/starknet-privacy) |
| Release | [`PRIVACY-0.14.3-RC.6`](https://github.com/starkware-libs/starknet-privacy/releases/tag/PRIVACY-0.14.3-RC.6) |
| Commit | [`4db755b9512f00b540126737b605472ea2275e15`](https://github.com/starkware-libs/starknet-privacy/commit/4db755b9512f00b540126737b605472ea2275e15) |
| Package | `@starkware-libs/starknet-privacy-sdk@0.14.3-rc.6` |
| SNIP-12/RPC client | `starknet@10.5.0` |
| Runtime | Node.js 24 or newer |

The tag's upstream compatibility matrix pairs this SDK with transaction prover `RC.2`, discovery
service `RC.2`, optional proof interceptor `RC.6`, and privacy-pool contract `RC.0`. The RC.6 release
notes and SDK changelog separately describe a breaking screening-v3 pool and regenerated ABI. Those
component tags and class hashes are not deployment addresses. CairoCash must record the actual
testnet chain, pool, token, RPC, prover, discovery service, class hash, and service revisions before
a network transaction.

## Deployment profile discovery

The official RC.6 release publishes screening-v3 privacy-pool class hash
`0x7e2bbd7ccc1e68b2695caef70aeb2a3be6cd017b5d5159278ba08f2d8de33f`. Its tag README still lists
older RC.0 class `0x52107fadffab71bdcbb6b2ccb68ba3e1b5558d94036538053e159d3076ad633`,
which does not match the RC.6 release's regenerated screening ABI. Testnet preflight therefore pins
the RC.6 release hash and rejects the older class. The release does not publish a reusable Sepolia
deployment profile in the inspected release-owned configuration paths. In particular:

- [`demo/.env.example`](https://github.com/starkware-libs/starknet-privacy/blob/4db755b9512f00b540126737b605472ea2275e15/demo/.env.example)
  contains local service URLs and placeholder contract values;
- [`demo/.env.mainnet.example`](https://github.com/starkware-libs/starknet-privacy/blob/4db755b9512f00b540126737b605472ea2275e15/demo/.env.mainnet.example)
  leaves deployment and service values as operator-supplied TODOs;
- [`demo/DEPLOY.md`](https://github.com/starkware-libs/starknet-privacy/blob/4db755b9512f00b540126737b605472ea2275e15/demo/DEPLOY.md)
  defines the required variables without assigning deployment identities;
- [the demo deployment workflow](https://github.com/starkware-libs/starknet-privacy/blob/4db755b9512f00b540126737b605472ea2275e15/.github/workflows/demo-deploy.yml)
  pulls the real values from private Vercel configuration; and
- [`e2e/.env.example`](https://github.com/starkware-libs/starknet-privacy/blob/4db755b9512f00b540126737b605472ea2275e15/e2e/.env.example)
  targets a local integration chain and uses zero placeholders.

The release tag alone therefore left the Sepolia pool, USDC token, settlement-account class, hosted
services, and their deployment ownership unresolved; only the intended RC.6 pool class was pinned.
An address found only in third-party material remains insufficient because provider agreement would
not establish that it is the intended deployment.

The public documentation surfaces do not close the ownership gap. Starknet's
[privacy architecture guide](https://docs.starknet.io/build/starknet-privacy/architecture) publishes
a mainnet pool, not a Sepolia profile. Starkscan's beta
[STRK20 prover relay](https://starkscan.co/docs/api/strk20-prover) states that it is mainnet-only and
has no Sepolia prover. Starkscan is useful as a public-data candidate, but it is not the deployment
owner and its indexed class observations cannot establish that a contract is this project's intended
pool.

A 2026-09-02 recheck of the official repository did not close this gap. Repository HEAD was
[`bc75e4bac71ad0ce10c6e63effc33b5b25131a4f`](https://github.com/starkware-libs/starknet-privacy/commit/bc75e4bac71ad0ce10c6e63effc33b5b25131a4f),
and the newest SDK tag remained `PRIVACY-0.14.3-RC.6`. The repository also had a later
[`CONTRACT_V2_DEPLOYED_MAINNET_2026-07-08`](https://github.com/starkware-libs/starknet-privacy/tree/CONTRACT_V2_DEPLOYED_MAINNET_2026-07-08)
tag, but that tag identifies a source revision rather than publishing a pool address, token,
prover, discovery endpoint, or Sepolia profile. Its `demo/.env.mainnet.example` still leaves those
values as operator-supplied TODOs. The tag is therefore not substituted for deployment identity or
compatibility evidence, and it does not justify changing this project's RC.6 pin.

A 2026-09-09 review found an active Integration Sepolia target through a demo preview attached to
[upstream pull request 951](https://github.com/starkware-libs/starknet-privacy/pull/951), built from
[`42bc24b18166f8a685ec2c0c0f8d9cd6dfb585f6`](https://github.com/starkware-libs/starknet-privacy/commit/42bc24b18166f8a685ec2c0c0f8d9cd6dfb585f6).
Its public configuration identifies a shared pool, discovery service, and transaction prover. The
canonical
[Starknet Sepolia token registry](https://github.com/starknet-io/starknet-addresses/blob/e46241a806dd2d85cdf89dfb5c076855ff1e512e/bridged_tokens/sepolia.json)
independently identifies the configured USDC address and six-decimal unit.

The local `testnet:observe-integration` command confirmed the demo's pool at block `14,818,810`
through PublicNode and Cartridge. Both returned current pool class
`0x7e2bbd7ccc1e68b2695caef70aeb2a3be6cd017b5d5159278ba08f2d8de33f`, pool version `2.1`,
nonzero auditor and screener keys, proof-validity window `450`, the same canonical USDC contract,
USDC class `0xb45dbc3714180381c5680e41931172d67194d77d504413465390e0bef194ec`, and six decimals. The
discovery head was fresh and the prover reported API `0.10.3-rc.2`. This makes the deployment a
usable read-only compatibility target. The command also verifies the exact L1-final UDC deployment
at block `8,271,125`, all five subsequent `replace_to` calls and class transitions, and the complete
filtered `ImplementationReplaced` inventory through the discovery head. It pins the 21-event
standard AccessControl inventory and checks all ten common roles for the two event-discovered
authority accounts at that same block. It does not authenticate the preview operator or authority
controllers, approve the deployment or authorities, discover storage changes without standard
events, authenticate source provenance for historical classes, identify remote service images,
prove screening configuration or activity, or approve a funded transaction.

The exact RC.6 Cairo source also resolves a deployment-documentation conflict. Its privacy-pool
[constructor](https://github.com/starkware-libs/starknet-privacy/blob/4db755b9512f00b540126737b605472ea2275e15/packages/privacy/src/privacy.cairo#L142-L158)
takes `governance_admin`, `auditor_public_key`, `screener_public_key`, and
`proof_validity_blocks`, in that order. The same commit's package README and demo deployment hook
omit `screener_public_key`, so those three-field examples do not encode the pinned class ABI. The
local canonical deployment-manifest verifier rejects that stale form and preserves the four values
for review.

The read-only deployment path uses the current UDC exported by exact `starknet@10.5.0`, address
`0x2ceed65a4bd731034c01113685c831b01c15d7d432f71afb1cf1634b53a2125`, the
OpenZeppelin-published Sierra class
`0x1b2df6d8861670d4a8ca4670433b2418d78169c2947f46dc614e69f333745c8`, and the
`ContractDeployed` selector
`0x26b160f10156dea0639bec90696772c640b9706a47f5b8c52ea1abe5858b34d`. For origin-dependent
deployments it hashes deployer and salt before calculating the address; for origin-independent
deployments it uses the raw salt and zero origin. Deterministic tests freeze both modes and the
event layout. The deployment and combined-context commands require every configured RPC to agree
on successful policy-final receipts, the exact event, canonical transaction inclusion, the declared
class, and the UDC class at the deployment block. The verifier also re-derives both addresses when
rebuilding public evidence. These checks still do not authenticate the manifest publisher, approve
the token source or authorities, establish RPC independence, or approve the observed shared Sepolia
profile.

## Usable surface

The SDK exposes `createPrivateTransfers`, `IndexerDiscoveryProvider`, proof-provider configuration,
and a fluent private-transfer builder. Its public `Note` model contains a note ID, amount, creation
block number, sender address, and private witness. `discoverNotes` can filter by token and pin reads
to a block identifier. The concrete indexer provider returns the discovery cursor needed for a
fresh or incremental scan.

The indexer history API can associate discovered note IDs with a transaction hash and block number.
That association is useful but not authoritative: RC.6 copies the indexer's `note_id`, amount, and
witness fields into its `Note` result without checking the note commitment. The local adapter
recomputes `note_id = Poseidon(NOTE_ID_TAG, channel_key, token, index, 0)` and derives the encrypted
`packed_value` from the witness salt and decrypted amount. Independent providers must then observe
that exact pool event, invoke sender, accepted receipt, block identity, and transaction membership.

RC.6 also makes the ingredients for the sender's next note ID observable to a wallet. The package
root exports `Channel`; `discoverChannels` returns the channel key and token state; and each token
state carries `noteNonce`, documented as the next note index. The compiler passes that nonce into
`CreateEncNote`, and the resulting `EncNoteCreated` event keys the public `note_id`. The source-level
utility `compute_note_id(channel_key, token, index)` uses the same Poseidon formula. However,
`compute_note_id` is exported only from `sdk/src/utils/index.ts`, while RC.6's package root and
package export map do not expose that subpath. A production wallet therefore needs an upstream
public helper or a separately audited compatibility helper; a deep import from the published
package is not a stable option.

The local `starknet-privacy-sdk-note-reference` boundary is that compatibility helper. It accepts
the structural public `Channel` shape, reads only the selected token's next nonce, reproduces the
pinned formula with exact `starknet@10.5.0`, and returns only the nonce and public note ID. The
incoming note verifier uses the same implementation, and deterministic tests bind it to the pinned
Cairo vector. This is local source evidence, not published-package or wallet interoperability
evidence. The helper must run inside the wallet: the channel key is private state and must never be
sent to the mint, logged, or included in the challenge.

Pinned RC.6 has no operation queue in `SimplePrivateTransfersImpl`. An
[upstream serialization proposal](https://github.com/starkware-libs/starknet-privacy/pull/937),
still open, review-required, and merge-blocked when rechecked on 2026-09-10, documents that
overlapping operations can compile against the same unspent notes and clobber mutable registry
state. The local
`StarknetPrivacySdkNoteReferenceCoordinator` queues callbacks that share one coordinator and stable
SDK operation-scope object, derives only after acquiring that queue, and exposes a synchronous
pre-compile assertion that rejects a changed nonce. A failed callback releases the next operation.
The callback must remain open through transaction landing or authoritative state advancement.
It must not synchronously or asynchronously reenter the same coordinator and scope.

That coordinator is a narrow local mitigation, not a backport of the proposed upstream fix.
Reading `noteNonce` still does not reserve it. Separate coordinators, processes, devices, SDK
instances over shared storage, premature callback completion, and the discovery-to-submission
TOCTOU window remain outside its guarantee. The same upstream report notes that shared storage
needs versioned or compare-and-swap persistence rather than a per-instance queue.

The indexer accepts a previous block hash for reorg detection and maps HTTP `409` to an internal
`ReorgError`. That error is not exported from the package root in RC.6, so the adapter cannot depend
on its class identity. It must classify the response through a narrow wrapper or contribute a
stable exported error upstream.

`discoverNotes` returns the SDK's custom `AddressMap`, not a native `Map`. The local structural
adapter accepts the actual bounded iterable shape and rejects arrays, inconsistent sizes, malformed
entries, and unexpected token collections. It rediscovery-pins history to the exact discovery block
hash and never persists or logs the opaque note, channel, or history cursors.

RC.6 history may return more entries than `maxTransactions` while filling withdrawal gaps. The
adapter therefore separates request page size, maximum response size, cumulative lookup size, and
page count. Treating the request size as a response invariant would reject valid RC.6 pages; leaving
the cumulative size unbounded would permit resource exhaustion.

For payouts, SDK `execute()` compiles and proves a transfer but returns a `CallAndProof`; it does not
broadcast a Starknet transaction. Account execution, transaction-hash capture, receipt polling, and
canonical-finality checks remain gateway responsibilities.

The local payout adapter uses that separation directly. It compiles and proves once, then uses
`starknet@10.5.0` `Account.getSignedTransaction()` to create an exact V3 invoke without broadcasting.
The RC.6 `PrivateTransfersInterface` is structurally assignable to the local payout port at the
pinned source commit. This is compile-time evidence only; it does not establish prover, signer,
contract, or RPC compatibility on Sepolia.

RC.6 passes an explicit proving block through to the proving service, and the pool exposes
`get_proof_validity_blocks`. The local selector chooses a historical accepted block only after
independent providers agree on its hash, then reads that pool view at the same block and preserves a
configured number of validity blocks beyond the newest observed provider head. The block offset,
head-lag allowance, freshness limit, and remaining margin are deployment policy, not SDK defaults.
The payout adapter also checks RC.6 proof-fact fields 4 and 5 against the selected base block number
and hash before signing, so an SDK or prover response cannot silently bypass the selector.

Primary source locations:

- [note and proof models](https://github.com/starkware-libs/starknet-privacy/blob/4db755b9512f00b540126737b605472ea2275e15/sdk/src/interfaces.ts#L77-L109)
- [public `Channel` and registry surface](https://github.com/starkware-libs/starknet-privacy/blob/4db755b9512f00b540126737b605472ea2275e15/sdk/src/interfaces.ts#L70-L75)
- [`Channel.tokens` and next `noteNonce`](https://github.com/starkware-libs/starknet-privacy/blob/4db755b9512f00b540126737b605472ea2275e15/sdk/src/internal/channel.ts#L103-L130)
- [note-ID computation](https://github.com/starkware-libs/starknet-privacy/blob/4db755b9512f00b540126737b605472ea2275e15/sdk/src/utils/hashes.ts#L86-L89)
- [utility-module export](https://github.com/starkware-libs/starknet-privacy/blob/4db755b9512f00b540126737b605472ea2275e15/sdk/src/utils/index.ts#L27-L40)
- [package-root exports](https://github.com/starkware-libs/starknet-privacy/blob/4db755b9512f00b540126737b605472ea2275e15/sdk/src/index.ts#L1-L4)
- [package export map](https://github.com/starkware-libs/starknet-privacy/blob/4db755b9512f00b540126737b605472ea2275e15/sdk/package.json#L10-L29)
- [discovery interface](https://github.com/starkware-libs/starknet-privacy/blob/4db755b9512f00b540126737b605472ea2275e15/sdk/src/interfaces.ts#L775-L814)
- [incoming indexer response and note conversion](https://github.com/starkware-libs/starknet-privacy/blob/4db755b9512f00b540126737b605472ea2275e15/sdk/src/internal/indexer-discovery.ts#L51-L103)
- [history lookup](https://github.com/starkware-libs/starknet-privacy/blob/4db755b9512f00b540126737b605472ea2275e15/sdk/src/internal/indexer-discovery.ts#L388-L415)
- [reorg response handling](https://github.com/starkware-libs/starknet-privacy/blob/4db755b9512f00b540126737b605472ea2275e15/sdk/src/internal/indexer-discovery.ts#L430-L445)
- [disabled preprepared deposit note ID](https://github.com/starkware-libs/starknet-privacy/blob/4db755b9512f00b540126737b605472ea2275e15/sdk/src/internal/compiler.ts#L349-L369)
- [next nonce used for encrypted notes](https://github.com/starkware-libs/starknet-privacy/blob/4db755b9512f00b540126737b605472ea2275e15/sdk/src/internal/compiler.ts#L392-L429)
- [public note-ID event key](https://github.com/starkware-libs/starknet-privacy/blob/4db755b9512f00b540126737b605472ea2275e15/packages/privacy/src/events.cairo#L93-L100)
- [public package exports](https://github.com/starkware-libs/starknet-privacy/blob/4db755b9512f00b540126737b605472ea2275e15/sdk/src/index.ts)

## Attribution result

RC.6 does not expose a receiver-created channel or request field that is unique to a payment quote.
Channels are organized by sender and recipient, with token subchannels, while notes advance by
nonce inside that relationship. The transfer builder has no note memo or payment-request field.
Although the action type contains an optional preprepared note ID, the compiler does not currently
forward it into deposit actions.

Therefore `quote_channel` is not directly implementable through the reviewed public SDK surface.
It remains a failed source-level hypothesis until a testnet experiment or upstream capability shows
otherwise. CairoCash must not issue quote-channel instructions that merely reuse one mint recipient
and pretend the destination is quote-unique.

The viable experiment is `signed_payer`:

1. Bind an opaque payment request and the payer's expected next pool note ID to a verified Starknet
   payer address and replay-resistant client challenge.
2. Accept a wallet transaction hash only as an untrusted per-scan lookup filter.
3. Discover the note independently and require its recomputed ID, sender, token, amount, recipient
   context, and creation block to match the signed request.
4. Require its accepted inclusion block to be strictly newer than the block used to verify the
   payer binding.
5. Use indexer history to prove the note belongs to the hinted transaction.
6. Query canonical block and transaction status independently.
7. Claim the `(network, pool, note ID)` tuple once before marking the request paid.

The local settlement boundary implements the challenge, durable replay state, steps 3 through 7,
the concrete signed-payer funding join, the RC.6 note/history adapter, and Starknet account and
transaction observers. Its mapper accepts an expected payer only as the output of the verified
binding, and rejects payment evidence from the binding block or any earlier block. Restart
reconciliation carries the full stored observation into the gateway, reapplies that block lower
bound, and exposes only immutable chain references to the collector, preventing a recorded wrong
amount or pre-binding payment from being reconstructed as a match. Deterministic tests cover the
pinned Cairo commitment vectors and adversarial SDK/RPC responses. Package-artifact installation,
wallet flow, live indexer, configured RPC, and Sepolia deployment evidence are still absent.

### Payer-binding candidate

The local challenge coordinator now reconstructs a candidate
[SNIP-12](https://github.com/starknet-io/SNIPs/blob/main/SNIPS/snip-12.md) revision 1 message. Its
domain is `CairoCash Funding`, version `2`, on `SN_SEPOLIA`. The message binds the opaque payment
request, payer account, pool, privacy recipient, token, expected note ID, exact base-unit amount,
funding expiry, challenge expiry, and a 256-bit server challenge. The verifier version records
`snip12-funding-v2-rev1` so persisted evidence cannot be confused with the earlier message schema.

The adapter hashes this message with exact `starknet@10.5.0` and uses the account contract's
[SNIP-6 `is_valid_signature`](https://github.com/starknet-io/SNIPs/blob/main/SNIPS/snip-6.md#current-interface)
entry point over a server-reconstructed message hash. Starknet account abstraction means the
service cannot safely assume a particular public-key or signature layout; valid wallet signatures
may be multisignature or account-specific arrays. The verifier requires two or more named provider
instances to agree on a fresh accepted block, pins every call to that block hash, and accepts only
SNIP-6 `VALID`, legacy `1`, or explicit `0`. Only a unanimous valid result may consume the challenge.

This schema is an implementation candidate, not yet an interoperability claim. The public
[deterministic hash vector](../specs/vectors/signed-payer-snip12-v2.json) freezes the builder inputs,
typed data, outer account address, and exact `starknet@10.5.0` result. It omits a signature because
signature semantics are account-specific. Wallet signing checks against the target Wallet API and
live SNIP-6 verification on selected Sepolia accounts are still required. The SNIP documents
themselves remain in Review status. The [v1 vector](../specs/vectors/signed-payer-snip12-v1.json) is
superseded and retained only to make the incompatible schema change reviewable.

The local store reserves each verified note ID forever within its network and privacy pool. A later
request cannot sign the same note ID even after the first funding window ends. Open unsigned
challenges do not reserve it, preventing an unauthenticated caller from exhausting wallet note
identities. The store also retains the conservative rule that only one overlapping verified binding
may exist for the same payer, pool, recipient, token, and amount. The gateway still does not persist
an untrusted transaction hint, because anyone who learns a payment request could otherwise pin an
unrelated transaction and deny reconciliation.

Exact note binding resolves the sequential late-payment ambiguity: a payment can satisfy only the
request that signed that note ID, and a payment first observed after its expiry enters that request's
late-payment state. It creates a wallet requirement instead. If a signed instruction expires before
the note is created, the same unchanged next nonce cannot be used for a later request. RC.6 wallet
support for safely advancing or cancelling that unused note identity is not demonstrated, and the
package does not publicly export its note-ID hash helper. Both points remain deployment gates.

Fresh discovery is not sufficient for reorg recovery because a reorged or later-spent note may no
longer appear in the unspent-note response. Reconciliation must persist the note and transaction
references from the first observation, query those transaction references directly on later runs,
and emit `REORGED` when their original canonical block is displaced.

The coordinator now supplies those persisted references to every later gateway scan, and the local
evidence collector exposes a direct re-observation path. A live finality source must report status
against the stored original block hash and number; it may not rewrite an evidence identity when a
transaction moves or disappears.

## Payout recovery boundary

A generated `CallAndProof` is only a prepared private action. Retrying SDK `execute()` is not
idempotency because it can compile new randomness and create a different transfer. The local adapter
therefore signs and identifies one exact transaction before any broadcast.

It validates the RC.6 pool call, compiles the expected account calldata independently, requires the
signed transaction to contain the same proof and proof facts, enforces local resource-fee and tip
caps, and calculates the Sepolia transaction hash locally. It then encrypts the signed transaction
with AES-256-GCM and atomically stores it under the CDK-derived intent before submission. Associated
data binds the payload version, intent, opaque submission ID, request digest, adapter version,
signer, nonce, and transaction hash. Unique constraints prevent two intents from owning one signer
nonce or transaction.

After a timeout, process restart, or lost store response, recovery loads that artifact rather than
calling RC.6 again. Each submission authenticates and re-hashes it before broadcasting the exact
signed RPC object. An expiring durable lease admits one broadcaster across store instances, remains
held after an ambiguous response, and must outlive the RPC timeout. After lease expiry, `NOT_FOUND`
permits only that exact rebroadcast. Provider failure, disagreement, or a reorg remains non-final.
Once a provider set agrees on an accepted inclusion, its block hash and number are stored write-once
and supplied to later observations after restart. A displaced original inclusion becomes `REORGED`
rather than being silently replaced.

The payout-specific observer recognizes one concrete proof of permanent non-execution. Every
provider must report the exact prepared transaction as `REVERTED`, in the same canonical block, with
transaction membership and the configured L2 or L1 finality policy satisfied. The adapter stores
that original inclusion before returning `FAILED`. Missing receipts, provider disagreement,
timeouts, and a later account nonce are insufficient and remain non-final. Starknet documents that
a reverted transaction is included, charges a fee, and increments the account nonce while reverting
its execution-stage state changes; nonce replay protection then prevents that exact signed payout
from executing later. See the official [transaction lifecycle](https://docs.starknet.io/learn/protocol/transactions)
and [account nonce](https://docs.starknet.io/learn/protocol/accounts) documentation. The charged fee
is an operator cost and does not become Cashu `total_spent` for a failed melt.

For a terminal `PAID` or `FAILED` intent, the adapter exposes a read-only reobservation path that
always supplies the stored original inclusion. `PayoutFinalityMonitor` checks the intent, prepared
artifact, single transaction reference, and returned inclusion before storing the first `REORGED` or
`CONFLICTED` incident. It does not call RC.6, the signer, or transaction submission, and it does not
rewrite terminal accounting. Provider unavailability remains `UNKNOWN` and creates no incident.

The encrypted artifact uses a dedicated SQLite file and an externally supplied keyring. Signer keys,
viewing keys, decrypted notes, and bearer proofs do not enter either settlement database. This is
deterministic recovery evidence, not a production key-management design or a live payout claim.

## Finality boundary

Discovery success and `receipt.isSuccess()` prove neither the project finality policy nor continued
canonicality. `pre_confirmed` is explicitly speculative. The prover's base-block age requirement is
also separate from payment finality.

The local `starknet@10.5.0` observer verifies each receipt against the canonical block at its reported
height, including transaction membership, through at least two providers. New funding evidence also
requires every provider to return the expected `EncNoteCreated` ID and packed value plus the bound
payer as the invoke sender. It implements selectable L2-accepted and L1-accepted candidates and
rechecks persisted original heights for reorgs. Payout observation additionally requires unanimous
execution status before treating a policy-final reversion as non-execution. This is deterministic
implementation evidence, not a live finality claim. CairoCash will leave the deployment policy
unresolved until Sepolia evidence measures accepted-status agreement, provider lag, reversion, and
reorg behavior.

The executable deployment verifier now uses the same policy vocabulary to compare accepted heads,
pin one common block, and check configured pool, token, and account class hashes through every RPC.
Its real Starknet.js path is covered by deterministic loopback JSON-RPC tests. No actual Sepolia
profile has been verified yet, so this does not close the deployment or finality evidence gates.

## Package audit gate

The credential-free `pnpm privacy-sdk:verify-source-ports` command makes the source structural check
repeatable. It checks out commit `4db755b9512f00b540126737b605472ea2275e15` in the digest-pinned
Node `24.0.2` Linux/AMD64 container, installs the exact SDK lockfile with lifecycle scripts disabled,
builds RC.6 with its own compiler configuration, then compiles its emitted public declarations
against the local discovery, channel, viewing-key, and private-transfer ports under strict consumer
settings. It mounts only the generated local port declaration and compatibility fixture, records
both SHA-256 values, and forwards no package credential.

On 2026-09-10 at `01:11:55Z`, that check passed with port-declaration SHA-256
`3897008fc4cf18afcb20e62d9dc870d71663217124f6270735b075a8fa991c67` and fixture SHA-256
`ea334435c2e6d18775816ecc75034d5c77bb779d2de98c9320e2d3db8f6a23ea`. It did not execute the SDK
runtime or inspect the authenticated registry artifact. The published package therefore remains
excluded from this repository. Its manifest declares `starknet-devnet`
as a production dependency although the source imports it only from the testing entry point. On
2026-09-10, `npm audit --omit=dev` against the pinned lockfile reported four vulnerable production
packages: one critical, two high, and one moderate. They include critical archive-extraction
advisories through `decompress` and high-severity HTTP client advisories through `axios` and
`form-data`.

The latest upstream release remained RC.6 on 2026-09-10. Current `main` at
`ce65fd6a5ab01ecab3358160c5eba102246ce826` had no `sdk/package.json` or `sdk/package-lock.json`
change from the release commit, so no upstream dependency remediation was available to adopt while
retaining the pinned SDK surface.

This does not show that the note-discovery runtime invokes those paths, but it does make them part of
the installed production supply chain. The live adapter gate requires an upstream dependency fix or
a reviewed, locked override that removes the unused devnet subtree. Do not run an automatic
force-fix because it proposes a breaking `starknet-devnet` downgrade and would diverge from the
pinned release without compatibility evidence.

The workspace now provides `pnpm privacy-sdk:verify-artifact`. It reads a GitHub Packages token only
from `NODE_AUTH_TOKEN`, downloads into a private temporary directory, passes no token to `tar`, and
runs no package code. It requires the exact publisher-declared registry `gitHead`, source manifest
projection, runtime dependencies, exports, regular-file archive members, and SHA-512/SHA-1 registry
digests before emitting sanitized evidence. Because `gitHead` is not reproducible-build proof, the
evidence leaves source-build matching and production installation unapproved. The `starknet-devnet`
dependency also remains. A 2026-09-02 attempt with the current GitHub CLI token failed closed because
that token lacks `read:packages`; no authenticated artifact evidence is yet claimed.

The workspace also provides `pnpm privacy-sdk:verify-artifact-ports`. It authenticates and validates
the package before starting Docker, then compiles the package's public declarations against the same
local discovery, channel, viewing-key, and private-transfer fixture. Only an owned archive copy and
the two hashed compatibility inputs are mounted read-only. The package token, RPC configuration, and
workspace are not forwarded. The container installs the exact public RC.6 lockfile with lifecycle
scripts disabled to obtain TypeScript and the declaration dependencies; it does not execute package
or SDK runtime code. A 2026-09-10 exercise of this container recipe against a throwaway archive built
from the exact public source passed with the same port-declaration and fixture hashes recorded above.
That exercise validates the container mechanics only, not the authenticated registry artifact. A
scoped-token run is still pending and its evidence will retain source-build matching and production
installation as false.

### Independent source rebuild

The release does not include a package asset. The repository's only
[SDK prerelease publish workflow](https://github.com/starkware-libs/starknet-privacy/blob/PRIVACY-0.14.3-RC.6/.github/workflows/sdk-publish-prerelease.yml)
had no run for commit `4db755b9512f00b540126737b605472ea2275e15` when checked on 2026-09-02.
That workflow also selects floating Node `24`, rewrites the package version, and runs only `npm run
build`. At RC.6, that script runs TypeScript compilation but does not generate the four files named
by the browser exports. The separate browser script invokes `npx tsx`, while `tsx` is not a locked
top-level dependency. These gaps mean the public repository does not establish the publisher's exact
package-build recipe.

An independent controlled rebuild now supplies a conservative comparison candidate. It uses the
multi-architecture Node `24.0.2` image index pinned at
`sha256:7cd385e17f9d66b2c3ae40597359286073a33266db71b5f01ce2d87db81b52f7`, forces
Linux/AMD64, checks out the exact commit, runs `npm ci --ignore-scripts`, compiles the normal SDK,
transpiles the browser build driver with locked TypeScript `5.9.3`, runs locked esbuild `0.27.2`, and
packs with lifecycle scripts disabled. It mounts no host workspace or output directory and receives
no package credential. GitHub and npm remain reachable during the build.

Four local rebuilds on 2026-09-02 produced the same 2,607,626-byte archive on ARM64 and AMD64 and
through both the upstream `npx tsx` driver and the lockfile-only TypeScript driver. Its SHA-256 is
`38890093ad7c134414de666907a096427311aa1a2a6d2c2cc7febc2336a6b522`. This is deterministic source
candidate evidence, not authenticated registry evidence. `pnpm privacy-sdk:verify-source-build`
first passes the authenticated artifact verifier, then reruns the controlled build, and emits
`sourceBuildMatchVerified: true` only if the two complete npm archives are byte-identical. The
current under-scoped GitHub token fails before Docker starts, so no registry comparison is claimed.

### Service image resolution

The compatibility matrix's public container tags are available even though a hosted Sepolia stack
is not. A 2026-09-02 registry check resolved the transaction prover RC.2, discovery service RC.2,
and proof interceptor RC.6 tags to exact multi-platform OCI indexes. The
`privacy-services:verify-images` command compares those tags and their Linux platform manifests to
the reviewed digests without pulling or starting a container. It then reads each reviewed immutable
reference and requires the attached BuildKit metadata for both platforms to match these source
declarations:

| Component | Source revision | Dockerfile | Declared builder |
|---|---|---|---|
| Transaction prover | `starkware-libs/sequencer@e6b6fd2e9932909107833579e5b6efd6c75fa0af` | `crates/starknet_transaction_prover/Dockerfile` | absent |
| Discovery service | `starkware-libs/starknet-privacy@9bfeb8dd35565a2915a0617dff3f649bd5bb891a` | `deploy/discovery-service/Dockerfile` | GitHub Actions run `28506731538` |
| Proof interceptor | `starkware-libs/starknet-privacy@4db755b9512f00b540126737b605472ea2275e15` | `deploy/proof-interceptor/Dockerfile` | GitHub Actions run `33398719195` |

The immutable references and operator requirements are recorded in the
[testnet privacy services guide](../operations/testnet-privacy-services.md).

This remains publisher-controlled registry evidence. The transaction-prover statement has an empty
builder identity; every image marks resolved dependencies incomplete, and only the interceptor marks
the BuildKit request complete. On 2026-09-02, GHCR returned no OCI referrer manifest for the reviewed
index digests and exposed no legacy Cosign `.sig` tag for them. That observation is not proof that no
other signature exists. The command does not authenticate the attached statements, verify an image
signature, reproduce the source build, inspect runtime configuration or screening behavior, or
identify the bytes behind a remote endpoint. It leaves provenance verification, remote-runtime
identity, and deployment approval unresolved.

### Shared Integration Sepolia observation

`testnet:observe-integration` has a fixed public profile and requires no environment file. It probes
only the public discovery and prover compatibility surfaces, confirms the discovery block through
two separately named public RPC operators, and reads the pool and USDC state at that exact block
hash. It verifies the original UDC deployment, each of the five canonical `replace_to` transitions
through RC.6, the complete filtered `ImplementationReplaced` event inventory, the exact reviewed
standard AccessControl inventory, and current common-role membership for each account named by that
history. Each RPC supplies one bounded union-selector inventory; separate upgrade and authority
verifiers consume exact filtered views and retain their own completeness and fingerprint checks. It
submits no transaction and sends no Cashu proof, quote, note, recipient, screening
subject, or private transaction payload. The allowlisted output omits endpoints and explicitly
leaves controller identity and approval, non-event storage mutation, historical class source
authenticity, runtime version, screening configuration, screening activity, settlement account, and
funded execution unresolved. Because the shared profile is mutable, each observation is
time-specific and later use must rerun the command.

### Read-only service compatibility

`testnet:verify-services` validates an operator's read-only Sepolia profile against the RC.6 matrix
and sends only fixed public compatibility requests. It requires transaction prover and discovery
labels `PRIVACY-0.14.3-RC.2`, proof-interceptor label `PRIVACY-0.14.3-RC.6`, prover JSON-RPC
`starknet_specVersion` `0.10.3-rc.2`, the RC.2 discovery `/health` shape and freshness policy, and
exact interceptor health `{ "status": "ok" }`. It then requires every configured RPC to identify
Sepolia and return the exact reported discovery block number, hash, and timestamp as L2- or
L1-accepted. The weakest status in that provider set is recorded and is not promoted to settlement
finality. Requests reject redirects and unbounded or non-JSON responses. Sanitized evidence binds
the existing public deployment profile to public operator labels, the prover API result, discovery
head, interceptor liveness, and provider IDs; it contains no endpoint, settlement account address,
screening credential, Cashu, note, address, recipient, or transaction data.

This is not runtime attestation. No response exposes its runtime component version or OCI digest,
and the prover response does not identify its chain. Exact discovery-head agreement ties that
observation to Sepolia but does not identify the service binary or backend. Interceptor health does
not prove `SCREENING_URL`, pool/RPC binding, non-pool blocking, fail-open settings, or screening
activity; no test address is sent. The evidence leaves every runtime version, prover chain identity,
screening runtime configuration, screening activity, remote runtime image, and deployment approval
false. Endpoint credentials and network metadata remain visible to the endpoint itself even though
they are not published.

## Open integration gates

- Re-run the credential-free source-port check whenever a local port or its compatibility fixture
  changes; do not treat that result as authenticated-package or runtime evidence.
- Run the artifact, authenticated-declaration, and source-build commands with a scoped
  `read:packages` token without writing it to the repository, and retain all three sanitized records.
- Remove or explicitly remediate the unused vulnerable `starknet-devnet` production subtree.
- Authenticate and explicitly approve the shared Integration Sepolia profile or deploy an
  operator-owned replacement. Record immutable original pool and token provenance, review the
  observed upgrade authority, retain the read-only compatibility record, and bind each endpoint to
  a reviewed image digest.
- Retain reviewed fail-closed interceptor and prover runtime configuration, then run an explicitly
  authorized known-good deposit envelope with allowed and blocked subjects, confirm nonzero
  screening metrics, and publish neither test subjects nor provider credentials.
- Confirm note-to-history transaction association against that deployment.
- Confirm note ID, packed-value, and invoke-sender checks against a real wallet transfer.
- Validate the local note-ID helper against the authenticated published artifact and a target wallet;
  hold one stable operation scope through transaction landing; exercise stale-nonce rejection and
  shared-storage concurrency; and demonstrate behavior when a signed instruction expires without
  creating that note.
- Confirm whether history completeness is sufficient after notes are spent.
- Validate the implemented typed-data challenge with target wallets and Sepolia account classes.
- Exercise exact prepared-payout recovery, fee policy, and canonical status against the selected
  Sepolia deployment, including a safe reverted transaction, without exposing proof or recipient
  material.
- Calibrate the proving-block offset and remaining validity margin against measured prover latency,
  block production, and the selected pool's live governance value.
- Operate the durable post-finality runtime under process supervision, calibrate its callback and
  lease budgets, and connect an idempotent production sink with a retention policy. Add CDK issuance
  admission, coordinated submit quiescence, and reviewed resume governance. The local runtime does
  not make an external broadcast atomic with a pause commit.
- Select a finality policy only from observed testnet behavior.
