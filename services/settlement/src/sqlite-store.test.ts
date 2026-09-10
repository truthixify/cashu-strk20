import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { PaymentObservation } from "@cashu-strk20/strk20-method";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FundingEvidenceConflictError, type FundingRequestCandidate } from "./funding-records.js";
import {
  IntentConflictError,
  IntentIntegrityError,
  type SettlementIntentCandidate,
} from "./intents.js";
import {
  PayerBindingAttributionConflictError,
  type PayerBindingChallengeCandidate,
  PayerBindingChallengeConflictError,
} from "./payer-binding-records.js";
import type { PayoutFinalityCheck } from "./payout-finality.js";
import { derivePayoutIncidentAlert } from "./payout-finality-jobs.js";
import { PayoutFinalityScheduler } from "./payout-finality-scheduler.js";
import { PayoutFinalitySupervisor } from "./payout-finality-supervisor.js";
import { InProcessSettlementActivityGate } from "./settlement-activity-gate.js";
import { SettlementProfilePausedError } from "./settlement-admission.js";
import type { SettlementPauseRecord } from "./settlement-pauses.js";
import {
  SettlementStoreCorruptionError,
  SettlementStoreError,
  SqliteSettlementStore,
} from "./sqlite-store.js";

const FIRST_PAYMENT_REQUEST_ID = "funding-request-first";
const SECOND_PAYMENT_REQUEST_ID = "funding-request-second";
const NOW_SECONDS = 2_000_000_000;

describe("SQLite settlement store", () => {
  let directory: string;
  let databasePath: string;
  let stores: SqliteSettlementStore[];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "cashu-strk20-settlement-"));
    databasePath = join(directory, "settlement.sqlite");
    stores = [];
  });

  afterEach(() => {
    for (const store of stores) {
      store.close();
    }
    rmSync(directory, { force: true, recursive: true });
  });

  function openStore(): SqliteSettlementStore {
    const store = new SqliteSettlementStore(databasePath);
    stores.push(store);
    return store;
  }

  it("creates private database and journal files", () => {
    openStore();

    const files = readdirSync(directory);
    expect(files).toEqual(
      expect.arrayContaining([
        "settlement.sqlite",
        "settlement.sqlite-shm",
        "settlement.sqlite-wal",
      ]),
    );
    for (const file of files) {
      expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600);
    }
  });

  it("recovers funding evidence and finalization across restarts", async () => {
    const firstStore = openStore();
    await firstStore.createOrGet(fundingCandidate());
    await firstStore.recordEvidence({
      paymentRequestId: FIRST_PAYMENT_REQUEST_ID,
      observation: observation({ status: "PENDING" }),
      observedAt: NOW_SECONDS,
      matchesRequest: true,
    });
    firstStore.close();

    const secondStore = openStore();
    expect(await secondStore.getByPaymentRequestId(FIRST_PAYMENT_REQUEST_ID)).toMatchObject({
      state: "OBSERVED",
      acceptedEvidenceId: "evidence-first",
      evidence: [{ firstObservedAt: NOW_SECONDS, lastObservedAt: NOW_SECONDS }],
    });
    await secondStore.recordEvidence({
      paymentRequestId: FIRST_PAYMENT_REQUEST_ID,
      observation: observation({ status: "FINAL" }),
      observedAt: NOW_SECONDS + 1,
      matchesRequest: true,
    });
    await secondStore.markPaid(FIRST_PAYMENT_REQUEST_ID, "evidence-first");
    secondStore.close();

    const recovered = await openStore().getByPaymentRequestId(FIRST_PAYMENT_REQUEST_ID);
    expect(recovered).toMatchObject({
      state: "PAID",
      acceptedEvidenceId: "evidence-first",
      evidence: [
        {
          firstObservedAt: NOW_SECONDS,
          lastObservedAt: NOW_SECONDS + 1,
          matchesRequest: true,
          observation: { status: "FINAL" },
        },
      ],
    });
  });

  it("recovers a verified payer binding with its signed-payer funding request", async () => {
    const firstStore = openStore();
    await persistVerifiedPayerBinding(firstStore);
    await firstStore.createOrGet(signedFundingCandidate());
    firstStore.close();

    const recovered = await openStore().getByPaymentRequestId(FIRST_PAYMENT_REQUEST_ID);

    expect(recovered?.identity).toEqual(signedFundingCandidate().identity);
    expect(recovered?.identity.verifiedPayerBinding).toMatchObject({
      amountBaseUnits: 1_000_000n,
      blockNumber: 42n,
      payerAddress: "0xaaa",
    });
  });

  it("rejects signed-payer funding without its durable verified challenge", async () => {
    const store = openStore();

    await expect(store.createOrGet(signedFundingCandidate())).rejects.toBeInstanceOf(
      SettlementStoreError,
    );
    expect(await store.getByPaymentRequestId(FIRST_PAYMENT_REQUEST_ID)).toBeNull();
  });

  it("claims each evidence ID globally across store instances", async () => {
    const firstStore = openStore();
    const secondStore = openStore();
    await firstStore.createOrGet(fundingCandidate());
    await secondStore.createOrGet(fundingCandidate(SECOND_PAYMENT_REQUEST_ID));
    await firstStore.recordEvidence({
      paymentRequestId: FIRST_PAYMENT_REQUEST_ID,
      observation: observation(),
      observedAt: NOW_SECONDS,
      matchesRequest: true,
    });

    await expect(
      secondStore.recordEvidence({
        paymentRequestId: SECOND_PAYMENT_REQUEST_ID,
        observation: observation({ payment_request_id: SECOND_PAYMENT_REQUEST_ID }),
        observedAt: NOW_SECONDS,
        matchesRequest: true,
      }),
    ).rejects.toBeInstanceOf(FundingEvidenceConflictError);
    expect(await secondStore.getByPaymentRequestId(SECOND_PAYMENT_REQUEST_ID)).toMatchObject({
      state: "CREATED",
      evidence: [],
    });
  });

  it("rolls back an evidence claim when the request update fails", async () => {
    const store = openStore();
    await store.createOrGet(fundingCandidate());
    const faultConnection = new DatabaseSync(databasePath);
    faultConnection.exec(`
      CREATE TRIGGER reject_funding_update
      BEFORE UPDATE ON funding_requests
      BEGIN
        SELECT RAISE(ABORT, 'injected update failure');
      END
    `);
    faultConnection.close();

    await expect(
      store.recordEvidence({
        paymentRequestId: FIRST_PAYMENT_REQUEST_ID,
        observation: observation(),
        observedAt: NOW_SECONDS,
        matchesRequest: true,
      }),
    ).rejects.toThrow("injected update failure");

    const repairConnection = new DatabaseSync(databasePath);
    expect(
      repairConnection.prepare("SELECT count(*) AS count FROM funding_evidence").get(),
    ).toMatchObject({ count: 0 });
    repairConnection.exec("DROP TRIGGER reject_funding_update");
    repairConnection.close();
    expect(await store.getByPaymentRequestId(FIRST_PAYMENT_REQUEST_ID)).toMatchObject({
      state: "CREATED",
      evidence: [],
    });
  });

  it("recovers payer challenges and verification evidence across restarts", async () => {
    const firstStore = openStore();
    await firstStore.createOrGetPayerBinding(payerBindingCandidate());
    firstStore.close();

    const secondStore = openStore();
    expect(await secondStore.getPayerBinding(FIRST_PAYMENT_REQUEST_ID)).toMatchObject({
      challengeId: "payer-challenge-first",
      state: "OPEN",
      identity: { payerAddress: "0xaaa" },
    });
    await secondStore.markPayerBindingVerified({
      paymentRequestId: FIRST_PAYMENT_REQUEST_ID,
      challengeId: "payer-challenge-first",
      verification: payerBindingVerification(),
    });
    secondStore.close();

    expect(await openStore().getPayerBinding(FIRST_PAYMENT_REQUEST_ID)).toEqual({
      ...payerBindingRecord(),
      state: "VERIFIED",
      verification: payerBindingVerification(),
    });
  });

  it("claims each payer challenge ID globally across store instances", async () => {
    const firstStore = openStore();
    const secondStore = openStore();
    await firstStore.createOrGetPayerBinding(payerBindingCandidate());

    await expect(
      secondStore.createOrGetPayerBinding(
        payerBindingCandidate(SECOND_PAYMENT_REQUEST_ID, "payer-challenge-first"),
      ),
    ).rejects.toBeInstanceOf(PayerBindingChallengeConflictError);
    expect(await secondStore.getPayerBinding(SECOND_PAYMENT_REQUEST_ID)).toBeNull();
  });

  it("keeps the first durable payer verification across concurrent retries", async () => {
    const firstStore = openStore();
    const secondStore = openStore();
    await firstStore.createOrGetPayerBinding(payerBindingCandidate());

    const [first, second] = await Promise.all([
      firstStore.markPayerBindingVerified({
        paymentRequestId: FIRST_PAYMENT_REQUEST_ID,
        challengeId: "payer-challenge-first",
        verification: payerBindingVerification(),
      }),
      secondStore.markPayerBindingVerified({
        paymentRequestId: FIRST_PAYMENT_REQUEST_ID,
        challengeId: "payer-challenge-first",
        verification: payerBindingVerification({ blockHash: "0x999", blockNumber: 43n }),
      }),
    ]);

    expect(second).toEqual(first);
    expect(first.verification).toEqual(payerBindingVerification());
  });

  it("rejects overlapping indistinguishable verified bindings across store instances", async () => {
    const firstStore = openStore();
    const secondStore = openStore();
    await firstStore.createOrGetPayerBinding(payerBindingCandidate());
    await secondStore.createOrGetPayerBinding(
      payerBindingCandidate(SECOND_PAYMENT_REQUEST_ID, "payer-challenge-second"),
    );
    await firstStore.markPayerBindingVerified({
      paymentRequestId: FIRST_PAYMENT_REQUEST_ID,
      challengeId: "payer-challenge-first",
      verification: payerBindingVerification(),
    });

    await expect(
      secondStore.markPayerBindingVerified({
        paymentRequestId: SECOND_PAYMENT_REQUEST_ID,
        challengeId: "payer-challenge-second",
        verification: payerBindingVerification({ blockHash: "0x999", blockNumber: 43n }),
      }),
    ).rejects.toBeInstanceOf(PayerBindingAttributionConflictError);
    await expect(secondStore.getPayerBinding(SECOND_PAYMENT_REQUEST_ID)).resolves.toMatchObject({
      state: "OPEN",
    });
  });

  it("allows an indistinguishable verified binding at the earlier expiry boundary", async () => {
    const store = openStore();
    await store.createOrGetPayerBinding(payerBindingCandidate());
    await store.createOrGetPayerBinding(
      payerBindingCandidate(SECOND_PAYMENT_REQUEST_ID, "payer-challenge-second", {
        expectedNoteReference: "0x222",
        fundingExpiresAt: NOW_SECONDS + 600,
        challengeExpiresAt: NOW_SECONDS + 420,
      }),
    );
    await store.markPayerBindingVerified({
      paymentRequestId: FIRST_PAYMENT_REQUEST_ID,
      challengeId: "payer-challenge-first",
      verification: payerBindingVerification(),
    });

    await expect(
      store.markPayerBindingVerified({
        paymentRequestId: SECOND_PAYMENT_REQUEST_ID,
        challengeId: "payer-challenge-second",
        verification: payerBindingVerification({
          blockHash: "0x999",
          blockNumber: 43n,
          verifiedAt: NOW_SECONDS + 300,
        }),
      }),
    ).resolves.toMatchObject({ state: "VERIFIED" });
  });

  it("recovers an expired payer challenge without verification evidence", async () => {
    const firstStore = openStore();
    await firstStore.createOrGetPayerBinding(payerBindingCandidate());
    await firstStore.expirePayerBinding(FIRST_PAYMENT_REQUEST_ID, NOW_SECONDS + 120);
    firstStore.close();

    const recovered = await openStore().getPayerBinding(FIRST_PAYMENT_REQUEST_ID);
    expect(recovered).toMatchObject({ state: "EXPIRED" });
    expect(recovered === null ? true : "verification" in recovered).toBe(false);
  });

  it("rejects reuse of a verified note reference after the first funding window", async () => {
    const firstStore = openStore();
    const secondStore = openStore();
    await firstStore.createOrGetPayerBinding(payerBindingCandidate());
    await firstStore.markPayerBindingVerified({
      paymentRequestId: FIRST_PAYMENT_REQUEST_ID,
      challengeId: "payer-challenge-first",
      verification: payerBindingVerification(),
    });
    await secondStore.createOrGetPayerBinding(
      payerBindingCandidate(SECOND_PAYMENT_REQUEST_ID, "payer-challenge-second", {
        fundingExpiresAt: NOW_SECONDS + 600,
        challengeExpiresAt: NOW_SECONDS + 420,
      }),
    );

    await expect(
      secondStore.markPayerBindingVerified({
        paymentRequestId: SECOND_PAYMENT_REQUEST_ID,
        challengeId: "payer-challenge-second",
        verification: payerBindingVerification({
          blockHash: "0x999",
          blockNumber: 43n,
          verifiedAt: NOW_SECONDS + 300,
        }),
      }),
    ).rejects.toBeInstanceOf(PayerBindingAttributionConflictError);
    await expect(secondStore.getPayerBinding(SECOND_PAYMENT_REQUEST_ID)).resolves.toMatchObject({
      state: "OPEN",
    });
  });

  it("scopes verified note-reference uniqueness to one privacy pool", async () => {
    const firstStore = openStore();
    const secondStore = openStore();
    await firstStore.createOrGetPayerBinding(payerBindingCandidate());
    await secondStore.createOrGetPayerBinding(
      payerBindingCandidate(SECOND_PAYMENT_REQUEST_ID, "payer-challenge-second", {
        poolContract: "0x124",
      }),
    );
    await firstStore.markPayerBindingVerified({
      paymentRequestId: FIRST_PAYMENT_REQUEST_ID,
      challengeId: "payer-challenge-first",
      verification: payerBindingVerification(),
    });

    await expect(
      secondStore.markPayerBindingVerified({
        paymentRequestId: SECOND_PAYMENT_REQUEST_ID,
        challengeId: "payer-challenge-second",
        verification: payerBindingVerification({ blockHash: "0x999", blockNumber: 43n }),
      }),
    ).resolves.toMatchObject({
      state: "VERIFIED",
      identity: { poolContract: "0x124", expectedNoteReference: "0x111" },
    });
  });

  it("recovers payout state and transaction lineage across restarts", async () => {
    const firstStore = openStore();
    await firstStore.createOrGet(payoutCandidate());
    await firstStore.attachSubmission("intent-first", "submission-first");
    await firstStore.recordAttempt({
      intentId: "intent-first",
      submissionId: "submission-first",
      status: "PENDING",
      transactionReference: "0xtx-pending",
    });
    firstStore.close();

    const secondStore = openStore();
    expect(await secondStore.getByQuoteId("secret-quote-first")).toMatchObject({
      intentId: "intent-first",
      state: "PENDING",
      submissionId: "submission-first",
      transactionReferences: ["0xtx-pending"],
    });
    await secondStore.recordAttempt({
      intentId: "intent-first",
      submissionId: "submission-first",
      status: "PAID",
      transactionReference: "0xtx-final",
    });
    secondStore.close();

    expect(await openStore().getByQuoteId("secret-quote-first")).toMatchObject({
      state: "PAID",
      transactionReferences: ["0xtx-pending", "0xtx-final"],
    });
  });

  it("enforces quote, intent, and submission uniqueness", async () => {
    const firstStore = openStore();
    const secondStore = openStore();
    await firstStore.createOrGet(payoutCandidate());

    await expect(
      secondStore.createOrGet(
        payoutCandidate("intent-other", "secret-quote-first", { amountBaseUnits: "2000000" }),
      ),
    ).rejects.toBeInstanceOf(IntentConflictError);
    await expect(
      secondStore.createOrGet(payoutCandidate("intent-first", "secret-quote-other")),
    ).rejects.toBeInstanceOf(IntentIntegrityError);

    await firstStore.attachSubmission("intent-first", "submission-first");
    await secondStore.createOrGet(payoutCandidate("intent-second", "secret-quote-second"));
    await expect(
      secondStore.attachSubmission("intent-second", "submission-first"),
    ).rejects.toBeInstanceOf(IntentIntegrityError);
    expect(await firstStore.attachSubmission("intent-first", "submission-retry")).toMatchObject({
      submissionId: "submission-first",
    });
  });

  it("rejects structurally corrupted persisted values", async () => {
    const store = openStore();
    await store.createOrGet(payoutCandidate());
    store.close();

    const corruptionConnection = new DatabaseSync(databasePath);
    corruptionConnection.exec(
      "UPDATE settlement_intents SET destination_json = '[]' WHERE intent_id = 'intent-first'",
    );
    corruptionConnection.close();

    await expect(openStore().getByQuoteId("secret-quote-first")).rejects.toBeInstanceOf(
      SettlementStoreCorruptionError,
    );
  });

  it("rejects accepted evidence that no longer matches its request", async () => {
    const store = openStore();
    await store.createOrGet(fundingCandidate());
    await store.recordEvidence({
      paymentRequestId: FIRST_PAYMENT_REQUEST_ID,
      observation: observation(),
      observedAt: NOW_SECONDS,
      matchesRequest: true,
    });
    await store.markPaid(FIRST_PAYMENT_REQUEST_ID, "evidence-first");
    store.close();

    const corruptionConnection = new DatabaseSync(databasePath);
    corruptionConnection.exec(
      "UPDATE funding_evidence SET token_contract = '0xother' WHERE evidence_id = 'evidence-first'",
    );
    corruptionConnection.close();

    await expect(
      openStore().getByPaymentRequestId(FIRST_PAYMENT_REQUEST_ID),
    ).rejects.toBeInstanceOf(SettlementStoreCorruptionError);
  });

  it("rejects a non-canonical persisted funding address", async () => {
    const store = openStore();
    await store.createOrGet(fundingCandidate());
    store.close();

    const corruptionConnection = new DatabaseSync(databasePath);
    corruptionConnection
      .prepare("UPDATE funding_requests SET pool_contract = ? WHERE payment_request_id = ?")
      .run("0x0123", FIRST_PAYMENT_REQUEST_ID);
    corruptionConnection.close();

    await expect(
      openStore().getByPaymentRequestId(FIRST_PAYMENT_REQUEST_ID),
    ).rejects.toBeInstanceOf(SettlementStoreCorruptionError);
  });

  it.each([
    ["zero", "0x0"],
    ["non-canonical", "0x0aaa"],
    ["out-of-range", `0x${((1n << 251n) - 256n).toString(16)}`],
  ])("rejects %s addresses in non-matching persisted evidence", async (_name, address) => {
    const store = openStore();
    await store.createOrGet(fundingCandidate());
    await store.recordEvidence({
      paymentRequestId: FIRST_PAYMENT_REQUEST_ID,
      observation: observation(),
      observedAt: NOW_SECONDS,
      matchesRequest: false,
    });
    store.close();

    const corruptionConnection = new DatabaseSync(databasePath);
    corruptionConnection
      .prepare("UPDATE funding_evidence SET sender_address = ? WHERE evidence_id = ?")
      .run(address, "evidence-first");
    corruptionConnection.close();

    await expect(
      openStore().getByPaymentRequestId(FIRST_PAYMENT_REQUEST_ID),
    ).rejects.toBeInstanceOf(SettlementStoreCorruptionError);
  });

  it("rejects a payer binding detached from its funding request", async () => {
    const store = openStore();
    await persistVerifiedPayerBinding(store);
    await store.createOrGet(signedFundingCandidate());
    store.close();

    const corruptionConnection = new DatabaseSync(databasePath);
    corruptionConnection.exec(
      "UPDATE funding_requests SET payer_binding_json = json_set(payer_binding_json, '$.payerAddress', '0xaab') WHERE payment_request_id = 'funding-request-first'",
    );
    corruptionConnection.close();

    await expect(
      openStore().getByPaymentRequestId(FIRST_PAYMENT_REQUEST_ID),
    ).rejects.toBeInstanceOf(SettlementStoreCorruptionError);
  });

  it("rejects advanced payout state without a durable submission", async () => {
    const store = openStore();
    await store.createOrGet(payoutCandidate());
    store.close();

    const corruptionConnection = new DatabaseSync(databasePath);
    corruptionConnection.exec(
      "UPDATE settlement_intents SET state = 'PAID' WHERE intent_id = 'intent-first'",
    );
    corruptionConnection.close();

    await expect(openStore().getByQuoteId("secret-quote-first")).rejects.toBeInstanceOf(
      SettlementStoreCorruptionError,
    );
  });

  it("rejects structurally corrupted payer challenge values", async () => {
    const store = openStore();
    await store.createOrGetPayerBinding(payerBindingCandidate());
    store.close();

    const corruptionConnection = new DatabaseSync(databasePath);
    corruptionConnection.exec(
      "UPDATE payer_binding_challenges SET payer_address = '' WHERE payment_request_id = 'funding-request-first'",
    );
    corruptionConnection.close();

    await expect(openStore().getPayerBinding(FIRST_PAYMENT_REQUEST_ID)).rejects.toBeInstanceOf(
      SettlementStoreCorruptionError,
    );
  });

  it("rejects semantically corrupted payer verification evidence", async () => {
    const store = openStore();
    await store.createOrGetPayerBinding(payerBindingCandidate());
    await store.markPayerBindingVerified({
      paymentRequestId: FIRST_PAYMENT_REQUEST_ID,
      challengeId: "payer-challenge-first",
      verification: payerBindingVerification(),
    });
    store.close();

    const corruptionConnection = new DatabaseSync(databasePath);
    corruptionConnection.exec(
      "UPDATE payer_binding_challenges SET message_hash = 'not-a-felt' WHERE payment_request_id = 'funding-request-first'",
    );
    corruptionConnection.close();

    await expect(openStore().getPayerBinding(FIRST_PAYMENT_REQUEST_ID)).rejects.toBeInstanceOf(
      SettlementStoreCorruptionError,
    );
  });

  it("retains the first profile pause across store instances and restarts", async () => {
    const firstStore = openStore();
    await persistTerminalPayout(firstStore);
    const first = settlementPause();
    await expect(firstStore.pause(first)).resolves.toEqual(first);

    const secondStore = openStore();
    await expect(
      secondStore.pause(
        settlementPause({
          reason: "PAYOUT_FINALITY_CONFLICTED",
          intentId: "intent-second",
          submissionId: "submission-second",
          transactionReference: "0x999",
        }),
      ),
    ).resolves.toEqual(first);
    firstStore.close();
    secondStore.close();

    await expect(openStore().getPause(first.profile)).resolves.toEqual(first);
  });

  it("enqueues a terminal payout watch in the terminal-state transaction", async () => {
    const store = openStore();
    await store.createOrGet(payoutCandidate());
    await store.attachSubmission("intent-first", "submission-first");
    await store.recordAttempt({
      intentId: "intent-first",
      submissionId: "submission-first",
      transactionReference: "0xabc",
      status: "PENDING",
    });
    await expect(
      store.claimDuePayoutFinalityWatches({
        leaseId: "nonterminal-lease",
        now: NOW_SECONDS,
        leaseExpiresAt: NOW_SECONDS + 60,
        limit: 10,
      }),
    ).resolves.toEqual([]);
    await store.recordAttempt({
      intentId: "intent-first",
      submissionId: "submission-first",
      transactionReference: "0xabc",
      status: "PAID",
    });
    store.close();

    await expect(
      openStore().claimDuePayoutFinalityWatches({
        leaseId: "terminal-lease",
        now: NOW_SECONDS,
        leaseExpiresAt: NOW_SECONDS + 60,
        limit: 10,
      }),
    ).resolves.toEqual([
      {
        intentId: "intent-first",
        quoteId: "secret-quote-first",
        profile: settlementPause().profile,
        nextCheckAt: 0,
        leaseId: "terminal-lease",
        leaseExpiresAt: NOW_SECONDS + 60,
        consecutiveFailures: 0,
      },
    ]);
  });

  it("rolls back a terminal payout when watch creation fails", async () => {
    const store = openStore();
    await store.createOrGet(payoutCandidate());
    await store.attachSubmission("intent-first", "submission-first");
    await store.recordAttempt({
      intentId: "intent-first",
      submissionId: "submission-first",
      transactionReference: "0xabc",
      status: "PENDING",
    });
    const faultConnection = new DatabaseSync(databasePath);
    faultConnection.exec(`
      CREATE TRIGGER reject_finality_watch_insert
      BEFORE INSERT ON payout_finality_watches
      BEGIN
        SELECT RAISE(ABORT, 'injected watch failure');
      END
    `);
    faultConnection.close();

    await expect(
      store.recordAttempt({
        intentId: "intent-first",
        submissionId: "submission-first",
        transactionReference: "0xabc",
        status: "PAID",
      }),
    ).rejects.toThrow("injected watch failure");
    await expect(store.getByQuoteId("secret-quote-first")).resolves.toMatchObject({
      state: "PENDING",
    });
  });

  it("persists incident alert retry and delivery without storing a quote in the alert", async () => {
    const store = openStore();
    await persistTerminalPayout(store);
    const pause = await store.pause(settlementPause());
    const watches = await store.claimDuePayoutFinalityWatches({
      leaseId: "incident-watch-lease",
      now: NOW_SECONDS,
      leaseExpiresAt: NOW_SECONDS + 60,
      limit: 10,
    });
    await store.recordPayoutIncident({
      intentId: "intent-first",
      leaseId: "incident-watch-lease",
      checkedAt: NOW_SECONDS + 1,
      alert: derivePayoutIncidentAlert(pause),
    });
    expect(watches).toHaveLength(1);
    await expect(
      store.claimDuePayoutFinalityWatches({
        leaseId: "closed-watch-lease",
        now: NOW_SECONDS + 1,
        leaseExpiresAt: NOW_SECONDS + 61,
        limit: 10,
      }),
    ).resolves.toEqual([]);

    const alerts = await store.claimDuePayoutIncidentAlerts({
      leaseId: "first-alert-lease",
      now: NOW_SECONDS + 1,
      leaseExpiresAt: NOW_SECONDS + 61,
      limit: 10,
    });
    expect(alerts).toHaveLength(1);
    expect(
      JSON.stringify(alerts, (_key, value) =>
        typeof value === "bigint" ? value.toString(10) : value,
      ),
    ).not.toContain("secret-quote-first");
    const alertId = alerts[0]?.alertId ?? "";
    await store.retryPayoutIncidentAlert({
      alertId,
      leaseId: "first-alert-lease",
      attemptedAt: NOW_SECONDS + 2,
      nextAttemptAt: NOW_SECONDS + 12,
    });
    store.close();

    const recovered = openStore();
    await expect(
      recovered.claimDuePayoutIncidentAlerts({
        leaseId: "too-early-alert-lease",
        now: NOW_SECONDS + 11,
        leaseExpiresAt: NOW_SECONDS + 71,
        limit: 10,
      }),
    ).resolves.toEqual([]);
    const retried = await recovered.claimDuePayoutIncidentAlerts({
      leaseId: "recovered-alert-lease",
      now: NOW_SECONDS + 12,
      leaseExpiresAt: NOW_SECONDS + 72,
      limit: 10,
    });
    expect(retried).toMatchObject([{ alertId, deliveryAttempts: 1 }]);
    await recovered.completePayoutIncidentAlert({
      alertId,
      leaseId: "recovered-alert-lease",
      deliveredAt: NOW_SECONDS + 13,
    });
    await expect(
      recovered.claimDuePayoutIncidentAlerts({
        leaseId: "delivered-alert-lease",
        now: NOW_SECONDS + 100,
        leaseExpiresAt: NOW_SECONDS + 160,
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });

  it("runs a terminal incident from durable watch through pause and alert outbox", async () => {
    const store = openStore();
    await persistTerminalPayout(store);
    const checkedQuotes: string[] = [];
    const supervisor = new PayoutFinalitySupervisor({
      checker: {
        async checkTerminalPayout(quoteId: string): Promise<PayoutFinalityCheck> {
          checkedQuotes.push(quoteId);
          return {
            intentId: "intent-first",
            submissionId: "submission-first",
            transactionReference: "0xabc",
            network: "SN_SEPOLIA",
            tokenContract: "0x456",
            inclusion: { blockHash: "0xdef", blockNumber: 42n },
            status: "REORGED",
            incident: {
              status: "REORGED",
              detectedAt: "2026-09-01T10:00:00.000Z",
              observerVersion: "observer-v1",
            },
          };
        },
      },
      pauseStore: store,
      pauseQuiescer: new InProcessSettlementActivityGate(),
    });
    const scheduler = new PayoutFinalityScheduler({
      supervisor,
      jobStore: store,
      batchSize: 10,
      leaseSeconds: 60,
      callbackTimeoutMilliseconds: 5_000,
      healthyCheckIntervalSeconds: 300,
      retryBaseSeconds: 10,
      maximumRetrySeconds: 60,
      now: () => new Date(NOW_SECONDS * 1_000),
      createLeaseId: () => "integrated-watch-lease",
    });

    await expect(scheduler.runDue()).resolves.toEqual({
      claimed: 1,
      healthy: 0,
      ambiguous: 0,
      incidents: 1,
      failed: 0,
    });
    expect(checkedQuotes).toEqual(["secret-quote-first"]);
    await expect(store.getPause(settlementPause().profile)).resolves.toEqual(settlementPause());
    await expect(
      store.claimDuePayoutIncidentAlerts({
        leaseId: "integrated-alert-lease",
        now: NOW_SECONDS,
        leaseExpiresAt: NOW_SECONDS + 60,
        limit: 10,
      }),
    ).resolves.toMatchObject([
      {
        pause: {
          profile: settlementPause().profile,
          reason: "PAYOUT_FINALITY_REORGED",
          intentId: "intent-first",
        },
      },
    ]);
  });

  it("blocks new funding and payout records for a paused profile", async () => {
    const store = openStore();
    await persistTerminalPayout(store);
    await store.pause(settlementPause());

    await expect(
      store.createOrGet(fundingCandidate(SECOND_PAYMENT_REQUEST_ID)),
    ).rejects.toBeInstanceOf(SettlementProfilePausedError);
    await expect(
      store.createOrGet(payoutCandidate("intent-second", "secret-quote-second")),
    ).rejects.toBeInstanceOf(SettlementProfilePausedError);
    await expect(store.getByPaymentRequestId(SECOND_PAYMENT_REQUEST_ID)).resolves.toBeNull();
    await expect(store.getByQuoteId("secret-quote-second")).resolves.toBeNull();

    await expect(store.createOrGet(payoutCandidate())).resolves.toMatchObject({
      intentId: "intent-first",
      state: "PAID",
    });
  });

  it("blocks first submission attachment after a profile pause", async () => {
    const store = openStore();
    await store.createOrGet(payoutCandidate("intent-unsubmitted", "secret-quote-unsubmitted"));
    await persistTerminalPayout(store);
    await store.pause(settlementPause());

    await expect(
      store.attachSubmission("intent-unsubmitted", "submission-unsubmitted"),
    ).rejects.toBeInstanceOf(SettlementProfilePausedError);
    const retained = await store.getByQuoteId("secret-quote-unsubmitted");
    expect(retained).toMatchObject({ state: "INTENT_RECORDED" });
    expect(retained).not.toHaveProperty("submissionId");
  });

  it("blocks funding finalization after a profile pause but preserves evidence", async () => {
    const store = openStore();
    await store.createOrGet(fundingCandidate());
    await store.recordEvidence({
      paymentRequestId: FIRST_PAYMENT_REQUEST_ID,
      observation: observation(),
      observedAt: NOW_SECONDS,
      matchesRequest: true,
    });
    await persistTerminalPayout(store);
    await store.pause(settlementPause());

    await expect(store.markPaid(FIRST_PAYMENT_REQUEST_ID, "evidence-first")).rejects.toBeInstanceOf(
      SettlementProfilePausedError,
    );
    await expect(store.getByPaymentRequestId(FIRST_PAYMENT_REQUEST_ID)).resolves.toMatchObject({
      state: "OBSERVED",
      acceptedEvidenceId: "evidence-first",
      evidence: [{ observation: { status: "FINAL" } }],
    });
  });

  it("keeps an already paid funding transition idempotent during a later pause", async () => {
    const store = openStore();
    await store.createOrGet(fundingCandidate());
    await store.recordEvidence({
      paymentRequestId: FIRST_PAYMENT_REQUEST_ID,
      observation: observation(),
      observedAt: NOW_SECONDS,
      matchesRequest: true,
    });
    await store.markPaid(FIRST_PAYMENT_REQUEST_ID, "evidence-first");
    await persistTerminalPayout(store);
    await store.pause(settlementPause());

    await expect(store.markPaid(FIRST_PAYMENT_REQUEST_ID, "evidence-first")).resolves.toMatchObject(
      {
        state: "PAID",
        acceptedEvidenceId: "evidence-first",
      },
    );
  });

  it("rejects a new pause that does not belong to its terminal payout", async () => {
    const store = openStore();
    await persistTerminalPayout(store);

    await expect(
      store.pause(settlementPause({ submissionId: "submission-other" })),
    ).rejects.toThrow("Settlement pause does not match one terminal payout transaction");
    await expect(
      store.pause(
        settlementPause({
          profile: { ...settlementPause().profile, tokenContract: "0x789" },
        }),
      ),
    ).rejects.toThrow("Settlement pause does not match one terminal payout transaction");
    await expect(store.getPause(settlementPause().profile)).resolves.toBeNull();
  });

  it("migrates a note-bound schema through empty pause and finality-job state", async () => {
    const store = openStore();
    await store.createOrGet(payoutCandidate());
    store.close();

    const versionConnection = new DatabaseSync(databasePath);
    versionConnection.exec("DROP TABLE payout_incident_alerts");
    versionConnection.exec("DROP TABLE payout_finality_watches");
    versionConnection.exec("DROP TABLE settlement_pauses");
    versionConnection.exec("PRAGMA user_version = 2");
    versionConnection.close();

    const migrated = openStore();
    await expect(migrated.getByQuoteId("secret-quote-first")).resolves.toMatchObject({
      intentId: "intent-first",
      state: "INTENT_RECORDED",
    });
    await expect(migrated.getPause(settlementPause().profile)).resolves.toBeNull();
    migrated.close();

    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    expect(inspection.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 4 });
    inspection.close();
  });

  it("migrates profile-pause schema and backfills terminal payout watches", async () => {
    const store = openStore();
    await persistTerminalPayout(store);
    store.close();

    const versionConnection = new DatabaseSync(databasePath);
    versionConnection.exec("DROP TABLE payout_incident_alerts");
    versionConnection.exec("DROP TABLE payout_finality_watches");
    versionConnection.exec("PRAGMA user_version = 3");
    versionConnection.close();

    const migrated = openStore();
    await expect(
      migrated.claimDuePayoutFinalityWatches({
        leaseId: "migration-lease",
        now: NOW_SECONDS,
        leaseExpiresAt: NOW_SECONDS + 60,
        limit: 10,
      }),
    ).resolves.toEqual([
      {
        intentId: "intent-first",
        quoteId: "secret-quote-first",
        profile: settlementPause().profile,
        nextCheckAt: 0,
        leaseId: "migration-lease",
        leaseExpiresAt: NOW_SECONDS + 60,
        consecutiveFailures: 0,
      },
    ]);
  });

  it("rejects a semantically corrupted persisted pause", async () => {
    const store = openStore();
    await persistTerminalPayout(store);
    await store.pause(settlementPause());
    store.close();

    const corruptionConnection = new DatabaseSync(databasePath);
    corruptionConnection.exec(
      "UPDATE settlement_pauses SET original_block_number = '18446744073709551616'",
    );
    corruptionConnection.close();

    await expect(openStore().getPause(settlementPause().profile)).rejects.toBeInstanceOf(
      SettlementStoreCorruptionError,
    );
  });

  it("refuses a database with an unsupported schema version", () => {
    const store = openStore();
    store.close();
    const versionConnection = new DatabaseSync(databasePath);
    versionConnection.exec("PRAGMA user_version = 99");
    versionConnection.close();

    expect(() => openStore()).toThrowError(SettlementStoreError);
  });

  it("fails closed on the legacy payer-binding schema", () => {
    const store = openStore();
    store.close();
    const versionConnection = new DatabaseSync(databasePath);
    versionConnection.exec("PRAGMA user_version = 1");
    versionConnection.close();

    expect(() => openStore()).toThrow(/payer bindings without note-bound attribution/);
  });

  it("fails closed when the verified-note uniqueness constraint is missing", () => {
    const store = openStore();
    store.close();
    const corruptionConnection = new DatabaseSync(databasePath);
    corruptionConnection.exec("DROP INDEX verified_payer_note_reference_unique");
    corruptionConnection.close();

    expect(() => openStore()).toThrowError(SettlementStoreCorruptionError);
  });

  it("fails closed when the settlement pause table is missing", () => {
    const store = openStore();
    store.close();
    const corruptionConnection = new DatabaseSync(databasePath);
    corruptionConnection.exec("DROP TABLE settlement_pauses");
    corruptionConnection.close();

    expect(() => openStore()).toThrowError(SettlementStoreCorruptionError);
  });

  it("fails closed when a payout finality due index is missing", () => {
    const store = openStore();
    store.close();
    const corruptionConnection = new DatabaseSync(databasePath);
    corruptionConnection.exec("DROP INDEX payout_finality_watch_due_index");
    corruptionConnection.close();

    expect(() => openStore()).toThrowError(SettlementStoreCorruptionError);
  });
});

function fundingCandidate(paymentRequestId = FIRST_PAYMENT_REQUEST_ID): FundingRequestCandidate {
  return {
    identity: {
      paymentRequestId,
      network: "SN_SEPOLIA",
      poolContract: "0x123",
      tokenContract: "0x456",
      amountBaseUnits: "1000000",
      expiresAt: NOW_SECONDS + 300,
      attributionProfile: "quote_channel",
      destination: { channel: `channel:${paymentRequestId}` },
      finalityPolicy: "starknet_l2_final_v1",
    },
  };
}

function settlementPause(overrides: Partial<SettlementPauseRecord> = {}): SettlementPauseRecord {
  return {
    profile: {
      method: "strk20",
      network: "SN_SEPOLIA",
      tokenContract: "0x456",
    },
    reason: "PAYOUT_FINALITY_REORGED",
    intentId: "intent-first",
    submissionId: "submission-first",
    transactionReference: "0xabc",
    originalInclusion: { blockHash: "0xdef", blockNumber: 42n },
    detectedAt: "2026-09-01T10:00:00.000Z",
    observerVersion: "observer-v1",
    ...overrides,
  };
}

function observation(change: Partial<PaymentObservation> = {}): PaymentObservation {
  return {
    network: "SN_SEPOLIA",
    pool_contract: "0x123",
    sender_address: "0xaaa",
    recipient_address: "0x789",
    token_contract: "0x456",
    amount_base_units: 1_000_000n,
    payment_request_id: FIRST_PAYMENT_REQUEST_ID,
    attribution_profile: "quote_channel",
    destination: { channel: `channel:${FIRST_PAYMENT_REQUEST_ID}` },
    evidence_id: "evidence-first",
    note_reference: "note-first",
    transaction_reference: "transaction-first",
    block_hash: "0xblock",
    block_number: 123n,
    status: "FINAL",
    finality_policy: "starknet_l2_final_v1",
    verifier_version: "test-verifier-v1",
    ...change,
  };
}

function signedFundingCandidate(): FundingRequestCandidate {
  return {
    identity: {
      ...fundingCandidate().identity,
      attributionProfile: "signed_payer",
      destination: {
        pool_contract: "0x123",
        recipient_address: "0x789",
        note_reference: "0x111",
      },
      verifiedPayerBinding: {
        paymentRequestId: FIRST_PAYMENT_REQUEST_ID,
        challengeId: "payer-challenge-first",
        network: "SN_SEPOLIA",
        poolContract: "0x123",
        recipientAddress: "0x789",
        tokenContract: "0x456",
        expectedNoteReference: "0x111",
        amountBaseUnits: 1_000_000n,
        payerAddress: "0xaaa",
        fundingExpiresAt: NOW_SECONDS + 300,
        challengeExpiresAt: NOW_SECONDS + 120,
        messageHash: "0xabc",
        blockHash: "0xdef",
        blockNumber: 42n,
        verifierVersion: "snip12-funding-v2-rev1-snip6-rpc-v1",
        verifiedAt: NOW_SECONDS,
      },
    },
  };
}

function payerBindingCandidate(
  paymentRequestId = FIRST_PAYMENT_REQUEST_ID,
  challengeId = "payer-challenge-first",
  identityChange: Partial<PayerBindingChallengeCandidate["identity"]> = {},
): PayerBindingChallengeCandidate {
  return {
    identity: {
      paymentRequestId,
      network: "SN_SEPOLIA",
      poolContract: "0x123",
      recipientAddress: "0x789",
      tokenContract: "0x456",
      expectedNoteReference: "0x111",
      amountBaseUnits: "1000000",
      payerAddress: "0xaaa",
      fundingExpiresAt: NOW_SECONDS + 300,
      challengeExpiresAt: NOW_SECONDS + 120,
      ...identityChange,
    },
    challengeId,
  };
}

function payerBindingRecord() {
  return {
    identity: payerBindingCandidate().identity,
    challengeId: "payer-challenge-first",
    state: "OPEN" as const,
  };
}

function payerBindingVerification(
  change: Partial<{
    messageHash: string;
    blockHash: string;
    blockNumber: bigint;
    verifierVersion: string;
    verifiedAt: number;
  }> = {},
) {
  return {
    messageHash: "0xabc",
    blockHash: "0xdef",
    blockNumber: 42n,
    verifierVersion: "snip12-funding-v2-rev1-snip6-rpc-v1",
    verifiedAt: NOW_SECONDS,
    ...change,
  };
}

async function persistVerifiedPayerBinding(store: SqliteSettlementStore): Promise<void> {
  await store.createOrGetPayerBinding(payerBindingCandidate());
  await store.markPayerBindingVerified({
    paymentRequestId: FIRST_PAYMENT_REQUEST_ID,
    challengeId: "payer-challenge-first",
    verification: payerBindingVerification(),
  });
}

async function persistTerminalPayout(store: SqliteSettlementStore): Promise<void> {
  await store.createOrGet(payoutCandidate());
  await store.attachSubmission("intent-first", "submission-first");
  await store.recordAttempt({
    intentId: "intent-first",
    submissionId: "submission-first",
    transactionReference: "0xabc",
    status: "PENDING",
  });
  await store.recordAttempt({
    intentId: "intent-first",
    submissionId: "submission-first",
    transactionReference: "0xabc",
    status: "PAID",
  });
}

function payoutCandidate(
  intentId = "intent-first",
  quoteId = "secret-quote-first",
  identityChange: Partial<SettlementIntentCandidate["identity"]> = {},
): SettlementIntentCandidate {
  return {
    intentId,
    identity: {
      quoteId,
      network: "SN_SEPOLIA",
      tokenContract: "0x456",
      amountBaseUnits: "1000000",
      expiresAt: NOW_SECONDS + 300,
      destination: { recipient: "0x789", pool: "0x123" },
      ...identityChange,
    },
  };
}
