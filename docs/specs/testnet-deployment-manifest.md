# Testnet Deployment Manifest

Status: Draft 0.1. This format records public Sepolia deployment claims for the settlement spike. It
does not authenticate an operator or prove that a transaction deployed a contract.

The key words `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, and `MAY` in this document are to be
interpreted as described in RFC 2119 and RFC 8174 when, and only when, they appear in all capitals.

## Purpose

A deployment profile identifies a privacy pool and six-decimal test USDC by address, class hash,
version, and deployment transaction. The manifest makes the source, constructor, authority, and
test-supply claims behind those identifiers independently reviewable. The profile commits to the
exact manifest bytes with SHA-256.

The format is public. It MUST NOT contain private keys, signer or viewing material, endpoint
credentials, screening credentials, private notes, Cashu quote IDs, or unpublished transaction
payloads. The settlement account address MUST NOT be reused as a manifest contract, deployer,
governance admin, auditor key, screener key, mint authority, or constructor-calldata value.

## Encoding

A manifest MUST be UTF-8 JSON no larger than 64 KiB. It MUST use the property order shown in the
[canonical vector](vectors/testnet-deployment-manifest-v1.json), two spaces for indentation, and one
trailing line feed. Duplicate properties, extra properties, alternate whitespace, a byte-order
mark, invalid UTF-8, sparse arrays, and noncanonical numeric encodings are invalid.

The published vector is synthetic and does not identify a live deployment. Its exact file SHA-256
is `1888f8ebca6f35f5a6f6303eb32202b1bf2edd86596c1c77fabe7c32f9d90ce5`.

The top-level object is:

```text
schemaVersion  "cashu-strk20-testnet-deployment-manifest-v1"
network        "SN_SEPOLIA"
chainId        canonical nonzero Starknet felt
contracts      one or two contract records
```

Contract roles MUST be unique. When both records are present, `privacy_pool` MUST precede
`usdc_token`. Separate pool and token URLs MAY each contain one record. One shared URL MAY contain
both records only when both profile declarations use that exact URL and SHA-256.

Felt values use lowercase `0x` hexadecimal without redundant leading zeroes. Addresses additionally
fit the Starknet contract-address bound. Block numbers, proof-validity blocks, and supply amounts use
canonical unsigned decimal strings. Amounts and limits are parsed as integers, never floating point.

## Common Contract Fields

Each contract record contains:

- `role`, `address`, `classHash`, and `version`;
- `source.repository`, a public HTTPS URL without credentials, query, or fragment;
- `source.commit`, a lowercase 40-character Git commit;
- `source.contractPath`, a relative repository path without traversal;
- `deployment.transactionReference`, the canonical nonzero transaction hash;
- `deployment.acceptedBlockHash` and `acceptedBlockNumber`;
- `deployment.deployer`, `salt`, and `unique` address-derivation inputs;
- `deployment.constructorCalldata`, the ordered canonical felt array.

The manifest verifier retrieves each distinct URL once with credentials omitted, redirects disabled,
`Accept-Encoding: identity`, a ten-second deadline, and a 64 KiB response limit. The response MUST
be `application/json` and MUST NOT be content-encoded. Its SHA-256 MUST equal the lowercase,
unprefixed profile declaration before content is accepted.

## Privacy Pool Record

The pool source repository, commit, and path MUST equal the pinned RC.6 values:

```text
repository    https://github.com/starkware-libs/starknet-privacy
commit        4db755b9512f00b540126737b605472ea2275e15
contractPath  packages/privacy/src/privacy.cairo
```

The `configuration` object contains canonical `governanceAdmin`, `auditorPublicKey`, and
`screenerPublicKey` felts plus a positive u64 `proofValidityBlocks` decimal string. Constructor
calldata MUST contain those four values in that order, with `proofValidityBlocks` encoded as a felt.

This four-field rule follows the
[exact RC.6 Cairo constructor](https://github.com/starkware-libs/starknet-privacy/blob/4db755b9512f00b540126737b605472ea2275e15/packages/privacy/src/privacy.cairo#L142-L158).
The same commit's package README and demo deployment hook omit `screener_public_key`; they are stale
for this class and MUST NOT be used to construct deployment calldata.

## Test USDC Record

The token `configuration` object contains:

```text
symbol                  "USDC"
decimals                6
mintAuthority           canonical Starknet address
supplyPolicy            "capped_test_supply_v1"
maximumSupplyBaseUnits  positive uint256 decimal string
```

The token's source and constructor ABI remain deployment-specific. Reviewers SHOULD compare its raw
constructor calldata and mint authority with the pinned source before approving test funds. The
manifest claim does not enforce a supply cap onchain.

Before deployment, `testnet:plan-pool-deployment` can construct an unsigned RC.6 pool plan with the
same four-field rule and UDC address semantics. A plan is not a manifest: it has no transaction,
receipt, accepted block, or deployment-origin evidence and MUST NOT be substituted for a contract
record. After an authorized deployment, the operator must create the manifest from independently
verified canonical results rather than copying unverified outcome fields into the plan.

## UDC Deployment Profile

Deployment-origin verification uses the current OpenZeppelin Universal Deployer Contract profile
exposed by the pinned `starknet@10.5.0` dependency:

```text
UDC address              0x2ceed65a4bd731034c01113685c831b01c15d7d432f71afb1cf1634b53a2125
UDC Sierra class hash    0x1b2df6d8861670d4a8ca4670433b2418d78169c2947f46dc614e69f333745c8
ContractDeployed selector 0x26b160f10156dea0639bec90696772c640b9706a47f5b8c52ea1abe5858b34d
```

The manifest field `unique` maps to the current UDC interface's `not_from_zero` parameter. For
`unique: false`, address derivation MUST use the declared salt unchanged and zero as the
deployment-origin input. For `unique: true`, it MUST use Pedersen(`deployer`, `salt`) as the
effective salt and the UDC address as the deployment-origin input. Both modes then calculate the
contract address from the effective salt, declared class hash, and exact constructor calldata. A
manifest whose declared address differs from that result MUST be rejected before any RPC call.

The expected `ContractDeployed` event MUST come from the pinned UDC, have exactly the selector above
as its sole key, and encode this exact data sequence:

```text
address, deployer, unique_as_0_or_1, class_hash, calldata_length, calldata..., salt
```

This profile follows the [OpenZeppelin UDC deployment
model](https://docs.openzeppelin.com/contracts-cairo/2.x/udc). Changing the Starknet.js version,
UDC address, selector, uniqueness semantics, or event layout requires a compatibility review and a
new verifier version.

## Verification Evidence

`testnet:verify-deployment` and `testnet:verify-context` fetch and validate the manifests before
constructing RPC providers. Their public evidence preserves the parsed contract records, artifact
URLs, declared hashes, and byte counts. It records these true statements:

- manifest bytes were retrieved;
- SHA-256 declarations matched;
- canonical JSON and profile identity matched;
- pool constructor calldata matched the pinned ABI.

The nested manifest-verification record also preserves these component-scoped false statements and
blockers because manifest retrieval itself performs no RPC calls:

- source publishers are not authenticated;
- deployment transaction receipts are not verified;
- deployment is not approved.

After manifest verification, the deployment-origin verifier MUST use between two and sixteen
distinct configured provider instances. Every provider MUST report Sepolia and agree on, for each
contract:

- an `INVOKE` receipt for the exact declared transaction, with `SUCCEEDED` execution and finality
  satisfying the configured policy;
- exactly one matching UDC event with the layout above;
- the declared block hash and number in both receipt and canonical block;
- inclusion of the transaction in that canonical block; and
- the declared contract class and pinned UDC class at the declared block hash.

The combined deployment evidence records the normalized origin inputs and provider IDs, sets
`deploymentOriginVerified: true`, and removes the manifest component's
`deployment_transactions_unverified` blocker at the combined boundary. It retains
`manifest_publishers_unauthenticated` and `deployment_approval_required`: deterministic address,
receipt, event, inclusion, and class verification do not authenticate the manifest publisher,
approve the selected token source or authorities, establish provider independence, or approve the
deployment for funded use.

The verifier MUST also reject a manifest accepted-block number after the recent block used for the
separate current class-hash check. Neither verifier inspects arbitrary state diffs or authenticates
the manifest host.

## Versioning

Consumers MUST reject unknown schema versions. A schema change requires a new version string,
updated canonical vector, compatibility tests, and an explicit evidence-schema review. Records are
not migrated by guessing missing security fields.
