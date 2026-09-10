import type { AttributionProfile, PaymentObservation } from "@cashu-strk20/strk20-method";
import { describe, expect, it } from "vitest";

import {
  FundingConfigurationError,
  FundingCoordinator,
  FundingCoordinatorIntegrityError,
  FundingGatewayProtocolError,
  FundingValidationError,
  generatePaymentRequestId,
} from "./funding.js";
import {
  FundingIntegrityError,
  FundingRequestConflictError,
  type FundingRequestStore,
  InMemoryFundingRequestStore,
} from "./funding-records.js";
import type {
  FundingDiscoveryInput,
  FundingInstructionRequest,
  FundingInstructions,
  FundingRequestInput,
  PayoutAttempt,
  PayoutPreparationInput,
  PrivateFundingGateway,
  PrivateSettlementGateway,
} from "./gateway.js";
import { InMemoryPayerBindingChallengeStore } from "./payer-binding-records.js";
import type { VerifiedPayerBinding } from "./payer-bindings.js";
import { derivePrivacyEvidenceId } from "./privacy-evidence.js";
import {
  InProcessSettlementActivityGate,
  type SettlementFundingFinalizationGate,
} from "./settlement-activity-gate.js";
import {
  type SettlementAdmissionChecker,
  SettlementAdmissionController,
  SettlementAdmissionUnavailableError,
  SettlementProfilePausedError,
} from "./settlement-admission.js";
import {
  InMemorySettlementPauseStore,
  type SettlementPauseRecord,
  type SettlementProfile,
} from "./settlement-pauses.js";

const NOW_SECONDS = 2_000_000_000;
const FINALITY_POLICY = "starknet_l2_final_v1";
const PAYMENT_REQUEST_ID = "funding_request_0000000000000001";
const SECOND_PAYMENT_REQUEST_ID = "funding_request_0000000000000002";
const DEFAULT_NOTE_REFERENCE = "0x101";
const DEFAULT_EVIDENCE_ID = derivePrivacyEvidenceId("SN_SEPOLIA", "0x123", DEFAULT_NOTE_REFERENCE);
const PROFILE = {
  method: "strk20",
  network: "SN_SEPOLIA",
  tokenContract: "0x456",
} as const;

const request: FundingRequestInput = {
  paymentRequestId: PAYMENT_REQUEST_ID,
  network: "SN_SEPOLIA",
  poolContract: "0x0123",
  tokenContract: "0x0456",
  amountBaseUnits: 1_000_000n,
  expiresAt: new Date((NOW_SECONDS + 300) * 1_000),
  attributionProfile: "quote_channel",
};

describe("funding coordination", () => {
  it("generates a base64url payment request ID from 256 random bits", () => {
    expect(generatePaymentRequestId()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("creates idempotent quote-channel instructions without exposing a Cashu quote ID", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    const coordinator = createCoordinator(store, gateway);

    const first = await coordinator.ensureFundingRequest(request);
    const retried = await coordinator.ensureFundingRequest(request);

    expect(first).toEqual(retried);
    expect(first).toMatchObject({
      paymentRequestId: PAYMENT_REQUEST_ID,
      state: "CREATED",
      destination: destinationFor(PAYMENT_REQUEST_ID),
    });
    expect(JSON.stringify(first)).not.toContain("cashu-quote");
    expect(gateway.createCalls).toBe(1);
    expect(gateway.lastFundingRequest).toMatchObject({
      poolContract: "0x123",
      tokenContract: "0x456",
    });
    expect(request.poolContract).toBe("0x0123");
  });

  it("blocks new funding instructions while the settlement profile is paused", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    const pauseStore = new InMemorySettlementPauseStore();
    await pauseStore.pause(pauseRecord("0x456"));
    const coordinator = createCoordinator(
      store,
      gateway,
      NOW_SECONDS,
      new SettlementAdmissionController(pauseStore),
    );

    await expect(coordinator.ensureFundingRequest(request)).rejects.toBeInstanceOf(
      SettlementProfilePausedError,
    );
    expect(gateway.createCalls).toBe(0);
    expect(await store.getByPaymentRequestId(PAYMENT_REQUEST_ID)).toBeNull();
  });

  it("routes final funding evidence to operator review when the profile pauses", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    const pauseStore = new InMemorySettlementPauseStore();
    const coordinator = createCoordinator(
      store,
      gateway,
      NOW_SECONDS,
      new SettlementAdmissionController(pauseStore),
    );
    await coordinator.ensureFundingRequest(request);
    await pauseStore.pause(pauseRecord("0x456"));
    gateway.observations = [observation()];

    const result = await coordinator.reconcileFunding({
      paymentRequestId: PAYMENT_REQUEST_ID,
    });

    expect(result).toMatchObject({
      state: "OPERATOR_REQUIRED",
      acceptedEvidenceId: DEFAULT_EVIDENCE_ID,
      operatorReason: "settlement_profile_paused",
    });
    expect((await store.getByPaymentRequestId(PAYMENT_REQUEST_ID))?.evidence).toHaveLength(1);
  });

  it("retains final funding evidence as observed when admission state is unavailable", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    let available = true;
    const admission: SettlementAdmissionChecker = {
      async assertActive() {
        if (!available) {
          throw new SettlementAdmissionUnavailableError();
        }
      },
    };
    const coordinator = createCoordinator(store, gateway, NOW_SECONDS, admission);
    await coordinator.ensureFundingRequest(request);
    available = false;
    gateway.observations = [observation()];

    const result = await coordinator.reconcileFunding({
      paymentRequestId: PAYMENT_REQUEST_ID,
    });

    expect(result).toMatchObject({ state: "OBSERVED", acceptedEvidenceId: DEFAULT_EVIDENCE_ID });
    expect(result).not.toHaveProperty("operatorReason");
  });

  it("routes final evidence to operator review when pause quiescence wins admission", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    const gate = new InProcessSettlementActivityGate();
    const pauseStore = new InMemorySettlementPauseStore();
    const persistRelease = deferred<void>();
    const coordinator = createCoordinator(
      store,
      gateway,
      NOW_SECONDS,
      new SettlementAdmissionController(pauseStore),
      gate,
    );
    await coordinator.ensureFundingRequest(request);
    gateway.observations = [observation()];

    const pause = gate.quiesceForPause(PROFILE, async () => {
      await persistRelease.promise;
      return pauseStore.pause(pauseRecord("0x456"));
    });
    const result = await coordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID });

    expect(result).toMatchObject({
      state: "OPERATOR_REQUIRED",
      acceptedEvidenceId: DEFAULT_EVIDENCE_ID,
      operatorReason: "settlement_activity_blocked",
    });
    await expect(pauseStore.getPause(PROFILE)).resolves.toBeNull();
    persistRelease.resolve();
    await expect(pause).resolves.toMatchObject({ profile: PROFILE });
  });

  it("orders an active funding finalization before pause persistence", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    const gate = new InProcessSettlementActivityGate();
    const finalAdmissionEntered = deferred<void>();
    const finalAdmissionRelease = deferred<void>();
    const events: string[] = [];
    let admissionCalls = 0;
    const admission: SettlementAdmissionChecker = {
      async assertActive() {
        admissionCalls += 1;
        if (admissionCalls === 2) {
          finalAdmissionEntered.resolve();
          await finalAdmissionRelease.promise;
          events.push("finalization:admitted");
        }
      },
    };
    const coordinator = createCoordinator(store, gateway, NOW_SECONDS, admission, gate);
    await coordinator.ensureFundingRequest(request);
    gateway.observations = [observation()];

    const reconciliation = coordinator.reconcileFunding({
      paymentRequestId: PAYMENT_REQUEST_ID,
    });
    await finalAdmissionEntered.promise;
    const pause = gate.quiesceForPause(PROFILE, async () => {
      events.push("pause:persisted");
      return "paused";
    });

    expect(gate.snapshot(PROFILE)).toEqual({
      state: "QUIESCING",
      activeFundingFinalizations: 1,
      activeSubmissions: 0,
      pauseOperationInProgress: true,
    });
    expect(events).toEqual([]);
    finalAdmissionRelease.resolve();
    await expect(reconciliation).resolves.toMatchObject({ state: "PAID" });
    await expect(pause).resolves.toBe("paused");
    expect(events).toEqual(["finalization:admitted", "pause:persisted"]);
  });

  it("rejects a funding finalization gate that skips or repeats its callback", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    const skippedGate: SettlementFundingFinalizationGate = {
      async runFundingFinalization<Result>() {
        return undefined as Result;
      },
    };
    const coordinator = createCoordinator(
      store,
      gateway,
      NOW_SECONDS,
      activeAdmission(),
      skippedGate,
    );
    await coordinator.ensureFundingRequest(request);
    gateway.observations = [observation()];

    await expect(
      coordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID }),
    ).rejects.toBeInstanceOf(FundingCoordinatorIntegrityError);
    await expect(store.getByPaymentRequestId(PAYMENT_REQUEST_ID)).resolves.toMatchObject({
      state: "OBSERVED",
    });

    const repeatedGate: SettlementFundingFinalizationGate = {
      async runFundingFinalization<Result>(
        _profile: SettlementProfile,
        finalization: () => Promise<Result>,
      ) {
        await finalization();
        return finalization();
      },
    };
    const repeatedCoordinator = createCoordinator(
      store,
      gateway,
      NOW_SECONDS,
      activeAdmission(),
      repeatedGate,
    );
    await expect(
      repeatedCoordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID }),
    ).rejects.toBeInstanceOf(FundingCoordinatorIntegrityError);
    await expect(store.getByPaymentRequestId(PAYMENT_REQUEST_ID)).resolves.toMatchObject({
      state: "PAID",
    });
  });

  it("rejects non-JSON funding destinations before persistence", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    gateway.destinationOverride = { channel: "channel", amount: 1.5 };

    await expect(
      createCoordinator(store, gateway).ensureFundingRequest(request),
    ).rejects.toBeInstanceOf(FundingGatewayProtocolError);
    expect(await store.getByPaymentRequestId(PAYMENT_REQUEST_ID)).toBeNull();
  });

  it("rejects sparse funding destination arrays before persistence", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    gateway.destinationOverride = { channel: "channel", route: new Array<string>(1) };

    await expect(
      createCoordinator(store, gateway).ensureFundingRequest(request),
    ).rejects.toBeInstanceOf(FundingGatewayProtocolError);
    expect(await store.getByPaymentRequestId(PAYMENT_REQUEST_ID)).toBeNull();
  });

  it("rejects instructions returned for another payment request", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    gateway.instructionPaymentRequestIdOverride = SECOND_PAYMENT_REQUEST_ID;

    await expect(
      createCoordinator(store, gateway).ensureFundingRequest(request),
    ).rejects.toBeInstanceOf(FundingGatewayProtocolError);
    expect(await store.getByPaymentRequestId(PAYMENT_REQUEST_ID)).toBeNull();
  });

  it("rejects a retry that mutates immutable funding fields", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    const coordinator = createCoordinator(store, gateway);
    await coordinator.ensureFundingRequest(request);

    await expect(
      coordinator.ensureFundingRequest({ ...request, amountBaseUnits: 2_000_000n }),
    ).rejects.toBeInstanceOf(FundingRequestConflictError);
    expect(gateway.createCalls).toBe(1);
  });

  it("marks only exact independently discovered final evidence paid", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    const coordinator = createCoordinator(store, gateway);
    await coordinator.ensureFundingRequest(request);
    gateway.observations = [observation()];

    const result = await coordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID });
    const stored = await store.getByPaymentRequestId(PAYMENT_REQUEST_ID);

    expect(result).toMatchObject({
      state: "PAID",
      acceptedEvidenceId: DEFAULT_EVIDENCE_ID,
    });
    expect(stored?.evidence).toHaveLength(1);
    expect(stored?.evidence[0]).toMatchObject({
      firstObservedAt: NOW_SECONDS,
      matchesRequest: true,
      observation: { status: "FINAL", verifier_version: "fake-verifier-v1" },
    });
  });

  it("binds signed-payer funding to verified scope and the observed note sender", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    const coordinator = await createSignedPayerCoordinator(store, gateway);
    const signedRequest = {
      ...request,
      attributionProfile: "signed_payer" as const,
    };

    await coordinator.ensureFundingRequest(signedRequest);
    gateway.observations = [
      observation({ attribution_profile: "signed_payer", sender_address: "0x0aaa" }),
    ];
    const paid = await coordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID });

    expect(paid.state).toBe("PAID");
    expect(gateway.lastFundingRequest?.verifiedPayerBinding).toEqual(verifiedPayerBinding());
    expect(gateway.lastDiscoveryInput?.verifiedPayerBinding).toEqual(verifiedPayerBinding());
    expect((await store.getByPaymentRequestId(PAYMENT_REQUEST_ID))?.identity).toMatchObject({
      attributionProfile: "signed_payer",
      verifiedPayerBinding: { payerAddress: "0xaaa", challengeId: "challenge-1" },
    });
  });

  it("persists canonical gateway addresses across equivalent evidence retries", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    const coordinator = await createSignedPayerCoordinator(store, gateway);
    await coordinator.ensureFundingRequest({
      ...request,
      attributionProfile: "signed_payer",
    });
    gateway.observations = [
      observation({
        attribution_profile: "signed_payer",
        pool_contract: "0x0123",
        sender_address: "0x0aaa",
        recipient_address: "0x0789",
        token_contract: "0x0456",
        status: "PENDING",
      }),
    ];

    expect(
      (await coordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID })).state,
    ).toBe("OBSERVED");
    expect(
      (await store.getByPaymentRequestId(PAYMENT_REQUEST_ID))?.evidence[0]?.observation,
    ).toMatchObject({
      pool_contract: "0x123",
      sender_address: "0xaaa",
      recipient_address: "0x789",
      token_contract: "0x456",
    });

    gateway.observations = [observation({ attribution_profile: "signed_payer", status: "FINAL" })];
    expect(
      (await coordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID })).state,
    ).toBe("PAID");
  });

  it("rejects a signed-payer payment from a different note sender", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    const coordinator = await createSignedPayerCoordinator(store, gateway);
    await coordinator.ensureFundingRequest({
      ...request,
      attributionProfile: "signed_payer",
    });
    gateway.observations = [
      observation({ attribution_profile: "signed_payer", sender_address: "0xaab" }),
    ];

    const result = await coordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID });

    expect(result.state).toBe("REJECTED");
    expect(result.acceptedEvidenceId).toBeUndefined();
  });

  it("rejects a signed-payer payment for a different privacy recipient", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    const coordinator = await createSignedPayerCoordinator(store, gateway);
    await coordinator.ensureFundingRequest({
      ...request,
      attributionProfile: "signed_payer",
    });
    gateway.observations = [
      observation({ attribution_profile: "signed_payer", recipient_address: "0x788" }),
    ];

    const result = await coordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID });

    expect(result.state).toBe("REJECTED");
    expect(result.acceptedEvidenceId).toBeUndefined();
  });

  it("rejects a signed-payer payment with a different note reference", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    const coordinator = await createSignedPayerCoordinator(store, gateway);
    await coordinator.ensureFundingRequest({
      ...request,
      attributionProfile: "signed_payer",
    });
    gateway.observations = [
      observation({ attribution_profile: "signed_payer", note_reference: "0x112" }),
    ];

    const result = await coordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID });

    expect(result.state).toBe("REJECTED");
    expect(result.acceptedEvidenceId).toBeUndefined();
  });

  it.each([
    {
      name: "missing binding",
      binding: null,
    },
    {
      name: "another payment request",
      binding: verifiedPayerBinding({ paymentRequestId: SECOND_PAYMENT_REQUEST_ID }),
    },
    {
      name: "another amount",
      binding: verifiedPayerBinding({ amountBaseUnits: 2_000_000n }),
    },
    {
      name: "another recipient",
      binding: verifiedPayerBinding({ recipientAddress: "0x788" }),
    },
    {
      name: "another verifier",
      binding: verifiedPayerBinding({ verifierVersion: "unexpected-verifier" }),
    },
  ])("rejects signed-payer funding with $name", async ({ binding }) => {
    const gateway = new FakeGateway();
    const coordinator = await createSignedPayerCoordinator(
      new InMemoryFundingRequestStore(),
      gateway,
      binding,
    );

    await expect(
      coordinator.ensureFundingRequest({
        ...request,
        attributionProfile: "signed_payer",
      }),
    ).rejects.toMatchObject({ code: "invalid_funding_request" });
    expect(gateway.createCalls).toBe(0);
  });

  it("rediscovers pending evidence after restart and finalizes it after expiry", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    await createCoordinator(store, gateway).ensureFundingRequest(request);
    gateway.observations = [observation({ status: "PENDING" })];

    const observed = await createCoordinator(store, gateway).reconcileFunding({
      paymentRequestId: PAYMENT_REQUEST_ID,
    });
    gateway.observations = [observation({ status: "FINAL" })];
    const restarted = createCoordinator(store, gateway, request.expiresAt.getTime() / 1_000 + 1);
    const paid = await restarted.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID });

    expect(observed.state).toBe("OBSERVED");
    expect(paid.state).toBe("PAID");
    expect(gateway.discoveryCalls).toBe(2);
  });

  it("finishes finalization after a crash persisted final evidence but not paid state", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    const coordinator = createCoordinator(store, gateway);
    await coordinator.ensureFundingRequest(request);
    await store.recordEvidence({
      paymentRequestId: PAYMENT_REQUEST_ID,
      observation: observation(),
      observedAt: NOW_SECONDS,
      matchesRequest: true,
    });
    gateway.observations = [observation({ status: "PENDING" })];

    const recovered = await coordinator.reconcileFunding({
      paymentRequestId: PAYMENT_REQUEST_ID,
    });

    expect(recovered.state).toBe("PAID");
  });

  it("treats a wallet transaction hash only as a discovery hint", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    const coordinator = createCoordinator(store, gateway);
    await coordinator.ensureFundingRequest(request);

    const result = await coordinator.reconcileFunding({
      paymentRequestId: PAYMENT_REQUEST_ID,
      transactionHint: "0xforged-or-unrelated",
    });

    expect(result.state).toBe("CREATED");
    expect(gateway.lastDiscoveryInput?.transactionHint).toBe("0xforged-or-unrelated");
    expect(gateway.lastDiscoveryInput?.knownEvidence).toEqual([]);
  });

  it("passes persisted evidence references to a fresh gateway after restart", async () => {
    const store = new InMemoryFundingRequestStore();
    const firstGateway = new FakeGateway();
    await createCoordinator(store, firstGateway).ensureFundingRequest(request);
    firstGateway.observations = [observation({ status: "PENDING" })];
    await createCoordinator(store, firstGateway).reconcileFunding({
      paymentRequestId: PAYMENT_REQUEST_ID,
    });

    const restartedGateway = new FakeGateway();
    restartedGateway.observations = [observation({ status: "REORGED" })];
    const result = await createCoordinator(store, restartedGateway).reconcileFunding({
      paymentRequestId: PAYMENT_REQUEST_ID,
    });

    expect(restartedGateway.lastDiscoveryInput?.knownEvidence).toEqual([
      observation({ status: "PENDING" }),
    ]);
    expect(result.state).toBe("REJECTED");
  });

  it("rejects a gateway candidate attributed to another payment request", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    const coordinator = createCoordinator(store, gateway);
    await coordinator.ensureFundingRequest(request);
    gateway.observations = [
      observation({
        payment_request_id: SECOND_PAYMENT_REQUEST_ID,
        destination: destinationFor(SECOND_PAYMENT_REQUEST_ID),
      }),
    ];

    await expect(
      coordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID }),
    ).rejects.toBeInstanceOf(FundingGatewayProtocolError);
    expect((await store.getByPaymentRequestId(PAYMENT_REQUEST_ID))?.state).toBe("CREATED");
  });

  it.each([
    { name: "network", change: { network: "SN_MAIN" as const } },
    { name: "pool", change: { pool_contract: "0x999" } },
    { name: "token", change: { token_contract: "0x999" } },
    { name: "amount", change: { amount_base_units: 2_000_000n } },
    { name: "destination", change: { destination: { channel: "attacker-channel" } } },
    { name: "attribution", change: { attribution_profile: "signed_payer" as const } },
  ])("rejects final evidence with the wrong $name", async ({ change }) => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    const coordinator = createCoordinator(store, gateway);
    await coordinator.ensureFundingRequest(request);
    gateway.observations = [observation(change)];

    const result = await coordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID });

    expect(result.state).toBe("REJECTED");
    expect(result.acceptedEvidenceId).toBeUndefined();
  });

  it("can accept exact evidence after rejecting an unrelated candidate", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    const coordinator = createCoordinator(store, gateway);
    await coordinator.ensureFundingRequest(request);
    gateway.observations = [observation({ token_contract: "0x999" })];
    expect(
      (await coordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID })).state,
    ).toBe("REJECTED");

    const secondPayment = observation({ note_reference: "0x102" });
    gateway.observations = [secondPayment];
    const paid = await coordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID });

    expect(paid).toMatchObject({
      state: "PAID",
      acceptedEvidenceId: secondPayment.evidence_id,
    });
  });

  it("prevents two requests racing to claim one evidence ID", async () => {
    const store = new InMemoryFundingRequestStore();
    const firstGateway = new FakeGateway();
    const secondGateway = new FakeGateway();
    const firstCoordinator = createCoordinator(store, firstGateway);
    const secondCoordinator = createCoordinator(store, secondGateway);
    await firstCoordinator.ensureFundingRequest(request);
    await secondCoordinator.ensureFundingRequest({
      ...request,
      paymentRequestId: SECOND_PAYMENT_REQUEST_ID,
    });

    firstGateway.observations = [observation()];
    secondGateway.observations = [
      observation({
        payment_request_id: SECOND_PAYMENT_REQUEST_ID,
        destination: destinationFor(SECOND_PAYMENT_REQUEST_ID),
      }),
    ];
    const results = await Promise.all([
      firstCoordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID }),
      secondCoordinator.reconcileFunding({ paymentRequestId: SECOND_PAYMENT_REQUEST_ID }),
    ]);

    expect(results.map((result) => result.state).sort()).toEqual(["OPERATOR_REQUIRED", "PAID"]);
    expect(results.find((result) => result.state === "OPERATOR_REQUIRED")).toMatchObject({
      state: "OPERATOR_REQUIRED",
      operatorReason: "evidence_claimed_by_another_request",
    });
  });

  it("rejects a second evidence ID that aliases an already claimed privacy note", async () => {
    const store = new InMemoryFundingRequestStore();
    const firstGateway = new FakeGateway();
    const secondGateway = new FakeGateway();
    const firstCoordinator = createCoordinator(store, firstGateway);
    const secondCoordinator = createCoordinator(store, secondGateway);
    await firstCoordinator.ensureFundingRequest(request);
    await secondCoordinator.ensureFundingRequest({
      ...request,
      paymentRequestId: SECOND_PAYMENT_REQUEST_ID,
    });
    const noteReference = "0x101";
    firstGateway.observations = [
      observation({
        note_reference: noteReference,
        evidence_id: derivePrivacyEvidenceId("SN_SEPOLIA", "0x123", noteReference),
      }),
    ];
    secondGateway.observations = [
      observation({
        payment_request_id: SECOND_PAYMENT_REQUEST_ID,
        destination: destinationFor(SECOND_PAYMENT_REQUEST_ID),
        note_reference: noteReference,
        evidence_id: "relabeled-evidence",
      }),
    ];

    await expect(
      firstCoordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID }),
    ).resolves.toMatchObject({ state: "PAID" });
    await expect(
      secondCoordinator.reconcileFunding({ paymentRequestId: SECOND_PAYMENT_REQUEST_ID }),
    ).rejects.toBeInstanceOf(FundingGatewayProtocolError);
    await expect(store.getByPaymentRequestId(SECOND_PAYMENT_REQUEST_ID)).resolves.toMatchObject({
      state: "CREATED",
      evidence: [],
    });
  });

  it("requires operator review when more than one exact payment matches a request", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    const coordinator = createCoordinator(store, gateway);
    await coordinator.ensureFundingRequest(request);
    gateway.observations = [observation(), observation({ note_reference: "0x102" })];

    const result = await coordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID });

    expect(result).toMatchObject({
      state: "OPERATOR_REQUIRED",
      operatorReason: "multiple_matching_payments",
    });
  });

  it("does not expire a request while discovery is unavailable", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    await createCoordinator(store, gateway).ensureFundingRequest(request);
    gateway.throwOnDiscovery = true;
    const afterExpiry = createCoordinator(store, gateway, request.expiresAt.getTime() / 1_000 + 1);

    expect(
      (await afterExpiry.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID })).state,
    ).toBe("CREATED");
    gateway.throwOnDiscovery = false;
    expect(
      (await afterExpiry.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID })).state,
    ).toBe("EXPIRED");
  });

  it("records a payment first discovered after expiry as late", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    await createCoordinator(store, gateway).ensureFundingRequest(request);
    gateway.observations = [observation()];

    const afterExpiry = createCoordinator(store, gateway, request.expiresAt.getTime() / 1_000 + 1);
    const result = await afterExpiry.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID });

    expect(result.state).toBe("LATE_PAYMENT");
    expect(result.acceptedEvidenceId).toBeUndefined();
  });

  it("does not let an earlier rejected candidate bypass late-payment handling", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    const coordinator = createCoordinator(store, gateway);
    await coordinator.ensureFundingRequest(request);
    gateway.observations = [observation({ token_contract: "0x999" })];
    expect(
      (await coordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID })).state,
    ).toBe("REJECTED");

    gateway.observations = [observation({ note_reference: "0x102" })];
    const afterExpiry = createCoordinator(store, gateway, request.expiresAt.getTime() / 1_000 + 1);
    const result = await afterExpiry.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID });

    expect(result.state).toBe("LATE_PAYMENT");
    expect(result.acceptedEvidenceId).toBeUndefined();
  });

  it("requires operator review for provider disagreement", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    const coordinator = createCoordinator(store, gateway);
    await coordinator.ensureFundingRequest(request);
    gateway.observations = [observation({ status: "CONFLICTED" })];

    const result = await coordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID });

    expect(result).toMatchObject({
      state: "OPERATOR_REQUIRED",
      operatorReason: "provider_disagreement",
    });
  });

  it("rejects a reorg before finality", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    const coordinator = createCoordinator(store, gateway);
    await coordinator.ensureFundingRequest(request);
    gateway.observations = [observation({ status: "PENDING" })];
    expect(
      (await coordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID })).state,
    ).toBe("OBSERVED");

    gateway.observations = [observation({ status: "REORGED" })];
    const result = await coordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID });

    expect(result.state).toBe("REJECTED");
  });

  it("escalates a reorg after payment finality", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    const coordinator = createCoordinator(store, gateway);
    await coordinator.ensureFundingRequest(request);
    gateway.observations = [observation()];
    expect(
      (await coordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID })).state,
    ).toBe("PAID");

    gateway.observations = [observation({ status: "REORGED" })];
    const result = await coordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID });

    expect(result).toMatchObject({
      state: "OPERATOR_REQUIRED",
      operatorReason: "reorg_after_payment",
    });
  });

  it("rejects evidence produced under an unexpected finality policy", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    const coordinator = createCoordinator(store, gateway);
    await coordinator.ensureFundingRequest(request);
    gateway.observations = [observation({ finality_policy: "latest_block_only" })];

    await expect(
      coordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID }),
    ).rejects.toBeInstanceOf(FundingGatewayProtocolError);
    expect((await store.getByPaymentRequestId(PAYMENT_REQUEST_ID))?.state).toBe("CREATED");
  });

  it.each([
    { name: "unknown network", change: { network: "SN_UNKNOWN" } },
    { name: "unknown attribution profile", change: { attribution_profile: "wallet_hint" } },
    {
      name: "non-felt note reference",
      change: { note_reference: "note-1", evidence_id: "strk20-note-invalid" },
    },
  ])("rejects $name gateway evidence", async ({ change }) => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    const coordinator = createCoordinator(store, gateway);
    await coordinator.ensureFundingRequest(request);
    gateway.observations = [observation(change as Partial<PaymentObservation>)];

    await expect(
      coordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID }),
    ).rejects.toBeInstanceOf(FundingGatewayProtocolError);
    await expect(store.getByPaymentRequestId(PAYMENT_REQUEST_ID)).resolves.toMatchObject({
      state: "CREATED",
      evidence: [],
    });
  });

  it("rejects duplicate evidence in one gateway scan before changing state", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    const coordinator = createCoordinator(store, gateway);
    await coordinator.ensureFundingRequest(request);
    gateway.observations = [observation(), observation()];

    await expect(
      coordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID }),
    ).rejects.toBeInstanceOf(FundingGatewayProtocolError);
    expect((await store.getByPaymentRequestId(PAYMENT_REQUEST_ID))?.state).toBe("CREATED");
  });

  it("rejects an evidence ID whose immutable identity changes across scans", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    const coordinator = createCoordinator(store, gateway);
    await coordinator.ensureFundingRequest(request);
    gateway.observations = [observation({ status: "PENDING" })];
    await coordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID });

    gateway.observations = [observation({ status: "FINAL", amount_base_units: 2_000_000n })];
    await expect(
      coordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID }),
    ).rejects.toBeInstanceOf(FundingIntegrityError);
    expect(await store.getByPaymentRequestId(PAYMENT_REQUEST_ID)).toMatchObject({
      state: "OBSERVED",
      evidence: [{ observation: { status: "PENDING", amount_base_units: 1_000_000n } }],
    });
  });

  it.each([
    {
      name: "short payment request ID",
      value: { ...request, paymentRequestId: "too-short" },
      code: "invalid_payment_request_id",
    },
    {
      name: "mainnet",
      value: { ...request, network: "SN_MAIN" as const },
      code: "unsupported_network",
    },
    {
      name: "wrong pool",
      value: { ...request, poolContract: "0x999" },
      code: "unsupported_pool",
    },
    {
      name: "wrong token",
      value: { ...request, tokenContract: "0x999" },
      code: "unsupported_token",
    },
    {
      name: "disabled attribution",
      value: { ...request, attributionProfile: "signed_payer" as AttributionProfile },
      code: "unsupported_attribution_profile",
    },
    {
      name: "fractional cent",
      value: { ...request, amountBaseUnits: 10_001n },
      code: "amount_out_of_range",
    },
    {
      name: "amount above policy",
      value: { ...request, amountBaseUnits: 100_010_000n },
      code: "amount_out_of_range",
    },
    {
      name: "fractional-second expiry",
      value: { ...request, expiresAt: new Date(request.expiresAt.getTime() + 1) },
      code: "invalid_funding_request",
    },
  ] as const)("rejects $name before creating instructions", async ({ value, code }) => {
    const gateway = new FakeGateway();
    let error: unknown;

    try {
      await createCoordinator(new InMemoryFundingRequestStore(), gateway).ensureFundingRequest(
        value,
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(FundingValidationError);
    expect((error as FundingValidationError).code).toBe(code);
    expect(gateway.createCalls).toBe(0);
  });

  it("rejects expired new instructions and unsafe configuration", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    await expect(
      createCoordinator(store, gateway).ensureFundingRequest({
        ...request,
        expiresAt: new Date(NOW_SECONDS * 1_000),
      }),
    ).rejects.toMatchObject({ code: "request_expired" });

    expect(
      () =>
        new FundingCoordinator(store, gateway, {
          network: "SN_MAIN",
          poolContract: "0x123",
          tokenContract: "0x456",
          attributionProfiles: ["quote_channel"],
          minimumAmount: 1n,
          maximumAmount: 10_000n,
          finalityPolicy: FINALITY_POLICY,
          admission: activeAdmission(),
          finalizationGate: new InProcessSettlementActivityGate(),
        }),
    ).toThrowError(FundingConfigurationError);
    expect(
      () =>
        new FundingCoordinator(store, gateway, {
          network: "SN_SEPOLIA",
          poolContract: "0x123",
          tokenContract: "0x456",
          attributionProfiles: ["quote_channel"],
          minimumAmount: 1n,
          maximumAmount: 10_000n,
          finalityPolicy: FINALITY_POLICY,
          admission: {} as SettlementAdmissionChecker,
          finalizationGate: new InProcessSettlementActivityGate(),
        }),
    ).toThrowError(FundingConfigurationError);
    expect(
      () =>
        new FundingCoordinator(store, gateway, {
          network: "SN_SEPOLIA",
          poolContract: "0x123",
          tokenContract: "0x456",
          attributionProfiles: ["quote_channel"],
          minimumAmount: 1n,
          maximumAmount: 10_000n,
          finalityPolicy: FINALITY_POLICY,
          admission: activeAdmission(),
          finalizationGate: {} as SettlementFundingFinalizationGate,
        }),
    ).toThrowError(FundingConfigurationError);
  });

  it("rejects an attribution profile the configured funding gateway cannot implement", () => {
    const gateway = new FakeGateway(["signed_payer"]);

    expect(() => createCoordinator(new InMemoryFundingRequestStore(), gateway)).toThrowError(
      new FundingConfigurationError(
        "Configured attribution profile is not supported by the funding gateway",
      ),
    );
    expect(gateway.createCalls).toBe(0);
    expect(gateway.discoveryCalls).toBe(0);
  });

  it("rejects an invalid funding gateway capability declaration", () => {
    const gateway = new FakeGateway(["signed_payer", "signed_payer"]);

    expect(() => createCoordinator(new InMemoryFundingRequestStore(), gateway)).toThrowError(
      new FundingConfigurationError("Configured funding gateway attribution profiles are invalid"),
    );
  });

  it("rejects duplicate configured attribution profiles", () => {
    const gateway = new FakeGateway();

    expect(
      () =>
        new FundingCoordinator(new InMemoryFundingRequestStore(), gateway, {
          network: "SN_SEPOLIA",
          poolContract: "0x123",
          tokenContract: "0x456",
          attributionProfiles: ["quote_channel", "quote_channel"],
          minimumAmount: 1n,
          maximumAmount: 10_000n,
          finalityPolicy: FINALITY_POLICY,
          admission: activeAdmission(),
          finalizationGate: new InProcessSettlementActivityGate(),
        }),
    ).toThrowError(
      new FundingConfigurationError("Configured attribution profiles contain duplicates"),
    );
  });

  it("does not expose mutable destination or observation references", async () => {
    const store = new InMemoryFundingRequestStore();
    const gateway = new FakeGateway();
    const coordinator = createCoordinator(store, gateway);
    const created = await coordinator.ensureFundingRequest(request);
    gateway.observations = [observation()];
    await coordinator.reconcileFunding({ paymentRequestId: PAYMENT_REQUEST_ID });

    (created.destination as { channel: string }).channel = "mutated";
    const loaded = await store.getByPaymentRequestId(PAYMENT_REQUEST_ID);
    if (loaded !== null) {
      (loaded.evidence[0]?.observation.destination as { channel: string }).channel = "mutated";
    }
    const reloaded = await store.getByPaymentRequestId(PAYMENT_REQUEST_ID);

    expect(reloaded?.identity.destination).toEqual(destinationFor(PAYMENT_REQUEST_ID));
    expect(reloaded?.evidence[0]?.observation.destination).toEqual(
      destinationFor(PAYMENT_REQUEST_ID),
    );
  });
});

function createCoordinator(
  store: FundingRequestStore,
  gateway: PrivateFundingGateway,
  nowSeconds = NOW_SECONDS,
  admission: SettlementAdmissionChecker = activeAdmission(),
  finalizationGate: SettlementFundingFinalizationGate = new InProcessSettlementActivityGate(),
): FundingCoordinator {
  return new FundingCoordinator(store, gateway, {
    network: "SN_SEPOLIA",
    poolContract: "0x123",
    tokenContract: "0x456",
    attributionProfiles: ["quote_channel"],
    minimumAmount: 1n,
    maximumAmount: 10_000n,
    finalityPolicy: FINALITY_POLICY,
    admission,
    finalizationGate,
    now: () => new Date(nowSeconds * 1_000),
  });
}

async function createSignedPayerCoordinator(
  store: FundingRequestStore,
  gateway: PrivateFundingGateway,
  binding: VerifiedPayerBinding | null = verifiedPayerBinding(),
): Promise<FundingCoordinator> {
  const payerBindingStore = new InMemoryPayerBindingChallengeStore();
  if (binding !== null) {
    await payerBindingStore.createOrGetPayerBinding({
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
    await payerBindingStore.markPayerBindingVerified({
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
  return new FundingCoordinator(store, gateway, {
    network: "SN_SEPOLIA",
    poolContract: "0x123",
    tokenContract: "0x456",
    attributionProfiles: ["signed_payer"],
    minimumAmount: 1n,
    maximumAmount: 10_000n,
    finalityPolicy: FINALITY_POLICY,
    payerBindingRecipientAddress: "0x789",
    payerBindingVerifierVersion: "snip12-funding-v2-rev1-snip6-rpc-v1",
    payerBindingStore,
    admission: activeAdmission(),
    finalizationGate: new InProcessSettlementActivityGate(),
    now: () => new Date(NOW_SECONDS * 1_000),
  });
}

function activeAdmission(): SettlementAdmissionController {
  return new SettlementAdmissionController(new InMemorySettlementPauseStore());
}

function pauseRecord(tokenContract: string): SettlementPauseRecord {
  return {
    profile: { method: "strk20", network: "SN_SEPOLIA", tokenContract },
    reason: "PAYOUT_FINALITY_REORGED",
    intentId: "incident-intent",
    submissionId: "incident-submission",
    transactionReference: "0xabc",
    originalInclusion: { blockHash: "0xdef", blockNumber: 42n },
    detectedAt: "2026-09-01T10:00:00.000Z",
    observerVersion: "observer-v1",
  };
}

function destinationFor(paymentRequestId: string): Readonly<Record<string, unknown>> {
  return { channel: `channel:${paymentRequestId}` };
}

function observation(change: Partial<PaymentObservation> = {}): PaymentObservation {
  const paymentRequestId = change.payment_request_id ?? PAYMENT_REQUEST_ID;
  const network = change.network ?? "SN_SEPOLIA";
  const poolContract = change.pool_contract ?? "0x123";
  const noteReference =
    change.note_reference ??
    (change.attribution_profile === "signed_payer" ? "0x111" : DEFAULT_NOTE_REFERENCE);
  const evidenceId =
    change.evidence_id ?? derivePrivacyEvidenceId(network, poolContract, noteReference);
  return {
    network,
    pool_contract: poolContract,
    sender_address: "0xaaa",
    recipient_address: "0x789",
    token_contract: "0x456",
    amount_base_units: 1_000_000n,
    payment_request_id: paymentRequestId,
    attribution_profile: "quote_channel",
    destination: destinationFor(paymentRequestId),
    evidence_id: evidenceId,
    note_reference: noteReference,
    transaction_reference: "transaction-1",
    block_hash: "0xabc",
    block_number: 123n,
    status: "FINAL",
    finality_policy: FINALITY_POLICY,
    verifier_version: "fake-verifier-v1",
    ...change,
  };
}

function verifiedPayerBinding(change: Partial<VerifiedPayerBinding> = {}): VerifiedPayerBinding {
  return {
    paymentRequestId: PAYMENT_REQUEST_ID,
    challengeId: "challenge-1",
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
    ...change,
  };
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolveValue: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolveValue = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (resolveValue === undefined) {
        throw new Error("Test fixture is incomplete");
      }
      resolveValue(value);
    },
  };
}

class FakeGateway implements PrivateSettlementGateway {
  readonly supportedAttributionProfiles: readonly AttributionProfile[];
  createCalls = 0;
  discoveryCalls = 0;
  observations: readonly PaymentObservation[] = [];
  throwOnDiscovery = false;
  destinationOverride: unknown;
  instructionPaymentRequestIdOverride: string | undefined;
  lastFundingRequest: FundingInstructionRequest | undefined;
  lastDiscoveryInput: FundingDiscoveryInput | undefined;

  constructor(
    supportedAttributionProfiles: readonly AttributionProfile[] = ["quote_channel", "signed_payer"],
  ) {
    this.supportedAttributionProfiles = supportedAttributionProfiles;
  }

  async createFundingInstructions(input: FundingInstructionRequest): Promise<FundingInstructions> {
    this.createCalls += 1;
    this.lastFundingRequest = input;
    return {
      paymentRequestId: this.instructionPaymentRequestIdOverride ?? input.paymentRequestId,
      destination: (this.destinationOverride ?? destinationFor(input.paymentRequestId)) as Readonly<
        Record<string, unknown>
      >,
    };
  }

  async findFundingPayments(input: FundingDiscoveryInput): Promise<readonly PaymentObservation[]> {
    this.discoveryCalls += 1;
    this.lastDiscoveryInput = input;
    if (this.throwOnDiscovery) {
      throw new Error("discovery unavailable");
    }
    return this.observations;
  }

  async preparePayout(_input: PayoutPreparationInput): Promise<PayoutAttempt> {
    throw new Error("Not implemented by funding fake");
  }

  async submitPayout(_submissionId: string): Promise<PayoutAttempt> {
    throw new Error("Not implemented by funding fake");
  }

  async getPayoutStatus(_submissionId: string): Promise<PayoutAttempt> {
    throw new Error("Not implemented by funding fake");
  }
}
