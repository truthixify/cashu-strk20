import type { MeltPaymentEnvelope, PaymentObservation } from "@cashu-strk20/strk20-method";
import { describe, expect, it } from "vitest";

import type {
  FundingInstructions,
  FundingRequestInput,
  PayoutAttempt,
  PayoutAttemptStatus,
  PayoutPreparationInput,
  PrivateSettlementGateway,
} from "./gateway.js";
import {
  InMemorySettlementIntentStore,
  IntentConflictError,
  intentIdentity,
  type SettlementIntentCandidate,
  type SettlementIntentRecord,
  type SettlementIntentStore,
} from "./intents.js";
import {
  GatewayProtocolError,
  PayoutConfigurationError,
  PayoutCoordinator,
  PayoutValidationError,
} from "./payouts.js";

const NOW_SECONDS = 2_000_000_000;

const request: MeltPaymentEnvelope = {
  version: 1,
  kind: "melt",
  network: "SN_SEPOLIA",
  token_contract: "0x0123",
  amount: 100,
  amount_base_units: "1000000",
  expires_at: NOW_SECONDS + 300,
  destination: { recipient: "0xabc", pool: "0xdef" },
};

const input = { quoteId: "secret-quote-1", request } as const;

describe("payout coordination", () => {
  it("records an intent and prepared submission before broadcast", async () => {
    const events: string[] = [];
    const store = new RecordingStore(events);
    const gateway = new FakeGateway(events);
    const coordinator = createCoordinator(store, gateway);

    const result = await coordinator.ensurePayout(input);

    expect(result).toMatchObject({ intentId: "intent-1", state: "PENDING" });
    expect(result.intentId).not.toBe(input.quoteId);
    expect(events.indexOf("store:create")).toBeLessThan(events.indexOf("gateway:prepare"));
    expect(events.indexOf("store:attach")).toBeLessThan(events.indexOf("gateway:submit"));
  });

  it("reconciles an idempotent retry without preparing or submitting again", async () => {
    const store = new InMemorySettlementIntentStore();
    const gateway = new FakeGateway();
    const coordinator = createCoordinator(store, gateway);

    const first = await coordinator.ensurePayout(input);
    const second = await coordinator.ensurePayout(input);

    expect(second).toEqual(first);
    expect(gateway.prepareCalls).toBe(1);
    expect(gateway.submitCalls).toBe(1);
  });

  it.each([
    { amount: 200, amount_base_units: "2000000" },
    { expires_at: NOW_SECONDS + 301 },
    { destination: { recipient: "0xbad", pool: "0xdef" } },
  ])("rejects a retry that mutates immutable payout fields: %o", async (change) => {
    const store = new InMemorySettlementIntentStore();
    const gateway = new FakeGateway();
    const coordinator = createCoordinator(store, gateway);
    await coordinator.ensurePayout(input);

    await expect(
      coordinator.ensurePayout({
        ...input,
        request: { ...request, ...change } as MeltPaymentEnvelope,
      }),
    ).rejects.toBeInstanceOf(IntentConflictError);
    expect(gateway.submitCalls).toBe(1);
  });

  it("marks a lost response after accepted submission unknown and later reconciles it", async () => {
    const store = new InMemorySettlementIntentStore();
    const gateway = new FakeGateway();
    gateway.throwAfterSubmit = true;
    const coordinator = createCoordinator(store, gateway);

    const ambiguous = await coordinator.ensurePayout(input);
    expect(ambiguous.state).toBe("UNKNOWN");
    expect(gateway.submitCalls).toBe(1);

    gateway.throwAfterSubmit = false;
    gateway.setStatus("PAID", "0xtx-final");
    const reconciled = await coordinator.ensurePayout(input);

    expect(reconciled).toMatchObject({
      state: "PAID",
      transactionReferences: ["0xtx-final"],
    });
    expect(gateway.submitCalls).toBe(1);
  });

  it("keeps provider outages unknown without resubmitting", async () => {
    const store = new InMemorySettlementIntentStore();
    const gateway = new FakeGateway();
    const coordinator = createCoordinator(store, gateway);
    await coordinator.ensurePayout(input);

    gateway.throwOnStatus = true;
    expect((await coordinator.ensurePayout(input)).state).toBe("UNKNOWN");
    expect((await coordinator.ensurePayout(input)).state).toBe("UNKNOWN");
    expect(gateway.submitCalls).toBe(1);
  });

  it("continues reconciliation after the original payout request expires", async () => {
    const store = new InMemorySettlementIntentStore();
    const gateway = new FakeGateway();
    await createCoordinator(store, gateway).ensurePayout(input);
    gateway.setStatus("PAID", "0xtx-after-expiry");

    const afterExpiry = new PayoutCoordinator(store, gateway, {
      network: "SN_SEPOLIA",
      tokenContract: "0x123",
      minimumAmount: 1n,
      maximumAmount: 10_000n,
      now: () => new Date((request.expires_at + 1) * 1_000),
      createIntentId: () => input.quoteId,
    });
    const result = await afterExpiry.ensurePayout(input);

    expect(result).toMatchObject({
      intentId: "intent-1",
      state: "PAID",
      transactionReferences: ["0xtx-after-expiry"],
    });
    expect(gateway.submitCalls).toBe(1);
  });

  it("resumes the same prepared submission after a restart before broadcast", async () => {
    const store = new InMemorySettlementIntentStore();
    const gateway = new FakeGateway();
    const intent = await store.createOrGet({
      intentId: "intent-before-restart",
      identity: intentIdentity(input.quoteId, input.request),
    });
    const prepared = await gateway.preparePayout({
      intentId: intent.intentId,
      request: input.request,
    });
    await store.attachSubmission(intent.intentId, prepared.submissionId);

    const restarted = createCoordinator(store, gateway, "unused-after-restart");
    const result = await restarted.ensurePayout(input);

    expect(result.state).toBe("PENDING");
    expect(gateway.prepareCalls).toBe(1);
    expect(gateway.submitCalls).toBe(1);
  });

  it("keeps an intent retryable when preparation fails before a submission exists", async () => {
    const store = new InMemorySettlementIntentStore();
    const gateway = new FakeGateway();
    gateway.throwOnPrepare = true;
    const coordinator = createCoordinator(store, gateway);

    const unavailable = await coordinator.ensurePayout(input);
    expect(unavailable.state).toBe("INTENT_RECORDED");
    expect(gateway.submitCalls).toBe(0);

    gateway.throwOnPrepare = false;
    const retried = await coordinator.ensurePayout(input);
    expect(retried).toMatchObject({ intentId: unavailable.intentId, state: "PENDING" });
    expect(gateway.submitCalls).toBe(1);
  });

  it("accepts failed only when the gateway explicitly proves non-execution", async () => {
    const store = new InMemorySettlementIntentStore();
    const gateway = new FakeGateway();
    gateway.prepareStatus = "FAILED";

    const result = await createCoordinator(store, gateway).ensurePayout(input);

    expect(result.state).toBe("FAILED");
    expect(gateway.submitCalls).toBe(0);
  });

  it("normalizes an immediately final payout through pending and preserves lineage", async () => {
    const store = new InMemorySettlementIntentStore();
    const gateway = new FakeGateway();
    gateway.submitStatus = "PAID";
    gateway.submitTransactionReference = "0xtx-direct";
    const coordinator = createCoordinator(store, gateway);

    const paid = await coordinator.ensurePayout(input);
    const retried = await coordinator.ensurePayout(input);

    expect(paid).toMatchObject({ state: "PAID", transactionReferences: ["0xtx-direct"] });
    expect(retried).toEqual(paid);
    expect(gateway.statusCalls).toBe(1);
  });

  it("rejects a gateway response for a different intent", async () => {
    const gateway = new FakeGateway();
    gateway.responseIntentId = "other-intent";

    await expect(
      createCoordinator(new InMemorySettlementIntentStore(), gateway).ensurePayout(input),
    ).rejects.toBeInstanceOf(GatewayProtocolError);
    expect(gateway.submitCalls).toBe(0);
  });

  it("rejects mainnet and invalid amount-policy configuration", () => {
    const store = new InMemorySettlementIntentStore();
    const gateway = new FakeGateway();

    expect(
      () =>
        new PayoutCoordinator(store, gateway, {
          network: "SN_MAIN",
          tokenContract: "0x123",
          minimumAmount: 1n,
          maximumAmount: 10_000n,
        }),
    ).toThrowError(PayoutConfigurationError);
    expect(
      () =>
        new PayoutCoordinator(store, gateway, {
          network: "SN_SEPOLIA",
          tokenContract: "0x123",
          minimumAmount: 10_000n,
          maximumAmount: 1n,
        }),
    ).toThrowError(PayoutConfigurationError);
  });

  it.each([
    {
      name: "blank quote ID",
      value: { ...input, quoteId: " " },
      code: "invalid_quote_id",
    },
    {
      name: "wrong network",
      value: { ...input, request: { ...request, network: "SN_MAIN" as const } },
      code: "unsupported_network",
    },
    {
      name: "wrong token",
      value: { ...input, request: { ...request, token_contract: "0x456" } },
      code: "unsupported_token",
    },
    {
      name: "zero token address",
      value: { ...input, request: { ...request, token_contract: "0x0" } },
      code: "invalid_payment_request",
    },
    {
      name: "fractional amount",
      value: { ...input, request: { ...request, amount: 1.5 } },
      code: "amount_out_of_range",
    },
    {
      name: "unsafe amount",
      value: { ...input, request: { ...request, amount: Number.MAX_SAFE_INTEGER + 1 } },
      code: "amount_out_of_range",
    },
    {
      name: "mismatched base units",
      value: { ...input, request: { ...request, amount_base_units: "1000001" } },
      code: "amount_out_of_range",
    },
    {
      name: "amount above policy",
      value: {
        ...input,
        request: { ...request, amount: 10_001, amount_base_units: "100010000" },
      },
      code: "amount_out_of_range",
    },
    {
      name: "expired request",
      value: { ...input, request: { ...request, expires_at: NOW_SECONDS } },
      code: "quote_expired",
    },
    {
      name: "empty destination",
      value: { ...input, request: { ...request, destination: {} } },
      code: "invalid_payment_request",
    },
  ] as const)("rejects $name before creating an intent", async ({ value, code }) => {
    const gateway = new FakeGateway();
    let error: unknown;

    try {
      await createCoordinator(new InMemorySettlementIntentStore(), gateway).ensurePayout(value);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(PayoutValidationError);
    expect((error as PayoutValidationError).code).toBe(code);
    expect(gateway.prepareCalls).toBe(0);
  });
});

function createCoordinator(
  store: SettlementIntentStore,
  gateway: PrivateSettlementGateway,
  intentId = "intent-1",
): PayoutCoordinator {
  return new PayoutCoordinator(store, gateway, {
    network: "SN_SEPOLIA",
    tokenContract: "0x123",
    minimumAmount: 1n,
    maximumAmount: 10_000n,
    now: () => new Date(NOW_SECONDS * 1_000),
    createIntentId: () => intentId,
  });
}

class FakeGateway implements PrivateSettlementGateway {
  readonly events: string[];
  prepareCalls = 0;
  submitCalls = 0;
  statusCalls = 0;
  prepareStatus: PayoutAttemptStatus = "PREPARED";
  submitStatus: PayoutAttemptStatus = "PENDING";
  submitTransactionReference: string | undefined;
  responseIntentId: string | undefined;
  throwOnPrepare = false;
  throwAfterSubmit = false;
  throwOnStatus = false;
  #attempt: PayoutAttempt | undefined;

  constructor(events: string[] = []) {
    this.events = events;
  }

  async createFundingInstructions(_input: FundingRequestInput): Promise<FundingInstructions> {
    throw new Error("Not implemented by payout fake");
  }

  async findFundingPayment(_paymentRequestId: string): Promise<PaymentObservation | null> {
    return null;
  }

  async preparePayout(input: PayoutPreparationInput): Promise<PayoutAttempt> {
    this.events.push("gateway:prepare");
    this.prepareCalls += 1;
    if (this.throwOnPrepare) {
      throw new Error("prover unavailable");
    }
    this.#attempt = {
      intentId: this.responseIntentId ?? input.intentId,
      submissionId: `submission-${this.prepareCalls}`,
      status: this.prepareStatus,
    };
    return this.#attempt;
  }

  async submitPayout(submissionId: string): Promise<PayoutAttempt> {
    this.events.push("gateway:submit");
    this.submitCalls += 1;
    const attempt = this.#required(submissionId);
    this.#attempt = {
      ...attempt,
      status: this.submitStatus,
      ...(this.submitTransactionReference === undefined
        ? {}
        : { transactionReference: this.submitTransactionReference }),
    };
    if (this.throwAfterSubmit) {
      throw new Error("response lost after submit");
    }
    return this.#attempt;
  }

  async getPayoutStatus(submissionId: string): Promise<PayoutAttempt> {
    this.events.push("gateway:status");
    this.statusCalls += 1;
    if (this.throwOnStatus) {
      throw new Error("provider unavailable");
    }
    return this.#required(submissionId);
  }

  setStatus(status: PayoutAttemptStatus, transactionReference?: string): void {
    const attempt = this.#required(this.#attempt?.submissionId ?? "");
    this.#attempt = {
      ...attempt,
      status,
      ...(transactionReference === undefined ? {} : { transactionReference }),
    };
  }

  #required(submissionId: string): PayoutAttempt {
    if (this.#attempt === undefined || this.#attempt.submissionId !== submissionId) {
      throw new Error("submission not prepared");
    }
    return this.#attempt;
  }
}

class RecordingStore implements SettlementIntentStore {
  readonly #inner = new InMemorySettlementIntentStore();

  constructor(readonly events: string[]) {}

  getByQuoteId(quoteId: string): Promise<SettlementIntentRecord | null> {
    this.events.push("store:get");
    return this.#inner.getByQuoteId(quoteId);
  }

  createOrGet(candidate: SettlementIntentCandidate): Promise<SettlementIntentRecord> {
    this.events.push("store:create");
    return this.#inner.createOrGet(candidate);
  }

  attachSubmission(intentId: string, submissionId: string): Promise<SettlementIntentRecord> {
    this.events.push("store:attach");
    return this.#inner.attachSubmission(intentId, submissionId);
  }

  recordAttempt(attempt: PayoutAttempt): Promise<SettlementIntentRecord> {
    this.events.push(`store:record:${attempt.status}`);
    return this.#inner.recordAttempt(attempt);
  }
}
