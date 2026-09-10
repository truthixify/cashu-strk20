import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PaymentObservation } from "@cashu-strk20/strk20-method";
import { describe, expect, it } from "vitest";
import { FundingCoordinator, FundingGatewayProtocolError } from "./funding.js";
import { type FundingRequestStore, InMemoryFundingRequestStore } from "./funding-records.js";
import type {
  FundingDiscoveryInput,
  FundingEvidenceReference,
  FundingInstructionRequest,
} from "./gateway.js";
import {
  InMemoryPayerBindingChallengeStore,
  type PayerBindingChallengeStore,
} from "./payer-binding-records.js";
import type { VerifiedPayerBinding } from "./payer-bindings.js";
import {
  type CollectedIncomingPrivacyEvidence,
  derivePrivacyEvidenceId,
  PrivacyEvidenceProtocolError,
  type ReobservedPrivacyEvidence,
  STARKNET_PRIVACY_EVIDENCE_VERIFIER,
} from "./privacy-evidence.js";
import { InProcessSettlementActivityGate } from "./settlement-activity-gate.js";
import { SettlementAdmissionController } from "./settlement-admission.js";
import { InMemorySettlementPauseStore, type SettlementPauseStore } from "./settlement-pauses.js";
import {
  SignedPayerFundingGatewayConfigurationError,
  type SignedPayerPrivacyEvidenceReader,
  SignedPayerPrivacyFundingGateway,
} from "./signed-payer-funding.js";
import { SqliteSettlementStore } from "./sqlite-store.js";

const NOW_SECONDS = 2_000_000_000;
const PAYMENT_REQUEST_ID = "payer_binding_request_000000000001";
const FINALITY_POLICY = "starknet_l2_final_v1";
const PAYER_BINDING_VERIFIER = "snip12-funding-v2-rev1-snip6-rpc-v1";
const EVIDENCE_ID = derivePrivacyEvidenceId("SN_SEPOLIA", "0x123", "0x11");
const DESTINATION = {
  pool_contract: "0x123",
  recipient_address: "0x789",
  note_reference: "0x11",
};

describe("signed-payer privacy funding gateway", () => {
  it("advertises only the signed-payer attribution profile", () => {
    const profiles = createGateway().supportedAttributionProfiles;

    expect(profiles).toEqual(["signed_payer"]);
    expect(Object.isFrozen(profiles)).toBe(true);
  });

  it("creates minimal deterministic instructions without payer-binding or quote material", async () => {
    const gateway = createGateway();

    const first = await gateway.createFundingInstructions(instructionInput());
    const second = await gateway.createFundingInstructions(instructionInput());

    expect(first).toEqual({
      paymentRequestId: PAYMENT_REQUEST_ID,
      destination: DESTINATION,
    });
    expect(second).toEqual(first);
    expect(JSON.stringify(first.destination)).not.toMatch(/challenge|messageHash|payer|quote/i);

    (first.destination as { pool_contract: string }).pool_contract = "0x999";
    await expect(gateway.createFundingInstructions(instructionInput())).resolves.toEqual({
      paymentRequestId: PAYMENT_REQUEST_ID,
      destination: DESTINATION,
    });
  });

  it.each([
    {
      name: "another attribution profile",
      change: { attributionProfile: "quote_channel" as const },
    },
    {
      name: "another network",
      change: { network: "SN_MAIN" as const },
    },
    {
      name: "another pool",
      change: { poolContract: "0x124" },
    },
    {
      name: "another token",
      change: { tokenContract: "0x457" },
    },
    {
      name: "another amount",
      change: { amountBaseUnits: 2_000_000n },
    },
    {
      name: "another expiry",
      change: { expiresAt: new Date((NOW_SECONDS + 301) * 1_000) },
    },
  ])("rejects instructions with $name", async ({ change }) => {
    await expect(
      createGateway().createFundingInstructions({ ...instructionInput(), ...change }),
    ).rejects.toBeInstanceOf(FundingGatewayProtocolError);
  });

  it("rejects missing or mismatched verified payer bindings", async () => {
    const gateway = createGateway();
    const { verifiedPayerBinding: _binding, ...withoutBinding } = instructionInput();

    await expect(gateway.createFundingInstructions(withoutBinding)).rejects.toBeInstanceOf(
      FundingGatewayProtocolError,
    );
    await expect(
      gateway.findFundingPayments({
        ...discoveryInput(),
        verifiedPayerBinding: verifiedBinding({ poolContract: "0x124" }),
      }),
    ).rejects.toBeInstanceOf(FundingGatewayProtocolError);
  });

  it.each([
    {
      name: "payment request",
      binding: verifiedBinding({ paymentRequestId: "payer_binding_request_000000000002" }),
    },
    {
      name: "recipient",
      binding: verifiedBinding({ recipientAddress: "0x78a" }),
    },
    {
      name: "zero amount",
      binding: verifiedBinding({ amountBaseUnits: 0n }),
    },
    {
      name: "noncanonical payer",
      binding: verifiedBinding({ payerAddress: "0x0aaa" }),
    },
    {
      name: "zero expected note reference",
      binding: verifiedBinding({ expectedNoteReference: "0x0" }),
    },
    {
      name: "short challenge",
      binding: verifiedBinding({ challengeId: "too-short" }),
    },
    {
      name: "zero message hash",
      binding: verifiedBinding({ messageHash: "0x0" }),
    },
    {
      name: "negative block number",
      binding: verifiedBinding({ blockNumber: -1n }),
    },
    {
      name: "expired verification",
      binding: verifiedBinding({ verifiedAt: NOW_SECONDS + 120 }),
    },
    {
      name: "challenge after funding expiry",
      binding: verifiedBinding({ challengeExpiresAt: NOW_SECONDS + 301 }),
    },
    {
      name: "verifier version",
      binding: verifiedBinding({ verifierVersion: "different-verifier" }),
    },
  ])("rejects a binding with invalid $name", async ({ binding }) => {
    await expect(
      createGateway().findFundingPayments({
        ...discoveryInput(),
        verifiedPayerBinding: binding,
      }),
    ).rejects.toBeInstanceOf(FundingGatewayProtocolError);
  });

  it("uses the payer from each independently verified request", async () => {
    const reader = new FakeEvidenceReader();
    reader.fresh = [collectedEvidence({ senderAddress: "0xaab" })];

    await expect(
      createGateway(reader).findFundingPayments(
        discoveryInput({
          verifiedPayerBinding: verifiedBinding({ payerAddress: "0xaab" }),
        }),
      ),
    ).resolves.toEqual([paymentObservation({ sender_address: "0xaab" })]);
  });

  it("maps fresh evidence only for the verified payer and recipient", async () => {
    const reader = new FakeEvidenceReader();
    reader.fresh = [collectedEvidence()];

    await expect(createGateway(reader).findFundingPayments(discoveryInput())).resolves.toEqual([
      paymentObservation(),
    ]);
    expect(reader.reobserveInputs).toEqual([[]]);
    expect(reader.collectCalls).toBe(1);
  });

  it.each([40n, 41n])(
    "does not attribute fresh evidence from block %s at or before binding verification",
    async (blockNumber) => {
      const reader = new FakeEvidenceReader();
      reader.fresh = [collectedEvidence({ blockNumber })];

      await expect(createGateway(reader).findFundingPayments(discoveryInput())).resolves.toEqual(
        [],
      );
    },
  );

  it("keeps wrong amounts visible for conservative request matching", async () => {
    const reader = new FakeEvidenceReader();
    reader.fresh = [collectedEvidence({ amountBaseUnits: 2_000_000n })];

    await expect(createGateway(reader).findFundingPayments(discoveryInput())).resolves.toEqual([
      paymentObservation({ amount_base_units: 2_000_000n }),
    ]);
  });

  it.each([
    {
      name: "another payer",
      evidence: collectedEvidence({ senderAddress: "0xaab" }),
      input: discoveryInput(),
    },
    {
      name: "another signed note reference",
      evidence: collectedEvidence(),
      input: discoveryInput({
        verifiedPayerBinding: verifiedBinding({ expectedNoteReference: "0x12" }),
      }),
    },
    {
      name: "unrelated transaction hint",
      evidence: collectedEvidence(),
      input: discoveryInput({ transactionHint: "0xdee" }),
    },
    {
      name: "malformed transaction hint",
      evidence: collectedEvidence(),
      input: discoveryInput({ transactionHint: "not-a-transaction" }),
    },
  ])("does not attribute fresh evidence with $name", async ({ evidence, input }) => {
    const reader = new FakeEvidenceReader();
    reader.fresh = [evidence];

    await expect(createGateway(reader).findFundingPayments(input)).resolves.toEqual([]);
  });

  it("reobserves a full persisted identity after fresh discovery no longer returns it", async () => {
    const reader = new FakeEvidenceReader();
    reader.reobserved = [
      {
        ...fundingReference(paymentObservation()),
        status: "REORGED",
      },
    ];

    const result = await createGateway(reader).findFundingPayments(
      discoveryInput({ knownEvidence: [paymentObservation({ status: "PENDING" })] }),
    );

    expect(result).toEqual([paymentObservation({ status: "REORGED" })]);
    expect(reader.reobserveInputs).toEqual([[fundingReference(paymentObservation())]]);
  });

  it("reobserves a persisted wrong amount without rewriting it to the requested amount", async () => {
    const reader = new FakeEvidenceReader();
    const wrongAmount = paymentObservation({ amount_base_units: 2_000_000n, status: "PENDING" });
    reader.reobserved = [
      {
        ...fundingReference(wrongAmount),
        status: "FINAL",
      },
    ];

    await expect(
      createGateway(reader).findFundingPayments(discoveryInput({ knownEvidence: [wrongAmount] })),
    ).resolves.toEqual([paymentObservation({ amount_base_units: 2_000_000n, status: "FINAL" })]);
  });

  it("completes coordinator reconciliation from fresh discovery through restart", async () => {
    const reader = new FakeEvidenceReader();
    reader.fresh = [collectedEvidence({ status: "PENDING" })];
    const gateway = createGateway(reader);
    const fundingStore = new InMemoryFundingRequestStore();
    const bindingStore = await verifiedBindingStore();
    const coordinator = fundingCoordinator(fundingStore, bindingStore, gateway);

    await expect(coordinator.ensureFundingRequest(fundingRequest())).resolves.toMatchObject({
      state: "CREATED",
      destination: DESTINATION,
    });
    await expect(
      coordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID }),
    ).resolves.toMatchObject({ state: "OBSERVED", acceptedEvidenceId: EVIDENCE_ID });

    reader.fresh = [];
    reader.reobserved = [
      {
        ...fundingReference(paymentObservation()),
        status: "FINAL",
      },
    ];

    await expect(
      fundingCoordinator(fundingStore, bindingStore, gateway).reconcileFunding({
        paymentRequestId: PAYMENT_REQUEST_ID,
      }),
    ).resolves.toMatchObject({ state: "PAID", acceptedEvidenceId: EVIDENCE_ID });
  });

  it("recovers signed-payer discovery and finalization through a SQLite process restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cashu-strk20-signed-payer-"));
    const databasePath = join(directory, "settlement.sqlite");
    try {
      const initialStore = new SqliteSettlementStore(databasePath);
      try {
        await persistVerifiedBinding(initialStore);
        const initialReader = new FakeEvidenceReader();
        initialReader.fresh = [collectedEvidence({ status: "PENDING" })];
        const initial = fundingCoordinator(
          initialStore,
          initialStore,
          createGateway(initialReader),
          initialStore,
        );

        await expect(initial.ensureFundingRequest(fundingRequest())).resolves.toMatchObject({
          state: "CREATED",
          destination: DESTINATION,
        });
        await expect(
          initial.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID }),
        ).resolves.toMatchObject({ state: "OBSERVED", acceptedEvidenceId: EVIDENCE_ID });
      } finally {
        initialStore.close();
      }

      const restartedStore = new SqliteSettlementStore(databasePath);
      try {
        const restartedReader = new FakeEvidenceReader();
        restartedReader.reobserved = [
          {
            ...fundingReference(paymentObservation()),
            status: "FINAL",
          },
        ];
        const restarted = fundingCoordinator(
          restartedStore,
          restartedStore,
          createGateway(restartedReader),
          restartedStore,
        );

        await expect(
          restarted.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID }),
        ).resolves.toMatchObject({ state: "PAID", acceptedEvidenceId: EVIDENCE_ID });
        expect(restartedReader.reobserveInputs).toEqual([
          [fundingReference(paymentObservation({ status: "PENDING" }))],
        ]);
      } finally {
        restartedStore.close();
      }

      const recoveredStore = new SqliteSettlementStore(databasePath);
      try {
        await expect(
          recoveredStore.getByPaymentRequestId(PAYMENT_REQUEST_ID),
        ).resolves.toMatchObject({
          state: "PAID",
          acceptedEvidenceId: EVIDENCE_ID,
          evidence: [
            {
              matchesRequest: true,
              observation: {
                status: "FINAL",
                note_reference: "0x11",
                transaction_reference: "0xdef",
              },
            },
          ],
        });
      } finally {
        recoveredStore.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("keeps a request unpaid when the payment predates payer-binding verification", async () => {
    const reader = new FakeEvidenceReader();
    reader.fresh = [collectedEvidence({ blockNumber: 41n, status: "FINAL" })];
    const gateway = createGateway(reader);
    const fundingStore = new InMemoryFundingRequestStore();
    const bindingStore = await verifiedBindingStore();
    const coordinator = fundingCoordinator(fundingStore, bindingStore, gateway);
    await coordinator.ensureFundingRequest(fundingRequest());

    await expect(
      coordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID }),
    ).resolves.toEqual({
      paymentRequestId: PAYMENT_REQUEST_ID,
      state: "CREATED",
      destination: DESTINATION,
    });
    await expect(fundingStore.getByPaymentRequestId(PAYMENT_REQUEST_ID)).resolves.toMatchObject({
      state: "CREATED",
      evidence: [],
    });
  });

  it("keeps a wrong-amount observation rejected across coordinator restart", async () => {
    const reader = new FakeEvidenceReader();
    reader.fresh = [collectedEvidence({ amountBaseUnits: 2_000_000n, status: "PENDING" })];
    const gateway = createGateway(reader);
    const fundingStore = new InMemoryFundingRequestStore();
    const bindingStore = await verifiedBindingStore();
    const coordinator = fundingCoordinator(fundingStore, bindingStore, gateway);
    await coordinator.ensureFundingRequest(fundingRequest());

    await expect(
      coordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID }),
    ).resolves.toMatchObject({ state: "REJECTED" });

    reader.fresh = [];
    reader.reobserved = [
      {
        ...fundingReference(paymentObservation({ amount_base_units: 2_000_000n })),
        status: "FINAL",
      },
    ];

    const result = await fundingCoordinator(fundingStore, bindingStore, gateway).reconcileFunding({
      paymentRequestId: PAYMENT_REQUEST_ID,
    });
    expect(result.state).toBe("REJECTED");
    expect(result.acceptedEvidenceId).toBeUndefined();
  });

  it("reobserves persisted evidence even when a new hint names another transaction", async () => {
    const reader = new FakeEvidenceReader();
    reader.reobserved = [
      {
        ...fundingReference(paymentObservation()),
        status: "FINAL",
      },
    ];

    await expect(
      createGateway(reader).findFundingPayments(
        discoveryInput({
          knownEvidence: [paymentObservation({ status: "PENDING" })],
          transactionHint: "0xdee",
        }),
      ),
    ).resolves.toEqual([paymentObservation({ status: "FINAL" })]);
  });

  it("uses canonical reobservation when fresh discovery returns the same evidence", async () => {
    const reader = new FakeEvidenceReader();
    reader.fresh = [collectedEvidence({ status: "FINAL" })];
    reader.reobserved = [
      {
        ...fundingReference(paymentObservation()),
        status: "REORGED",
      },
    ];

    await expect(
      createGateway(reader).findFundingPayments(
        discoveryInput({ knownEvidence: [paymentObservation({ status: "PENDING" })] }),
      ),
    ).resolves.toEqual([paymentObservation({ status: "REORGED" })]);
  });

  it("conflicts fresh evidence that reuses an ID with changed immutable identity", async () => {
    const reader = new FakeEvidenceReader();
    reader.fresh = [collectedEvidence({ amountBaseUnits: 2_000_000n })];
    reader.reobserved = [
      {
        ...fundingReference(paymentObservation()),
        status: "PENDING",
      },
    ];

    await expect(
      createGateway(reader).findFundingPayments(
        discoveryInput({ knownEvidence: [paymentObservation({ status: "PENDING" })] }),
      ),
    ).resolves.toEqual([paymentObservation({ status: "CONFLICTED" })]);
  });

  it("rejects duplicate fresh evidence instead of silently collapsing it", async () => {
    const reader = new FakeEvidenceReader();
    reader.fresh = [collectedEvidence(), collectedEvidence()];

    await expect(
      createGateway(reader).findFundingPayments(discoveryInput()),
    ).rejects.toBeInstanceOf(FundingGatewayProtocolError);
  });

  it("rejects sparse persisted evidence before network reads", async () => {
    const reader = new FakeEvidenceReader();

    await expect(
      createGateway(reader).findFundingPayments(
        discoveryInput({ knownEvidence: new Array<PaymentObservation>(1) }),
      ),
    ).rejects.toBeInstanceOf(FundingGatewayProtocolError);
    expect(reader.reobserveInputs).toEqual([]);
    expect(reader.collectCalls).toBe(0);
  });

  it.each([
    {
      name: "destination",
      known: paymentObservation({ destination: { pool_contract: "0x999" } }),
    },
    {
      name: "payer",
      known: paymentObservation({ sender_address: "0xaab" }),
    },
    {
      name: "note reference",
      known: paymentObservation({ note_reference: "0x12" }),
    },
  ])("rejects persisted evidence with changed $name before network reads", async ({ known }) => {
    const reader = new FakeEvidenceReader();

    await expect(
      createGateway(reader).findFundingPayments(discoveryInput({ knownEvidence: [known] })),
    ).rejects.toBeInstanceOf(FundingGatewayProtocolError);
    expect(reader.reobserveInputs).toEqual([]);
    expect(reader.collectCalls).toBe(0);
  });

  it.each([40n, 41n])(
    "rejects persisted evidence from block %s at or before binding verification",
    async (blockNumber) => {
      const reader = new FakeEvidenceReader();

      await expect(
        createGateway(reader).findFundingPayments(
          discoveryInput({ knownEvidence: [paymentObservation({ block_number: blockNumber })] }),
        ),
      ).rejects.toBeInstanceOf(FundingGatewayProtocolError);
      expect(reader.reobserveInputs).toEqual([]);
      expect(reader.collectCalls).toBe(0);
    },
  );

  it("rejects incomplete or reference-changing reobservation", async () => {
    const missing = new FakeEvidenceReader();
    missing.reobserved = [];
    await expect(
      createGateway(missing).findFundingPayments(
        discoveryInput({ knownEvidence: [paymentObservation()] }),
      ),
    ).rejects.toBeInstanceOf(FundingGatewayProtocolError);

    const changed = new FakeEvidenceReader();
    changed.reobserved = [
      {
        ...fundingReference(paymentObservation()),
        blockHash: "0xbef0",
        status: "FINAL",
      },
    ];
    await expect(
      createGateway(changed).findFundingPayments(
        discoveryInput({ knownEvidence: [paymentObservation()] }),
      ),
    ).rejects.toBeInstanceOf(FundingGatewayProtocolError);
  });

  it("redacts privacy protocol failures but preserves retryable availability failures", async () => {
    const malformed = new FakeEvidenceReader();
    malformed.collectError = new PrivacyEvidenceProtocolError(
      "https://secret-indexer.example/private/path",
    );
    const protocolFailure = createGateway(malformed).findFundingPayments(discoveryInput());
    await expect(protocolFailure).rejects.toBeInstanceOf(FundingGatewayProtocolError);
    await expect(protocolFailure).rejects.not.toThrow(/secret-indexer|private\/path/);

    const unavailable = new FakeEvidenceReader();
    const outage = new Error("Indexer unavailable");
    unavailable.collectError = outage;
    await expect(createGateway(unavailable).findFundingPayments(discoveryInput())).rejects.toBe(
      outage,
    );
  });

  it("returns a completed reobservation when only fresh discovery is unavailable", async () => {
    const reader = new FakeEvidenceReader();
    reader.reobserved = [
      {
        ...fundingReference(paymentObservation()),
        status: "REORGED",
      },
    ];
    reader.collectError = new Error("Indexer unavailable");

    await expect(
      createGateway(reader).findFundingPayments(
        discoveryInput({ knownEvidence: [paymentObservation({ status: "PENDING" })] }),
      ),
    ).resolves.toEqual([paymentObservation({ status: "REORGED" })]);
  });

  it("rejects invalid gateway configuration", () => {
    expect(() => createGateway(new FakeEvidenceReader(), { network: "SN_MAIN" })).toThrowError(
      SignedPayerFundingGatewayConfigurationError,
    );
    expect(() => createGateway(new FakeEvidenceReader(), { poolContract: "0x0" })).toThrowError(
      SignedPayerFundingGatewayConfigurationError,
    );
    expect(() =>
      createGateway(new FakeEvidenceReader(), { recipientAddress: "0x456" }),
    ).toThrowError(SignedPayerFundingGatewayConfigurationError);
    expect(() =>
      createGateway(new FakeEvidenceReader(), { payerBindingVerifierVersion: "" }),
    ).toThrowError(SignedPayerFundingGatewayConfigurationError);
  });
});

function createGateway(
  reader: SignedPayerPrivacyEvidenceReader = new FakeEvidenceReader(),
  change: Partial<{
    network: "SN_SEPOLIA" | "SN_MAIN";
    poolContract: string;
    recipientAddress: string;
    tokenContract: string;
    finalityPolicy: string;
    payerBindingVerifierVersion: string;
  }> = {},
): SignedPayerPrivacyFundingGateway {
  return new SignedPayerPrivacyFundingGateway(reader, {
    network: "SN_SEPOLIA",
    poolContract: "0x0123",
    recipientAddress: "0x0789",
    tokenContract: "0x0456",
    finalityPolicy: FINALITY_POLICY,
    payerBindingVerifierVersion: PAYER_BINDING_VERIFIER,
    ...change,
  });
}

function instructionInput(
  change: Partial<FundingInstructionRequest> = {},
): FundingInstructionRequest {
  return {
    paymentRequestId: PAYMENT_REQUEST_ID,
    network: "SN_SEPOLIA",
    poolContract: "0x123",
    tokenContract: "0x456",
    amountBaseUnits: 1_000_000n,
    expiresAt: new Date((NOW_SECONDS + 300) * 1_000),
    attributionProfile: "signed_payer",
    verifiedPayerBinding: verifiedBinding(),
    ...change,
  };
}

function fundingRequest() {
  const { verifiedPayerBinding: _binding, ...request } = instructionInput();
  return request;
}

function discoveryInput(change: Partial<FundingDiscoveryInput> = {}): FundingDiscoveryInput {
  return {
    paymentRequestId: PAYMENT_REQUEST_ID,
    verifiedPayerBinding: verifiedBinding(),
    knownEvidence: [],
    ...change,
  };
}

function verifiedBinding(change: Partial<VerifiedPayerBinding> = {}): VerifiedPayerBinding {
  return {
    paymentRequestId: PAYMENT_REQUEST_ID,
    challengeId: "challenge_0000000000000000000000000001",
    network: "SN_SEPOLIA",
    poolContract: "0x123",
    recipientAddress: "0x789",
    tokenContract: "0x456",
    expectedNoteReference: "0x11",
    amountBaseUnits: 1_000_000n,
    payerAddress: "0xaaa",
    fundingExpiresAt: NOW_SECONDS + 300,
    challengeExpiresAt: NOW_SECONDS + 120,
    messageHash: "0xabc",
    blockHash: "0xdef",
    blockNumber: 41n,
    verifierVersion: PAYER_BINDING_VERIFIER,
    verifiedAt: NOW_SECONDS,
    ...change,
  };
}

async function verifiedBindingStore(): Promise<PayerBindingChallengeStore> {
  const store = new InMemoryPayerBindingChallengeStore();
  await persistVerifiedBinding(store);
  return store;
}

async function persistVerifiedBinding(store: PayerBindingChallengeStore): Promise<void> {
  const binding = verifiedBinding();
  await store.createOrGetPayerBinding({
    identity: {
      paymentRequestId: binding.paymentRequestId,
      network: binding.network,
      poolContract: binding.poolContract,
      recipientAddress: binding.recipientAddress,
      tokenContract: binding.tokenContract,
      expectedNoteReference: binding.expectedNoteReference,
      amountBaseUnits: binding.amountBaseUnits.toString(),
      payerAddress: binding.payerAddress,
      fundingExpiresAt: binding.fundingExpiresAt,
      challengeExpiresAt: binding.challengeExpiresAt,
    },
    challengeId: binding.challengeId,
  });
  await store.markPayerBindingVerified({
    paymentRequestId: binding.paymentRequestId,
    challengeId: binding.challengeId,
    verification: {
      messageHash: binding.messageHash,
      blockHash: binding.blockHash,
      blockNumber: binding.blockNumber,
      verifierVersion: binding.verifierVersion,
      verifiedAt: binding.verifiedAt,
    },
  });
}

function fundingCoordinator(
  fundingStore: FundingRequestStore,
  bindingStore: PayerBindingChallengeStore,
  gateway: SignedPayerPrivacyFundingGateway,
  pauseStore: SettlementPauseStore = new InMemorySettlementPauseStore(),
): FundingCoordinator {
  return new FundingCoordinator(fundingStore, gateway, {
    network: "SN_SEPOLIA",
    poolContract: "0x123",
    tokenContract: "0x456",
    attributionProfiles: ["signed_payer"],
    minimumAmount: 1n,
    maximumAmount: 10_000n,
    finalityPolicy: FINALITY_POLICY,
    payerBindingRecipientAddress: "0x789",
    payerBindingVerifierVersion: PAYER_BINDING_VERIFIER,
    payerBindingStore: bindingStore,
    admission: new SettlementAdmissionController(pauseStore),
    finalizationGate: new InProcessSettlementActivityGate(),
    now: () => new Date(NOW_SECONDS * 1_000),
  });
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
    evidenceId: EVIDENCE_ID,
    noteReference: "0x11",
    transactionReference: "0xdef",
    blockHash: "0xbeef",
    blockNumber: 42n,
    status: "FINAL",
    finalityPolicy: FINALITY_POLICY,
    verifierVersion: STARKNET_PRIVACY_EVIDENCE_VERIFIER,
    discoveryBlockHash: "0xcafe",
    ...change,
  };
}

function paymentObservation(change: Partial<PaymentObservation> = {}): PaymentObservation {
  return {
    network: "SN_SEPOLIA",
    pool_contract: "0x123",
    sender_address: "0xaaa",
    recipient_address: "0x789",
    token_contract: "0x456",
    amount_base_units: 1_000_000n,
    payment_request_id: PAYMENT_REQUEST_ID,
    attribution_profile: "signed_payer",
    destination: DESTINATION,
    evidence_id: EVIDENCE_ID,
    note_reference: "0x11",
    transaction_reference: "0xdef",
    block_hash: "0xbeef",
    block_number: 42n,
    status: "FINAL",
    finality_policy: FINALITY_POLICY,
    verifier_version: STARKNET_PRIVACY_EVIDENCE_VERIFIER,
    ...change,
  };
}

function fundingReference(observation: PaymentObservation): FundingEvidenceReference {
  return {
    evidenceId: observation.evidence_id,
    noteReference: observation.note_reference,
    transactionReference: observation.transaction_reference,
    blockHash: observation.block_hash,
    blockNumber: observation.block_number,
  };
}

class FakeEvidenceReader implements SignedPayerPrivacyEvidenceReader {
  fresh: readonly CollectedIncomingPrivacyEvidence[] = [];
  reobserved: readonly ReobservedPrivacyEvidence[] | undefined;
  collectError: Error | undefined;
  reobserveError: Error | undefined;
  collectCalls = 0;
  readonly reobserveInputs: FundingEvidenceReference[][] = [];

  async collect(): Promise<readonly CollectedIncomingPrivacyEvidence[]> {
    this.collectCalls += 1;
    if (this.collectError !== undefined) {
      throw this.collectError;
    }
    return this.fresh;
  }

  async reobserve(
    knownEvidence: readonly FundingEvidenceReference[],
  ): Promise<readonly ReobservedPrivacyEvidence[]> {
    this.reobserveInputs.push(structuredClone([...knownEvidence]));
    if (this.reobserveError !== undefined) {
      throw this.reobserveError;
    }
    return this.reobserved ?? knownEvidence.map((reference) => ({ ...reference, status: "FINAL" }));
  }
}
