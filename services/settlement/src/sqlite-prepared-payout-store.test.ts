import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AesGcmPreparedPayoutCipher,
  type PreparedPayoutEncryptionKey,
  type PreparedPayoutKeyring,
} from "./prepared-payout-cipher.js";
import {
  PREPARED_PAYOUT_PAYLOAD_VERSION,
  type PreparedPayoutCandidate,
  PreparedPayoutConflictError,
  PreparedPayoutIntegrityError,
  type PreparedPayoutPayloadContext,
} from "./prepared-payouts.js";
import {
  PreparedPayoutStoreCorruptionError,
  SqlitePreparedPayoutStore,
} from "./sqlite-prepared-payout-store.js";
import { SqliteSettlementStore } from "./sqlite-store.js";

describe("SQLite prepared payout store", () => {
  let directory: string;
  let databasePath: string;
  let stores: SqlitePreparedPayoutStore[];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "cashu-strk20-prepared-payout-"));
    databasePath = join(directory, "prepared-payouts.sqlite");
    stores = [];
  });

  afterEach(() => {
    for (const store of stores) {
      store.close();
    }
    rmSync(directory, { force: true, recursive: true });
  });

  function openStore(): SqlitePreparedPayoutStore {
    const store = new SqlitePreparedPayoutStore(databasePath);
    stores.push(store);
    return store;
  }

  it("creates private database and journal files", () => {
    openStore();

    const files = readdirSync(directory);
    expect(files).toEqual(
      expect.arrayContaining([
        "prepared-payouts.sqlite",
        "prepared-payouts.sqlite-shm",
        "prepared-payouts.sqlite-wal",
      ]),
    );
    for (const file of files) {
      expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600);
    }
  });

  it("recovers and decrypts the same signed transaction after restart", async () => {
    const cipher = createCipher();
    const transaction = {
      type: "INVOKE",
      privateMarker: "recipient-sensitive-signed-transaction",
    };
    const candidate = await encryptedCandidate(cipher, transaction);
    const first = openStore();
    await first.createOrGet(candidate);
    first.close();

    expect(readFileSync(databasePath).toString("latin1")).not.toContain(transaction.privateMarker);
    const recovered = await openStore().getBySubmissionId(candidate.submissionId);

    if (recovered === null) {
      throw new Error("Prepared payout was not recovered");
    }
    await expect(cipher.open(recovered.encryptedTransaction, recovered)).resolves.toEqual(
      transaction,
    );
  });

  it("persists the first accepted inclusion across restart", async () => {
    const candidate = await encryptedCandidate(createCipher());
    const first = openStore();
    await first.createOrGet(candidate);
    await first.recordInclusion({
      submissionId: candidate.submissionId,
      transactionReference: candidate.transactionReference,
      blockHash: "0xdef",
      blockNumber: 42n,
    });
    first.close();

    await expect(openStore().getBySubmissionId(candidate.submissionId)).resolves.toMatchObject({
      inclusion: { blockHash: "0xdef", blockNumber: 42n },
    });
  });

  it("persists the first finality incident across restart without replacing it", async () => {
    const candidate = await encryptedCandidate(createCipher());
    const first = openStore();
    await first.createOrGet(candidate);
    await first.recordInclusion({
      submissionId: candidate.submissionId,
      transactionReference: candidate.transactionReference,
      blockHash: "0xdef",
      blockNumber: 42n,
    });
    await first.recordFinalityIncident({
      intentId: candidate.intentId,
      submissionId: candidate.submissionId,
      transactionReference: candidate.transactionReference,
      status: "REORGED",
      detectedAt: "2026-09-01T10:00:00.000Z",
      observerVersion: "observer-v1",
    });
    first.close();

    const reopened = openStore();
    await expect(
      reopened.recordFinalityIncident({
        intentId: candidate.intentId,
        submissionId: candidate.submissionId,
        transactionReference: candidate.transactionReference,
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
      inclusion: { blockHash: "0xdef", blockNumber: 42n },
    });
  });

  it("serializes submission claims across instances and permits takeover only after expiry", async () => {
    const candidate = await encryptedCandidate(createCipher());
    const first = openStore();
    const second = openStore();
    await first.createOrGet(candidate);

    const [firstClaim, competingClaim] = await Promise.all([
      first.claimSubmission(submissionLease()),
      second.claimSubmission(submissionLease({ leaseId: "lease-2" })),
    ]);

    expect(firstClaim).toBe(true);
    expect(competingClaim).toBe(false);
    await expect(first.claimSubmission(submissionLease())).resolves.toBe(true);
    await expect(
      first.claimSubmission(submissionLease({ expiresAt: "2026-09-01T10:00:31.000Z" })),
    ).rejects.toBeInstanceOf(PreparedPayoutIntegrityError);
    first.close();
    second.close();

    const restarted = openStore();
    await expect(restarted.claimSubmission(submissionLease({ leaseId: "lease-3" }))).resolves.toBe(
      false,
    );
    await expect(
      restarted.claimSubmission(
        submissionLease({
          leaseId: "lease-4",
          acquiredAt: "2026-09-01T10:01:00.000Z",
          expiresAt: "2026-09-01T10:01:30.000Z",
        }),
      ),
    ).resolves.toBe(true);
  });

  it("rejects a finality incident before an inclusion exists", async () => {
    const candidate = await encryptedCandidate(createCipher());
    const store = openStore();
    await store.createOrGet(candidate);

    await expect(
      store.recordFinalityIncident({
        intentId: candidate.intentId,
        submissionId: candidate.submissionId,
        transactionReference: candidate.transactionReference,
        status: "REORGED",
        detectedAt: "2026-09-01T10:00:00.000Z",
        observerVersion: "observer-v1",
      }),
    ).rejects.toThrow("Prepared payout has no accepted inclusion to monitor");
  });

  it("migrates a legacy prepared-artifact database without changing its ciphertext", async () => {
    const candidate = await encryptedCandidate(createCipher());
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(LEGACY_SCHEMA_SQL);
    legacy
      .prepare(
        `INSERT INTO prepared_payouts (
          intent_id, submission_id, request_digest, adapter_version, sender_address, nonce,
          transaction_reference, payload_version, encryption_algorithm, encryption_key_id,
          initialization_vector, ciphertext, authentication_tag
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        candidate.intentId,
        candidate.submissionId,
        candidate.requestDigest,
        candidate.adapterVersion,
        candidate.senderAddress,
        candidate.nonce,
        candidate.transactionReference,
        candidate.payloadVersion,
        candidate.encryptedTransaction.algorithm,
        candidate.encryptedTransaction.keyId,
        candidate.encryptedTransaction.initializationVector,
        candidate.encryptedTransaction.ciphertext,
        candidate.encryptedTransaction.authenticationTag,
      );
    legacy.close();

    await expect(openStore().getByIntentId(candidate.intentId)).resolves.toEqual(candidate);

    const migrated = new DatabaseSync(databasePath);
    expect(migrated.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4 });
    migrated.close();
  });

  it("migrates an inclusion-aware database through finality and submission-lease storage", async () => {
    const candidate = await encryptedCandidate(createCipher());
    const previous = new DatabaseSync(databasePath);
    previous.exec(INCLUSION_SCHEMA_SQL);
    previous
      .prepare(
        `INSERT INTO prepared_payouts (
          intent_id, submission_id, request_digest, adapter_version, sender_address, nonce,
          transaction_reference, payload_version, encryption_algorithm, encryption_key_id,
          initialization_vector, ciphertext, authentication_tag, inclusion_block_hash,
          inclusion_block_number
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        candidate.intentId,
        candidate.submissionId,
        candidate.requestDigest,
        candidate.adapterVersion,
        candidate.senderAddress,
        candidate.nonce,
        candidate.transactionReference,
        candidate.payloadVersion,
        candidate.encryptedTransaction.algorithm,
        candidate.encryptedTransaction.keyId,
        candidate.encryptedTransaction.initializationVector,
        candidate.encryptedTransaction.ciphertext,
        candidate.encryptedTransaction.authenticationTag,
        "0xdef",
        "42",
      );
    previous.close();

    await expect(openStore().getByIntentId(candidate.intentId)).resolves.toMatchObject({
      inclusion: { blockHash: "0xdef", blockNumber: 42n },
    });

    const migrated = new DatabaseSync(databasePath);
    expect(migrated.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4 });
    migrated.close();
  });

  it("rejects replacement of a persisted inclusion", async () => {
    const candidate = await encryptedCandidate(createCipher());
    const store = openStore();
    await store.createOrGet(candidate);
    await store.recordInclusion({
      submissionId: candidate.submissionId,
      transactionReference: candidate.transactionReference,
      blockHash: "0xdef",
      blockNumber: 42n,
    });

    await expect(
      store.recordInclusion({
        submissionId: candidate.submissionId,
        transactionReference: candidate.transactionReference,
        blockHash: "0x999",
        blockNumber: 43n,
      }),
    ).rejects.toMatchObject({ code: "inclusion_conflict" });
  });

  it("serializes ownership across independent store instances", async () => {
    const first = openStore();
    const second = openStore();
    const candidate = await encryptedCandidate(createCipher());

    const [left, right] = await Promise.all([
      first.createOrGet(candidate),
      second.createOrGet(candidate),
    ]);

    expect(left).toEqual(candidate);
    expect(right).toEqual(candidate);
  });

  it.each([
    {
      name: "submission ID",
      change: { intentId: "intent-2" },
      code: "submission_conflict",
    },
    {
      name: "transaction hash",
      change: { intentId: "intent-2", submissionId: "submission-2", nonce: "0x2" },
      code: "transaction_conflict",
    },
    {
      name: "sender nonce",
      change: {
        intentId: "intent-2",
        submissionId: "submission-2",
        transactionReference: "0xdef",
      },
      code: "nonce_conflict",
    },
  ])("rejects cross-process $name reuse", async ({ change, code }) => {
    const first = openStore();
    const second = openStore();
    const candidate = await encryptedCandidate(createCipher());
    await first.createOrGet(candidate);

    await expect(second.createOrGet({ ...candidate, ...change })).rejects.toEqual(
      expect.objectContaining({
        name: PreparedPayoutConflictError.name,
        code,
      }),
    );
  });

  it("keeps the first artifact for a same-request race", async () => {
    const first = openStore();
    const second = openStore();
    const candidate = await encryptedCandidate(createCipher());
    const competing = await encryptedCandidate(createCipher(), undefined, {
      submissionId: "submission-2",
      nonce: "0x2",
      transactionReference: "0xdef",
    });

    await first.createOrGet(candidate);

    await expect(second.createOrGet(competing)).resolves.toEqual(candidate);
  });

  it("detects structurally corrupted rows instead of returning them", async () => {
    const store = openStore();
    const candidate = await encryptedCandidate(createCipher());
    await store.createOrGet(candidate);
    store.close();
    const connection = new DatabaseSync(databasePath);
    connection.exec("PRAGMA ignore_check_constraints = ON");
    connection
      .prepare("UPDATE prepared_payouts SET payload_version = 99 WHERE intent_id = ?")
      .run(candidate.intentId);
    connection.close();

    await expect(openStore().getByIntentId(candidate.intentId)).rejects.toBeInstanceOf(
      PreparedPayoutStoreCorruptionError,
    );
  });

  it("detects a partially persisted submission lease", async () => {
    const store = openStore();
    const candidate = await encryptedCandidate(createCipher());
    await store.createOrGet(candidate);
    store.close();
    const connection = new DatabaseSync(databasePath);
    connection.exec("PRAGMA ignore_check_constraints = ON");
    connection
      .prepare("UPDATE prepared_payouts SET submission_lease_id = ? WHERE intent_id = ?")
      .run("lease-1", candidate.intentId);
    connection.close();

    await expect(openStore().getByIntentId(candidate.intentId)).rejects.toBeInstanceOf(
      PreparedPayoutStoreCorruptionError,
    );
  });

  it("relies on AES-GCM authentication when stored ciphertext is modified", async () => {
    const cipher = createCipher();
    const candidate = await encryptedCandidate(cipher);
    const store = openStore();
    await store.createOrGet(candidate);
    store.close();
    const connection = new DatabaseSync(databasePath);
    connection
      .prepare("UPDATE prepared_payouts SET ciphertext = ? WHERE intent_id = ?")
      .run(flipBase64Url(candidate.encryptedTransaction.ciphertext), candidate.intentId);
    connection.close();

    const recovered = await openStore().getByIntentId(candidate.intentId);
    if (recovered === null) {
      throw new Error("Prepared payout was not recovered");
    }
    await expect(cipher.open(recovered.encryptedTransaction, recovered)).rejects.toMatchObject({
      code: "decryption_failure",
    });
  });

  it("refuses to share the unencrypted general settlement database", () => {
    const general = new SqliteSettlementStore(databasePath);
    general.close();

    expect(() => openStore()).toThrowError(PreparedPayoutStoreCorruptionError);
  });
});

async function encryptedCandidate(
  cipher: AesGcmPreparedPayoutCipher,
  transaction: unknown = { type: "INVOKE", calldata: ["0x1"] },
  change: Partial<PreparedPayoutPayloadContext> = {},
): Promise<PreparedPayoutCandidate> {
  const context: PreparedPayoutPayloadContext = {
    payloadVersion: PREPARED_PAYOUT_PAYLOAD_VERSION,
    intentId: "intent-1",
    submissionId: "submission-1",
    requestDigest: `sha256:${"a".repeat(64)}`,
    adapterVersion: "adapter-v1",
    senderAddress: "0x123",
    nonce: "0x1",
    transactionReference: "0xabc",
    ...change,
  };
  return {
    ...context,
    encryptedTransaction: await cipher.seal(transaction, context),
  };
}

function createCipher(): AesGcmPreparedPayoutCipher {
  let initializationVector = 0;
  return new AesGcmPreparedPayoutCipher({
    keyring: new TestKeyring(),
    maximumPlaintextBytes: 64 * 1024,
    randomInitializationVector: () => {
      initializationVector += 1;
      return new Uint8Array(12).fill(initializationVector);
    },
  });
}

function submissionLease(
  change: Partial<Parameters<SqlitePreparedPayoutStore["claimSubmission"]>[0]> = {},
): Parameters<SqlitePreparedPayoutStore["claimSubmission"]>[0] {
  return {
    submissionId: "submission-1",
    transactionReference: "0xabc",
    leaseId: "lease-1",
    acquiredAt: "2026-09-01T10:00:00.000Z",
    expiresAt: "2026-09-01T10:00:30.000Z",
    ...change,
  };
}

class TestKeyring implements PreparedPayoutKeyring {
  readonly key = new Uint8Array(32).fill(11);

  async getActiveKey(): Promise<PreparedPayoutEncryptionKey> {
    return { keyId: "test-key-1", key: this.key };
  }

  async getKey(keyId: string): Promise<Uint8Array | null> {
    return keyId === "test-key-1" ? this.key : null;
  }
}

function flipBase64Url(value: string): string {
  return `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
}

const LEGACY_SCHEMA_SQL = `
  CREATE TABLE prepared_payouts (
    intent_id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL UNIQUE,
    request_digest TEXT NOT NULL,
    adapter_version TEXT NOT NULL,
    sender_address TEXT NOT NULL,
    nonce TEXT NOT NULL,
    transaction_reference TEXT NOT NULL UNIQUE,
    payload_version INTEGER NOT NULL CHECK (payload_version = 1),
    encryption_algorithm TEXT NOT NULL CHECK (encryption_algorithm = 'A256GCM'),
    encryption_key_id TEXT NOT NULL,
    initialization_vector TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    authentication_tag TEXT NOT NULL,
    UNIQUE (sender_address, nonce)
  ) STRICT;
  PRAGMA user_version = 1;
`;

const INCLUSION_SCHEMA_SQL = `
  CREATE TABLE prepared_payouts (
    intent_id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL UNIQUE,
    request_digest TEXT NOT NULL,
    adapter_version TEXT NOT NULL,
    sender_address TEXT NOT NULL,
    nonce TEXT NOT NULL,
    transaction_reference TEXT NOT NULL UNIQUE,
    payload_version INTEGER NOT NULL CHECK (payload_version = 1),
    encryption_algorithm TEXT NOT NULL CHECK (encryption_algorithm = 'A256GCM'),
    encryption_key_id TEXT NOT NULL,
    initialization_vector TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    authentication_tag TEXT NOT NULL,
    inclusion_block_hash TEXT,
    inclusion_block_number TEXT,
    CHECK (
      (inclusion_block_hash IS NULL AND inclusion_block_number IS NULL) OR
      (inclusion_block_hash IS NOT NULL AND inclusion_block_number IS NOT NULL)
    ),
    UNIQUE (sender_address, nonce)
  ) STRICT;
  PRAGMA user_version = 2;
`;
