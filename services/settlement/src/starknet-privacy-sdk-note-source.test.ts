import { type BigNumberish, type BlockIdentifier, ec, shortString } from "starknet";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { PrivacyNoteSource } from "./privacy-evidence.js";
import {
  STARKNET_PRIVACY_SDK_NOTE_SOURCE_VERSION,
  type StarknetPrivacySdkIndexer,
  StarknetPrivacySdkNoteSource,
  type StarknetPrivacySdkNoteSourceConfig,
  StarknetPrivacySdkNoteSourceConfigurationError,
} from "./starknet-privacy-sdk-note-source.js";

const POOL = "0x123";
const RECIPIENT = "0x789";
const TOKEN = "0x456";
const SENDER = "0xaaa";
const BLOCK_HASH = "0xabc";
const BLOCK_NUMBER = 42;
const TRANSACTION_HASH = "0xdef";
const CHANNEL_KEY = 0x222n;
const NOTE_INDEX = 7;
const NOTE_SALT = 0x12345n;
const NOTE_REFERENCE = "0x753ca30819d193a78472f8738d6c23e688f04ead1597858588399fdc15bc2c";
const NOTE_EVENT_VALUE = "0x1234551342ed377b209c2724231b54d496e09";

interface TestNotesCursor {
  readonly blockId: BlockIdentifier;
  readonly marker: number;
}

interface TestChannelCursor {
  readonly channels?: ReadonlyMap<bigint, unknown>;
}

interface TestHistoryCursor {
  readonly historyComplete: boolean;
  readonly page: number;
}

type TestIndexer = StarknetPrivacySdkIndexer<TestNotesCursor, TestChannelCursor, TestHistoryCursor>;
type NoteResponse = Awaited<ReturnType<TestIndexer["discoverNotes"]>>;
type HistoryResponse = Awaited<ReturnType<TestIndexer["fetchHistory"]>>;
type SourceConfig = StarknetPrivacySdkNoteSourceConfig<
  TestNotesCursor,
  TestChannelCursor,
  TestHistoryCursor
>;

describe("Starknet Privacy SDK note source", () => {
  it("matches the pinned RC.6 indexer method shape", () => {
    expectTypeOf<FakePrivacySdkIndexer>().toMatchTypeOf<TestIndexer>();
  });

  it("accepts the SDK AddressMap shape without requiring a native Map", async () => {
    const provider = new FakePrivacySdkIndexer();
    const notes = new SdkStyleAddressMap([[0x456n, [sdkNote()]]]);
    provider.setNoteResponse(noteResponse({ notes }));

    expect(notes).not.toBeInstanceOf(Map);
    await expect(
      createSource({ discoveryProvider: provider }).discoverIncomingNotes(discoveryInput()),
    ).resolves.toMatchObject({ notes: [{ noteReference: NOTE_REFERENCE }] });
  });

  it("discovers and normalizes an encrypted incoming note at a pinned head", async () => {
    const provider = new FakePrivacySdkIndexer();
    const source = createSource({ discoveryProvider: provider });

    await expect(source.discoverIncomingNotes(discoveryInput())).resolves.toEqual({
      blockReference: BLOCK_HASH,
      notes: [
        {
          poolContract: POOL,
          recipientAddress: RECIPIENT,
          senderAddress: SENDER,
          tokenContract: TOKEN,
          amountBaseUnits: 1_000_000n,
          noteReference: NOTE_REFERENCE,
          eventValue: NOTE_EVENT_VALUE,
          blockNumber: 42n,
        },
      ],
    });
    expect(source.adapterVersion).toBe(STARKNET_PRIVACY_SDK_NOTE_SOURCE_VERSION);
    expect(provider.noteCalls).toEqual([
      {
        address: 0x789n,
        viewingKey: 0xbeefn,
        params: { tokens: [0x456n], blockIdentifier: "latest" },
      },
    ]);
  });

  it("returns an empty snapshot without inventing a token entry", async () => {
    const provider = new FakePrivacySdkIndexer();
    provider.setNoteResponse(noteResponse({ notes: new Map() }));

    await expect(
      createSource({ discoveryProvider: provider }).discoverIncomingNotes(discoveryInput()),
    ).resolves.toEqual({ blockReference: BLOCK_HASH, notes: [] });
  });

  it("sorts normalized notes by note ID", async () => {
    const provider = new FakePrivacySdkIndexer();
    const first = sdkNote({ amount: 2_000_000n }, { nonce: 8 });
    const second = sdkNote({ amount: 3_000_000n }, { nonce: 9 });
    provider.setNoteResponse(
      noteResponse({
        notes: new Map([[0x456n, [first, second]]]),
      }),
    );

    const result = await createSource({ discoveryProvider: provider }).discoverIncomingNotes(
      discoveryInput(),
    );

    expect(result.notes.map((note) => note.noteReference)).toEqual([first.id, second.id].sort());
  });

  it("matches the pinned Cairo note ID and encrypted-value vectors", async () => {
    const provider = new FakePrivacySdkIndexer();
    provider.setNoteResponse(
      noteResponse({
        notes: new Map([
          [
            0x1234n,
            [
              {
                id: "0x6b098ad0b0b4b1881a77f962eb0650de748f24efcabd5a64ac941e9a05777e8",
                amount: 1_000n,
                created: BLOCK_NUMBER,
                sender: 0xaaan,
                open: false,
                witness: { channelKey: 0xdefn, nonce: 5, r: 0x5678n },
              },
            ],
          ],
        ]),
      }),
    );

    await expect(
      createSource({
        discoveryProvider: provider,
        tokenContract: "0x1234",
      }).discoverIncomingNotes({ ...discoveryInput(), tokenContract: "0x1234" }),
    ).resolves.toMatchObject({
      notes: [
        {
          noteReference: "0x6b098ad0b0b4b1881a77f962eb0650de748f24efcabd5a64ac941e9a05777e8",
          eventValue: "0x5678e860f260ec796ecdd862d35616ea6f28",
        },
      ],
    });
  });

  it.each([
    { name: "wrong network", change: { network: "SN_MAIN" } },
    { name: "wrong pool", change: { poolContract: "0x124" } },
    { name: "wrong recipient", change: { recipientAddress: "0x790" } },
    { name: "wrong token", change: { tokenContract: "0x457" } },
    { name: "malformed address", change: { tokenContract: "secret" } },
    { name: "non-latest tag", change: { blockIdentifier: "pre_confirmed" } },
  ])("rejects a discovery request with $name before provider access", async ({ change }) => {
    const provider = new FakePrivacySdkIndexer();
    const source = createSource({ discoveryProvider: provider });

    await expect(
      source.discoverIncomingNotes({ ...discoveryInput(), ...change } as never),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(provider.noteCalls).toHaveLength(0);
  });

  it.each([
    { name: "block tag", response: noteResponse({ timestamp: "latest" }) },
    { name: "block number", response: noteResponse({ timestamp: 42 }) },
    { name: "zero block hash", response: noteResponse({ timestamp: "0x0" }) },
    { name: "missing cursor", response: { ...noteResponse(), cursor: undefined } },
    { name: "non-map notes", response: noteResponse({ notes: [] as never }) },
    {
      name: "inconsistent map size",
      response: noteResponse({
        notes: {
          size: 0,
          get: () => undefined,
          has: () => false,
          entries: () => new Map([[0x456n, [sdkNote()]]]).entries(),
          [Symbol.iterator]: () => new Map([[0x456n, [sdkNote()]]]).entries(),
        } as never,
      }),
    },
    {
      name: "unexpected token",
      response: noteResponse({ notes: new Map([[0x457n, [sdkNote()]]]) }),
    },
    {
      name: "duplicate note",
      response: noteResponse({ notes: new Map([[0x456n, [sdkNote(), sdkNote()]]]) }),
    },
    {
      name: "open note",
      response: noteResponse({ notes: new Map([[0x456n, [sdkNote({ open: true })]]]) }),
    },
    {
      name: "missing open marker",
      response: noteResponse({ notes: new Map([[0x456n, [sdkNote({ open: undefined })]]]) }),
    },
    {
      name: "missing witness",
      response: noteResponse({
        notes: new Map([[0x456n, [{ ...sdkNote(), witness: undefined }]]]),
      }),
    },
    {
      name: "open-note salt",
      response: noteResponse({ notes: new Map([[0x456n, [sdkNote({}, { salt: 1n })]]]) }),
    },
    {
      name: "wrong note commitment",
      response: noteResponse({ notes: new Map([[0x456n, [sdkNote({ id: "0x11" })]]]) }),
    },
    {
      name: "zero amount",
      response: noteResponse({ notes: new Map([[0x456n, [sdkNote({ amount: 0n })]]]) }),
    },
    {
      name: "string amount",
      response: noteResponse({ notes: new Map([[0x456n, [sdkNote({ amount: "100" })]]]) }),
    },
    {
      name: "missing creation block",
      response: noteResponse({ notes: new Map([[0x456n, [sdkNote({ created: undefined })]]]) }),
    },
    {
      name: "unsafe creation block",
      response: noteResponse({
        notes: new Map([[0x456n, [sdkNote({ created: Number.MAX_SAFE_INTEGER + 1 })]]]),
      }),
    },
    {
      name: "invalid sender",
      response: noteResponse({ notes: new Map([[0x456n, [sdkNote({ sender: "0x0" })]]]) }),
    },
    {
      name: "invalid note ID",
      response: noteResponse({ notes: new Map([[0x456n, [sdkNote({ id: "private" })]]]) }),
    },
  ])("rejects a malformed SDK snapshot with $name", async ({ response }) => {
    const provider = new FakePrivacySdkIndexer();
    provider.setNoteResponse(response);

    await expect(
      createSource({ discoveryProvider: provider }).discoverIncomingNotes(discoveryInput()),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("enforces the configured note bound", async () => {
    const provider = new FakePrivacySdkIndexer();
    provider.setNoteResponse(
      noteResponse({
        notes: new Map([
          [0x456n, [sdkNote(), sdkNote({}, { nonce: 8 }), sdkNote({}, { nonce: 9 })]],
        ]),
      }),
    );

    await expect(
      createSource({
        discoveryProvider: provider,
        maximumNotesPerSnapshot: 2,
      }).discoverIncomingNotes(discoveryInput()),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("redacts note-discovery and viewing-key failures", async () => {
    const discoveryProvider = new FakePrivacySdkIndexer();
    discoveryProvider.noteFailure = new Error("https://indexer.example/private-token");
    const source = createSource({ discoveryProvider });

    await expect(source.discoverIncomingNotes(discoveryInput())).rejects.toMatchObject({
      code: "provider_failure",
      message: "Privacy SDK note discovery failed",
    });

    const viewingFailure = createSource({
      viewingKeyProvider: {
        getViewingKey: () => Promise.reject(new Error("viewing-key=super-secret")),
      },
    });
    await expect(viewingFailure.discoverIncomingNotes(discoveryInput())).rejects.toMatchObject({
      code: "provider_failure",
      message: "Privacy SDK viewing-key access failed",
    });
  });

  it.each([0n, -1n, "not-a-key", Number.MAX_SAFE_INTEGER + 1])(
    "rejects malformed viewing key %s without calling discovery",
    async (viewingKey) => {
      const provider = new FakePrivacySdkIndexer();
      const source = createSource({
        discoveryProvider: provider,
        viewingKeyProvider: { getViewingKey: async () => viewingKey as BigNumberish },
      });

      await expect(source.discoverIncomingNotes(discoveryInput())).rejects.toMatchObject({
        code: "invalid_response",
      });
      expect(provider.noteCalls).toHaveLength(0);
    },
  );

  it("times out a stalled SDK call without exposing provider details", async () => {
    const provider = new FakePrivacySdkIndexer();
    provider.noteDelay = new Promise<never>(() => undefined);

    await expect(
      createSource({
        discoveryProvider: provider,
        requestTimeoutMilliseconds: 5,
      }).discoverIncomingNotes(discoveryInput()),
    ).rejects.toMatchObject({
      code: "provider_failure",
      message: "Privacy SDK note discovery failed",
    });
  });

  it("re-discovers at the exact block and resolves a note through history", async () => {
    const provider = new FakePrivacySdkIndexer();
    const source = createSource({ discoveryProvider: provider });

    await expect(source.findNoteTransactions(historyInput())).resolves.toEqual({
      blockReference: BLOCK_HASH,
      transactions: [
        {
          noteReference: NOTE_REFERENCE,
          transactionReference: TRANSACTION_HASH,
          blockNumber: 42n,
        },
      ],
    });
    expect(provider.noteCalls[0]).toMatchObject({
      params: { tokens: [0x456n], blockIdentifier: BLOCK_HASH },
    });
    expect(provider.historyCalls).toEqual([
      {
        address: 0x789n,
        notesCursor: { blockId: BLOCK_HASH, marker: 1 },
        channelCursor: {},
        options: { maxTransactions: 10, blockIdentifier: BLOCK_HASH },
      },
    ]);
  });

  it("paginates history with only the opaque returned cursor", async () => {
    const provider = new FakePrivacySdkIndexer();
    provider.historyResponses = [
      historyResponse({
        transactions: [],
        cursor: { historyComplete: false, page: 1 },
      }),
      historyResponse({ cursor: { historyComplete: true, page: 2 } }),
    ];

    await expect(
      createSource({ discoveryProvider: provider }).findNoteTransactions(historyInput()),
    ).resolves.toMatchObject({ transactions: [{ noteReference: NOTE_REFERENCE }] });
    expect(provider.historyCalls).toHaveLength(2);
    expect(provider.historyCalls[1]?.options).toEqual({
      maxTransactions: 10,
      blockIdentifier: BLOCK_HASH,
      historyCursor: { historyComplete: false, page: 1 },
    });
  });

  it("allows the RC.6 history response to exceed the requested page size within a separate bound", async () => {
    const provider = new FakePrivacySdkIndexer();
    provider.historyResponses = [
      historyResponse({
        transactions: [
          historyTransaction({
            transactionHash: 0xdeen,
            notes: [historyNote({ noteId: 0x12n })],
          }),
          historyTransaction(),
        ],
      }),
    ];

    await expect(
      createSource({
        discoveryProvider: provider,
        maximumTransactionsPerPage: 1,
        maximumTransactionsPerHistoryResponse: 2,
      }).findNoteTransactions(historyInput()),
    ).resolves.toMatchObject({ transactions: [{ noteReference: NOTE_REFERENCE }] });
    expect(provider.historyCalls[0]?.options?.maxTransactions).toBe(1);
  });

  it("rejects a history response outside its configured resource bound", async () => {
    const provider = new FakePrivacySdkIndexer();
    provider.historyResponses = [
      historyResponse({
        transactions: [
          historyTransaction({
            transactionHash: 0xdeen,
            notes: [historyNote({ noteId: 0x12n })],
          }),
          historyTransaction(),
        ],
      }),
    ];

    await expect(
      createSource({
        discoveryProvider: provider,
        maximumTransactionsPerPage: 1,
        maximumTransactionsPerHistoryResponse: 1,
      }).findNoteTransactions(historyInput()),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("stops history pagination at the configured cumulative transaction bound", async () => {
    const provider = new FakePrivacySdkIndexer();
    provider.historyResponses = [
      historyResponse({
        transactions: [
          historyTransaction({ transactionHash: 0x1n, notes: [] }),
          historyTransaction({ transactionHash: 0x2n, notes: [] }),
        ],
        cursor: { historyComplete: false, page: 1 },
      }),
      historyResponse({
        transactions: [
          historyTransaction({ transactionHash: 0x3n, notes: [] }),
          historyTransaction({ transactionHash: 0x4n, notes: [] }),
        ],
        cursor: { historyComplete: false, page: 2 },
      }),
    ];

    await expect(
      createSource({
        discoveryProvider: provider,
        maximumTransactionsPerPage: 1,
        maximumTransactionsPerHistoryResponse: 2,
        maximumTransactionsPerHistoryLookup: 3,
      }).findNoteTransactions(historyInput()),
    ).rejects.toMatchObject({ code: "history_incomplete" });
    expect(provider.historyCalls).toHaveLength(2);
  });

  it("does not call the SDK for an empty history request", async () => {
    const provider = new FakePrivacySdkIndexer();

    await expect(
      createSource({ discoveryProvider: provider }).findNoteTransactions({
        ...historyInput(),
        noteReferences: [],
      }),
    ).resolves.toEqual({ blockReference: BLOCK_HASH, transactions: [] });
    expect(provider.noteCalls).toHaveLength(0);
    expect(provider.historyCalls).toHaveLength(0);
  });

  it.each([
    { name: "malformed block", change: { blockReference: "latest" } },
    { name: "sparse note batch", change: { noteReferences: new Array<string>(1) } },
    {
      name: "duplicate note",
      change: { noteReferences: [NOTE_REFERENCE, `0x0${NOTE_REFERENCE.slice(2)}`] },
    },
    { name: "malformed note", change: { noteReferences: ["secret"] } },
    { name: "wrong pool", change: { poolContract: "0x124" } },
    { name: "wrong recipient", change: { recipientAddress: "0x790" } },
  ])("rejects a history request with $name before provider access", async ({ change }) => {
    const provider = new FakePrivacySdkIndexer();

    await expect(
      createSource({ discoveryProvider: provider }).findNoteTransactions({
        ...historyInput(),
        ...change,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(provider.noteCalls).toHaveLength(0);
  });

  it.each([
    {
      name: "different snapshot hash",
      response: noteResponse({ timestamp: "0xabd" }),
    },
    {
      name: "missing requested note",
      response: noteResponse({ notes: new Map() }),
    },
    {
      name: "extra note",
      response: noteResponse({
        notes: new Map([[0x456n, [sdkNote(), sdkNote({}, { nonce: 8 })]]]),
      }),
    },
  ])("rejects a $name between discovery and history", async ({ response }) => {
    const provider = new FakePrivacySdkIndexer();
    provider.setNoteResponse(response);

    await expect(
      createSource({ discoveryProvider: provider }).findNoteTransactions(historyInput()),
    ).rejects.toMatchObject({ code: "snapshot_conflict" });
    expect(provider.historyCalls).toHaveLength(0);
  });

  it.each([
    {
      name: "history block drift",
      response: historyResponse({ blockRef: "0xabd" }),
      code: "snapshot_conflict",
    },
    {
      name: "missing history transactions",
      response: historyResponse({ transactions: undefined as never }),
      code: "invalid_response",
    },
    {
      name: "malformed history cursor",
      response: historyResponse({ cursor: { historyComplete: "yes", page: 1 } as never }),
      code: "invalid_response",
    },
    {
      name: "malformed transaction hash",
      response: historyResponse({
        transactions: [historyTransaction({ transactionHash: "secret" })],
      }),
      code: "invalid_response",
    },
    {
      name: "unsafe transaction block",
      response: historyResponse({
        transactions: [historyTransaction({ blockNumber: Number.MAX_SAFE_INTEGER + 1 })],
      }),
      code: "invalid_response",
    },
    {
      name: "non-incoming target note",
      response: historyResponse({
        transactions: [
          historyTransaction({ notes: [historyNote({ channelKind: "self_channel" })] }),
        ],
      }),
      code: "invalid_response",
    },
    {
      name: "wrong history token",
      response: historyResponse({
        transactions: [historyTransaction({ notes: [historyNote({ token: 0x457n })] })],
      }),
      code: "invalid_response",
    },
    {
      name: "wrong counterparty",
      response: historyResponse({
        transactions: [historyTransaction({ notes: [historyNote({ counterparty: 0xaabn })] })],
      }),
      code: "invalid_response",
    },
    {
      name: "wrong history amount",
      response: historyResponse({
        transactions: [historyTransaction({ notes: [historyNote({ amount: 2_000_000n })] })],
      }),
      code: "invalid_response",
    },
    {
      name: "wrong creation block",
      response: historyResponse({ transactions: [historyTransaction({ blockNumber: 43 })] }),
      code: "invalid_response",
    },
    {
      name: "duplicate target note",
      response: historyResponse({
        transactions: [historyTransaction({ notes: [historyNote(), historyNote()] })],
      }),
      code: "invalid_response",
    },
  ])("rejects $name", async ({ response, code }) => {
    const provider = new FakePrivacySdkIndexer();
    provider.historyResponses = [response];

    await expect(
      createSource({ discoveryProvider: provider }).findNoteTransactions(historyInput()),
    ).rejects.toMatchObject({ code });
  });

  it("reports complete history that omits the target as incomplete", async () => {
    const provider = new FakePrivacySdkIndexer();
    provider.historyResponses = [
      historyResponse({
        transactions: [historyTransaction({ notes: [historyNote({ noteId: 0x12n })] })],
      }),
    ];

    await expect(
      createSource({ discoveryProvider: provider }).findNoteTransactions(historyInput()),
    ).rejects.toMatchObject({ code: "history_incomplete" });
  });

  it("stops an incomplete history scan at the configured page bound", async () => {
    const provider = new FakePrivacySdkIndexer();
    provider.historyResponses = [
      historyResponse({ transactions: [], cursor: { historyComplete: false, page: 1 } }),
      historyResponse({ transactions: [], cursor: { historyComplete: false, page: 2 } }),
    ];

    await expect(
      createSource({ discoveryProvider: provider, maximumHistoryPages: 2 }).findNoteTransactions(
        historyInput(),
      ),
    ).rejects.toMatchObject({ code: "history_incomplete" });
    expect(provider.historyCalls).toHaveLength(2);
  });

  it("redacts history provider failures", async () => {
    const provider = new FakePrivacySdkIndexer();
    provider.historyFailure = new Error("viewing-key=super-secret");

    await expect(
      createSource({ discoveryProvider: provider }).findNoteTransactions(historyInput()),
    ).rejects.toMatchObject({
      code: "provider_failure",
      message: "Privacy SDK history failed",
    });
  });

  it.each([
    { name: "mainnet", change: { network: "SN_MAIN" } },
    { name: "zero pool", change: { poolContract: "0x0" } },
    { name: "invalid recipient", change: { recipientAddress: "recipient" } },
    { name: "zero token", change: { tokenContract: "0x0" } },
    { name: "missing viewing provider", change: { viewingKeyProvider: null } },
    { name: "missing discovery provider", change: { discoveryProvider: null } },
    { name: "missing cursor factory", change: { createEmptyChannelCursor: null } },
    { name: "zero note bound", change: { maximumNotesPerSnapshot: 0 } },
    { name: "excessive page bound", change: { maximumHistoryPages: 1_001 } },
    { name: "zero page size", change: { maximumTransactionsPerPage: 0 } },
    {
      name: "zero history response size",
      change: { maximumTransactionsPerHistoryResponse: 0 },
    },
    {
      name: "excessive history response size",
      change: { maximumTransactionsPerHistoryResponse: 100_001 },
    },
    {
      name: "history response smaller than request",
      change: { maximumTransactionsPerHistoryResponse: 9 },
    },
    {
      name: "zero history lookup size",
      change: { maximumTransactionsPerHistoryLookup: 0 },
    },
    {
      name: "excessive history lookup size",
      change: { maximumTransactionsPerHistoryLookup: 1_000_001 },
    },
    {
      name: "history lookup smaller than response",
      change: { maximumTransactionsPerHistoryLookup: 99 },
    },
    { name: "excessive timeout", change: { requestTimeoutMilliseconds: 120_001 } },
  ])("rejects invalid $name configuration", ({ change }) => {
    expect(() => createSource(change as never)).toThrow(
      StarknetPrivacySdkNoteSourceConfigurationError,
    );
  });

  it("rejects an invalid empty-channel cursor without exposing history state", async () => {
    const provider = new FakePrivacySdkIndexer();
    const source = createSource({
      discoveryProvider: provider,
      createEmptyChannelCursor: () => null as never,
    });

    await expect(source.findNoteTransactions(historyInput())).rejects.toMatchObject({
      code: "invalid_response",
      message: "Privacy SDK channel-cursor factory returned an invalid cursor",
    });
  });
});

class FakePrivacySdkIndexer implements TestIndexer {
  noteCalls: {
    readonly address: bigint;
    readonly viewingKey: BigNumberish;
    readonly params?: {
      readonly cursor?: TestNotesCursor;
      readonly tokens?: bigint[];
      readonly blockIdentifier?: BlockIdentifier;
    };
  }[] = [];
  historyCalls: {
    readonly address: bigint;
    readonly notesCursor: TestNotesCursor;
    readonly channelCursor: TestChannelCursor;
    readonly options?: {
      readonly maxTransactions?: number;
      readonly lastKnownBlock?: string;
      readonly blockIdentifier?: BlockIdentifier;
      readonly historyCursor?: TestHistoryCursor;
    };
  }[] = [];
  noteFailure: unknown;
  historyFailure: unknown;
  noteDelay: Promise<never> | undefined;
  historyResponses: HistoryResponse[] = [historyResponse()];
  #noteResponse: NoteResponse = noteResponse();

  setNoteResponse(value: unknown): void {
    this.#noteResponse = value as NoteResponse;
  }

  async discoverNotes(
    address: bigint,
    viewingKey: BigNumberish,
    params?: {
      readonly cursor?: TestNotesCursor;
      readonly tokens?: bigint[];
      readonly blockIdentifier?: BlockIdentifier;
    },
  ): Promise<NoteResponse> {
    this.noteCalls.push({ address, viewingKey, ...(params === undefined ? {} : { params }) });
    if (this.noteFailure !== undefined) {
      throw this.noteFailure;
    }
    if (this.noteDelay !== undefined) {
      return this.noteDelay;
    }
    return this.#noteResponse;
  }

  async fetchHistory(
    address: bigint,
    notesCursor: TestNotesCursor,
    channelCursor: TestChannelCursor,
    options?: {
      readonly maxTransactions?: number;
      readonly lastKnownBlock?: string;
      readonly blockIdentifier?: BlockIdentifier;
      readonly historyCursor?: TestHistoryCursor;
    },
  ): Promise<HistoryResponse> {
    this.historyCalls.push({
      address,
      notesCursor,
      channelCursor,
      ...(options === undefined ? {} : { options }),
    });
    if (this.historyFailure !== undefined) {
      throw this.historyFailure;
    }
    const response = this.historyResponses.shift();
    if (response === undefined) {
      throw new Error("No fake history response configured");
    }
    return response;
  }
}

function createSource(
  change: Partial<SourceConfig> = {},
): StarknetPrivacySdkNoteSource<TestNotesCursor, TestChannelCursor, TestHistoryCursor> {
  return new StarknetPrivacySdkNoteSource({
    network: "SN_SEPOLIA",
    poolContract: POOL,
    recipientAddress: RECIPIENT,
    tokenContract: TOKEN,
    viewingKeyProvider: { getViewingKey: async () => 0xbeefn },
    discoveryProvider: new FakePrivacySdkIndexer(),
    createEmptyChannelCursor: () => ({}),
    maximumNotesPerSnapshot: 100,
    maximumHistoryPages: 10,
    maximumTransactionsPerPage: 10,
    maximumTransactionsPerHistoryResponse: 100,
    maximumTransactionsPerHistoryLookup: 1_000,
    requestTimeoutMilliseconds: 1_000,
    ...change,
  });
}

class SdkStyleAddressMap<Value> {
  readonly #map: Map<bigint, Value>;

  constructor(entries: Iterable<readonly [BigNumberish, Value]>) {
    this.#map = new Map([...entries].map(([key, value]) => [BigInt(key), value]));
  }

  get size(): number {
    return this.#map.size;
  }

  get(key: bigint): Value | undefined {
    return this.#map.get(BigInt(key));
  }

  has(key: bigint): boolean {
    return this.#map.has(BigInt(key));
  }

  entries(): IterableIterator<[bigint, Value]> {
    return this.#map.entries();
  }

  [Symbol.iterator](): IterableIterator<[bigint, Value]> {
    return this.#map[Symbol.iterator]();
  }
}

function discoveryInput(): Parameters<PrivacyNoteSource["discoverIncomingNotes"]>[0] {
  return {
    network: "SN_SEPOLIA",
    poolContract: POOL,
    recipientAddress: RECIPIENT,
    tokenContract: TOKEN,
    blockIdentifier: "latest",
  };
}

function historyInput(): Parameters<PrivacyNoteSource["findNoteTransactions"]>[0] {
  return {
    network: "SN_SEPOLIA",
    poolContract: POOL,
    recipientAddress: RECIPIENT,
    blockReference: BLOCK_HASH,
    noteReferences: [NOTE_REFERENCE],
  };
}

function sdkNote(
  change: Record<string, unknown> = {},
  witnessChange: {
    readonly channelKey?: bigint;
    readonly nonce?: number;
    readonly salt?: bigint;
  } = {},
) {
  const witness = {
    channelKey: witnessChange.channelKey ?? CHANNEL_KEY,
    nonce: witnessChange.nonce ?? NOTE_INDEX,
    r: witnessChange.salt ?? NOTE_SALT,
  };
  return {
    id: testNoteId(witness.channelKey, BigInt(TOKEN), witness.nonce),
    amount: 1_000_000n,
    created: BLOCK_NUMBER,
    sender: 0xaaan,
    open: false,
    witness,
    ...change,
  };
}

function noteResponse(change: Partial<NoteResponse> = {}): NoteResponse {
  return {
    timestamp: BLOCK_HASH,
    notes: new Map([[0x456n, [sdkNote()]]]),
    cursor: { blockId: BLOCK_HASH, marker: 1 },
    ...change,
  };
}

function historyNote(change: Record<string, unknown> = {}) {
  return {
    channelKind: "incoming",
    token: 0x456n,
    noteId: BigInt(NOTE_REFERENCE),
    counterparty: 0xaaan,
    amount: 1_000_000n,
    ...change,
  };
}

function testNoteId(channelKey: bigint, token: bigint, nonce: number): string {
  const value = ec.starkCurve.poseidonHashMany([
    BigInt(shortString.encodeShortString("NOTE_ID_TAG:V1")),
    channelKey,
    token,
    BigInt(nonce),
    0n,
  ]);
  return `0x${value.toString(16)}`;
}

function historyTransaction(change: Record<string, unknown> = {}) {
  return {
    blockNumber: BLOCK_NUMBER,
    transactionHash: 0xdefn,
    notes: [historyNote()],
    ...change,
  };
}

function historyResponse(change: Partial<HistoryResponse> = {}): HistoryResponse {
  return {
    blockRef: BLOCK_HASH,
    transactions: [historyTransaction()],
    cursor: { historyComplete: true, page: 1 },
    ...change,
  };
}
