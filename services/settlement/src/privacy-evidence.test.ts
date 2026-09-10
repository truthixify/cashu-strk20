import type { PaymentObservationStatus } from "@cashu-strk20/strk20-method";
import { describe, expect, it } from "vitest";

import type { FundingEvidenceReference } from "./gateway.js";
import {
  type CollectedIncomingPrivacyEvidence,
  derivePrivacyEvidenceId,
  IncomingPrivacyEvidenceCollector,
  PrivacyEvidenceConfigurationError,
  PrivacyEvidenceProtocolError,
  type PrivacyEvidenceSource,
  type PrivacyHistorySnapshot,
  type PrivacyNoteSnapshot,
  type PrivacyTransactionObservation,
  STARKNET_PRIVACY_EVIDENCE_VERIFIER,
  STARKNET_PRIVACY_SDK_COMMIT,
  STARKNET_PRIVACY_SDK_VERSION,
  toSignedPayerPaymentObservation,
} from "./privacy-evidence.js";

const FINALITY_POLICY = "starknet_l2_final_v1";

describe("incoming privacy evidence collection", () => {
  it("pins the reviewed SDK source", () => {
    expect(STARKNET_PRIVACY_SDK_VERSION).toBe("0.14.3-rc.6");
    expect(STARKNET_PRIVACY_SDK_COMMIT).toBe("4db755b9512f00b540126737b605472ea2275e15");
  });

  it("correlates a discovered note, history transaction, and finality observation", async () => {
    const source = new FakePrivacyEvidenceSource();
    const evidence = await createCollector(source).collect();

    expect(source.discoveryInput).toEqual({
      network: "SN_SEPOLIA",
      poolContract: "0x123",
      recipientAddress: "0x789",
      tokenContract: "0x456",
      blockIdentifier: "latest",
    });
    expect(source.historyInput).toMatchObject({
      blockReference: "0xabc",
      noteReferences: ["0x11"],
    });
    expect(source.finalityInput).toEqual({
      network: "SN_SEPOLIA",
      transactionReferences: ["0xdef"],
      finalityPolicy: FINALITY_POLICY,
      expectedNoteEvents: [
        {
          transactionReference: "0xdef",
          poolContract: "0x123",
          noteReferences: ["0x11"],
          noteEventValues: [{ noteReference: "0x11", eventValue: "0x1" }],
          senderAddress: "0xaaa",
        },
      ],
    });
    expect(evidence).toEqual([
      {
        network: "SN_SEPOLIA",
        poolContract: "0x123",
        recipientAddress: "0x789",
        senderAddress: "0xaaa",
        tokenContract: "0x456",
        amountBaseUnits: 1_000_000n,
        evidenceId: derivePrivacyEvidenceId("SN_SEPOLIA", "0x123", "0x11"),
        noteReference: "0x11",
        transactionReference: "0xdef",
        blockHash: "0xbeef",
        blockNumber: 42n,
        status: "FINAL",
        finalityPolicy: FINALITY_POLICY,
        verifierVersion: STARKNET_PRIVACY_EVIDENCE_VERIFIER,
        discoveryBlockHash: "0xabc",
      },
    ]);
  });

  it.each<PaymentObservationStatus>(["PENDING", "FINAL", "REORGED", "CONFLICTED"])(
    "preserves the explicit %s finality status",
    async (status) => {
      const source = new FakePrivacyEvidenceSource();
      source.finality = [{ ...defaultFinality(), status }];

      expect((await createCollector(source).collect())[0]?.status).toBe(status);
    },
  );

  it("uses one finality lookup when one transaction creates multiple notes", async () => {
    const source = new FakePrivacyEvidenceSource();
    source.notes = {
      ...source.notes,
      notes: [
        ...source.notes.notes,
        {
          ...defaultNote(),
          amountBaseUnits: 2_000_000n,
          noteReference: "0x12",
        },
      ],
    };
    source.history = {
      ...source.history,
      transactions: [
        ...source.history.transactions,
        {
          noteReference: "0x12",
          transactionReference: "0xdef",
          blockNumber: 42n,
        },
      ],
    };

    const evidence = await createCollector(source).collect();

    expect(evidence).toHaveLength(2);
    expect(source.finalityInput?.transactionReferences).toEqual(["0xdef"]);
    expect(source.finalityInput?.expectedNoteEvents).toEqual([
      {
        transactionReference: "0xdef",
        poolContract: "0x123",
        noteReferences: ["0x11", "0x12"],
        noteEventValues: [
          { noteReference: "0x11", eventValue: "0x1" },
          { noteReference: "0x12", eventValue: "0x1" },
        ],
        senderAddress: "0xaaa",
      },
    ]);
  });

  it("does not query history or finality when discovery is empty", async () => {
    const source = new FakePrivacyEvidenceSource();
    source.notes = { blockReference: "0xabc", notes: [] };

    await expect(createCollector(source).collect()).resolves.toEqual([]);
    expect(source.historyCalls).toBe(0);
    expect(source.finalityCalls).toBe(0);
  });

  it("reobserves persisted evidence without relying on fresh note discovery", async () => {
    const source = new FakePrivacyEvidenceSource();
    source.notes = { blockReference: "0xabc", notes: [] };
    source.finality = [{ ...defaultFinality(), status: "REORGED" }];

    const result = await createCollector(source).reobserve([knownEvidence()]);

    expect(result).toEqual([{ ...knownEvidence(), status: "REORGED" }]);
    expect(source.discoveryInput).toBeUndefined();
    expect(source.historyCalls).toBe(0);
    expect(source.finalityInput).toEqual({
      network: "SN_SEPOLIA",
      transactionReferences: ["0xdef"],
      finalityPolicy: FINALITY_POLICY,
      knownInclusions: [
        {
          transactionReference: "0xdef",
          blockHash: "0xbeef",
          blockNumber: 42n,
        },
      ],
      expectedNoteEvents: [
        {
          transactionReference: "0xdef",
          poolContract: "0x123",
          noteReferences: ["0x11"],
        },
      ],
    });
  });

  it("rejects sparse persisted evidence before finality lookup", async () => {
    const source = new FakePrivacyEvidenceSource();

    await expect(
      createCollector(source).reobserve(new Array<FundingEvidenceReference>(1)),
    ).rejects.toBeInstanceOf(PrivacyEvidenceProtocolError);
    expect(source.finalityCalls).toBe(0);
  });

  it("deduplicates transaction reobservation for multiple persisted notes", async () => {
    const source = new FakePrivacyEvidenceSource();
    const second = knownEvidence({
      evidenceId: derivePrivacyEvidenceId("SN_SEPOLIA", "0x123", "0x12"),
      noteReference: "0x12",
    });

    const result = await createCollector(source).reobserve([second, knownEvidence()]);

    expect(result).toHaveLength(2);
    expect(source.finalityInput?.transactionReferences).toEqual(["0xdef"]);
  });

  it("rejects a reobservation that changes the original inclusion block", async () => {
    const source = new FakePrivacyEvidenceSource();
    source.finality = [{ ...defaultFinality(), blockHash: "0xbad" }];

    await expect(createCollector(source).reobserve([knownEvidence()])).rejects.toBeInstanceOf(
      PrivacyEvidenceProtocolError,
    );
  });

  it("rejects a persisted evidence ID that does not match its note", async () => {
    const source = new FakePrivacyEvidenceSource();

    await expect(
      createCollector(source).reobserve([knownEvidence({ evidenceId: "tampered-evidence" })]),
    ).rejects.toBeInstanceOf(PrivacyEvidenceProtocolError);
    expect(source.finalityCalls).toBe(0);
  });

  it("derives one canonical pool-scoped evidence ID per note", () => {
    const first = derivePrivacyEvidenceId("SN_SEPOLIA", "0x0123", "0x0011");

    expect(first).toBe(derivePrivacyEvidenceId("SN_SEPOLIA", "0x123", "0x11"));
    expect(first).toMatch(/^strk20-note-[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(derivePrivacyEvidenceId("SN_SEPOLIA", "0x124", "0x11"));
    expect(first).not.toBe(derivePrivacyEvidenceId("SN_SEPOLIA", "0x123", "0x12"));
  });

  it.each([
    {
      name: "mainnet",
      config: { network: "SN_MAIN" as const },
    },
    {
      name: "zero pool address",
      config: { poolContract: "0x0" },
    },
    {
      name: "pool address at the Starknet address bound",
      config: { poolContract: `0x${((1n << 251n) - 256n).toString(16)}` },
    },
    {
      name: "blank finality policy",
      config: { finalityPolicy: " " },
    },
  ])("rejects invalid $name configuration", ({ config }) => {
    expect(
      () =>
        new IncomingPrivacyEvidenceCollector(new FakePrivacyEvidenceSource(), {
          ...collectorConfig(),
          ...config,
        }),
    ).toThrowError(PrivacyEvidenceConfigurationError);
  });

  it("rejects duplicate notes before querying history", async () => {
    const source = new FakePrivacyEvidenceSource();
    source.notes = {
      ...source.notes,
      notes: [...source.notes.notes, defaultNote()],
    };

    await expect(createCollector(source).collect()).rejects.toBeInstanceOf(
      PrivacyEvidenceProtocolError,
    );
    expect(source.historyCalls).toBe(0);
  });

  it("rejects a sparse note snapshot before querying history", async () => {
    const source = new FakePrivacyEvidenceSource();
    source.notes = { ...source.notes, notes: new Array(1) };

    await expect(createCollector(source).collect()).rejects.toBeInstanceOf(
      PrivacyEvidenceProtocolError,
    );
    expect(source.historyCalls).toBe(0);
  });

  it.each([
    {
      name: "pool",
      change: { poolContract: "0x999" },
    },
    {
      name: "recipient",
      change: { recipientAddress: "0x999" },
    },
    {
      name: "token",
      change: { tokenContract: "0x999" },
    },
  ])("rejects a note outside the configured $name scope", async ({ change }) => {
    const source = new FakePrivacyEvidenceSource();
    source.notes = {
      ...source.notes,
      notes: [{ ...defaultNote(), ...change }],
    };

    await expect(createCollector(source).collect()).rejects.toBeInstanceOf(
      PrivacyEvidenceProtocolError,
    );
    expect(source.finalityCalls).toBe(0);
  });

  it.each(["0x0", "not-a-felt"])(
    "rejects a malformed public note event value %s",
    async (eventValue) => {
      const source = new FakePrivacyEvidenceSource();
      source.notes = {
        ...source.notes,
        notes: [{ ...defaultNote(), eventValue }],
      };

      await expect(createCollector(source).collect()).rejects.toBeInstanceOf(
        PrivacyEvidenceProtocolError,
      );
      expect(source.finalityCalls).toBe(0);
    },
  );

  it("rejects one transaction attributed to multiple note senders", async () => {
    const source = new FakePrivacyEvidenceSource();
    source.notes = {
      ...source.notes,
      notes: [
        ...source.notes.notes,
        {
          ...defaultNote(),
          senderAddress: "0xaab",
          noteReference: "0x12",
        },
      ],
    };
    source.history = {
      ...source.history,
      transactions: [
        ...source.history.transactions,
        { noteReference: "0x12", transactionReference: "0xdef", blockNumber: 42n },
      ],
    };

    await expect(createCollector(source).collect()).rejects.toBeInstanceOf(
      PrivacyEvidenceProtocolError,
    );
    expect(source.finalityCalls).toBe(0);
  });

  it("rejects history from a different discovery snapshot", async () => {
    const source = new FakePrivacyEvidenceSource();
    source.history = { ...source.history, blockReference: "0xabd" };

    await expect(createCollector(source).collect()).rejects.toBeInstanceOf(
      PrivacyEvidenceProtocolError,
    );
    expect(source.finalityCalls).toBe(0);
  });

  it.each([
    {
      name: "missing note",
      transactions: [],
    },
    {
      name: "sparse transaction collection",
      transactions: new Array(1),
    },
    {
      name: "unrelated note",
      transactions: [
        {
          noteReference: "0x99",
          transactionReference: "0xdef",
          blockNumber: 42n,
        },
      ],
    },
    {
      name: "duplicate note",
      transactions: [defaultHistoryTransaction(), defaultHistoryTransaction()],
    },
    {
      name: "wrong note block",
      transactions: [{ ...defaultHistoryTransaction(), blockNumber: 43n }],
    },
  ])("rejects history with a $name", async ({ transactions }) => {
    const source = new FakePrivacyEvidenceSource();
    source.history = { ...source.history, transactions };

    await expect(createCollector(source).collect()).rejects.toBeInstanceOf(
      PrivacyEvidenceProtocolError,
    );
    expect(source.finalityCalls).toBe(0);
  });

  it.each([
    {
      name: "missing transaction",
      finality: [],
    },
    {
      name: "sparse observation collection",
      finality: new Array(1),
    },
    {
      name: "unrelated transaction",
      finality: [{ ...defaultFinality(), transactionReference: "0x999" }],
    },
    {
      name: "duplicate transaction",
      finality: [defaultFinality(), defaultFinality()],
    },
    {
      name: "wrong block number",
      finality: [{ ...defaultFinality(), blockNumber: 43n }],
    },
    {
      name: "unknown status",
      finality: [{ ...defaultFinality(), status: "ACCEPTED" as PaymentObservationStatus }],
    },
  ])("rejects finality with a $name", async ({ finality }) => {
    const source = new FakePrivacyEvidenceSource();
    source.finality = finality;

    await expect(createCollector(source).collect()).rejects.toBeInstanceOf(
      PrivacyEvidenceProtocolError,
    );
  });

  it("rejects one transaction mapped to inconsistent history blocks", async () => {
    const source = new FakePrivacyEvidenceSource();
    source.notes = {
      ...source.notes,
      notes: [...source.notes.notes, { ...defaultNote(), noteReference: "0x12", blockNumber: 43n }],
    };
    source.history = {
      ...source.history,
      transactions: [
        defaultHistoryTransaction(),
        { noteReference: "0x12", transactionReference: "0xdef", blockNumber: 43n },
      ],
    };

    await expect(createCollector(source).collect()).rejects.toBeInstanceOf(
      PrivacyEvidenceProtocolError,
    );
    expect(source.finalityCalls).toBe(0);
  });
});

describe("signed payer observation mapping", () => {
  it("maps independently collected evidence for the bound payer and recipient", () => {
    const destination = {
      recipient: "0x789",
      payer_binding: { address: "0xaaa", challenge: "challenge-1" },
    };

    expect(
      toSignedPayerPaymentObservation({
        paymentRequestId: "request-0123456789abcdef",
        expectedPayerAddress: "0x0aaa",
        expectedRecipientAddress: "0x0789",
        expectedNoteReference: "0x0011",
        payerBindingBlockNumber: 41n,
        destination,
        evidence: collectedEvidence(),
      }),
    ).toEqual({
      network: "SN_SEPOLIA",
      pool_contract: "0x123",
      sender_address: "0xaaa",
      recipient_address: "0x789",
      token_contract: "0x456",
      amount_base_units: 1_000_000n,
      payment_request_id: "request-0123456789abcdef",
      attribution_profile: "signed_payer",
      destination,
      evidence_id: derivePrivacyEvidenceId("SN_SEPOLIA", "0x123", "0x11"),
      note_reference: "0x11",
      transaction_reference: "0xdef",
      block_hash: "0xbeef",
      block_number: 42n,
      status: "FINAL",
      finality_policy: FINALITY_POLICY,
      verifier_version: STARKNET_PRIVACY_EVIDENCE_VERIFIER,
    });
  });

  it.each([
    {
      name: "wrong payer",
      change: { expectedPayerAddress: "0xaab" },
    },
    {
      name: "wrong recipient",
      change: { expectedRecipientAddress: "0x788" },
    },
    {
      name: "wrong signed note reference",
      change: { expectedNoteReference: "0x12" },
    },
    {
      name: "unrelated transaction hint",
      change: { transactionHint: "0xdee" },
    },
    {
      name: "malformed transaction hint",
      change: { transactionHint: "not-a-transaction" },
    },
    {
      name: "payment in the payer-binding block",
      change: { payerBindingBlockNumber: 42n },
    },
    {
      name: "payment before the payer binding",
      change: { payerBindingBlockNumber: 43n },
    },
  ])("does not attribute evidence with a $name", ({ change }) => {
    expect(toSignedPayerPaymentObservation({ ...signedPayerInput(), ...change })).toBeNull();
  });

  it("does not let a matching transaction hint override the payer binding", () => {
    expect(
      toSignedPayerPaymentObservation({
        ...signedPayerInput(),
        expectedPayerAddress: "0xaab",
        transactionHint: "0x0def",
      }),
    ).toBeNull();
  });

  it("snapshots the funding destination", () => {
    const destination = { payer_binding: { address: "0xaaa" } };
    const observation = toSignedPayerPaymentObservation({
      ...signedPayerInput(),
      destination,
    });
    destination.payer_binding.address = "0x999";

    expect(observation?.destination).toEqual({ payer_binding: { address: "0xaaa" } });
  });

  it("accepts the coordinator's full payment-request identifier range", () => {
    const paymentRequestId = "a".repeat(512);

    expect(
      toSignedPayerPaymentObservation({ ...signedPayerInput(), paymentRequestId })
        ?.payment_request_id,
    ).toBe(paymentRequestId);
  });

  it("rejects a malformed payment request ID", () => {
    expect(() =>
      toSignedPayerPaymentObservation({ ...signedPayerInput(), paymentRequestId: "not valid" }),
    ).toThrowError(PrivacyEvidenceConfigurationError);
  });

  it.each([-1n, 1n << 64n])("rejects invalid payer-binding block number %s", (blockNumber) => {
    expect(() =>
      toSignedPayerPaymentObservation({
        ...signedPayerInput(),
        payerBindingBlockNumber: blockNumber,
      }),
    ).toThrowError(PrivacyEvidenceConfigurationError);
  });

  it.each(["0x0", "not-a-felt", `0x${STARK_FIELD_PRIME.toString(16)}`])(
    "rejects invalid configured note reference %s",
    (expectedNoteReference) => {
      expect(() =>
        toSignedPayerPaymentObservation({ ...signedPayerInput(), expectedNoteReference }),
      ).toThrowError(PrivacyEvidenceConfigurationError);
    },
  );

  it.each([
    {
      name: "derived evidence ID",
      evidence: collectedEvidence({ evidenceId: "strk20-note-tampered" }),
    },
    {
      name: "reviewed verifier version",
      evidence: collectedEvidence({ verifierVersion: "unknown-verifier" }),
    },
  ])("rejects collected evidence without its $name", ({ evidence }) => {
    expect(() => toSignedPayerPaymentObservation({ ...signedPayerInput(), evidence })).toThrowError(
      PrivacyEvidenceProtocolError,
    );
  });

  it("rejects a sparse public destination array", () => {
    expect(() =>
      toSignedPayerPaymentObservation({
        paymentRequestId: "request-0123456789abcdef",
        expectedPayerAddress: "0x0aaa",
        expectedRecipientAddress: "0x0789",
        expectedNoteReference: "0x0011",
        payerBindingBlockNumber: 41n,
        destination: { route: new Array<string>(1) },
        evidence: collectedEvidence(),
      }),
    ).toThrow(PrivacyEvidenceConfigurationError);
  });
});

function collectorConfig() {
  return {
    network: "SN_SEPOLIA" as const,
    poolContract: "0x0123",
    recipientAddress: "0x0789",
    tokenContract: "0x0456",
    finalityPolicy: FINALITY_POLICY,
  };
}

function createCollector(source: PrivacyEvidenceSource): IncomingPrivacyEvidenceCollector {
  return new IncomingPrivacyEvidenceCollector(source, collectorConfig());
}

function defaultNoteSnapshot(): PrivacyNoteSnapshot {
  return {
    blockReference: "0x00abc",
    notes: [defaultNote()],
  };
}

function defaultNote() {
  return {
    poolContract: "0x0123",
    recipientAddress: "0x0789",
    senderAddress: "0x0aaa",
    tokenContract: "0x0456",
    amountBaseUnits: 1_000_000n,
    noteReference: "0x0011",
    eventValue: "0x01",
    blockNumber: 42n,
  };
}

function defaultHistoryTransaction() {
  return {
    noteReference: "0x11",
    transactionReference: "0x0def",
    blockNumber: 42n,
  };
}

function defaultHistorySnapshot(): PrivacyHistorySnapshot {
  return {
    blockReference: "0xabc",
    transactions: [defaultHistoryTransaction()],
  };
}

function defaultFinality(): PrivacyTransactionObservation {
  return {
    transactionReference: "0x00def",
    blockHash: "0x00beef",
    blockNumber: 42n,
    status: "FINAL",
  };
}

function collectedEvidence(
  change: Partial<CollectedIncomingPrivacyEvidence> = {},
): CollectedIncomingPrivacyEvidence {
  return {
    network: "SN_SEPOLIA",
    poolContract: "0x123",
    recipientAddress: "0x789",
    senderAddress: "0xaaa",
    tokenContract: "0x456",
    amountBaseUnits: 1_000_000n,
    evidenceId: derivePrivacyEvidenceId("SN_SEPOLIA", "0x123", "0x11"),
    noteReference: "0x11",
    transactionReference: "0xdef",
    blockHash: "0xbeef",
    blockNumber: 42n,
    status: "FINAL",
    finalityPolicy: FINALITY_POLICY,
    verifierVersion: STARKNET_PRIVACY_EVIDENCE_VERIFIER,
    discoveryBlockHash: "0xabc",
    ...change,
  };
}

function signedPayerInput() {
  return {
    paymentRequestId: "request-0123456789abcdef",
    expectedPayerAddress: "0xaaa",
    expectedRecipientAddress: "0x789",
    expectedNoteReference: "0x11",
    payerBindingBlockNumber: 41n,
    destination: { payer_binding: { address: "0xaaa", challenge: "challenge-1" } },
    evidence: collectedEvidence(),
  };
}

const STARK_FIELD_PRIME = (1n << 251n) + (17n << 192n) + 1n;

function knownEvidence(change: Partial<FundingEvidenceReference> = {}): FundingEvidenceReference {
  return {
    evidenceId: derivePrivacyEvidenceId("SN_SEPOLIA", "0x123", "0x11"),
    noteReference: "0x11",
    transactionReference: "0xdef",
    blockHash: "0xbeef",
    blockNumber: 42n,
    ...change,
  };
}

class FakePrivacyEvidenceSource implements PrivacyEvidenceSource {
  notes = defaultNoteSnapshot();
  history = defaultHistorySnapshot();
  finality: readonly PrivacyTransactionObservation[] = [defaultFinality()];
  historyCalls = 0;
  finalityCalls = 0;
  discoveryInput: Parameters<PrivacyEvidenceSource["discoverIncomingNotes"]>[0] | undefined;
  historyInput: Parameters<PrivacyEvidenceSource["findNoteTransactions"]>[0] | undefined;
  finalityInput: Parameters<PrivacyEvidenceSource["observeTransactions"]>[0] | undefined;

  async discoverIncomingNotes(
    input: Parameters<PrivacyEvidenceSource["discoverIncomingNotes"]>[0],
  ): Promise<PrivacyNoteSnapshot> {
    this.discoveryInput = structuredClone(input);
    return structuredClone(this.notes);
  }

  async findNoteTransactions(
    input: Parameters<PrivacyEvidenceSource["findNoteTransactions"]>[0],
  ): Promise<PrivacyHistorySnapshot> {
    this.historyCalls += 1;
    this.historyInput = structuredClone(input);
    return structuredClone(this.history);
  }

  async observeTransactions(
    input: Parameters<PrivacyEvidenceSource["observeTransactions"]>[0],
  ): Promise<readonly PrivacyTransactionObservation[]> {
    this.finalityCalls += 1;
    this.finalityInput = structuredClone(input);
    return structuredClone(this.finality);
  }
}
