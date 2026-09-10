import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MeltPaymentEnvelope } from "@cashu-strk20/strk20-method";
import { type CairoVersion, transaction } from "starknet";
import { describe, expect, it } from "vitest";

import {
  CompositePrivateSettlementGateway,
  type PayoutPreparationInput,
  type PrivateFundingGateway,
} from "./gateway.js";
import { InMemorySettlementIntentStore, type SettlementIntentStore } from "./intents.js";
import { PayoutCoordinator } from "./payouts.js";
import {
  AesGcmPreparedPayoutCipher,
  type PreparedPayoutEncryptionKey,
  type PreparedPayoutKeyring,
} from "./prepared-payout-cipher.js";
import { InMemoryPreparedPayoutStore, type PreparedPayoutStore } from "./prepared-payouts.js";
import { InProcessSettlementActivityGate } from "./settlement-activity-gate.js";
import { SettlementAdmissionController } from "./settlement-admission.js";
import { InMemorySettlementPauseStore, type SettlementPauseStore } from "./settlement-pauses.js";
import { SqlitePreparedPayoutStore } from "./sqlite-prepared-payout-store.js";
import { SqliteSettlementStore } from "./sqlite-store.js";
import {
  STARKNET_PRIVACY_SDK_PAYOUT_ADAPTER_VERSION,
  type StarknetPayoutRpc,
  type StarknetPayoutSigningAccount,
  type StarknetPreparedPayoutChainStatus,
  type StarknetPreparedPayoutStatusSource,
  StarknetPrivacySdkPayoutAdapter,
  type StarknetPrivacySdkPayoutBuilder,
  StarknetPrivacySdkPayoutConfigurationError,
  StarknetPrivacySdkPayoutError,
  type StarknetPrivacySdkPayoutExecuteResult,
  type StarknetPrivacySdkPayoutLimits,
  type StarknetPrivacySdkPayoutTokenBuilder,
  type StarknetPrivacySdkPayoutTransfers,
  type StarknetSignedInvokeTransaction,
} from "./starknet-privacy-sdk-payout.js";

const NOW_SECONDS = 2_000_000_000;
const POOL = "0x123";
const TOKEN = "0x456";
const RECIPIENT = "0x789";
const SENDER = "0xabc";
const PROVING_BLOCK = "0xdef";
const PROVING_BLOCK_NUMBER = 95n;
const INCLUSION_BLOCK = "0x222";
const INCLUSION_BLOCK_NUMBER = 42n;
const PROOF = "YQ==";
const PROOF_FACTS = ["0x1", "0x2", "0x3", "0x4", "0x5f", PROVING_BLOCK];

const request: MeltPaymentEnvelope = {
  version: 1,
  kind: "melt",
  network: "SN_SEPOLIA",
  token_contract: TOKEN,
  amount: 100,
  amount_base_units: "1000000",
  expires_at: NOW_SECONDS + 300,
  destination: { pool: POOL, recipient: RECIPIENT },
};

describe("Starknet Privacy SDK payout adapter", () => {
  it("compiles, signs, encrypts, and owns one exact transaction before broadcast", async () => {
    const harness = createHarness();

    const prepared = await harness.adapter.preparePayout(payoutInput());
    const repeated = await harness.adapter.preparePayout(payoutInput());

    expect(repeated).toEqual(prepared);
    expect(prepared).toMatchObject({
      intentId: "intent-1",
      submissionId: "submission-1",
      status: "PREPARED",
    });
    expect(prepared.transactionReference).toMatch(/^0x[1-9a-f][0-9a-f]*$/);
    expect(harness.transfers.executeCalls).toBe(1);
    expect(harness.account.calls).toHaveLength(1);
    expect(harness.transfers.buildCalls).toEqual([
      {
        autoRegister: false,
        autoDiscover: { notes: "refresh", channels: "refresh" },
        autoSetup: false,
        autoSelectNotes: "naive",
        registryConst: true,
        provingBlockId: PROVING_BLOCK,
      },
    ]);
    expect(harness.transfers.tokenCalls).toEqual([BigInt(TOKEN)]);
    expect(harness.transfers.transferCalls).toEqual([
      { recipient: BigInt(RECIPIENT), amount: 1_000_000n },
    ]);
    expect(harness.transfers.surplusCalls).toEqual([
      { recipient: BigInt(SENDER), withdraw: false },
    ]);
    expect(harness.account.calls[0]).toEqual({
      call: { contractAddress: POOL, entrypoint: "apply_actions", calldata: ["0x10"] },
      details: {
        blockIdentifier: PROVING_BLOCK,
        proofFacts: PROOF_FACTS,
        proof: PROOF,
      },
    });
    const stored = await harness.preparedStore.getByIntentId("intent-1");
    expect(stored?.adapterVersion).toBe(STARKNET_PRIVACY_SDK_PAYOUT_ADAPTER_VERSION);
    expect(JSON.stringify(stored?.encryptedTransaction)).not.toContain("sender_address");
    expect(harness.rpc.submissions).toHaveLength(0);
  });

  it("fences immediate rebroadcast and permits only the exact signed transaction after expiry", async () => {
    let nowMilliseconds = NOW_SECONDS * 1_000;
    const harness = createHarness({ now: () => new Date(nowMilliseconds) });
    const prepared = await harness.adapter.preparePayout(payoutInput());
    harness.rpc.returnedTransactionReference = prepared.transactionReference;

    await expect(harness.adapter.submitPayout(prepared.submissionId)).resolves.toMatchObject({
      status: "PENDING",
      transactionReference: prepared.transactionReference,
    });
    await expect(harness.adapter.submitPayout(prepared.submissionId)).resolves.toMatchObject({
      status: "UNKNOWN",
      transactionReference: prepared.transactionReference,
    });

    expect(harness.rpc.submissions).toHaveLength(1);
    nowMilliseconds += 30_000;
    await expect(harness.adapter.submitPayout(prepared.submissionId)).resolves.toMatchObject({
      status: "PENDING",
      transactionReference: prepared.transactionReference,
    });

    expect(harness.rpc.submissions).toHaveLength(2);
    expect(harness.rpc.submissions[1]).toEqual(harness.rpc.submissions[0]);
    expect(harness.transfers.executeCalls).toBe(1);
    expect(harness.account.calls).toHaveLength(1);
  });

  it("allows only one broadcaster across concurrent adapter instances", async () => {
    const shared = createSharedPayoutState();
    const first = createHarness(shared);
    const prepared = await first.adapter.preparePayout(payoutInput());
    first.rpc.returnedTransactionReference = prepared.transactionReference;
    const second = createHarness(shared);

    const attempts = await Promise.all([
      first.adapter.submitPayout(prepared.submissionId),
      second.adapter.submitPayout(prepared.submissionId),
    ]);

    expect(attempts.map((attempt) => attempt.status).sort()).toEqual(["PENDING", "UNKNOWN"]);
    expect(first.rpc.submissions).toHaveLength(1);
  });

  it("keeps a durable fence when the submission-claim response is lost", async () => {
    let nowMilliseconds = NOW_SECONDS * 1_000;
    const delegate = new InMemoryPreparedPayoutStore();
    const preparedStore = new ThrowAfterClaimPreparedPayoutStore(delegate);
    const harness = createHarness({
      preparedStore,
      now: () => new Date(nowMilliseconds),
    });
    const prepared = await harness.adapter.preparePayout(payoutInput());
    harness.rpc.returnedTransactionReference = prepared.transactionReference;

    await expect(harness.adapter.submitPayout(prepared.submissionId)).rejects.toMatchObject({
      code: "store_failure",
    });
    await expect(harness.adapter.submitPayout(prepared.submissionId)).resolves.toMatchObject({
      status: "UNKNOWN",
    });
    expect(harness.rpc.submissions).toHaveLength(0);

    nowMilliseconds += 30_000;
    await expect(harness.adapter.submitPayout(prepared.submissionId)).resolves.toMatchObject({
      status: "PENDING",
    });
    expect(harness.rpc.submissions).toHaveLength(1);
  });

  it("recovers a lost submission response after restart without compiling another transfer", async () => {
    const intentStore = new InMemorySettlementIntentStore();
    const shared = createSharedPayoutState();
    const first = createHarness(shared);
    first.rpc.throwAfterSubmission = true;
    const firstCoordinator = createCoordinator(intentStore, first.adapter);

    const ambiguous = await firstCoordinator.ensurePayout({ quoteId: "quote-1", request });
    expect(ambiguous.state).toBe("UNKNOWN");
    expect(first.rpc.submissions).toHaveLength(1);

    first.rpc.throwAfterSubmission = false;
    first.status.status = "FINAL";
    const restarted = createHarness(shared);
    const recovered = await createCoordinator(intentStore, restarted.adapter).ensurePayout({
      quoteId: "quote-1",
      request,
    });

    expect(recovered).toMatchObject({ state: "PAID" });
    expect(restarted.transfers.executeCalls).toBe(0);
    expect(restarted.account.calls).toHaveLength(0);
    expect(first.rpc.submissions).toHaveLength(1);
  });

  it("recovers a lost submission response after both SQLite stores restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cashu-strk20-payout-recovery-"));
    const settlementPath = join(directory, "settlement.sqlite");
    const preparedPath = join(directory, "prepared.sqlite");
    const cipher = createCipher();
    const rpc = new FakePayoutRpc();
    const status = new FakePayoutStatusSource();
    let transactionReference = "";
    try {
      const initialIntents = new SqliteSettlementStore(settlementPath);
      const initialPrepared = new SqlitePreparedPayoutStore(preparedPath);
      try {
        const initialHarness = createHarness({
          preparedStore: initialPrepared,
          cipher,
          rpc,
          status,
        });
        rpc.throwAfterSubmission = true;

        await expect(
          createCoordinator(initialIntents, initialHarness.adapter, initialIntents).ensurePayout({
            quoteId: "quote-1",
            request,
          }),
        ).resolves.toMatchObject({ state: "UNKNOWN" });
        expect(rpc.submissions).toHaveLength(1);
        const prepared = await initialPrepared.getByIntentId("intent-1");
        if (prepared === null) {
          throw new Error("Prepared payout fixture was not persisted");
        }
        transactionReference = prepared.transactionReference;
        expect(transactionReference).toMatch(/^0x[1-9a-f][0-9a-f]*$/);
      } finally {
        initialPrepared.close();
        initialIntents.close();
      }

      const restartedIntents = new SqliteSettlementStore(settlementPath);
      const restartedPrepared = new SqlitePreparedPayoutStore(preparedPath);
      try {
        rpc.throwAfterSubmission = false;
        status.status = "FINAL";
        const restartedHarness = createHarness({
          preparedStore: restartedPrepared,
          cipher,
          rpc,
          status,
        });

        await expect(
          createCoordinator(
            restartedIntents,
            restartedHarness.adapter,
            restartedIntents,
          ).ensurePayout({ quoteId: "quote-1", request }),
        ).resolves.toMatchObject({ state: "PAID" });
        expect(restartedHarness.transfers.executeCalls).toBe(0);
        expect(restartedHarness.account.calls).toHaveLength(0);
        expect(rpc.submissions).toHaveLength(1);
        expect(status.calls.at(-1)).toMatchObject({ transactionReference });
        await expect(restartedPrepared.getByIntentId("intent-1")).resolves.toMatchObject({
          submissionId: "submission-1",
          transactionReference,
          inclusion: { blockHash: INCLUSION_BLOCK, blockNumber: INCLUSION_BLOCK_NUMBER },
        });
        await expect(restartedIntents.getByQuoteId("quote-1")).resolves.toMatchObject({
          state: "PAID",
          transactionReferences: [transactionReference],
        });
      } finally {
        restartedPrepared.close();
        restartedIntents.close();
      }

      const recoveredIntents = new SqliteSettlementStore(settlementPath);
      try {
        await expect(recoveredIntents.getByQuoteId("quote-1")).resolves.toMatchObject({
          intentId: "intent-1",
          state: "PAID",
          submissionId: "submission-1",
          transactionReferences: [transactionReference],
        });
      } finally {
        recoveredIntents.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("recovers an already prepared artifact after request expiry", async () => {
    const shared = createSharedPayoutState();
    const first = createHarness(shared);
    const prepared = await first.adapter.preparePayout(payoutInput());

    const restarted = createHarness({
      ...shared,
      now: () => new Date((request.expires_at + 1) * 1_000),
    });

    await expect(restarted.adapter.preparePayout(payoutInput())).resolves.toEqual(prepared);
    expect(restarted.transfers.executeCalls).toBe(0);
    expect(restarted.account.calls).toHaveLength(0);
  });

  it("recovers when durable ownership succeeds but the store response is lost", async () => {
    const delegate = new InMemoryPreparedPayoutStore();
    const preparedStore = new ThrowAfterCreatePreparedPayoutStore(delegate);
    const harness = createHarness({ preparedStore });

    await expect(harness.adapter.preparePayout(payoutInput())).rejects.toMatchObject({
      code: "store_failure",
    });
    expect(await delegate.getByIntentId("intent-1")).not.toBeNull();

    await expect(harness.adapter.preparePayout(payoutInput())).resolves.toMatchObject({
      intentId: "intent-1",
      submissionId: "submission-1",
      status: "PREPARED",
    });
    expect(harness.transfers.executeCalls).toBe(1);
    expect(harness.account.calls).toHaveLength(1);
  });

  it("submits the encrypted exact transaction after the prepared store is closed and reopened", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cashu-strk20-payout-adapter-"));
    const databasePath = join(directory, "prepared.sqlite");
    const cipher = createCipher();
    const rpc = new FakePayoutRpc();
    const status = new FakePayoutStatusSource();
    const firstStore = new SqlitePreparedPayoutStore(databasePath);
    try {
      const first = createHarness({ preparedStore: firstStore, cipher, rpc, status });
      const prepared = await first.adapter.preparePayout(payoutInput());
      firstStore.close();

      const reopened = new SqlitePreparedPayoutStore(databasePath);
      try {
        const restarted = createHarness({ preparedStore: reopened, cipher, rpc, status });
        rpc.returnedTransactionReference = prepared.transactionReference;

        await expect(restarted.adapter.submitPayout(prepared.submissionId)).resolves.toMatchObject({
          status: "PENDING",
          transactionReference: prepared.transactionReference,
        });
        expect(restarted.transfers.executeCalls).toBe(0);
        expect(restarted.account.calls).toHaveLength(0);
        expect(rpc.submissions).toHaveLength(1);
      } finally {
        reopened.close();
      }
    } finally {
      firstStore.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("reobserves a persisted inclusion after restart and keeps a reorg non-final", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cashu-strk20-payout-reorg-"));
    const databasePath = join(directory, "prepared.sqlite");
    const cipher = createCipher();
    const rpc = new FakePayoutRpc();
    const status = new FakePayoutStatusSource();
    const firstStore = new SqlitePreparedPayoutStore(databasePath);
    try {
      const first = createHarness({ preparedStore: firstStore, cipher, rpc, status });
      const prepared = await first.adapter.preparePayout(payoutInput());
      rpc.returnedTransactionReference = prepared.transactionReference;
      await first.adapter.submitPayout(prepared.submissionId);
      status.status = "PENDING";

      await expect(first.adapter.getPayoutStatus(prepared.submissionId)).resolves.toMatchObject({
        status: "PENDING",
      });
      expect(await firstStore.getBySubmissionId(prepared.submissionId)).toMatchObject({
        inclusion: { blockHash: INCLUSION_BLOCK, blockNumber: INCLUSION_BLOCK_NUMBER },
      });
      firstStore.close();

      const reopened = new SqlitePreparedPayoutStore(databasePath);
      try {
        status.status = "REORGED";
        const restarted = createHarness({ preparedStore: reopened, cipher, rpc, status });

        await expect(
          restarted.adapter.getPayoutStatus(prepared.submissionId),
        ).resolves.toMatchObject({ status: "UNKNOWN" });
        expect(status.calls.at(-1)).toMatchObject({
          knownInclusion: {
            blockHash: INCLUSION_BLOCK,
            blockNumber: INCLUSION_BLOCK_NUMBER,
          },
        });
        expect(restarted.transfers.executeCalls).toBe(0);
        expect(restarted.account.calls).toHaveLength(0);
      } finally {
        reopened.close();
      }
    } finally {
      firstStore.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("recovers when inclusion persistence succeeds but the store response is lost", async () => {
    const delegate = new InMemoryPreparedPayoutStore();
    const preparedStore = new ThrowAfterInclusionPreparedPayoutStore(delegate);
    const harness = createHarness({ preparedStore });
    const prepared = await harness.adapter.preparePayout(payoutInput());
    harness.status.status = "PENDING";

    await expect(harness.adapter.getPayoutStatus(prepared.submissionId)).rejects.toMatchObject({
      code: "store_failure",
    });
    await expect(delegate.getBySubmissionId(prepared.submissionId)).resolves.toMatchObject({
      inclusion: { blockHash: INCLUSION_BLOCK, blockNumber: INCLUSION_BLOCK_NUMBER },
    });

    await expect(harness.adapter.getPayoutStatus(prepared.submissionId)).resolves.toMatchObject({
      status: "PENDING",
    });
    expect(harness.status.calls.at(-1)).toMatchObject({
      knownInclusion: { blockHash: INCLUSION_BLOCK, blockNumber: INCLUSION_BLOCK_NUMBER },
    });
    expect(harness.transfers.executeCalls).toBe(1);
    expect(harness.account.calls).toHaveLength(1);
  });

  it("rejects an accepted status without durable block identity", async () => {
    const harness = createHarness();
    const prepared = await harness.adapter.preparePayout(payoutInput());
    harness.status.status = "PENDING";
    harness.status.includeBlock = false;

    await expect(harness.adapter.getPayoutStatus(prepared.submissionId)).rejects.toMatchObject({
      code: "invalid_response",
    });
    await expect(harness.preparedStore.getBySubmissionId(prepared.submissionId)).resolves.toEqual(
      expect.not.objectContaining({ inclusion: expect.anything() }),
    );
  });

  it("rejects replacement of the original accepted inclusion", async () => {
    const harness = createHarness();
    const prepared = await harness.adapter.preparePayout(payoutInput());
    harness.status.status = "PENDING";
    await harness.adapter.getPayoutStatus(prepared.submissionId);
    harness.status.blockHash = "0x333";
    harness.status.blockNumber = 43n;

    await expect(harness.adapter.getPayoutStatus(prepared.submissionId)).rejects.toMatchObject({
      code: "store_conflict",
    });
    await expect(
      harness.preparedStore.getBySubmissionId(prepared.submissionId),
    ).resolves.toMatchObject({
      inclusion: { blockHash: INCLUSION_BLOCK, blockNumber: INCLUSION_BLOCK_NUMBER },
    });
  });

  it.each([
    { chainStatus: "FINAL", finalStatus: "FINAL" },
    { chainStatus: "PENDING", finalStatus: "UNKNOWN" },
    { chainStatus: "NOT_FOUND", finalStatus: "UNKNOWN" },
    { chainStatus: "UNKNOWN", finalStatus: "UNKNOWN" },
    { chainStatus: "REORGED", finalStatus: "REORGED" },
    { chainStatus: "CONFLICTED", finalStatus: "CONFLICTED" },
    { chainStatus: "REVERTED", finalStatus: "REVERTED" },
  ] as const)(
    "reobserves an already final payout as $finalStatus for $chainStatus without replay",
    async ({ chainStatus, finalStatus }) => {
      const harness = createHarness();
      const prepared = await harness.adapter.preparePayout(payoutInput());
      harness.status.status = "FINAL";
      await harness.adapter.getPayoutStatus(prepared.submissionId);
      harness.status.status = chainStatus;

      await expect(harness.adapter.reobserveFinalPayout(prepared.submissionId)).resolves.toEqual({
        intentId: "intent-1",
        submissionId: "submission-1",
        transactionReference: prepared.transactionReference,
        inclusion: { blockHash: INCLUSION_BLOCK, blockNumber: INCLUSION_BLOCK_NUMBER },
        status: finalStatus,
      });
      expect(harness.status.calls.at(-1)).toMatchObject({
        knownInclusion: { blockHash: INCLUSION_BLOCK, blockNumber: INCLUSION_BLOCK_NUMBER },
      });
      expect(harness.transfers.executeCalls).toBe(1);
      expect(harness.account.calls).toHaveLength(1);
      expect(harness.rpc.submissions).toHaveLength(0);
    },
  );

  it("keeps an unavailable post-finality observation unknown", async () => {
    const harness = createHarness();
    const prepared = await harness.adapter.preparePayout(payoutInput());
    harness.status.status = "FINAL";
    await harness.adapter.getPayoutStatus(prepared.submissionId);
    harness.status.throwOnObserve = true;

    await expect(
      harness.adapter.reobserveFinalPayout(prepared.submissionId),
    ).resolves.toMatchObject({
      status: "UNKNOWN",
      inclusion: { blockHash: INCLUSION_BLOCK, blockNumber: INCLUSION_BLOCK_NUMBER },
    });
  });

  it("rejects post-finality status evidence for a different inclusion", async () => {
    const harness = createHarness();
    const prepared = await harness.adapter.preparePayout(payoutInput());
    harness.status.status = "FINAL";
    await harness.adapter.getPayoutStatus(prepared.submissionId);
    harness.status.status = "REORGED";
    harness.status.blockHash = "0x333";
    harness.status.blockNumber = 43n;

    await expect(harness.adapter.reobserveFinalPayout(prepared.submissionId)).rejects.toMatchObject(
      {
        code: "invalid_response",
      },
    );
  });

  it("rejects finality reobservation before an inclusion has been accepted", async () => {
    const harness = createHarness();
    const prepared = await harness.adapter.preparePayout(payoutInput());

    await expect(harness.adapter.reobserveFinalPayout(prepared.submissionId)).rejects.toMatchObject(
      {
        code: "invalid_input",
      },
    );
    expect(harness.status.calls).toHaveLength(0);
  });

  it("rebroadcasts the same bytes after an ambiguous result only when its fence expires", async () => {
    const intentStore = new InMemorySettlementIntentStore();
    let nowMilliseconds = NOW_SECONDS * 1_000;
    const harness = createHarness({ now: () => new Date(nowMilliseconds) });
    const coordinator = createCoordinator(intentStore, harness.adapter);
    harness.rpc.throwAfterSubmission = true;

    expect((await coordinator.ensurePayout({ quoteId: "quote-1", request })).state).toBe("UNKNOWN");
    harness.rpc.throwAfterSubmission = false;
    harness.status.status = "NOT_FOUND";
    const stored = await harness.preparedStore.getByIntentId("intent-1");
    harness.rpc.returnedTransactionReference = stored?.transactionReference;

    expect((await coordinator.ensurePayout({ quoteId: "quote-1", request })).state).toBe("UNKNOWN");
    expect(harness.rpc.submissions).toHaveLength(1);

    nowMilliseconds += 30_000;
    expect((await coordinator.ensurePayout({ quoteId: "quote-1", request })).state).toBe("PENDING");
    expect(harness.rpc.submissions).toHaveLength(2);
    expect(harness.rpc.submissions[1]).toEqual(harness.rpc.submissions[0]);
    expect(harness.transfers.executeCalls).toBe(1);
  });

  it.each([
    { chainStatus: "NOT_FOUND", payoutStatus: "PREPARED" },
    { chainStatus: "PENDING", payoutStatus: "PENDING" },
    { chainStatus: "FINAL", payoutStatus: "PAID" },
    { chainStatus: "REVERTED", payoutStatus: "FAILED" },
    { chainStatus: "UNKNOWN", payoutStatus: "UNKNOWN" },
    { chainStatus: "CONFLICTED", payoutStatus: "UNKNOWN" },
    { chainStatus: "REORGED", payoutStatus: "UNKNOWN" },
  ] as const)(
    "maps $chainStatus observation conservatively",
    async ({ chainStatus, payoutStatus }) => {
      const harness = createHarness();
      const prepared = await harness.adapter.preparePayout(payoutInput());
      harness.status.status = chainStatus;

      await expect(harness.adapter.getPayoutStatus(prepared.submissionId)).resolves.toMatchObject({
        status: payoutStatus,
        transactionReference: prepared.transactionReference,
      });
    },
  );

  it("persists canonical reverted inclusion before reporting failed", async () => {
    const harness = createHarness();
    const prepared = await harness.adapter.preparePayout(payoutInput());
    harness.status.status = "REVERTED";

    await expect(harness.adapter.getPayoutStatus(prepared.submissionId)).resolves.toMatchObject({
      status: "FAILED",
    });
    await expect(
      harness.preparedStore.getBySubmissionId(prepared.submissionId),
    ).resolves.toMatchObject({
      inclusion: { blockHash: INCLUSION_BLOCK, blockNumber: INCLUSION_BLOCK_NUMBER },
    });
  });

  it("recovers a reverted inclusion when its durable-store response is lost", async () => {
    const delegate = new InMemoryPreparedPayoutStore();
    const preparedStore = new ThrowAfterInclusionPreparedPayoutStore(delegate);
    const harness = createHarness({ preparedStore });
    const prepared = await harness.adapter.preparePayout(payoutInput());
    harness.status.status = "REVERTED";

    await expect(harness.adapter.getPayoutStatus(prepared.submissionId)).rejects.toMatchObject({
      code: "store_failure",
    });
    await expect(delegate.getBySubmissionId(prepared.submissionId)).resolves.toMatchObject({
      inclusion: { blockHash: INCLUSION_BLOCK, blockNumber: INCLUSION_BLOCK_NUMBER },
    });

    await expect(harness.adapter.getPayoutStatus(prepared.submissionId)).resolves.toMatchObject({
      status: "FAILED",
    });
    expect(harness.status.calls.at(-1)).toMatchObject({
      knownInclusion: { blockHash: INCLUSION_BLOCK, blockNumber: INCLUSION_BLOCK_NUMBER },
    });
  });

  it("rejects privacy warnings without signing or persisting the SDK result", async () => {
    const harness = createHarness();
    harness.transfers.result = sdkResult({
      warnings: [{ code: "USER_LINKAGE", message: "warning" }],
    });

    await expect(harness.adapter.preparePayout(payoutInput())).rejects.toMatchObject({
      code: "preparation_rejected",
    });
    expect(harness.account.calls).toHaveLength(0);
    await expect(harness.preparedStore.getByIntentId("intent-1")).resolves.toBeNull();
  });

  it.each([
    {
      name: "wrong SDK pool",
      configure: (harness: PayoutHarness) => {
        harness.transfers.result = sdkResult({
          callAndProof: sdkCallAndProof({
            call: { contractAddress: "0x999", entrypoint: "apply_actions", calldata: ["0x10"] },
          }),
        });
      },
    },
    {
      name: "wrong proof base block number",
      configure: (harness: PayoutHarness) => {
        const proofFacts = [...PROOF_FACTS];
        proofFacts[4] = "0x60";
        harness.transfers.result = sdkResult({
          callAndProof: sdkCallAndProof({
            proof: { data: PROOF, output: ["0x1"], proofFacts },
          }),
        });
      },
    },
    {
      name: "wrong proof base block hash",
      configure: (harness: PayoutHarness) => {
        const proofFacts = [...PROOF_FACTS];
        proofFacts[5] = "0x999";
        harness.transfers.result = sdkResult({
          callAndProof: sdkCallAndProof({
            proof: { data: PROOF, output: ["0x1"], proofFacts },
          }),
        });
      },
    },
    {
      name: "wrong signed sender",
      configure: (harness: PayoutHarness) => {
        harness.account.transaction = signedTransaction({ sender_address: "0x999" });
      },
    },
    {
      name: "missing signed proof",
      configure: (harness: PayoutHarness) => {
        harness.account.transaction = signedTransaction({ proof: "Yg==" });
      },
    },
    {
      name: "different signed call",
      configure: (harness: PayoutHarness) => {
        harness.account.transaction = signedTransaction({ calldata: ["0x1"] });
      },
    },
    {
      name: "sparse signed proof facts",
      configure: (harness: PayoutHarness) => {
        const transaction = signedTransaction();
        const proofFacts = new Array<string>(PROOF_FACTS.length);
        proofFacts[0] = PROOF_FACTS[0] as string;
        harness.account.transaction = { ...transaction, proof_facts: proofFacts };
      },
    },
  ])("rejects a $name before durable ownership", async ({ configure }) => {
    const harness = createHarness();
    configure(harness);

    await expect(harness.adapter.preparePayout(payoutInput())).rejects.toMatchObject({
      code: "invalid_response",
    });
    await expect(harness.preparedStore.getByIntentId("intent-1")).resolves.toBeNull();
    expect(harness.rpc.submissions).toHaveLength(0);
  });

  it.each([
    {
      name: "resource maximum",
      change: {
        resource_bounds: {
          l1_gas: { max_amount: "0x40", max_price_per_unit: "0x2" },
          l1_data_gas: { max_amount: "0x1", max_price_per_unit: "0x2" },
          l2_gas: { max_amount: "0x1", max_price_per_unit: "0x2" },
        },
      },
    },
    { name: "priority tip", change: { tip: "0xb" } },
  ])("rejects a signed transaction above the configured $name", async ({ change }) => {
    const harness = createHarness();
    harness.account.transaction = signedTransaction(change);

    await expect(harness.adapter.preparePayout(payoutInput())).rejects.toMatchObject({
      code: "preparation_rejected",
    });
    await expect(harness.preparedStore.getByIntentId("intent-1")).resolves.toBeNull();
    expect(harness.rpc.submissions).toHaveLength(0);
  });

  it("rejects an unsupported signing-account Cairo version before signing", async () => {
    const harness = createHarness();
    harness.account.cairoVersion = "2" as CairoVersion;

    await expect(harness.adapter.preparePayout(payoutInput())).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(harness.account.calls).toHaveLength(0);
  });

  it("rejects the wrong RPC chain before invoking the prover", async () => {
    const harness = createHarness();
    harness.rpc.chainId = "0x534e5f4d41494e";

    await expect(harness.adapter.preparePayout(payoutInput())).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(harness.transfers.executeCalls).toBe(0);
  });

  it("rejects a broadcast response for a different transaction", async () => {
    const harness = createHarness();
    const prepared = await harness.adapter.preparePayout(payoutInput());
    harness.rpc.returnedTransactionReference = "0x999";

    await expect(harness.adapter.submitPayout(prepared.submissionId)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it.each([
    { name: "wrong token", change: { token_contract: "0x999" } },
    { name: "mismatched amount", change: { amount_base_units: "1000001" } },
    { name: "expired request", change: { expires_at: NOW_SECONDS } },
    { name: "wrong pool", change: { destination: { pool: "0x999", recipient: RECIPIENT } } },
    { name: "zero recipient", change: { destination: { pool: POOL, recipient: "0x0" } } },
  ])("rejects a $name before external work", async ({ change }) => {
    const harness = createHarness();

    await expect(
      harness.adapter.preparePayout(
        payoutInput({ request: { ...request, ...change } as MeltPaymentEnvelope }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(harness.rpc.chainCalls).toBe(0);
    expect(harness.transfers.executeCalls).toBe(0);
  });

  it("prevents two payout intents from owning one signing-account nonce", async () => {
    const shared = createSharedPayoutState();
    const first = createHarness(shared);
    await first.adapter.preparePayout(payoutInput());
    const second = createHarness({ ...shared, submissionId: "submission-2" });
    second.account.transaction = signedTransaction({ nonce: "0x1", tip: "0x1" });

    await expect(
      second.adapter.preparePayout(
        payoutInput({
          intentId: "intent-2",
          request: { ...request, amount: 200, amount_base_units: "2000000" },
        }),
      ),
    ).rejects.toMatchObject({ code: "store_conflict" });
  });

  it("does not treat an unavailable status provider as permanent failure", async () => {
    const harness = createHarness();
    const prepared = await harness.adapter.preparePayout(payoutInput());
    harness.status.throwOnObserve = true;

    await expect(harness.adapter.getPayoutStatus(prepared.submissionId)).rejects.toEqual(
      expect.objectContaining({
        name: StarknetPrivacySdkPayoutError.name,
        code: "provider_failure",
      }),
    );
  });

  it.each([
    { maximumProofFacts: 5 },
    { maximumResourceFeeFri: 0n },
    { maximumTipFri: -1n },
    { submissionLeaseMilliseconds: 5_000 },
    { submissionLeaseMilliseconds: 600_001 },
  ])("rejects an unsafe payout limit configuration %#", (change) => {
    expect(() => createHarness({ limits: { ...payoutLimits(), ...change } })).toThrow(
      StarknetPrivacySdkPayoutConfigurationError,
    );
  });
});

interface SharedPayoutState {
  readonly preparedStore: PreparedPayoutStore;
  readonly cipher: AesGcmPreparedPayoutCipher;
  readonly rpc: FakePayoutRpc;
  readonly status: FakePayoutStatusSource;
  readonly submissionId?: string;
  readonly now?: () => Date;
  readonly limits?: StarknetPrivacySdkPayoutLimits;
}

interface PayoutHarness extends SharedPayoutState {
  readonly adapter: StarknetPrivacySdkPayoutAdapter;
  readonly transfers: FakePrivacyTransfers;
  readonly account: FakeSigningAccount;
  readonly preparedStore: PreparedPayoutStore;
}

function createSharedPayoutState(): SharedPayoutState {
  return {
    preparedStore: new InMemoryPreparedPayoutStore(),
    cipher: createCipher(),
    rpc: new FakePayoutRpc(),
    status: new FakePayoutStatusSource(),
  };
}

function createHarness(shared: Partial<SharedPayoutState> = {}): PayoutHarness {
  const transfers = new FakePrivacyTransfers();
  const account = new FakeSigningAccount();
  const preparedStore = shared.preparedStore ?? new InMemoryPreparedPayoutStore();
  const cipher = shared.cipher ?? createCipher();
  const rpc = shared.rpc ?? new FakePayoutRpc();
  const status = shared.status ?? new FakePayoutStatusSource();
  const submissionId = shared.submissionId ?? "submission-1";
  const adapter = new StarknetPrivacySdkPayoutAdapter({
    network: "SN_SEPOLIA",
    poolContract: POOL,
    tokenContract: TOKEN,
    finalityPolicy: "L2_ACCEPTED",
    privateTransfers: transfers,
    account,
    rpc,
    statusSource: status,
    store: preparedStore,
    cipher,
    resolveDestination: resolveTestDestination,
    selectProvingBlock: async () => ({
      blockHash: PROVING_BLOCK,
      blockNumber: PROVING_BLOCK_NUMBER,
    }),
    createSubmissionId: () => submissionId,
    now: shared.now ?? (() => new Date(NOW_SECONDS * 1_000)),
    limits: shared.limits ?? payoutLimits(),
  });
  return { adapter, transfers, account, preparedStore, cipher, rpc, status, submissionId };
}

function createCoordinator(
  store: SettlementIntentStore,
  gateway: StarknetPrivacySdkPayoutAdapter,
  pauseStore: SettlementPauseStore = new InMemorySettlementPauseStore(),
): PayoutCoordinator {
  return new PayoutCoordinator(
    store,
    new CompositePrivateSettlementGateway(unusedFunding, gateway),
    {
      network: "SN_SEPOLIA",
      tokenContract: TOKEN,
      minimumAmount: 1n,
      maximumAmount: 10_000n,
      admission: new SettlementAdmissionController(pauseStore),
      submissionGate: new InProcessSettlementActivityGate(),
      now: () => new Date(NOW_SECONDS * 1_000),
      createIntentId: () => "intent-1",
    },
  );
}

const unusedFunding: PrivateFundingGateway = {
  supportedAttributionProfiles: Object.freeze(["signed_payer"] as const),
  async createFundingInstructions() {
    throw new Error("Funding is outside this payout test");
  },
  async findFundingPayments() {
    throw new Error("Funding is outside this payout test");
  },
};

function payoutInput(change: Partial<PayoutPreparationInput> = {}): PayoutPreparationInput {
  return { intentId: "intent-1", request, ...change };
}

function resolveTestDestination(destination: Readonly<Record<string, unknown>>): {
  poolContract: string;
  recipientAddress: string;
} {
  const value = destination as { readonly pool?: unknown; readonly recipient?: unknown };
  return {
    poolContract: String(value.pool),
    recipientAddress: String(value.recipient),
  };
}

function payoutLimits(): StarknetPrivacySdkPayoutLimits {
  return {
    maximumCallCalldataFelts: 64,
    maximumProofBytes: 1_024,
    maximumProofFacts: 64,
    maximumProofOutputFelts: 64,
    maximumSignatureFelts: 64,
    maximumTransactionCalldataFelts: 256,
    maximumResourceFeeFri: 100n,
    maximumTipFri: 10n,
    requestTimeoutMilliseconds: 5_000,
    submissionLeaseMilliseconds: 30_000,
  };
}

class FakePrivacyTransfers
  implements
    StarknetPrivacySdkPayoutTransfers,
    StarknetPrivacySdkPayoutBuilder,
    StarknetPrivacySdkPayoutTokenBuilder
{
  readonly user = SENDER;
  readonly buildCalls: unknown[] = [];
  readonly tokenCalls: bigint[] = [];
  readonly transferCalls: { recipient: bigint; amount: bigint }[] = [];
  readonly surplusCalls: { recipient: bigint; withdraw: boolean | undefined }[] = [];
  executeCalls = 0;
  result: StarknetPrivacySdkPayoutExecuteResult = sdkResult();

  build(options: unknown): StarknetPrivacySdkPayoutBuilder {
    this.buildCalls.push(structuredClone(options));
    return this;
  }

  with(token: bigint): StarknetPrivacySdkPayoutTokenBuilder {
    this.tokenCalls.push(token);
    return this;
  }

  transfer(output: { recipient: bigint; amount: bigint }): this {
    this.transferCalls.push({ ...output });
    return this;
  }

  surplusTo(recipient: bigint, withdraw?: boolean): this {
    this.surplusCalls.push({ recipient, withdraw });
    return this;
  }

  async execute(): Promise<StarknetPrivacySdkPayoutExecuteResult> {
    this.executeCalls += 1;
    return structuredClone(this.result);
  }
}

class FakeSigningAccount implements StarknetPayoutSigningAccount {
  readonly address = SENDER;
  readonly calls: { call: unknown; details: unknown }[] = [];
  transaction: unknown = signedTransaction();
  cairoVersion: CairoVersion = "1";

  async getCairoVersion(): Promise<CairoVersion> {
    return this.cairoVersion;
  }

  async getSignedTransaction(call: unknown, details: unknown): Promise<unknown> {
    this.calls.push({ call: structuredClone(call), details: structuredClone(details) });
    return structuredClone(this.transaction);
  }
}

class FakePayoutRpc implements StarknetPayoutRpc {
  chainId = "0x534e5f5345504f4c4941";
  chainCalls = 0;
  returnedTransactionReference: string | undefined;
  throwAfterSubmission = false;
  readonly submissions: StarknetSignedInvokeTransaction[] = [];

  async getChainId(): Promise<string> {
    this.chainCalls += 1;
    return this.chainId;
  }

  async invokeSignedTx(transaction: StarknetSignedInvokeTransaction): Promise<unknown> {
    this.submissions.push(structuredClone(transaction));
    if (this.throwAfterSubmission) {
      throw new Error("Submission response lost");
    }
    return { transaction_hash: this.returnedTransactionReference };
  }
}

class FakePayoutStatusSource implements StarknetPreparedPayoutStatusSource {
  status: StarknetPreparedPayoutChainStatus = "NOT_FOUND";
  throwOnObserve = false;
  includeBlock = true;
  blockHash = INCLUSION_BLOCK;
  blockNumber = INCLUSION_BLOCK_NUMBER;
  readonly calls: unknown[] = [];

  async observePayoutTransaction(input: {
    network: "SN_SEPOLIA";
    transactionReference: string;
    finalityPolicy: string;
    knownInclusion?: { blockHash: string; blockNumber: bigint };
  }): Promise<{
    transactionReference: string;
    status: StarknetPreparedPayoutChainStatus;
    blockHash?: string;
    blockNumber?: bigint;
  }> {
    this.calls.push({ ...input });
    if (this.throwOnObserve) {
      throw new Error("Provider unavailable");
    }
    return {
      transactionReference: input.transactionReference,
      status: this.status,
      ...(!this.includeBlock || this.status === "NOT_FOUND" || this.status === "UNKNOWN"
        ? {}
        : { blockHash: this.blockHash, blockNumber: this.blockNumber }),
    };
  }
}

function sdkResult(
  change: Partial<StarknetPrivacySdkPayoutExecuteResult> = {},
): StarknetPrivacySdkPayoutExecuteResult {
  return { callAndProof: sdkCallAndProof(), warnings: [], ...change };
}

function sdkCallAndProof(change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    call: { contractAddress: POOL, entrypoint: "apply_actions", calldata: ["0x10"] },
    proof: { data: PROOF, output: ["0x1"], proofFacts: PROOF_FACTS },
    ...change,
  };
}

function signedTransaction(change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "INVOKE",
    sender_address: SENDER,
    calldata: transaction.getExecuteCalldata(
      [{ contractAddress: POOL, entrypoint: "apply_actions", calldata: ["0x10"] }],
      "1",
    ),
    version: "0x3",
    signature: ["0x2", "0x3"],
    nonce: "0x1",
    resource_bounds: {
      l1_gas: { max_amount: "0x1", max_price_per_unit: "0x2" },
      l1_data_gas: { max_amount: "0x1", max_price_per_unit: "0x2" },
      l2_gas: { max_amount: "0x1", max_price_per_unit: "0x2" },
    },
    tip: "0x0",
    paymaster_data: [],
    account_deployment_data: [],
    nonce_data_availability_mode: "L1",
    fee_data_availability_mode: "L1",
    proof_facts: PROOF_FACTS,
    proof: PROOF,
    ...change,
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

class TestKeyring implements PreparedPayoutKeyring {
  readonly key = new Uint8Array(32).fill(9);

  async getActiveKey(): Promise<PreparedPayoutEncryptionKey> {
    return { keyId: "test-key-1", key: this.key };
  }

  async getKey(keyId: string): Promise<Uint8Array | null> {
    return keyId === "test-key-1" ? this.key : null;
  }
}

class ThrowAfterCreatePreparedPayoutStore implements PreparedPayoutStore {
  #throwAfterCreate = true;

  constructor(readonly delegate: PreparedPayoutStore) {}

  getByIntentId(intentId: string) {
    return this.delegate.getByIntentId(intentId);
  }

  getBySubmissionId(submissionId: string) {
    return this.delegate.getBySubmissionId(submissionId);
  }

  async createOrGet(candidate: Parameters<PreparedPayoutStore["createOrGet"]>[0]) {
    const stored = await this.delegate.createOrGet(candidate);
    if (this.#throwAfterCreate) {
      this.#throwAfterCreate = false;
      throw new Error("Prepared payout store response lost");
    }
    return stored;
  }

  claimSubmission(candidate: Parameters<PreparedPayoutStore["claimSubmission"]>[0]) {
    return this.delegate.claimSubmission(candidate);
  }

  recordInclusion(candidate: Parameters<PreparedPayoutStore["recordInclusion"]>[0]) {
    return this.delegate.recordInclusion(candidate);
  }

  recordFinalityIncident(candidate: Parameters<PreparedPayoutStore["recordFinalityIncident"]>[0]) {
    return this.delegate.recordFinalityIncident(candidate);
  }
}

class ThrowAfterClaimPreparedPayoutStore implements PreparedPayoutStore {
  #throwAfterClaim = true;

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

  async claimSubmission(candidate: Parameters<PreparedPayoutStore["claimSubmission"]>[0]) {
    const claimed = await this.delegate.claimSubmission(candidate);
    if (this.#throwAfterClaim) {
      this.#throwAfterClaim = false;
      throw new Error("Prepared payout submission claim response lost");
    }
    return claimed;
  }

  recordInclusion(candidate: Parameters<PreparedPayoutStore["recordInclusion"]>[0]) {
    return this.delegate.recordInclusion(candidate);
  }

  recordFinalityIncident(candidate: Parameters<PreparedPayoutStore["recordFinalityIncident"]>[0]) {
    return this.delegate.recordFinalityIncident(candidate);
  }
}

class ThrowAfterInclusionPreparedPayoutStore implements PreparedPayoutStore {
  #throwAfterInclusion = true;

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

  async recordInclusion(candidate: Parameters<PreparedPayoutStore["recordInclusion"]>[0]) {
    const stored = await this.delegate.recordInclusion(candidate);
    if (this.#throwAfterInclusion) {
      this.#throwAfterInclusion = false;
      throw new Error("Prepared payout inclusion response lost");
    }
    return stored;
  }

  recordFinalityIncident(candidate: Parameters<PreparedPayoutStore["recordFinalityIncident"]>[0]) {
    return this.delegate.recordFinalityIncident(candidate);
  }
}
