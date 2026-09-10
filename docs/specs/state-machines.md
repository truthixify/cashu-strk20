# Settlement State Machines

Status: Draft 0.1.

These state machines are stricter than a happy-path demo because the dangerous cases occur when an
external call succeeds but its response is lost. Persist transitions before emitting downstream
events. Every transition must be idempotent.

## Incoming quote states

```text
CREATED
  | observation before expiry
  v
OBSERVED -------- reorg / mismatch --------> CREATED or REJECTED
  | canonical finality
  v
PAID
  | CDK completes blind issuance
  v
ISSUED

CREATED -------- expiry without payment ---> EXPIRED
EXPIRED -------- later value observed ------> LATE_PAYMENT
any pre-issued state -- unrecoverable fault -> OPERATOR_REQUIRED
```

### Meanings

| Internal state | Cashu-facing state | Meaning |
|---|---|---|
| `CREATED` | `UNPAID` | Funding instructions exist; no matching canonical payment |
| `OBSERVED` | `UNPAID` | Matching payment is seen but not final |
| `PAID` | `PAID` | Matching payment is canonical and may authorize issuance |
| `ISSUED` | `ISSUED` | CDK has issued the paid amount |
| `EXPIRED` | `UNPAID`/expired | No accepted payment arrived under expiry policy |
| `LATE_PAYMENT` | not payable | Value arrived outside policy and needs disposition |
| `REJECTED` | `UNPAID` | Evidence was invalid, mismatched, or reorged before payment |
| `OPERATOR_REQUIRED` | unavailable | Safety cannot be established automatically |

### Incoming rules

- `CREATED -> OBSERVED` requires independently discovered exact token, amount, network, and
  attribution evidence. Under `signed_payer`, the recomputed note ID must equal the ID signed into
  the verified payer binding.
- `OBSERVED -> PAID` requires the configured canonical finality rule.
- A paused profile cannot transition `OBSERVED -> PAID`; final evidence remains recorded and the
  request moves to `OPERATOR_REQUIRED`. Unavailable pause state leaves it `OBSERVED` for retry.
- In a single process, the final pause read and `OBSERVED -> PAID` write share a profile activity
  slot. Pause quiescence blocks new funding-finalization slots and drains an active one before pause
  persistence.
- `PAID -> ISSUED` is performed by CDK, not the settlement service.
- `PAID -> CREATED` is forbidden in normal operation. A reorg after `PAID` is a critical incident.
- `ISSUED` is terminal for the quote's issuance accounting.
- `EXPIRED -> LATE_PAYMENT` never auto-mints.
- One chain payment evidence record cannot transition two quotes to `OBSERVED` or `PAID`.
- Partial and overpayment do not accumulate in Draft 0.1.

## Incoming observation evidence

A transition to `OBSERVED` stores enough non-secret evidence to reproduce the decision:

- network and pool deployment identifier;
- token contract;
- exact base-unit amount;
- payment request ID and attribution profile;
- signed expected note reference where the attribution profile requires one;
- observed note and transaction references;
- observed block hash and number;
- observation timestamp and quote expiry;
- verifier version.

Do not store decrypted note plaintext when a stable opaque reference is sufficient.

For RC.6 privacy-pool evidence, `evidence_id` is the ASCII prefix `strk20-note-` followed by the
unpadded base64url encoding of:

```text
SHA-256(UTF-8(network || NUL || canonical_pool_contract || NUL || canonical_note_reference))
```

Starknet felts use lowercase minimal `0x` form before hashing. A gateway-supplied evidence ID that
does not equal this derivation is malformed and cannot enter durable state. This makes textual felt
aliases converge on one globally owned evidence identity.

## Outgoing melt states

```text
UNPAID
  | CDK accepts proofs and calls make_payment
  v
INTENT_RECORDED
  | submit or recover existing submission
  v
PENDING <------------------------------+
  | final canonical payout             | retry / poll / restart
  v                                    |
PAID                                   |
                                       |
PENDING -- ambiguous provider result -> UNKNOWN
UNKNOWN -- payout found --------------> PENDING or PAID
UNKNOWN -- exact final reversion -----> FAILED
PENDING -- exact final reversion -----> FAILED
```

### Meanings

| Internal state | CDK-facing state | Meaning |
|---|---|---|
| `UNPAID` | `UNPAID` | Quote exists; no proofs committed to payout |
| `INTENT_RECORDED` | `PENDING` | Durable unique intent exists; submission may not have started |
| `PENDING` | `PENDING` | Submission or finality is in progress |
| `UNKNOWN` | `UNKNOWN` or `PENDING` | Execution cannot be established; never resubmit blindly |
| `PAID` | `PAID` | Exactly one payout is canonical and final |
| `FAILED` | `FAILED` | Non-execution is proven and CDK recovery is safe |
| `OPERATOR_REQUIRED` | `UNKNOWN` | Automatic recovery cannot preserve safety |

### Outgoing rules

- The CDK quote ID has a unique database constraint and identifies exactly one settlement intent.
- `INTENT_RECORDED` is committed before calling the Starknet SDK or signer.
- One exact signed transaction is encrypted and atomically owned before its first broadcast.
- An expiring durable lease permits one broadcaster for that prepared transaction. A competing
  worker reports `UNKNOWN`; a lost response does not release the lease.
- A retry after preparation, timeout, or restart loads that artifact; it does not invoke the prover
  or signer again for the same intent.
- After lease expiry, a missing transaction permits only exact rebroadcast of the authenticated
  prepared artifact. The configured lease must outlive one RPC attempt and cannot exceed ten
  minutes.
- The signer nonce, transaction hash, and opaque submission ID are unique across payout intents.
- Signed resource bounds and priority tips must satisfy an explicit operator policy before storage.
- The proof facts must bind the exact accepted base block selected under the provider and pool
  validity policy before the payout is signed.
- A retry first loads the existing intent and polls its transaction lineage.
- A timeout after submission transitions to `UNKNOWN`, never directly to `FAILED`.
- `UNKNOWN -> FAILED` requires affirmative proof that the exact prepared payout did not execute and
  cannot execute later. The current concrete proof is unanimous `REVERTED` receipts for that exact
  transaction, matching canonical block membership, and satisfaction of the configured finality
  policy.
- Receipt absence, provider disagreement, timeout, and account nonce movement alone are not proof of
  non-execution.
- The reverted inclusion is stored write-once before `FAILED` is committed. Reverted transactions
  may still consume a Starknet nonce and fee; the fee is not Cashu `total_spent` for a failed melt.
- `PAID` and `FAILED` are terminal under normal operation.
- A post-terminal canonicality or outcome incident is recorded separately and never causes
  automatic replay or a backward accounting transition.
- A paused profile blocks a new intent, private payout preparation, first submission attachment,
  and broadcast. Status reconciliation for an already submitted or terminal payout remains enabled.
- `total_spent` is zero until `PAID` and authoritative only at `PAID`.
- A replacement transaction remains part of the same intent and must be proven not to duplicate the
  original effective payout.

## Event delivery states

Settlement state and CDK event delivery are separate. A final state is persisted first, then an
outbox record is delivered at least once.

```text
READY -> DELIVERING -> DELIVERED
   ^          |
   +----------+ retry after failure
```

The mint-side consumer must be idempotent. Replaying `PaymentReceived`, `PaymentSuccessful`, or
`PaymentFailed` cannot repeat issuance or payout.

## Reconciliation loop

For each non-terminal intent, a reconciliation worker:

1. loads the durable intent and transaction lineage;
2. queries canonical chain state through the configured provider set;
3. validates network, token, destination, amount, and receipt;
4. advances one legal transition or leaves the state unchanged;
5. records evidence and emits an outbox event after commit;
6. applies bounded backoff without losing the intent.

The worker must tolerate restart at every boundary. Tests should inject a crash before and after
each durable write and external call.

## Finality and reorgs

`OBSERVED` and `PENDING` may refer to non-final chain data. The verifier stores block identity and
rechecks canonicality. A reorg before finality returns incoming evidence to an unpaid/rejected state
or keeps a payout pending while its effective result is resolved.

The local transaction observer re-reads a persisted inclusion by its original block number. It emits
`REORGED` only when every configured provider returns the same replacement block hash. If providers
disagree about the canonical hash, block contents, receipt inclusion, note event, invoke sender, or
execution result, it emits `CONFLICTED` or leaves the prior state unchanged after a retryable
provider error. A missing receipt alone is not proof of a reorg.

A reorg or contradictory execution result after the system has reported `PAID` or `FAILED` is a
severity-one incident. A deployment must stop new affected issuance or payouts, preserve evidence,
and require operator review. It must not try to repair the accounting by silently issuing, paying,
or releasing proofs again.

The local payout status adapter handles a reorg or provider conflict before terminal settlement as
`UNKNOWN`. For a terminal intent, `PayoutFinalityMonitor` reobserves the persisted original inclusion
without proving, signing, submitting, or replacing a payout. `PAID` remains healthy only while the
transaction is `FINAL`; `FAILED` remains healthy only while it is `REVERTED`. The monitor records the
first confirmed `REORGED` or contradictory result as a separate incident while leaving terminal
accounting immutable. Provider or RPC ambiguity remains `UNKNOWN` and creates no incident.
`PayoutFinalitySupervisor` can atomically retain the first durable pause for the affected `strk20`
network/token profile from that persisted incident. The pause binds the original intent,
submission, transaction, inclusion, detection time, and observer version but contains no Cashu
quote ID and grants no transaction or resume capability. Healthy, ambiguous, malformed, or failed
checks cannot create a pause.

Entering terminal `PAID` or `FAILED` also creates one durable watch in the same settlement-store
transaction. Due work follows this lease state machine:

```text
ACTIVE due -> LEASED -> ACTIVE healthy (next periodic check)
                    \-> ACTIVE unknown/error (bounded retry)
                    \-> INCIDENT (watch closed, profile pause and alert retained)

PENDING alert -> LEASED -> DELIVERED
                         \-> PENDING (bounded retry)
```

Expired leases are reclaimable and a stale worker cannot acknowledge them. Alert delivery is at
least once; the sink must deduplicate the stable `alertId`. The quote ID is private lookup material
for the monitor and is absent from worker summaries and alert records. The scheduler and dispatcher
have no signer, prover, submission, replacement, or resume capability. Their configured response
deadline multiplied by the maximum batch size must be strictly shorter than the lease. A deadline is
not cancellation: a late supervisor completion remains idempotent and a late alert delivery may be
retried only under the same `alertId`. The runtime invokes the scheduler before the dispatcher, never
overlaps cycles, reports fixed quote-free health state, and waits for an active cycle during
shutdown. An unresolved job-store or worker operation keeps the cycle in progress for external
liveness monitoring. The runtime records its start time so a missing first cycle is distinguishable
from ordinary startup. A read-only health evaluator validates the full snapshot and emits only fixed
status and reason values for stopped, stopping, stale, stalled, and degraded conditions. Its policy
thresholds are deployment inputs; it does not poll, alarm, restart, or attest the observed process.

The admission controller blocks new funding and payout work for that exact method, network, and
token profile. The SQLite store enforces new record creation, first payout-submission attachment,
and incoming payment finalization in the same write transaction as the pause state. It deliberately
does not block evidence collection or reconciliation of an already submitted payout. The CDK
issuance transition must consult the same pause before issuing bearer value. The final local pause
read for both incoming `PAID` finalization and external payout broadcast MUST share their respective
profile activity slots in a single-process deployment. A confirmed incident MUST block both slot
kinds and wait for active funding-finalization and submission callbacks before persisting the pause.
Failure to persist MUST leave the local profile quiescing, and automation MUST NOT resume it. The
in-memory gate does not coordinate separate processes or survive a pre-persistence crash; such
deployments still require shared coordination or external worker quiescence. Independent
health polling, live process supervision and alarm delivery, an idempotent production alert sink
with calibrated deadlines and retention, CDK issuance admission, multi-process quiescence, and
operator resume remain deployment blockers.

## Operator actions

Operator actions are explicit transitions with actor, reason, timestamp, and evidence. Allowed
initial actions are limited to:

- acknowledge and refund a late incoming payment;
- pause a method/network/token profile;
- propose resume after documented incident resolution through a separately reviewed future path;
- attach additional observation evidence;
- mark `OPERATOR_REQUIRED` after automation reaches a safety boundary.

An operator cannot force `PAID` without canonical settlement evidence and cannot erase transition
history.
