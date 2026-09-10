import { describe, expect, it } from "vitest";

import {
  InMemoryPayerBindingChallengeStore,
  PayerBindingChallengeConflictError,
  PayerBindingConflictError,
} from "./payer-binding-records.js";
import {
  PAYER_BINDING_DOMAIN_NAME,
  PAYER_BINDING_DOMAIN_VERSION,
  PAYER_BINDING_PRIMARY_TYPE,
  PAYER_BINDING_SNIP12_REVISION,
  type PayerBindingChallengeInput,
  PayerBindingCoordinator,
  type PayerBindingSignatureInput,
  type PayerBindingSignatureVerification,
  type PayerBindingSignatureVerifier,
  type PayerBindingTypedData,
  PayerBindingVerifierProtocolError,
} from "./payer-bindings.js";

const NOW_SECONDS = 2_000_000_000;
const PAYMENT_REQUEST_ID = "payer_binding_request_000000000001";
const SECOND_PAYMENT_REQUEST_ID = "payer_binding_request_000000000002";
const CHALLENGE_ID = "challenge_0000000000000000000000000001";
const SECOND_CHALLENGE_ID = "challenge_0000000000000000000000000002";
const VERIFIER_VERSION = "snip12-funding-v2-rev1-snip6-rpc-v1";

describe("payer binding coordination", () => {
  it("builds a readable note-bound SNIP-12 revision 1 challenge", async () => {
    const challenge = await createCoordinator().issueChallenge(challengeInput());

    expect(challenge).toEqual({
      paymentRequestId: PAYMENT_REQUEST_ID,
      challengeId: CHALLENGE_ID,
      payerAddress: "0xaaa",
      expiresAt: NOW_SECONDS + 120,
      state: "OPEN",
      typedData: {
        types: {
          StarknetDomain: [
            { name: "name", type: "shortstring" },
            { name: "version", type: "shortstring" },
            { name: "chainId", type: "shortstring" },
            { name: "revision", type: "shortstring" },
          ],
          [PAYER_BINDING_PRIMARY_TYPE]: [
            { name: "Payment Request", type: "string" },
            { name: "Payer", type: "ContractAddress" },
            { name: "Pool", type: "ContractAddress" },
            { name: "Recipient", type: "ContractAddress" },
            { name: "Token", type: "ContractAddress" },
            { name: "Expected Note", type: "felt" },
            { name: "Amount", type: "u128" },
            { name: "Funding Expires At", type: "timestamp" },
            { name: "Challenge Expires At", type: "timestamp" },
            { name: "Challenge", type: "string" },
          ],
        },
        primaryType: PAYER_BINDING_PRIMARY_TYPE,
        domain: {
          name: PAYER_BINDING_DOMAIN_NAME,
          version: PAYER_BINDING_DOMAIN_VERSION,
          chainId: "SN_SEPOLIA",
          revision: PAYER_BINDING_SNIP12_REVISION,
        },
        message: {
          "Payment Request": PAYMENT_REQUEST_ID,
          Payer: "0xaaa",
          Pool: "0x123",
          Recipient: "0x789",
          Token: "0x456",
          "Expected Note": "0x111",
          Amount: "1000000",
          "Funding Expires At": (NOW_SECONDS + 300).toString(),
          "Challenge Expires At": (NOW_SECONDS + 120).toString(),
          Challenge: CHALLENGE_ID,
        },
      },
    });
  });

  it("issues one idempotent challenge for one immutable payment request", async () => {
    let generationCalls = 0;
    const coordinator = createCoordinator({
      generateChallengeId: () => {
        generationCalls += 1;
        return generationCalls === 1 ? CHALLENGE_ID : SECOND_CHALLENGE_ID;
      },
    });

    const first = await coordinator.issueChallenge(challengeInput());
    const retried = await coordinator.issueChallenge(challengeInput());

    expect(retried).toEqual(first);
    expect(generationCalls).toBe(1);
  });

  it.each([
    { name: "payer", change: { payerAddress: "0xaab" } },
    { name: "expected note", change: { expectedNoteReference: "0x222" } },
    { name: "amount", change: { amountBaseUnits: 2_000_000n } },
    {
      name: "funding expiry",
      change: { fundingExpiresAt: new Date((NOW_SECONDS + 301) * 1_000) },
    },
  ])("rejects a retry that changes the bound $name", async ({ change }) => {
    const coordinator = createCoordinator();
    await coordinator.issueChallenge(challengeInput());

    await expect(
      coordinator.issueChallenge({ ...challengeInput(), ...change }),
    ).rejects.toBeInstanceOf(PayerBindingConflictError);
  });

  it("verifies through the payer account boundary and consumes the challenge", async () => {
    const store = new InMemoryPayerBindingChallengeStore();
    const verifier = new FakePayerBindingVerifier();
    const coordinator = createCoordinator({ store, verifier });
    const challenge = await coordinator.issueChallenge(challengeInput());

    const binding = await coordinator.verifySignature(signatureInput());

    expect(verifier.inputs).toEqual([
      {
        network: "SN_SEPOLIA",
        payerAddress: "0xaaa",
        typedData: challenge.typedData,
        signature: ["0x1", "0x2", "0x3", "0x4"],
      },
    ]);
    expect(binding).toEqual({
      paymentRequestId: PAYMENT_REQUEST_ID,
      challengeId: CHALLENGE_ID,
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
      verifierVersion: VERIFIER_VERSION,
      verifiedAt: NOW_SECONDS,
    });
    expect(await store.getPayerBinding(PAYMENT_REQUEST_ID)).toMatchObject({
      state: "VERIFIED",
      verification: { messageHash: "0xabc", verifiedAt: NOW_SECONDS },
    });
  });

  it("returns the first durable verification on a retry without another account call", async () => {
    const verifier = new FakePayerBindingVerifier();
    const coordinator = createCoordinator({ verifier });
    await coordinator.issueChallenge(challengeInput());
    const first = await coordinator.verifySignature(signatureInput());

    const retried = await coordinator.verifySignature({
      ...signatureInput(),
      signature: ["0x99"],
    });

    expect(retried).toEqual(first);
    expect(verifier.inputs).toHaveLength(1);
  });

  it("rejects an overlapping indistinguishable verified payer binding", async () => {
    const store = new InMemoryPayerBindingChallengeStore();
    const first = createCoordinator({ store, generateChallengeId: () => CHALLENGE_ID });
    const second = createCoordinator({ store, generateChallengeId: () => SECOND_CHALLENGE_ID });
    await first.issueChallenge(challengeInput());
    await first.verifySignature(signatureInput());
    await second.issueChallenge(challengeInput({ paymentRequestId: SECOND_PAYMENT_REQUEST_ID }));

    await expect(
      second.verifySignature(
        signatureInput({
          paymentRequestId: SECOND_PAYMENT_REQUEST_ID,
          challengeId: SECOND_CHALLENGE_ID,
        }),
      ),
    ).rejects.toMatchObject({ code: "ambiguous_request" });
    await expect(store.getPayerBinding(SECOND_PAYMENT_REQUEST_ID)).resolves.toMatchObject({
      state: "OPEN",
    });
  });

  it.each([
    {
      name: "payer",
      change: { payerAddress: "0xaab", expectedNoteReference: "0x222" },
    },
    {
      name: "amount",
      change: { amountBaseUnits: 2_000_000n, expectedNoteReference: "0x222" },
    },
  ])("allows overlapping bindings distinguished by $name", async ({ change }) => {
    const store = new InMemoryPayerBindingChallengeStore();
    const first = createCoordinator({ store, generateChallengeId: () => CHALLENGE_ID });
    const second = createCoordinator({ store, generateChallengeId: () => SECOND_CHALLENGE_ID });
    await first.issueChallenge(challengeInput());
    await first.verifySignature(signatureInput());
    await second.issueChallenge(
      challengeInput({ paymentRequestId: SECOND_PAYMENT_REQUEST_ID, ...change }),
    );

    await expect(
      second.verifySignature(
        signatureInput({
          paymentRequestId: SECOND_PAYMENT_REQUEST_ID,
          challengeId: SECOND_CHALLENGE_ID,
        }),
      ),
    ).resolves.toMatchObject({
      paymentRequestId: SECOND_PAYMENT_REQUEST_ID,
      ...change,
    });
  });

  it("allows an indistinguishable binding once the earlier funding window ends", async () => {
    const store = new InMemoryPayerBindingChallengeStore();
    const first = createCoordinator({ store, generateChallengeId: () => CHALLENGE_ID });
    const second = createCoordinator({
      store,
      generateChallengeId: () => SECOND_CHALLENGE_ID,
      now: () => new Date((NOW_SECONDS + 300) * 1_000),
    });
    await first.issueChallenge(challengeInput());
    await first.verifySignature(signatureInput());
    await second.issueChallenge(
      challengeInput({
        paymentRequestId: SECOND_PAYMENT_REQUEST_ID,
        expectedNoteReference: "0x222",
        fundingExpiresAt: new Date((NOW_SECONDS + 600) * 1_000),
      }),
    );

    await expect(
      second.verifySignature(
        signatureInput({
          paymentRequestId: SECOND_PAYMENT_REQUEST_ID,
          challengeId: SECOND_CHALLENGE_ID,
        }),
      ),
    ).resolves.toMatchObject({
      paymentRequestId: SECOND_PAYMENT_REQUEST_ID,
      verifiedAt: NOW_SECONDS + 300,
    });
  });

  it("never reuses a verified note reference after the earlier funding window ends", async () => {
    const store = new InMemoryPayerBindingChallengeStore();
    const first = createCoordinator({ store, generateChallengeId: () => CHALLENGE_ID });
    const second = createCoordinator({
      store,
      generateChallengeId: () => SECOND_CHALLENGE_ID,
      now: () => new Date((NOW_SECONDS + 300) * 1_000),
    });
    await first.issueChallenge(challengeInput());
    await first.verifySignature(signatureInput());
    await second.issueChallenge(
      challengeInput({
        paymentRequestId: SECOND_PAYMENT_REQUEST_ID,
        fundingExpiresAt: new Date((NOW_SECONDS + 600) * 1_000),
      }),
    );

    await expect(
      second.verifySignature(
        signatureInput({
          paymentRequestId: SECOND_PAYMENT_REQUEST_ID,
          challengeId: SECOND_CHALLENGE_ID,
        }),
      ),
    ).rejects.toMatchObject({ code: "ambiguous_request" });
    await expect(store.getPayerBinding(SECOND_PAYMENT_REQUEST_ID)).resolves.toMatchObject({
      state: "OPEN",
    });
  });

  it("allows the same note reference in a different privacy pool", async () => {
    const store = new InMemoryPayerBindingChallengeStore();
    const first = createCoordinator({ store, generateChallengeId: () => CHALLENGE_ID });
    const second = createCoordinator({
      store,
      poolContract: "0x124",
      generateChallengeId: () => SECOND_CHALLENGE_ID,
    });
    await first.issueChallenge(challengeInput());
    await first.verifySignature(signatureInput());
    await second.issueChallenge(challengeInput({ paymentRequestId: SECOND_PAYMENT_REQUEST_ID }));

    await expect(
      second.verifySignature(
        signatureInput({
          paymentRequestId: SECOND_PAYMENT_REQUEST_ID,
          challengeId: SECOND_CHALLENGE_ID,
        }),
      ),
    ).resolves.toMatchObject({
      paymentRequestId: SECOND_PAYMENT_REQUEST_ID,
      poolContract: "0x124",
      expectedNoteReference: "0x111",
    });
  });

  it("keeps the challenge open after an invalid signature", async () => {
    const store = new InMemoryPayerBindingChallengeStore();
    const verifier = new FakePayerBindingVerifier();
    verifier.result = { valid: false };
    const coordinator = createCoordinator({ store, verifier });
    await coordinator.issueChallenge(challengeInput());

    await expect(coordinator.verifySignature(signatureInput())).rejects.toMatchObject({
      code: "invalid_signature",
    });
    expect(await store.getPayerBinding(PAYMENT_REQUEST_ID)).toMatchObject({ state: "OPEN" });
  });

  it.each(["PENDING", "REORGED", "CONFLICTED"] as const)(
    "does not consume a challenge after a %s verification read",
    async (status) => {
      const store = new InMemoryPayerBindingChallengeStore();
      const verifier = new FakePayerBindingVerifier();
      verifier.result = { ...validVerification(), status };
      const coordinator = createCoordinator({ store, verifier });
      await coordinator.issueChallenge(challengeInput());

      await expect(coordinator.verifySignature(signatureInput())).rejects.toMatchObject({
        code: "verification_not_final",
      });
      expect(await store.getPayerBinding(PAYMENT_REQUEST_ID)).toMatchObject({
        state: "OPEN",
      });
    },
  );

  it("expires before making an account call", async () => {
    let nowSeconds = NOW_SECONDS;
    const store = new InMemoryPayerBindingChallengeStore();
    const verifier = new FakePayerBindingVerifier();
    const coordinator = createCoordinator({
      store,
      verifier,
      now: () => new Date(nowSeconds * 1_000),
    });
    await coordinator.issueChallenge(challengeInput());
    nowSeconds += 120;

    await expect(coordinator.verifySignature(signatureInput())).rejects.toMatchObject({
      code: "challenge_expired",
    });
    expect(verifier.inputs).toHaveLength(0);
    expect(await store.getPayerBinding(PAYMENT_REQUEST_ID)).toMatchObject({
      state: "EXPIRED",
    });
  });

  it("does not consume a challenge that expires during account verification", async () => {
    let nowSeconds = NOW_SECONDS;
    const store = new InMemoryPayerBindingChallengeStore();
    const verifier = new FakePayerBindingVerifier();
    verifier.afterVerify = () => {
      nowSeconds += 120;
    };
    const coordinator = createCoordinator({
      store,
      verifier,
      now: () => new Date(nowSeconds * 1_000),
    });
    await coordinator.issueChallenge(challengeInput());

    await expect(coordinator.verifySignature(signatureInput())).rejects.toMatchObject({
      code: "challenge_expired",
    });
    expect(verifier.inputs).toHaveLength(1);
    expect(await store.getPayerBinding(PAYMENT_REQUEST_ID)).toMatchObject({
      state: "EXPIRED",
    });
  });

  it("persists expiry when an issued challenge is read after its deadline", async () => {
    let nowSeconds = NOW_SECONDS;
    const store = new InMemoryPayerBindingChallengeStore();
    const coordinator = createCoordinator({
      store,
      now: () => new Date(nowSeconds * 1_000),
    });
    await coordinator.issueChallenge(challengeInput());
    nowSeconds += 120;

    const retried = await coordinator.issueChallenge(challengeInput());

    expect(retried.state).toBe("EXPIRED");
    expect(await store.getPayerBinding(PAYMENT_REQUEST_ID)).toMatchObject({
      state: "EXPIRED",
    });
  });

  it("rejects a challenge from another payment request before verification", async () => {
    const verifier = new FakePayerBindingVerifier();
    const coordinator = createCoordinator({ verifier });
    await coordinator.issueChallenge(challengeInput());

    await expect(
      coordinator.verifySignature({ ...signatureInput(), challengeId: SECOND_CHALLENGE_ID }),
    ).rejects.toMatchObject({ code: "challenge_mismatch" });
    expect(verifier.inputs).toHaveLength(0);
  });

  it("enforces challenge uniqueness across payment requests", async () => {
    const store = new InMemoryPayerBindingChallengeStore();
    const coordinator = createCoordinator({ store });
    await coordinator.issueChallenge(challengeInput());

    await expect(
      coordinator.issueChallenge({
        ...challengeInput(),
        paymentRequestId: SECOND_PAYMENT_REQUEST_ID,
      }),
    ).rejects.toBeInstanceOf(PayerBindingChallengeConflictError);
  });

  it.each([
    { name: "empty", signature: [] },
    { name: "sparse", signature: new Array<string>(1) },
    { name: "non-felt", signature: ["signature"] },
    { name: "out-of-field", signature: [`0x${STARK_FIELD_PRIME.toString(16)}`] },
  ])("rejects a $name account signature before verification", async ({ signature }) => {
    const verifier = new FakePayerBindingVerifier();
    const coordinator = createCoordinator({ verifier });
    await coordinator.issueChallenge(challengeInput());

    await expect(
      coordinator.verifySignature({ ...signatureInput(), signature }),
    ).rejects.toMatchObject({ code: "invalid_signature" });
    expect(verifier.inputs).toHaveLength(0);
  });

  it.each(["0x0", "not-a-felt", `0x${STARK_FIELD_PRIME.toString(16)}`])(
    "rejects invalid expected note reference %s before issuing a challenge",
    async (expectedNoteReference) => {
      await expect(
        createCoordinator().issueChallenge(challengeInput({ expectedNoteReference })),
      ).rejects.toMatchObject({ code: "invalid_request" });
    },
  );

  it.each([
    {
      name: "version drift",
      result: { ...validVerification(), verifierVersion: "different-verifier" },
    },
    {
      name: "malformed block hash",
      result: { ...validVerification(), blockHash: "not-a-block" },
    },
    {
      name: "unknown status",
      result: { ...validVerification(), status: "ACCEPTED" },
    },
  ])("rejects verifier $name", async ({ result }) => {
    const verifier = new FakePayerBindingVerifier();
    verifier.result = result as PayerBindingSignatureVerification;
    const coordinator = createCoordinator({ verifier });
    await coordinator.issueChallenge(challengeInput());

    await expect(coordinator.verifySignature(signatureInput())).rejects.toBeInstanceOf(
      PayerBindingVerifierProtocolError,
    );
  });

  it("does not expose mutable typed-data references", async () => {
    const coordinator = createCoordinator();
    const first = await coordinator.issueChallenge(challengeInput());
    (first.typedData.message as { Payer: string }).Payer = "0x999";

    const retried = await coordinator.issueChallenge(challengeInput());

    expect(retried.typedData.message.Payer).toBe("0xaaa");
  });

  it("generates 256-bit base64url challenges by default", async () => {
    const coordinator = createCoordinator({ randomChallenge: true });

    expect((await coordinator.issueChallenge(challengeInput())).challengeId).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
  });
});

function challengeInput(
  change: Partial<PayerBindingChallengeInput> = {},
): PayerBindingChallengeInput {
  return {
    paymentRequestId: PAYMENT_REQUEST_ID,
    payerAddress: "0x0aaa",
    expectedNoteReference: "0x0111",
    amountBaseUnits: 1_000_000n,
    fundingExpiresAt: new Date((NOW_SECONDS + 300) * 1_000),
    ...change,
  };
}

function signatureInput(
  change: Partial<PayerBindingSignatureInput> = {},
): PayerBindingSignatureInput {
  return {
    paymentRequestId: PAYMENT_REQUEST_ID,
    challengeId: CHALLENGE_ID,
    signature: ["0x01", "0x02", "0x03", "0x04"],
    ...change,
  };
}

function validVerification(): PayerBindingSignatureVerification & { valid: true } {
  return {
    valid: true,
    status: "FINAL",
    messageHash: "0x0abc",
    blockHash: "0x0def",
    blockNumber: 42n,
    verifierVersion: VERIFIER_VERSION,
  };
}

function createCoordinator(
  options: {
    store?: InMemoryPayerBindingChallengeStore;
    verifier?: FakePayerBindingVerifier;
    now?: () => Date;
    generateChallengeId?: () => string;
    randomChallenge?: boolean;
    poolContract?: string;
  } = {},
): PayerBindingCoordinator {
  return new PayerBindingCoordinator(
    options.store ?? new InMemoryPayerBindingChallengeStore(),
    options.verifier ?? new FakePayerBindingVerifier(),
    {
      network: "SN_SEPOLIA",
      poolContract: options.poolContract ?? "0x0123",
      recipientAddress: "0x0789",
      tokenContract: "0x0456",
      verifierVersion: VERIFIER_VERSION,
      challengeTtlSeconds: 120,
      now: options.now ?? (() => new Date(NOW_SECONDS * 1_000)),
      ...(options.randomChallenge
        ? {}
        : { generateChallengeId: options.generateChallengeId ?? (() => CHALLENGE_ID) }),
    },
  );
}

class FakePayerBindingVerifier implements PayerBindingSignatureVerifier {
  result: PayerBindingSignatureVerification = validVerification();
  afterVerify: (() => void) | undefined;
  inputs: Array<{
    network: "SN_SEPOLIA";
    payerAddress: string;
    typedData: PayerBindingTypedData;
    signature: readonly string[];
  }> = [];

  async verify(
    input: Parameters<PayerBindingSignatureVerifier["verify"]>[0],
  ): Promise<PayerBindingSignatureVerification> {
    this.inputs.push(structuredClone(input) as (typeof this.inputs)[number]);
    this.afterVerify?.();
    return structuredClone(this.result);
  }
}

const STARK_FIELD_PRIME = (1n << 251n) + (17n << 192n) + 1n;
