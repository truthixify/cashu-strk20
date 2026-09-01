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
  attribution evidence.
- `OBSERVED -> PAID` requires the configured canonical finality rule.
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
- opaque note or transaction reference;
- observed block hash and number;
- observation timestamp and quote expiry;
- verifier version.

Do not store decrypted note plaintext when a stable opaque reference is sufficient.

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
UNKNOWN -- non-execution proven ------> FAILED
PENDING -- permanent non-execution ---> FAILED
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
- A retry first loads the existing intent and polls its transaction lineage.
- A timeout after submission transitions to `UNKNOWN`, never directly to `FAILED`.
- `UNKNOWN -> FAILED` requires affirmative proof that no effective payout can execute.
- `PAID` and `FAILED` are terminal under normal operation.
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

A reorg after the system has reported `PAID` is a severity-one incident. The implementation stops
new affected issuance or payouts, preserves evidence, and requires operator review. It must not try
to repair the accounting by silently issuing or paying again.

## Operator actions

Operator actions are explicit transitions with actor, reason, timestamp, and evidence. Allowed
initial actions are limited to:

- acknowledge and refund a late incoming payment;
- pause a method/network/token profile;
- resume after a documented incident resolution;
- attach additional observation evidence;
- mark `OPERATOR_REQUIRED` after automation reaches a safety boundary.

An operator cannot force `PAID` without canonical settlement evidence and cannot erase transition
history.
