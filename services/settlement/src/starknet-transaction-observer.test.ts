import type { StarknetNetwork } from "@cashu-strk20/strk20-method";
import { type BlockIdentifier, RpcError, type RpcProvider } from "starknet";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  CompositePrivacyEvidenceSource,
  IncomingPrivacyEvidenceCollector,
  type PrivacyNoteSource,
  type PrivacyTransactionInclusion,
} from "./privacy-evidence.js";
import {
  type NamedStarknetTransactionProvider,
  STARKNET_ENC_NOTE_CREATED_SELECTOR,
  type StarknetPayoutTransactionObserver,
  STARKNET_TRANSACTION_FINALITY_POLICIES,
  STARKNET_TRANSACTION_OBSERVER_VERSION,
  StarknetTransactionObserver,
  type StarknetTransactionObserverConfig,
  StarknetTransactionObserverConfigurationError,
  type StarknetTransactionRpc,
} from "./starknet-transaction-observer.js";

const TRANSACTION_HASH = "0xabc";
const SECOND_TRANSACTION_HASH = "0xdef";
const BLOCK_HASH = "0xbeef";
const BLOCK_NUMBER = 42n;
const STARKNET_SEPOLIA_CHAIN_ID = "0x534e5f5345504f4c4941";
const STARK_FIELD_PRIME = (1n << 251n) + (17n << 192n) + 1n;

describe("Starknet transaction observer", () => {
  it("accepts the pinned Starknet.js RPC provider interface", () => {
    expectTypeOf<RpcProvider>().toMatchTypeOf<StarknetTransactionRpc>();
    expectTypeOf<StarknetTransactionObserver>().toMatchTypeOf<StarknetPayoutTransactionObserver>();
  });

  it("requires unanimous successful receipts and canonical blocks for L2 finality", async () => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();
    const observer = createObserver({ providers: namedProviders(first, second) });

    await expect(observer.observeTransactions(observationInput())).resolves.toEqual([
      {
        transactionReference: TRANSACTION_HASH,
        blockHash: BLOCK_HASH,
        blockNumber: BLOCK_NUMBER,
        status: "FINAL",
      },
    ]);
    expect(observer.observerVersion).toBe(STARKNET_TRANSACTION_OBSERVER_VERSION);
    expect(first.chainCalls).toBe(1);
    expect(first.receiptCalls).toEqual([TRANSACTION_HASH]);
    expect(first.blockCalls).toEqual([BLOCK_NUMBER]);
    expect(second.receiptCalls).toEqual(first.receiptCalls);
    expect(second.blockCalls).toEqual(first.blockCalls);
  });

  it("composes with note discovery into collected incoming evidence", async () => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();
    const observer = createObserver({ providers: namedProviders(first, second) });
    const collector = new IncomingPrivacyEvidenceCollector(
      new CompositePrivacyEvidenceSource(new FakePrivacyNoteSource(), observer),
      {
        network: "SN_SEPOLIA",
        poolContract: "0x123",
        recipientAddress: "0x789",
        tokenContract: "0x456",
        finalityPolicy: STARKNET_TRANSACTION_FINALITY_POLICIES.L2,
      },
    );

    await expect(collector.collect()).resolves.toMatchObject([
      {
        network: "SN_SEPOLIA",
        poolContract: "0x123",
        recipientAddress: "0x789",
        senderAddress: "0xaaa",
        tokenContract: "0x456",
        amountBaseUnits: 1_000_000n,
        noteReference: "0x11",
        transactionReference: TRANSACTION_HASH,
        blockHash: BLOCK_HASH,
        blockNumber: BLOCK_NUMBER,
        status: "FINAL",
        finalityPolicy: STARKNET_TRANSACTION_FINALITY_POLICIES.L2,
      },
    ]);
  });

  it("marks an indexer mapping conflicted when one receipt omits the expected note event", async () => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();
    second.setReceipt(TRANSACTION_HASH, acceptedReceipt({ events: [] }));

    await expect(
      createObserver({ providers: namedProviders(first, second) }).observeTransactions(
        expectedNoteObservationInput(),
      ),
    ).resolves.toMatchObject([{ status: "CONFLICTED" }]);
  });

  it.each([
    {
      name: "wrong pool",
      events: [encryptedNoteCreatedEvent({ from_address: "0x124" })],
    },
    {
      name: "wrong selector",
      events: [encryptedNoteCreatedEvent({ keys: ["0x999", "0x11"] })],
    },
    {
      name: "wrong note",
      events: [encryptedNoteCreatedEvent({ keys: [STARKNET_ENC_NOTE_CREATED_SELECTOR, "0x12"] })],
    },
    {
      name: "duplicate note event",
      events: [encryptedNoteCreatedEvent(), encryptedNoteCreatedEvent()],
    },
    {
      name: "unexpected event arity",
      events: [
        encryptedNoteCreatedEvent({
          keys: [STARKNET_ENC_NOTE_CREATED_SELECTOR, "0x11", "0x12"],
        }),
      ],
    },
  ])("marks a $name mapping conflicted", async ({ events }) => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();
    for (const provider of [first, second]) {
      provider.setReceipt(TRANSACTION_HASH, acceptedReceipt({ events }));
    }

    await expect(
      createObserver({ providers: namedProviders(first, second) }).observeTransactions(
        expectedNoteObservationInput(),
      ),
    ).resolves.toMatchObject([{ status: "CONFLICTED" }]);
  });

  it("verifies multiple normalized note events in one transaction", async () => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();
    const events = [
      encryptedNoteCreatedEvent({ keys: [STARKNET_ENC_NOTE_CREATED_SELECTOR, "0x0011"] }),
      encryptedNoteCreatedEvent({ keys: [STARKNET_ENC_NOTE_CREATED_SELECTOR, "0x12"] }),
    ];
    for (const provider of [first, second]) {
      provider.setReceipt(TRANSACTION_HASH, acceptedReceipt({ events }));
    }

    await expect(
      createObserver({ providers: namedProviders(first, second) }).observeTransactions({
        ...observationInput(),
        expectedNoteEvents: [
          {
            transactionReference: "0x0abc",
            poolContract: "0x0123",
            noteReferences: ["0x12", "0x11"],
            noteEventValues: [
              { noteReference: "0x12", eventValue: "0x1" },
              { noteReference: "0x11", eventValue: "0x1" },
            ],
            senderAddress: "0xaaa",
          },
        ],
      }),
    ).resolves.toMatchObject([{ status: "FINAL" }]);
  });

  it("binds the decrypted note value and sender to independent public transaction data", async () => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();

    await expect(
      createObserver({ providers: namedProviders(first, second) }).observeTransactions(
        boundNoteObservationInput(),
      ),
    ).resolves.toMatchObject([{ status: "FINAL" }]);
    expect(first.transactionCalls).toEqual([TRANSACTION_HASH]);
    expect(second.transactionCalls).toEqual([TRANSACTION_HASH]);
  });

  it.each([
    {
      name: "different public note value",
      configure(provider: FakeStarknetTransactionRpc) {
        provider.setReceipt(
          TRANSACTION_HASH,
          acceptedReceipt({ events: [encryptedNoteCreatedEvent({ data: ["0x2"] })] }),
        );
      },
    },
    {
      name: "different invoke sender",
      configure(provider: FakeStarknetTransactionRpc) {
        provider.setTransaction(TRANSACTION_HASH, invokeTransaction({ sender_address: "0xaab" }));
      },
    },
  ])("marks a note with a $name conflicted", async ({ configure }) => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();
    configure(first);

    await expect(
      createObserver({ providers: namedProviders(first, second) }).observeTransactions(
        boundNoteObservationInput(),
      ),
    ).resolves.toMatchObject([{ status: "CONFLICTED" }]);
  });

  it.each([
    { name: "malformed response", value: { type: "INVOKE" }, code: "invalid_response" },
    { name: "provider failure", value: new Error("rpc-key=secret"), code: "provider_failure" },
  ])("rejects a $name while reading the invoke sender", async ({ value, code }) => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();
    first.setTransaction(TRANSACTION_HASH, value);

    await expect(
      createObserver({ providers: namedProviders(first, second) }).observeTransactions(
        boundNoteObservationInput(),
      ),
    ).rejects.toMatchObject({ code });
  });

  it.each([
    { name: "missing events", receipt: acceptedReceipt({ events: undefined }) },
    { name: "non-array events", receipt: acceptedReceipt({ events: {} }) },
    {
      name: "malformed event",
      receipt: acceptedReceipt({ events: [{ from_address: "0x123", keys: null, data: [] }] }),
    },
    {
      name: "invalid event address",
      receipt: acceptedReceipt({ events: [encryptedNoteCreatedEvent({ from_address: "secret" })] }),
    },
    {
      name: "invalid event key",
      receipt: acceptedReceipt({
        events: [encryptedNoteCreatedEvent({ keys: ["secret", "0x11"] })],
      }),
    },
    {
      name: "sparse event keys",
      receipt: acceptedReceipt({
        events: [
          encryptedNoteCreatedEvent({
            keys: (() => {
              const keys = new Array<string>(2);
              keys[0] = STARKNET_ENC_NOTE_CREATED_SELECTOR;
              return keys;
            })(),
          }),
        ],
      }),
    },
    {
      name: "too many events",
      receipt: acceptedReceipt({ events: Array.from({ length: 10_001 }, () => ({})) }),
    },
    {
      name: "too many event keys",
      receipt: acceptedReceipt({
        events: [encryptedNoteCreatedEvent({ keys: Array.from({ length: 257 }, () => "0x1") })],
      }),
    },
  ])("rejects a receipt with $name when note evidence is required", async ({ receipt }) => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();
    first.setReceipt(TRANSACTION_HASH, receipt);

    await expect(
      createObserver({ providers: namedProviders(first, second) }).observeTransactions(
        expectedNoteObservationInput(),
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    { name: "empty collection", expectedNoteEvents: [] },
    {
      name: "wrong transaction",
      expectedNoteEvents: [
        { transactionReference: "0x999", poolContract: "0x123", noteReferences: ["0x11"] },
      ],
    },
    {
      name: "empty note list",
      expectedNoteEvents: [
        { transactionReference: TRANSACTION_HASH, poolContract: "0x123", noteReferences: [] },
      ],
    },
    {
      name: "duplicate note",
      expectedNoteEvents: [
        {
          transactionReference: TRANSACTION_HASH,
          poolContract: "0x123",
          noteReferences: ["0x11", "0x011"],
        },
      ],
    },
    {
      name: "sparse note list",
      expectedNoteEvents: [
        {
          transactionReference: TRANSACTION_HASH,
          poolContract: "0x123",
          noteReferences: new Array<string>(1),
        },
      ],
    },
    {
      name: "invalid pool",
      expectedNoteEvents: [
        { transactionReference: TRANSACTION_HASH, poolContract: "0x0", noteReferences: ["0x11"] },
      ],
    },
    {
      name: "invalid expected sender",
      expectedNoteEvents: [
        {
          transactionReference: TRANSACTION_HASH,
          poolContract: "0x123",
          noteReferences: ["0x11"],
          senderAddress: "sender",
        },
      ],
    },
    {
      name: "missing first-observation bindings",
      expectedNoteEvents: [
        {
          transactionReference: TRANSACTION_HASH,
          poolContract: "0x123",
          noteReferences: ["0x11"],
        },
      ],
    },
    {
      name: "sender without note event values",
      expectedNoteEvents: [
        {
          transactionReference: TRANSACTION_HASH,
          poolContract: "0x123",
          noteReferences: ["0x11"],
          senderAddress: "0xaaa",
        },
      ],
    },
    {
      name: "note event values without sender",
      expectedNoteEvents: [
        {
          transactionReference: TRANSACTION_HASH,
          poolContract: "0x123",
          noteReferences: ["0x11"],
          noteEventValues: [{ noteReference: "0x11", eventValue: "0x1" }],
        },
      ],
    },
    {
      name: "incomplete note event values",
      expectedNoteEvents: [
        {
          transactionReference: TRANSACTION_HASH,
          poolContract: "0x123",
          noteReferences: ["0x11", "0x12"],
          noteEventValues: [{ noteReference: "0x11", eventValue: "0x1" }],
        },
      ],
    },
    {
      name: "unrelated note event value",
      expectedNoteEvents: [
        {
          transactionReference: TRANSACTION_HASH,
          poolContract: "0x123",
          noteReferences: ["0x11"],
          noteEventValues: [{ noteReference: "0x12", eventValue: "0x1" }],
        },
      ],
    },
    {
      name: "zero note event value",
      expectedNoteEvents: [
        {
          transactionReference: TRANSACTION_HASH,
          poolContract: "0x123",
          noteReferences: ["0x11"],
          noteEventValues: [{ noteReference: "0x11", eventValue: "0x0" }],
        },
      ],
    },
  ])("rejects an expected-event input with $name", async ({ expectedNoteEvents }) => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();

    await expect(
      createObserver({ providers: namedProviders(first, second) }).observeTransactions({
        ...observationInput(),
        expectedNoteEvents,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(first.chainCalls).toBe(0);
    expect(second.chainCalls).toBe(0);
  });

  it("rechecks expected note events for a persisted inclusion", async () => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();
    first.setReceipt(TRANSACTION_HASH, acceptedReceipt({ events: [] }));

    await expect(
      createObserver({ providers: namedProviders(first, second) }).observeTransactions({
        ...expectedNoteObservationInput(),
        knownInclusions: [knownInclusion()],
      }),
    ).resolves.toMatchObject([{ status: "CONFLICTED" }]);
  });

  it("accepts ref-only note evidence when rechecking a persisted inclusion", async () => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();

    await expect(
      createObserver({ providers: namedProviders(first, second) }).observeTransactions({
        ...expectedNoteObservationInput(),
        expectedNoteEvents: [
          {
            transactionReference: TRANSACTION_HASH,
            poolContract: "0x123",
            noteReferences: ["0x11"],
          },
        ],
        knownInclusions: [knownInclusion()],
      }),
    ).resolves.toMatchObject([{ status: "FINAL" }]);
  });

  it("normalizes transaction hashes before provider calls and output", async () => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();

    await expect(
      createObserver({ providers: namedProviders(first, second) }).observeTransactions({
        ...observationInput(),
        transactionReferences: ["0x0abc"],
      }),
    ).resolves.toMatchObject([{ transactionReference: TRANSACTION_HASH }]);
    expect(first.receiptCalls).toEqual([TRANSACTION_HASH]);
  });

  it.each([
    {
      name: "L2 receipts and blocks",
      receiptFinality: "ACCEPTED_ON_L2",
      blockStatus: "ACCEPTED_ON_L2",
      expected: "PENDING",
    },
    {
      name: "mixed L1 and L2 block knowledge",
      receiptFinality: "ACCEPTED_ON_L1",
      blockStatus: "ACCEPTED_ON_L2",
      expected: "PENDING",
    },
    {
      name: "L1 receipts and blocks",
      receiptFinality: "ACCEPTED_ON_L1",
      blockStatus: "ACCEPTED_ON_L1",
      expected: "FINAL",
    },
  ])("classifies $name under the L1 policy as $expected", async (testCase) => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();
    for (const provider of [first, second]) {
      provider.setReceipt(
        TRANSACTION_HASH,
        acceptedReceipt({ finality_status: testCase.receiptFinality }),
      );
      provider.setBlock(BLOCK_NUMBER, acceptedBlock({ status: testCase.blockStatus }));
    }

    await expect(
      createObserver({
        finalityPolicy: STARKNET_TRANSACTION_FINALITY_POLICIES.L1,
        providers: namedProviders(first, second),
      }).observeTransactions({
        ...observationInput(),
        finalityPolicy: STARKNET_TRANSACTION_FINALITY_POLICIES.L1,
      }),
    ).resolves.toMatchObject([{ status: testCase.expected }]);
  });

  it("marks an agreed reverted transaction as conflicted", async () => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();
    first.setReceipt(TRANSACTION_HASH, acceptedReceipt({ execution_status: "REVERTED" }));
    second.setReceipt(TRANSACTION_HASH, acceptedReceipt({ execution_status: "REVERTED" }));

    await expect(
      createObserver({ providers: namedProviders(first, second) }).observeTransactions(
        observationInput(),
      ),
    ).resolves.toMatchObject([{ status: "CONFLICTED" }]);
  });

  it("proves a unanimous reverted payout under the L2 finality policy", async () => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();
    for (const provider of [first, second]) {
      provider.setReceipt(TRANSACTION_HASH, acceptedReceipt({ execution_status: "REVERTED" }));
    }

    await expect(
      createObserver({ providers: namedProviders(first, second) }).observePayoutTransactions(
        observationInput(),
      ),
    ).resolves.toEqual([
      {
        transactionReference: TRANSACTION_HASH,
        blockHash: BLOCK_HASH,
        blockNumber: BLOCK_NUMBER,
        status: "REVERTED",
      },
    ]);
  });

  it.each([
    {
      name: "L2-only canonical evidence",
      receiptFinality: "ACCEPTED_ON_L2",
      blockStatus: "ACCEPTED_ON_L2",
      expected: "PENDING",
    },
    {
      name: "L1-final canonical evidence",
      receiptFinality: "ACCEPTED_ON_L1",
      blockStatus: "ACCEPTED_ON_L1",
      expected: "REVERTED",
    },
  ] as const)(
    "classifies a reverted payout with $name as $expected under the L1 policy",
    async ({ receiptFinality, blockStatus, expected }) => {
      const first = new FakeStarknetTransactionRpc();
      const second = new FakeStarknetTransactionRpc();
      for (const provider of [first, second]) {
        provider.setReceipt(
          TRANSACTION_HASH,
          acceptedReceipt({
            execution_status: "REVERTED",
            finality_status: receiptFinality,
          }),
        );
        provider.setBlock(BLOCK_NUMBER, acceptedBlock({ status: blockStatus }));
      }
      const observer = createObserver({
        finalityPolicy: STARKNET_TRANSACTION_FINALITY_POLICIES.L1,
        providers: namedProviders(first, second),
      });

      await expect(
        observer.observePayoutTransactions({
          ...observationInput(),
          finalityPolicy: STARKNET_TRANSACTION_FINALITY_POLICIES.L1,
        }),
      ).resolves.toMatchObject([{ status: expected }]);
    },
  );

  it("does not prove failure when providers disagree on payout execution", async () => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();
    first.setReceipt(TRANSACTION_HASH, acceptedReceipt({ execution_status: "REVERTED" }));

    await expect(
      createObserver({ providers: namedProviders(first, second) }).observePayoutTransactions(
        observationInput(),
      ),
    ).resolves.toMatchObject([{ status: "CONFLICTED" }]);
  });

  it.each([
    {
      name: "different block hashes",
      receipt: acceptedReceipt({ block_hash: "0xbef0" }),
    },
    {
      name: "different block numbers",
      receipt: acceptedReceipt({ block_hash: "0xcafe", block_number: 43 }),
    },
  ])("rejects new evidence with $name across providers", async ({ receipt }) => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();
    second.setReceipt(TRANSACTION_HASH, receipt);

    await expect(
      createObserver({ providers: namedProviders(first, second) }).observeTransactions(
        observationInput(),
      ),
    ).rejects.toMatchObject({ code: "provider_disagreement" });
    expect(first.blockCalls).toHaveLength(0);
    expect(second.blockCalls).toHaveLength(0);
  });

  it.each([
    {
      name: "receipt block hash mismatch",
      block: acceptedBlock({ block_hash: "0xbef0" }),
    },
    {
      name: "transaction missing from block",
      block: acceptedBlock({ transactions: [] }),
    },
  ])("rejects an internally inconsistent $name", async ({ block }) => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();
    first.setBlock(BLOCK_NUMBER, block);

    await expect(
      createObserver({ providers: namedProviders(first, second) }).observeTransactions(
        observationInput(),
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    { name: "pre-confirmed", receipt: preconfirmedReceipt() },
    { name: "not found", receipt: transactionNotFound(TRANSACTION_HASH) },
  ])("keeps a $name transaction retryable without inventing an inclusion", async ({ receipt }) => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();
    first.setReceipt(TRANSACTION_HASH, receipt);
    second.setReceipt(TRANSACTION_HASH, receipt);

    await expect(
      createObserver({ providers: namedProviders(first, second) }).observeTransactions(
        observationInput(),
      ),
    ).rejects.toMatchObject({ code: "transaction_pending" });
    expect(first.blockCalls).toHaveLength(0);
    expect(second.blockCalls).toHaveLength(0);
  });

  it("reobserves a persisted canonical inclusion", async () => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();

    await expect(
      createObserver({ providers: namedProviders(first, second) }).observeTransactions(
        knownObservationInput(),
      ),
    ).resolves.toEqual([
      {
        transactionReference: TRANSACTION_HASH,
        blockHash: BLOCK_HASH,
        blockNumber: BLOCK_NUMBER,
        status: "FINAL",
      },
    ]);
  });

  it("reproves a persisted reverted payout inclusion after restart", async () => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();
    for (const provider of [first, second]) {
      provider.setReceipt(TRANSACTION_HASH, acceptedReceipt({ execution_status: "REVERTED" }));
    }

    await expect(
      createObserver({ providers: namedProviders(first, second) }).observePayoutTransactions(
        knownObservationInput(),
      ),
    ).resolves.toEqual([
      {
        transactionReference: TRANSACTION_HASH,
        blockHash: BLOCK_HASH,
        blockNumber: BLOCK_NUMBER,
        status: "REVERTED",
      },
    ]);
  });

  it("marks a known inclusion reorged only when every provider agrees the height changed", async () => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();
    first.setBlock(BLOCK_NUMBER, acceptedBlock({ block_hash: "0xcafe", transactions: [] }));
    second.setBlock(BLOCK_NUMBER, acceptedBlock({ block_hash: "0xcafe", transactions: [] }));

    await expect(
      createObserver({ providers: namedProviders(first, second) }).observeTransactions(
        knownObservationInput(),
      ),
    ).resolves.toEqual([
      {
        transactionReference: TRANSACTION_HASH,
        blockHash: BLOCK_HASH,
        blockNumber: BLOCK_NUMBER,
        status: "REORGED",
      },
    ]);
    expect(first.receiptCalls).toHaveLength(0);
    expect(second.receiptCalls).toHaveLength(0);
  });

  it("marks provider disagreement about a known canonical height as conflicted", async () => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();
    second.setBlock(BLOCK_NUMBER, acceptedBlock({ block_hash: "0xcafe", transactions: [] }));

    await expect(
      createObserver({ providers: namedProviders(first, second) }).observeTransactions(
        knownObservationInput(),
      ),
    ).resolves.toMatchObject([
      {
        transactionReference: TRANSACTION_HASH,
        blockHash: BLOCK_HASH,
        status: "CONFLICTED",
      },
    ]);
  });

  it("marks a known block that omits its persisted transaction as conflicted", async () => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();
    first.setBlock(BLOCK_NUMBER, acceptedBlock({ transactions: [] }));

    await expect(
      createObserver({ providers: namedProviders(first, second) }).observeTransactions(
        knownObservationInput(),
      ),
    ).resolves.toMatchObject([{ status: "CONFLICTED" }]);
    expect(first.receiptCalls).toHaveLength(0);
  });

  it("does not call a missing known receipt a reorg while its block remains canonical", async () => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();
    first.setReceipt(TRANSACTION_HASH, transactionNotFound(TRANSACTION_HASH));

    await expect(
      createObserver({ providers: namedProviders(first, second) }).observeTransactions(
        knownObservationInput(),
      ),
    ).rejects.toMatchObject({ code: "provider_disagreement" });
  });

  it("marks a known receipt that moved away from its canonical inclusion as conflicted", async () => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();
    first.setReceipt(TRANSACTION_HASH, acceptedReceipt({ block_hash: "0xcafe", block_number: 43 }));

    await expect(
      createObserver({ providers: namedProviders(first, second) }).observeTransactions(
        knownObservationInput(),
      ),
    ).resolves.toMatchObject([{ status: "CONFLICTED" }]);
  });

  it.each([
    { name: "non-object", receipt: null },
    { name: "wrong transaction hash", receipt: acceptedReceipt({ transaction_hash: "0xabd" }) },
    { name: "unknown finality", receipt: acceptedReceipt({ finality_status: "RECEIVED" }) },
    { name: "missing execution", receipt: acceptedReceipt({ execution_status: undefined }) },
    { name: "accepted without block hash", receipt: acceptedReceipt({ block_hash: undefined }) },
    {
      name: "pre-confirmed with a block hash",
      receipt: preconfirmedReceipt({ block_hash: BLOCK_HASH }),
    },
  ])("rejects a $name receipt", async ({ receipt }) => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();
    first.setReceipt(TRANSACTION_HASH, receipt);

    await expect(
      createObserver({ providers: namedProviders(first, second) }).observeTransactions(
        observationInput(),
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    { name: "non-object", block: null },
    { name: "pre-confirmed status", block: acceptedBlock({ status: "PRE_CONFIRMED" }) },
    { name: "wrong number", block: acceptedBlock({ block_number: 43 }) },
    {
      name: "duplicate transaction",
      block: acceptedBlock({ transactions: [TRANSACTION_HASH, TRANSACTION_HASH] }),
    },
    { name: "zero block hash", block: acceptedBlock({ block_hash: "0x0" }) },
  ])("rejects a $name transaction block", async ({ block }) => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();
    first.setBlock(BLOCK_NUMBER, block);

    await expect(
      createObserver({ providers: namedProviders(first, second) }).observeTransactions(
        observationInput(),
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects a provider on another chain before receipt reads", async () => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc({ chainId: "0x1" });

    await expect(
      createObserver({ providers: namedProviders(first, second) }).observeTransactions(
        observationInput(),
      ),
    ).rejects.toMatchObject({ code: "provider_disagreement" });
    expect(first.receiptCalls).toHaveLength(0);
    expect(second.receiptCalls).toHaveLength(0);
  });

  it("redacts receipt provider failures", async () => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();
    first.setReceipt(TRANSACTION_HASH, new Error("https://secret-rpc.example/api-key/value"));

    const observation = createObserver({
      providers: namedProviders(first, second),
    }).observeTransactions(observationInput());

    await expect(observation).rejects.toMatchObject({ code: "provider_failure" });
    await expect(observation).rejects.not.toThrow(/secret-rpc|api-key/);
  });

  it("redacts transaction-block provider failures", async () => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();
    first.setBlock(BLOCK_NUMBER, new Error("https://secret-rpc.example/api-key/value"));

    const observation = createObserver({
      providers: namedProviders(first, second),
    }).observeTransactions(observationInput());

    await expect(observation).rejects.toMatchObject({ code: "provider_failure" });
    await expect(observation).rejects.not.toThrow(/secret-rpc|api-key/);
  });

  it("redacts chain-ID provider failures", async () => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();
    first.chainError = new Error("https://secret-rpc.example/api-key/value");

    const observation = createObserver({
      providers: namedProviders(first, second),
    }).observeTransactions(observationInput());

    await expect(observation).rejects.toMatchObject({ code: "provider_failure" });
    await expect(observation).rejects.not.toThrow(/secret-rpc|api-key/);
    expect(first.receiptCalls).toHaveLength(0);
  });

  it("bounds a provider receipt request that never returns", async () => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();
    first.setReceipt(TRANSACTION_HASH, new Promise(() => undefined));

    await expect(
      createObserver({
        providers: namedProviders(first, second),
        requestTimeoutMilliseconds: 5,
      }).observeTransactions(observationInput()),
    ).rejects.toMatchObject({ code: "provider_failure" });
  });

  it("caches one block read per provider when a batch shares an inclusion", async () => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();
    for (const provider of [first, second]) {
      provider.setReceipt(
        SECOND_TRANSACTION_HASH,
        acceptedReceipt({ transaction_hash: SECOND_TRANSACTION_HASH }),
      );
      provider.setBlock(
        BLOCK_NUMBER,
        acceptedBlock({ transactions: [TRANSACTION_HASH, SECOND_TRANSACTION_HASH] }),
      );
    }

    const observations = await createObserver({
      providers: namedProviders(first, second),
    }).observeTransactions({
      ...observationInput(),
      transactionReferences: [SECOND_TRANSACTION_HASH, TRANSACTION_HASH],
    });

    expect(observations.map((observation) => observation.transactionReference)).toEqual([
      SECOND_TRANSACTION_HASH,
      TRANSACTION_HASH,
    ]);
    expect(first.blockCalls).toEqual([BLOCK_NUMBER]);
    expect(second.blockCalls).toEqual([BLOCK_NUMBER]);
  });

  it("stops scheduling new batch items after one transaction fails", async () => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();
    first.setReceipt(TRANSACTION_HASH, new Error("provider unavailable"));

    await expect(
      createObserver({
        providers: namedProviders(first, second),
        maximumConcurrentTransactions: 1,
      }).observeTransactions({
        ...observationInput(),
        transactionReferences: [TRANSACTION_HASH, SECOND_TRANSACTION_HASH],
      }),
    ).rejects.toMatchObject({ code: "provider_failure" });
    expect(first.receiptCalls).toEqual([TRANSACTION_HASH]);
    expect(second.receiptCalls).toEqual([TRANSACTION_HASH]);
  });

  it("returns an empty batch without contacting providers", async () => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();

    await expect(
      createObserver({ providers: namedProviders(first, second) }).observeTransactions({
        ...observationInput(),
        transactionReferences: [],
      }),
    ).resolves.toEqual([]);
    expect(first.chainCalls).toBe(0);
  });

  it.each([
    { name: "wrong network", change: { network: "SN_MAIN" as StarknetNetwork } },
    { name: "wrong policy", change: { finalityPolicy: "starknet_unknown_finality" } },
    { name: "zero transaction", change: { transactionReferences: ["0x0"] } },
    {
      name: "out-of-field transaction",
      change: { transactionReferences: [`0x${STARK_FIELD_PRIME.toString(16)}`] },
    },
    {
      name: "duplicate normalized transaction",
      change: { transactionReferences: [TRANSACTION_HASH, "0x0abc"] },
    },
    {
      name: "oversized batch",
      change: { transactionReferences: [TRANSACTION_HASH, SECOND_TRANSACTION_HASH] },
      config: { maximumTransactionsPerRequest: 1, maximumConcurrentTransactions: 1 },
    },
    {
      name: "sparse transaction batch",
      change: { transactionReferences: new Array<string>(1) },
    },
    { name: "missing known inclusion", change: { knownInclusions: [] } },
    {
      name: "known inclusion for another transaction",
      change: {
        knownInclusions: [{ ...knownInclusion(), transactionReference: SECOND_TRANSACTION_HASH }],
      },
    },
    {
      name: "invalid known block hash",
      change: { knownInclusions: [{ ...knownInclusion(), blockHash: "0x0" }] },
    },
  ])("rejects $name before provider reads", async ({ change, config }) => {
    const first = new FakeStarknetTransactionRpc();
    const second = new FakeStarknetTransactionRpc();

    await expect(
      createObserver({ providers: namedProviders(first, second), ...config }).observeTransactions({
        ...observationInput(),
        ...change,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(first.chainCalls).toBe(0);
    expect(second.chainCalls).toBe(0);
  });

  it.each([
    { name: "one provider", providers: [namedProvider("first", new FakeStarknetTransactionRpc())] },
    {
      name: "duplicate provider ID",
      providers: [
        namedProvider("same", new FakeStarknetTransactionRpc()),
        namedProvider("same", new FakeStarknetTransactionRpc()),
      ],
    },
    {
      name: "duplicate provider instance",
      providers: (() => {
        const provider = new FakeStarknetTransactionRpc();
        return [namedProvider("first", provider), namedProvider("second", provider)];
      })(),
    },
    {
      name: "too many providers",
      providers: Array.from({ length: 17 }, (_, index) =>
        namedProvider(`provider-${index}`, new FakeStarknetTransactionRpc()),
      ),
    },
  ])("rejects a configuration with $name", ({ providers }) => {
    expect(() => createObserver({ providers })).toThrow(
      StarknetTransactionObserverConfigurationError,
    );
  });

  it("rejects a sparse transaction-provider quorum", () => {
    const providers = new Array<NamedStarknetTransactionProvider>(2);
    providers[0] = namedProvider("first", new FakeStarknetTransactionRpc());

    expect(() => createObserver({ providers })).toThrow(
      StarknetTransactionObserverConfigurationError,
    );
  });

  it.each([
    { maximumTransactionsPerRequest: 0 },
    { maximumTransactionsPerRequest: 10_001 },
    { maximumConcurrentTransactions: 0 },
    { maximumConcurrentTransactions: 65 },
    { maximumTransactionsPerRequest: 1, maximumConcurrentTransactions: 2 },
    { requestTimeoutMilliseconds: 0 },
    { requestTimeoutMilliseconds: 120_001 },
  ])("rejects invalid resource configuration %#", (change) => {
    expect(() => createObserver(change)).toThrow(StarknetTransactionObserverConfigurationError);
  });

  it.each([
    { network: "SN_MAIN" as StarknetNetwork },
    { finalityPolicy: "starknet_unknown_finality" as never },
    {
      providers: namedProviders(
        new FakeStarknetTransactionRpc(),
        new FakeStarknetTransactionRpc(),
      ).map((provider, index) => ({ ...provider, id: index === 0 ? "bad provider" : provider.id })),
    },
  ])("rejects invalid network, policy, or provider identity configuration %#", (change) => {
    expect(() => createObserver(change)).toThrow(StarknetTransactionObserverConfigurationError);
  });
});

class FakeStarknetTransactionRpc implements StarknetTransactionRpc {
  readonly chainId: string;
  readonly transactions = new Map<string, unknown>();
  readonly receipts = new Map<string, unknown>();
  readonly blocks = new Map<string, unknown>();
  readonly transactionCalls: string[] = [];
  readonly receiptCalls: string[] = [];
  readonly blockCalls: BlockIdentifier[] = [];

  chainCalls = 0;
  chainError: Error | undefined;

  constructor(options: { chainId?: string } = {}) {
    this.chainId = options.chainId ?? STARKNET_SEPOLIA_CHAIN_ID;
    this.setTransaction(TRANSACTION_HASH, invokeTransaction());
    this.setReceipt(TRANSACTION_HASH, acceptedReceipt());
    this.setBlock(BLOCK_NUMBER, acceptedBlock());
  }

  setReceipt(transactionHash: string, value: unknown): void {
    this.receipts.set(transactionHash, value);
  }

  setTransaction(transactionHash: string, value: unknown): void {
    this.transactions.set(transactionHash, value);
  }

  setBlock(blockNumber: bigint, value: unknown): void {
    this.blocks.set(blockNumber.toString(), value);
  }

  async getChainId(): Promise<string> {
    this.chainCalls += 1;
    if (this.chainError !== undefined) {
      throw this.chainError;
    }
    return this.chainId;
  }

  async getTransactionReceipt(transactionHash: string): Promise<unknown> {
    this.receiptCalls.push(transactionHash);
    const value = this.receipts.get(transactionHash);
    if (value instanceof Error) {
      throw value;
    }
    if (value instanceof Promise) {
      return value;
    }
    return structuredClone(value);
  }

  async getTransactionByHash(transactionHash: string): Promise<unknown> {
    this.transactionCalls.push(transactionHash);
    const value = this.transactions.get(transactionHash);
    if (value instanceof Error) {
      throw value;
    }
    if (value instanceof Promise) {
      return value;
    }
    return structuredClone(value);
  }

  async getBlockWithTxHashes(blockIdentifier?: BlockIdentifier): Promise<unknown> {
    this.blockCalls.push(blockIdentifier ?? "latest");
    const value = this.blocks.get(blockIdentifier?.toString() ?? "latest");
    if (value instanceof Error) {
      throw value;
    }
    if (value instanceof Promise) {
      return value;
    }
    return structuredClone(value);
  }
}

class FakePrivacyNoteSource implements PrivacyNoteSource {
  async discoverIncomingNotes(
    _input: Parameters<PrivacyNoteSource["discoverIncomingNotes"]>[0],
  ): Promise<Awaited<ReturnType<PrivacyNoteSource["discoverIncomingNotes"]>>> {
    return {
      blockReference: "0x1234",
      notes: [
        {
          poolContract: "0x123",
          recipientAddress: "0x789",
          senderAddress: "0xaaa",
          tokenContract: "0x456",
          amountBaseUnits: 1_000_000n,
          noteReference: "0x11",
          eventValue: "0x1",
          blockNumber: BLOCK_NUMBER,
        },
      ],
    };
  }

  async findNoteTransactions(
    input: Parameters<PrivacyNoteSource["findNoteTransactions"]>[0],
  ): Promise<Awaited<ReturnType<PrivacyNoteSource["findNoteTransactions"]>>> {
    return {
      blockReference: input.blockReference,
      transactions: [
        {
          noteReference: "0x11",
          transactionReference: TRANSACTION_HASH,
          blockNumber: BLOCK_NUMBER,
        },
      ],
    };
  }
}

function createObserver(
  change: Partial<StarknetTransactionObserverConfig> = {},
): StarknetTransactionObserver {
  return new StarknetTransactionObserver({
    network: "SN_SEPOLIA",
    finalityPolicy: STARKNET_TRANSACTION_FINALITY_POLICIES.L2,
    providers: namedProviders(new FakeStarknetTransactionRpc(), new FakeStarknetTransactionRpc()),
    maximumTransactionsPerRequest: 10,
    maximumConcurrentTransactions: 2,
    requestTimeoutMilliseconds: 1_000,
    ...change,
  });
}

function namedProviders(
  first: StarknetTransactionRpc,
  second: StarknetTransactionRpc,
): readonly NamedStarknetTransactionProvider[] {
  return [namedProvider("first", first), namedProvider("second", second)];
}

function namedProvider(
  id: string,
  provider: StarknetTransactionRpc,
): NamedStarknetTransactionProvider {
  return { id, provider };
}

function observationInput(): {
  network: StarknetNetwork;
  transactionReferences: readonly string[];
  finalityPolicy: string;
  knownInclusions?: readonly PrivacyTransactionInclusion[];
} {
  return {
    network: "SN_SEPOLIA",
    transactionReferences: [TRANSACTION_HASH],
    finalityPolicy: STARKNET_TRANSACTION_FINALITY_POLICIES.L2,
  };
}

function knownObservationInput() {
  return { ...observationInput(), knownInclusions: [knownInclusion()] };
}

function expectedNoteObservationInput() {
  return {
    ...observationInput(),
    expectedNoteEvents: [
      {
        transactionReference: TRANSACTION_HASH,
        poolContract: "0x123",
        noteReferences: ["0x11"],
        noteEventValues: [{ noteReference: "0x11", eventValue: "0x1" }],
        senderAddress: "0xaaa",
      },
    ],
  };
}

function boundNoteObservationInput() {
  return {
    ...observationInput(),
    expectedNoteEvents: [
      {
        transactionReference: TRANSACTION_HASH,
        poolContract: "0x123",
        noteReferences: ["0x11"],
        noteEventValues: [{ noteReference: "0x11", eventValue: "0x1" }],
        senderAddress: "0xaaa",
      },
    ],
  };
}

function knownInclusion(): PrivacyTransactionInclusion {
  return {
    transactionReference: TRANSACTION_HASH,
    blockHash: BLOCK_HASH,
    blockNumber: BLOCK_NUMBER,
  };
}

function acceptedReceipt(change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transaction_hash: TRANSACTION_HASH,
    block_hash: BLOCK_HASH,
    block_number: Number(BLOCK_NUMBER),
    finality_status: "ACCEPTED_ON_L2",
    execution_status: "SUCCEEDED",
    events: [encryptedNoteCreatedEvent()],
    ...change,
  };
}

function invokeTransaction(change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "INVOKE",
    transaction_hash: TRANSACTION_HASH,
    sender_address: "0xaaa",
    ...change,
  };
}

function encryptedNoteCreatedEvent(change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    from_address: "0x123",
    keys: [STARKNET_ENC_NOTE_CREATED_SELECTOR, "0x11"],
    data: ["0x1"],
    ...change,
  };
}

function preconfirmedReceipt(change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transaction_hash: TRANSACTION_HASH,
    block_number: Number(BLOCK_NUMBER) + 1,
    finality_status: "PRE_CONFIRMED",
    execution_status: "SUCCEEDED",
    ...change,
  };
}

function acceptedBlock(change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "ACCEPTED_ON_L2",
    block_hash: BLOCK_HASH,
    block_number: Number(BLOCK_NUMBER),
    transactions: [TRANSACTION_HASH],
    ...change,
  };
}

function transactionNotFound(transactionHash: string): RpcError {
  return new RpcError(
    { code: 29, message: "Transaction hash not found" } as never,
    "starknet_getTransactionReceipt",
    { transaction_hash: transactionHash },
  );
}
