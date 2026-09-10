import { describe, expect, it } from "vitest";

import { InMemorySettlementIntentStore, type SettlementIntentStore } from "./intents.js";
import {
  type FinalPayoutCanonicalObservation,
  type FinalPayoutCanonicalStatus,
  type FinalPayoutCanonicalitySource,
  PayoutFinalityMonitor,
  PayoutFinalityMonitorError,
} from "./payout-finality.js";
import {
  InMemoryPreparedPayoutStore,
  PREPARED_PAYOUT_PAYLOAD_VERSION,
  type PreparedPayoutRecord,
  type PreparedPayoutStore,
} from "./prepared-payouts.js";

const QUOTE_ID = "quote-secret-1";
const INTENT_ID = "intent-1";
const SUBMISSION_ID = "submission-1";
const TRANSACTION_REFERENCE = "0xabc";
const NETWORK = "SN_SEPOLIA";
const TOKEN_CONTRACT = "0x456";
const INCLUSION = { blockHash: "0xdef", blockNumber: 42n } as const;
const DETECTED_AT = "2026-09-01T10:00:00.000Z";

describe("payout finality monitor", () => {
  it("reports a canonical paid payout without changing its terminal state", async () => {
    const harness = await createHarness("FINAL");

    await expect(harness.monitor.checkTerminalPayout(QUOTE_ID)).resolves.toEqual({
      intentId: INTENT_ID,
      submissionId: SUBMISSION_ID,
      transactionReference: TRANSACTION_REFERENCE,
      network: NETWORK,
      tokenContract: TOKEN_CONTRACT,
      inclusion: INCLUSION,
      status: "FINAL",
    });
    await expect(harness.intentStore.getByQuoteId(QUOTE_ID)).resolves.toMatchObject({
      state: "PAID",
    });
    await expect(harness.preparedStore.getByIntentId(INTENT_ID)).resolves.toEqual(
      expect.not.objectContaining({ finalityIncident: expect.anything() }),
    );
  });

  it.each(["PAID", "FAILED"] as const)(
    "keeps provider ambiguity unknown for a %s payout without creating an incident",
    async (terminalState) => {
      const harness = await createHarness(
        "UNKNOWN",
        new InMemoryPreparedPayoutStore(),
        terminalState,
      );

      await expect(harness.monitor.checkTerminalPayout(QUOTE_ID)).resolves.toMatchObject({
        status: "UNKNOWN",
      });
      await expect(harness.preparedStore.getByIntentId(INTENT_ID)).resolves.toEqual(
        expect.not.objectContaining({ finalityIncident: expect.anything() }),
      );
    },
  );

  it("reports a canonical reverted payout without changing failed accounting", async () => {
    const harness = await createHarness("REVERTED", new InMemoryPreparedPayoutStore(), "FAILED");

    await expect(harness.monitor.checkTerminalPayout(QUOTE_ID)).resolves.toMatchObject({
      status: "REVERTED",
    });
    await expect(harness.intentStore.getByQuoteId(QUOTE_ID)).resolves.toMatchObject({
      state: "FAILED",
    });
    await expect(harness.preparedStore.getByIntentId(INTENT_ID)).resolves.toEqual(
      expect.not.objectContaining({ finalityIncident: expect.anything() }),
    );
  });

  it.each([
    { terminalState: "PAID", observedStatus: "REVERTED" },
    { terminalState: "FAILED", observedStatus: "FINAL" },
  ] as const)(
    "records a conflict when $terminalState accounting contradicts $observedStatus chain state",
    async ({ terminalState, observedStatus }) => {
      const harness = await createHarness(
        observedStatus,
        new InMemoryPreparedPayoutStore(),
        terminalState,
      );

      await expect(harness.monitor.checkTerminalPayout(QUOTE_ID)).resolves.toMatchObject({
        status: "CONFLICTED",
        incident: { status: "CONFLICTED" },
      });
      await expect(harness.intentStore.getByQuoteId(QUOTE_ID)).resolves.toMatchObject({
        state: terminalState,
      });
    },
  );

  it.each([
    { terminalState: "PAID", status: "REORGED" },
    { terminalState: "PAID", status: "CONFLICTED" },
    { terminalState: "FAILED", status: "REORGED" },
    { terminalState: "FAILED", status: "CONFLICTED" },
  ] as const)(
    "records a separate $status incident while $terminalState accounting stays immutable",
    async ({ terminalState, status }) => {
      const harness = await createHarness(status, new InMemoryPreparedPayoutStore(), terminalState);

      await expect(harness.monitor.checkTerminalPayout(QUOTE_ID)).resolves.toEqual({
        intentId: INTENT_ID,
        submissionId: SUBMISSION_ID,
        transactionReference: TRANSACTION_REFERENCE,
        network: NETWORK,
        tokenContract: TOKEN_CONTRACT,
        inclusion: INCLUSION,
        status,
        incident: {
          status,
          detectedAt: DETECTED_AT,
          observerVersion: "observer-v1",
        },
      });
      await expect(harness.intentStore.getByQuoteId(QUOTE_ID)).resolves.toMatchObject({
        state: terminalState,
      });
    },
  );

  it("returns the first incident without another network observation", async () => {
    const harness = await createHarness("REORGED");
    await harness.monitor.checkTerminalPayout(QUOTE_ID);
    harness.source.status = "CONFLICTED";

    await expect(harness.monitor.checkTerminalPayout(QUOTE_ID)).resolves.toMatchObject({
      status: "REORGED",
      incident: {
        status: "REORGED",
        detectedAt: DETECTED_AT,
        observerVersion: "observer-v1",
      },
    });
    expect(harness.source.calls).toEqual([SUBMISSION_ID]);
  });

  it("recovers when incident persistence succeeds but its response is lost", async () => {
    const delegate = new InMemoryPreparedPayoutStore();
    const preparedStore = new ThrowAfterIncidentPreparedPayoutStore(delegate);
    const harness = await createHarness("REORGED", preparedStore);

    await expect(harness.monitor.checkTerminalPayout(QUOTE_ID)).rejects.toThrow(
      "Prepared payout incident response lost",
    );
    await expect(harness.monitor.checkTerminalPayout(QUOTE_ID)).resolves.toMatchObject({
      status: "REORGED",
      incident: { status: "REORGED" },
    });
    expect(harness.source.calls).toEqual([SUBMISSION_ID]);
  });

  it("rejects a source observation for a different transaction without recording it", async () => {
    const harness = await createHarness("REORGED");
    harness.source.transactionReference = "0x999";

    await expect(harness.monitor.checkTerminalPayout(QUOTE_ID)).rejects.toEqual(
      expect.objectContaining({
        name: PayoutFinalityMonitorError.name,
        code: "integrity_failure",
      }),
    );
    await expect(harness.preparedStore.getByIntentId(INTENT_ID)).resolves.toEqual(
      expect.not.objectContaining({ finalityIncident: expect.anything() }),
    );
  });

  it("refuses to monitor a payout that has not reached a terminal state", async () => {
    const intentStore = new InMemorySettlementIntentStore();
    await intentStore.createOrGet({
      intentId: INTENT_ID,
      identity: settlementIdentity(),
    });
    const preparedStore = new InMemoryPreparedPayoutStore();
    const source = new FakeFinalitySource("FINAL");
    const monitor = createMonitor(intentStore, preparedStore, source);

    await expect(monitor.checkTerminalPayout(QUOTE_ID)).rejects.toMatchObject({
      code: "not_terminal",
    });
    expect(source.calls).toHaveLength(0);
  });

  it("rejects a settlement-store result bound to a different quote", async () => {
    const harness = await createHarness("FINAL");
    const mismatched = new MismatchedQuoteSettlementIntentStore(harness.intentStore);
    const monitor = new PayoutFinalityMonitor({
      intentStore: mismatched,
      preparedStore: harness.preparedStore,
      source: harness.source,
      observerVersion: "observer-v1",
      now: () => new Date(DETECTED_AT),
    });

    await expect(monitor.checkTerminalPayout(QUOTE_ID)).rejects.toMatchObject({
      code: "integrity_failure",
    });
    expect(harness.source.calls).toHaveLength(0);
  });

  it("does not convert a source failure into a canonicality incident", async () => {
    const harness = await createHarness("REORGED");
    harness.source.throwOnObserve = true;

    await expect(harness.monitor.checkTerminalPayout(QUOTE_ID)).rejects.toThrow(
      "Source unavailable",
    );
    await expect(harness.preparedStore.getByIntentId(INTENT_ID)).resolves.toEqual(
      expect.not.objectContaining({ finalityIncident: expect.anything() }),
    );
  });
});

interface Harness {
  readonly intentStore: InMemorySettlementIntentStore;
  readonly preparedStore: PreparedPayoutStore;
  readonly source: FakeFinalitySource;
  readonly monitor: PayoutFinalityMonitor;
}

async function createHarness(
  status: FinalPayoutCanonicalStatus,
  preparedStore: PreparedPayoutStore = new InMemoryPreparedPayoutStore(),
  terminalState: "FAILED" | "PAID" = "PAID",
): Promise<Harness> {
  const intentStore = new InMemorySettlementIntentStore();
  await intentStore.createOrGet({ intentId: INTENT_ID, identity: settlementIdentity() });
  await intentStore.attachSubmission(INTENT_ID, SUBMISSION_ID);
  await intentStore.recordAttempt({
    intentId: INTENT_ID,
    submissionId: SUBMISSION_ID,
    transactionReference: TRANSACTION_REFERENCE,
    status: "PENDING",
  });
  await intentStore.recordAttempt({
    intentId: INTENT_ID,
    submissionId: SUBMISSION_ID,
    transactionReference: TRANSACTION_REFERENCE,
    status: terminalState,
  });
  await preparedStore.createOrGet(preparedPayout());
  await preparedStore.recordInclusion({
    submissionId: SUBMISSION_ID,
    transactionReference: TRANSACTION_REFERENCE,
    ...INCLUSION,
  });
  const source = new FakeFinalitySource(status);
  return {
    intentStore,
    preparedStore,
    source,
    monitor: createMonitor(intentStore, preparedStore, source),
  };
}

function createMonitor(
  intentStore: InMemorySettlementIntentStore,
  preparedStore: PreparedPayoutStore,
  source: FinalPayoutCanonicalitySource,
): PayoutFinalityMonitor {
  return new PayoutFinalityMonitor({
    intentStore,
    preparedStore,
    source,
    observerVersion: "observer-v1",
    now: () => new Date(DETECTED_AT),
  });
}

function settlementIdentity() {
  return {
    quoteId: QUOTE_ID,
    network: NETWORK,
    tokenContract: TOKEN_CONTRACT,
    amountBaseUnits: "1000000",
    expiresAt: 2_000_000_300,
    destination: { pool: "0x123", recipient: "0x789" },
  };
}

function preparedPayout(): PreparedPayoutRecord {
  return {
    payloadVersion: PREPARED_PAYOUT_PAYLOAD_VERSION,
    intentId: INTENT_ID,
    submissionId: SUBMISSION_ID,
    requestDigest: `sha256:${"a".repeat(64)}`,
    adapterVersion: "adapter-v1",
    senderAddress: "0x123",
    nonce: "0x1",
    transactionReference: TRANSACTION_REFERENCE,
    encryptedTransaction: {
      algorithm: "A256GCM",
      keyId: "test-key-1",
      initializationVector: "AAAAAAAAAAAAAAAA",
      ciphertext: "YQ",
      authenticationTag: "AAAAAAAAAAAAAAAAAAAAAA",
    },
  };
}

class FakeFinalitySource implements FinalPayoutCanonicalitySource {
  readonly calls: string[] = [];
  transactionReference = TRANSACTION_REFERENCE;
  throwOnObserve = false;

  constructor(public status: FinalPayoutCanonicalStatus) {}

  async reobserveFinalPayout(submissionId: string): Promise<FinalPayoutCanonicalObservation> {
    this.calls.push(submissionId);
    if (this.throwOnObserve) {
      throw new Error("Source unavailable");
    }
    return {
      intentId: INTENT_ID,
      submissionId: SUBMISSION_ID,
      transactionReference: this.transactionReference,
      inclusion: { ...INCLUSION },
      status: this.status,
    };
  }
}

class ThrowAfterIncidentPreparedPayoutStore implements PreparedPayoutStore {
  #throwAfterIncident = true;

  constructor(readonly delegate: PreparedPayoutStore) {}

  getByIntentId(intentId: string) {
    return this.delegate.getByIntentId(intentId);
  }

  getBySubmissionId(submissionId: string) {
    return this.delegate.getBySubmissionId(submissionId);
  }

  createOrGet(candidate: Parameters<PreparedPayoutStore["createOrGet"]>[0]) {
    return this.delegate.createOrGet(candidate);
  }

  claimSubmission(candidate: Parameters<PreparedPayoutStore["claimSubmission"]>[0]) {
    return this.delegate.claimSubmission(candidate);
  }

  recordInclusion(candidate: Parameters<PreparedPayoutStore["recordInclusion"]>[0]) {
    return this.delegate.recordInclusion(candidate);
  }

  async recordFinalityIncident(
    candidate: Parameters<PreparedPayoutStore["recordFinalityIncident"]>[0],
  ) {
    const stored = await this.delegate.recordFinalityIncident(candidate);
    if (this.#throwAfterIncident) {
      this.#throwAfterIncident = false;
      throw new Error("Prepared payout incident response lost");
    }
    return stored;
  }
}

class MismatchedQuoteSettlementIntentStore implements SettlementIntentStore {
  constructor(readonly delegate: SettlementIntentStore) {}

  async getByQuoteId(quoteId: string) {
    const record = await this.delegate.getByQuoteId(quoteId);
    return record === null
      ? null
      : { ...record, identity: { ...record.identity, quoteId: "different-secret-quote" } };
  }

  createOrGet(candidate: Parameters<SettlementIntentStore["createOrGet"]>[0]) {
    return this.delegate.createOrGet(candidate);
  }

  attachSubmission(
    intentId: string,
    submissionId: string,
  ): ReturnType<SettlementIntentStore["attachSubmission"]> {
    return this.delegate.attachSubmission(intentId, submissionId);
  }

  recordAttempt(
    attempt: Parameters<SettlementIntentStore["recordAttempt"]>[0],
  ): ReturnType<SettlementIntentStore["recordAttempt"]> {
    return this.delegate.recordAttempt(attempt);
  }
}
