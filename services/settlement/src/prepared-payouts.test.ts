import { describe, expect, it } from "vitest";

import {
  AesGcmPreparedPayoutCipher,
  PreparedPayoutCipherError,
  type PreparedPayoutEncryptionKey,
  type PreparedPayoutKeyring,
} from "./prepared-payout-cipher.js";
import {
  InMemoryPreparedPayoutStore,
  PREPARED_PAYOUT_PAYLOAD_VERSION,
  PreparedPayoutConflictError,
  PreparedPayoutIntegrityError,
  type PreparedPayoutPayloadContext,
  type PreparedPayoutRecord,
} from "./prepared-payouts.js";

describe("prepared payout ownership", () => {
  it("stores one isolated clone by intent and submission", async () => {
    const store = new InMemoryPreparedPayoutStore();
    const input = preparedRecord();

    const created = await store.createOrGet(input);
    (created.encryptedTransaction as { ciphertext: string }).ciphertext = "dGFtcGVyZWQ";

    await expect(store.getByIntentId(input.intentId)).resolves.toEqual(input);
    await expect(store.getBySubmissionId(input.submissionId)).resolves.toEqual(input);
  });

  it("returns the first artifact for a concurrent retry of the same request", async () => {
    const store = new InMemoryPreparedPayoutStore();
    const first = preparedRecord();
    const competing = preparedRecord({
      submissionId: "submission-2",
      nonce: "0x2",
      transactionReference: "0xdef",
    });

    await store.createOrGet(first);

    await expect(store.createOrGet(competing)).resolves.toEqual(first);
  });

  it.each([
    {
      name: "request identity",
      first: preparedRecord(),
      second: preparedRecord({ requestDigest: `sha256:${"b".repeat(64)}` }),
      code: "intent_conflict",
    },
    {
      name: "submission ID",
      first: preparedRecord(),
      second: preparedRecord({ intentId: "intent-2" }),
      code: "submission_conflict",
    },
    {
      name: "transaction hash",
      first: preparedRecord(),
      second: preparedRecord({ intentId: "intent-2", submissionId: "submission-2", nonce: "0x2" }),
      code: "transaction_conflict",
    },
    {
      name: "sender nonce",
      first: preparedRecord(),
      second: preparedRecord({
        intentId: "intent-2",
        submissionId: "submission-2",
        transactionReference: "0xdef",
      }),
      code: "nonce_conflict",
    },
  ])("rejects conflicting $name ownership", async ({ first, second, code }) => {
    const store = new InMemoryPreparedPayoutStore();
    await store.createOrGet(first);

    await expect(store.createOrGet(second)).rejects.toMatchObject({
      name: PreparedPayoutConflictError.name,
      code,
    });
  });

  it("rejects malformed encrypted artifacts before indexing them", async () => {
    const store = new InMemoryPreparedPayoutStore();
    const malformed = preparedRecord({
      encryptedTransaction: {
        ...preparedRecord().encryptedTransaction,
        initializationVector: "short",
      },
    });

    await expect(store.createOrGet(malformed)).rejects.toBeInstanceOf(PreparedPayoutIntegrityError);
    await expect(store.getByIntentId(malformed.intentId)).resolves.toBeNull();
  });

  it("atomically fences one prepared-payout broadcaster until lease expiry", async () => {
    const store = new InMemoryPreparedPayoutStore();
    const input = preparedRecord();
    await store.createOrGet(input);

    const [first, competing] = await Promise.all([
      store.claimSubmission(submissionLease()),
      store.claimSubmission(submissionLease({ leaseId: "lease-2" })),
    ]);

    expect(first).toBe(true);
    expect(competing).toBe(false);
    await expect(
      store.claimSubmission(
        submissionLease({
          leaseId: "lease-3",
          acquiredAt: "2026-09-01T10:01:00.000Z",
          expiresAt: "2026-09-01T10:01:30.000Z",
        }),
      ),
    ).resolves.toBe(true);
  });

  it("makes an identical lease retry idempotent but rejects conflicting bounds", async () => {
    const store = new InMemoryPreparedPayoutStore();
    await store.createOrGet(preparedRecord());
    const lease = submissionLease();
    await store.claimSubmission(lease);

    await expect(store.claimSubmission(lease)).resolves.toBe(true);
    await expect(
      store.claimSubmission({ ...lease, expiresAt: "2026-09-01T10:00:31.000Z" }),
    ).rejects.toBeInstanceOf(PreparedPayoutIntegrityError);
  });

  it("rejects a submission lease for a different transaction", async () => {
    const store = new InMemoryPreparedPayoutStore();
    await store.createOrGet(preparedRecord());

    await expect(
      store.claimSubmission(submissionLease({ transactionReference: "0xdef" })),
    ).rejects.toBeInstanceOf(PreparedPayoutIntegrityError);
  });

  it("records one isolated canonical inclusion for restart reconciliation", async () => {
    const store = new InMemoryPreparedPayoutStore();
    const input = preparedRecord();
    await store.createOrGet(input);

    const included = await store.recordInclusion({
      submissionId: input.submissionId,
      transactionReference: input.transactionReference,
      blockHash: "0xdef",
      blockNumber: 42n,
    });
    (included.inclusion as { blockHash: string }).blockHash = "0x999";

    await expect(store.getByIntentId(input.intentId)).resolves.toMatchObject({
      inclusion: { blockHash: "0xdef", blockNumber: 42n },
    });
  });

  it("never replaces the first accepted inclusion", async () => {
    const store = new InMemoryPreparedPayoutStore();
    const input = preparedRecord();
    await store.createOrGet(input);
    await store.recordInclusion({
      submissionId: input.submissionId,
      transactionReference: input.transactionReference,
      blockHash: "0xdef",
      blockNumber: 42n,
    });

    await expect(
      store.recordInclusion({
        submissionId: input.submissionId,
        transactionReference: input.transactionReference,
        blockHash: "0x999",
        blockNumber: 43n,
      }),
    ).rejects.toMatchObject({
      name: PreparedPayoutConflictError.name,
      code: "inclusion_conflict",
    });
  });

  it("rejects an inclusion for a different transaction", async () => {
    const store = new InMemoryPreparedPayoutStore();
    const input = preparedRecord();
    await store.createOrGet(input);

    await expect(
      store.recordInclusion({
        submissionId: input.submissionId,
        transactionReference: "0xdef",
        blockHash: "0x999",
        blockNumber: 43n,
      }),
    ).rejects.toBeInstanceOf(PreparedPayoutIntegrityError);
  });

  it("records one isolated post-finality incident and never replaces it", async () => {
    const store = new InMemoryPreparedPayoutStore();
    const input = preparedRecord();
    await store.createOrGet(input);
    await store.recordInclusion({
      submissionId: input.submissionId,
      transactionReference: input.transactionReference,
      blockHash: "0xdef",
      blockNumber: 42n,
    });

    const recorded = await store.recordFinalityIncident({
      intentId: input.intentId,
      submissionId: input.submissionId,
      transactionReference: input.transactionReference,
      status: "REORGED",
      detectedAt: "2026-09-01T10:00:00.000Z",
      observerVersion: "observer-v1",
    });
    (recorded.finalityIncident as { status: string }).status = "CONFLICTED";

    await expect(
      store.recordFinalityIncident({
        intentId: input.intentId,
        submissionId: input.submissionId,
        transactionReference: input.transactionReference,
        status: "CONFLICTED",
        detectedAt: "2026-09-01T10:01:00.000Z",
        observerVersion: "observer-v2",
      }),
    ).resolves.toMatchObject({
      finalityIncident: {
        status: "REORGED",
        detectedAt: "2026-09-01T10:00:00.000Z",
        observerVersion: "observer-v1",
      },
    });
  });

  it("rejects a finality incident before an inclusion exists", async () => {
    const store = new InMemoryPreparedPayoutStore();
    const input = preparedRecord();
    await store.createOrGet(input);

    await expect(
      store.recordFinalityIncident({
        intentId: input.intentId,
        submissionId: input.submissionId,
        transactionReference: input.transactionReference,
        status: "REORGED",
        detectedAt: "2026-09-01T10:00:00.000Z",
        observerVersion: "observer-v1",
      }),
    ).rejects.toBeInstanceOf(PreparedPayoutIntegrityError);
  });
});

describe("prepared payout encryption", () => {
  it("round-trips a signed transaction without exposing its plaintext", async () => {
    const cipher = createCipher();
    const context = payloadContext();
    const transaction = { type: "INVOKE", privateMarker: "recipient-sensitive-value" };

    const encrypted = await cipher.seal(transaction, context);

    expect(JSON.stringify(encrypted)).not.toContain(transaction.privateMarker);
    await expect(cipher.open(encrypted, context)).resolves.toEqual(transaction);
  });

  it("uses a fresh initialization vector for each sealed payload", async () => {
    let nextByte = 1;
    const cipher = createCipher({
      randomInitializationVector: () => new Uint8Array(12).fill(nextByte++),
    });

    const first = await cipher.seal({ value: 1 }, payloadContext());
    const second = await cipher.seal({ value: 1 }, payloadContext());

    expect(first.initializationVector).not.toBe(second.initializationVector);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it.each([
    {
      name: "ciphertext",
      change: (encrypted: Awaited<ReturnType<AesGcmPreparedPayoutCipher["seal"]>>) => ({
        ...encrypted,
        ciphertext: flipBase64Url(encrypted.ciphertext),
      }),
    },
    {
      name: "authentication tag",
      change: (encrypted: Awaited<ReturnType<AesGcmPreparedPayoutCipher["seal"]>>) => ({
        ...encrypted,
        authenticationTag: flipBase64Url(encrypted.authenticationTag),
      }),
    },
  ])("rejects a modified $name", async ({ change }) => {
    const cipher = createCipher();
    const context = payloadContext();
    const encrypted = await cipher.seal({ value: 1 }, context);

    await expect(cipher.open(change(encrypted), context)).rejects.toMatchObject({
      code: "decryption_failure",
    });
  });

  it("binds ciphertext to every durable identity field", async () => {
    const cipher = createCipher();
    const context = payloadContext();
    const encrypted = await cipher.seal({ value: 1 }, context);

    await expect(
      cipher.open(encrypted, { ...context, transactionReference: "0xdef" }),
    ).rejects.toMatchObject({ code: "decryption_failure" });
  });

  it("rejects an unavailable decryption key without leaking payload details", async () => {
    const encrypting = createCipher();
    const encrypted = await encrypting.seal({ value: 1 }, payloadContext());
    const unavailable = createCipher({ keyring: new TestKeyring(undefined) });

    await expect(unavailable.open(encrypted, payloadContext())).rejects.toEqual(
      expect.objectContaining({
        name: PreparedPayoutCipherError.name,
        code: "invalid_key",
      }),
    );
  });

  it("enforces the configured plaintext bound before encryption", async () => {
    const cipher = createCipher({ maximumPlaintextBytes: 16 });

    await expect(cipher.seal({ value: "x".repeat(64) }, payloadContext())).rejects.toMatchObject({
      code: "payload_too_large",
    });
  });
});

function preparedRecord(change: Partial<PreparedPayoutRecord> = {}): PreparedPayoutRecord {
  return {
    ...payloadContext(),
    encryptedTransaction: {
      algorithm: "A256GCM",
      keyId: "test-key-1",
      initializationVector: "AAAAAAAAAAAAAAAA",
      ciphertext: "YQ",
      authenticationTag: "AAAAAAAAAAAAAAAAAAAAAA",
    },
    ...change,
  };
}

function payloadContext(): PreparedPayoutPayloadContext {
  return {
    payloadVersion: PREPARED_PAYOUT_PAYLOAD_VERSION,
    submissionId: "submission-1",
    intentId: "intent-1",
    requestDigest: `sha256:${"a".repeat(64)}`,
    adapterVersion: "adapter-v1",
    senderAddress: "0x123",
    nonce: "0x1",
    transactionReference: "0xabc",
  };
}

function submissionLease(
  change: Partial<Parameters<InMemoryPreparedPayoutStore["claimSubmission"]>[0]> = {},
): Parameters<InMemoryPreparedPayoutStore["claimSubmission"]>[0] {
  return {
    submissionId: "submission-1",
    transactionReference: "0xabc",
    leaseId: "lease-1",
    acquiredAt: "2026-09-01T10:00:00.000Z",
    expiresAt: "2026-09-01T10:00:30.000Z",
    ...change,
  };
}

function createCipher(
  change: Partial<ConstructorParameters<typeof AesGcmPreparedPayoutCipher>[0]> = {},
): AesGcmPreparedPayoutCipher {
  return new AesGcmPreparedPayoutCipher({
    keyring: new TestKeyring(new Uint8Array(32).fill(7)),
    maximumPlaintextBytes: 1_024,
    randomInitializationVector: () => new Uint8Array(12).fill(3),
    ...change,
  });
}

class TestKeyring implements PreparedPayoutKeyring {
  constructor(readonly key: Uint8Array | undefined) {}

  async getActiveKey(): Promise<PreparedPayoutEncryptionKey> {
    if (this.key === undefined) {
      throw new Error("Key unavailable");
    }
    return { keyId: "test-key-1", key: this.key };
  }

  async getKey(keyId: string): Promise<Uint8Array | null> {
    return keyId === "test-key-1" && this.key !== undefined ? this.key : null;
  }
}

function flipBase64Url(value: string): string {
  return `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
}
