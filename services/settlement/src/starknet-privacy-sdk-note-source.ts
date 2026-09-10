import { ec, shortString } from "starknet";

import type {
  PrivacyHistorySnapshot,
  PrivacyIncomingNote,
  PrivacyNoteSnapshot,
  PrivacyNoteSource,
} from "./privacy-evidence.js";
import { computeStarknetPrivacySdkNoteReference } from "./starknet-privacy-sdk-note-reference.js";
import type {
  StarknetPrivacySdkHistoryNote,
  StarknetPrivacySdkHistoryTransaction,
  StarknetPrivacySdkIndexer,
  StarknetPrivacySdkNote,
  StarknetPrivacySdkViewingKeyProvider,
} from "./starknet-privacy-sdk-ports.js";

export type {
  StarknetPrivacySdkAddressMap,
  StarknetPrivacySdkHistoryCursor,
  StarknetPrivacySdkHistoryNote,
  StarknetPrivacySdkHistoryTransaction,
  StarknetPrivacySdkIndexer,
  StarknetPrivacySdkNote,
  StarknetPrivacySdkViewingKeyProvider,
} from "./starknet-privacy-sdk-ports.js";

export const STARKNET_PRIVACY_SDK_NOTE_SOURCE_VERSION =
  "starknet-privacy-sdk@0.14.3-rc.6:indexer-note-history-v1";

export interface StarknetPrivacySdkNoteSourceConfig<NotesCursor, ChannelCursor, HistoryCursor> {
  readonly network: "SN_SEPOLIA";
  readonly poolContract: string;
  readonly recipientAddress: string;
  readonly tokenContract: string;
  readonly viewingKeyProvider: StarknetPrivacySdkViewingKeyProvider;
  readonly discoveryProvider: StarknetPrivacySdkIndexer<NotesCursor, ChannelCursor, HistoryCursor>;
  readonly createEmptyChannelCursor: () => ChannelCursor;
  readonly maximumNotesPerSnapshot: number;
  readonly maximumHistoryPages: number;
  readonly maximumTransactionsPerPage: number;
  readonly maximumTransactionsPerHistoryResponse: number;
  readonly maximumTransactionsPerHistoryLookup: number;
  readonly requestTimeoutMilliseconds: number;
}

export type StarknetPrivacySdkNoteSourceErrorCode =
  | "history_incomplete"
  | "invalid_input"
  | "invalid_response"
  | "provider_failure"
  | "snapshot_conflict";

export class StarknetPrivacySdkNoteSourceConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StarknetPrivacySdkNoteSourceConfigurationError";
  }
}

export class StarknetPrivacySdkNoteSourceError extends Error {
  readonly code: StarknetPrivacySdkNoteSourceErrorCode;

  constructor(code: StarknetPrivacySdkNoteSourceErrorCode, message: string) {
    super(message);
    this.name = "StarknetPrivacySdkNoteSourceError";
    this.code = code;
  }
}

type NormalizedSdkNote = PrivacyIncomingNote;

interface NormalizedDiscovery<NotesCursor> {
  readonly blockReference: string;
  readonly notes: readonly NormalizedSdkNote[];
  readonly cursor: NotesCursor;
}

export class StarknetPrivacySdkNoteSource<NotesCursor, ChannelCursor, HistoryCursor>
  implements PrivacyNoteSource
{
  readonly #network: "SN_SEPOLIA";
  readonly #poolContract: string;
  readonly #recipientAddress: string;
  readonly #recipientAddressValue: bigint;
  readonly #tokenContract: string;
  readonly #tokenContractValue: bigint;
  readonly #viewingKeyProvider: StarknetPrivacySdkViewingKeyProvider;
  readonly #discoveryProvider: StarknetPrivacySdkIndexer<NotesCursor, ChannelCursor, HistoryCursor>;
  readonly #createEmptyChannelCursor: () => ChannelCursor;
  readonly #maximumNotesPerSnapshot: number;
  readonly #maximumHistoryPages: number;
  readonly #maximumTransactionsPerPage: number;
  readonly #maximumTransactionsPerHistoryResponse: number;
  readonly #maximumTransactionsPerHistoryLookup: number;
  readonly #requestTimeoutMilliseconds: number;

  readonly adapterVersion = STARKNET_PRIVACY_SDK_NOTE_SOURCE_VERSION;

  constructor(
    config: StarknetPrivacySdkNoteSourceConfig<NotesCursor, ChannelCursor, HistoryCursor>,
  ) {
    if (typeof config !== "object" || config === null || config.network !== "SN_SEPOLIA") {
      throw new StarknetPrivacySdkNoteSourceConfigurationError(
        "Only Starknet Sepolia privacy discovery is enabled",
      );
    }
    this.#network = config.network;
    this.#poolContract = configuredAddress(config.poolContract, "pool contract");
    this.#recipientAddress = configuredAddress(config.recipientAddress, "recipient address");
    this.#recipientAddressValue = BigInt(this.#recipientAddress);
    this.#tokenContract = configuredAddress(config.tokenContract, "token contract");
    this.#tokenContractValue = BigInt(this.#tokenContract);
    if (
      typeof config.viewingKeyProvider !== "object" ||
      config.viewingKeyProvider === null ||
      typeof config.viewingKeyProvider.getViewingKey !== "function"
    ) {
      throw new StarknetPrivacySdkNoteSourceConfigurationError(
        "Configured Privacy SDK viewing-key provider is invalid",
      );
    }
    if (
      typeof config.discoveryProvider !== "object" ||
      config.discoveryProvider === null ||
      typeof config.discoveryProvider.discoverNotes !== "function" ||
      typeof config.discoveryProvider.fetchHistory !== "function"
    ) {
      throw new StarknetPrivacySdkNoteSourceConfigurationError(
        "Configured Privacy SDK discovery provider is invalid",
      );
    }
    if (typeof config.createEmptyChannelCursor !== "function") {
      throw new StarknetPrivacySdkNoteSourceConfigurationError(
        "Configured Privacy SDK channel-cursor factory is invalid",
      );
    }
    this.#viewingKeyProvider = config.viewingKeyProvider;
    this.#discoveryProvider = config.discoveryProvider;
    this.#createEmptyChannelCursor = config.createEmptyChannelCursor;
    this.#maximumNotesPerSnapshot = configuredPositiveInteger(
      config.maximumNotesPerSnapshot,
      MAXIMUM_NOTES_PER_SNAPSHOT,
      "maximum notes per snapshot",
    );
    this.#maximumHistoryPages = configuredPositiveInteger(
      config.maximumHistoryPages,
      MAXIMUM_HISTORY_PAGES,
      "maximum history pages",
    );
    this.#maximumTransactionsPerPage = configuredPositiveInteger(
      config.maximumTransactionsPerPage,
      MAXIMUM_TRANSACTIONS_PER_PAGE,
      "maximum transactions per history page",
    );
    this.#maximumTransactionsPerHistoryResponse = configuredPositiveInteger(
      config.maximumTransactionsPerHistoryResponse,
      MAXIMUM_TRANSACTIONS_PER_HISTORY_RESPONSE,
      "maximum transactions per history response",
    );
    if (this.#maximumTransactionsPerHistoryResponse < this.#maximumTransactionsPerPage) {
      throw new StarknetPrivacySdkNoteSourceConfigurationError(
        "History response limit cannot be smaller than the requested history page size",
      );
    }
    this.#maximumTransactionsPerHistoryLookup = configuredPositiveInteger(
      config.maximumTransactionsPerHistoryLookup,
      MAXIMUM_TRANSACTIONS_PER_HISTORY_LOOKUP,
      "maximum transactions per history lookup",
    );
    if (this.#maximumTransactionsPerHistoryLookup < this.#maximumTransactionsPerHistoryResponse) {
      throw new StarknetPrivacySdkNoteSourceConfigurationError(
        "History lookup limit cannot be smaller than the history response limit",
      );
    }
    this.#requestTimeoutMilliseconds = configuredPositiveInteger(
      config.requestTimeoutMilliseconds,
      MAXIMUM_REQUEST_TIMEOUT_MILLISECONDS,
      "request timeout",
    );
  }

  async discoverIncomingNotes(
    input: Parameters<PrivacyNoteSource["discoverIncomingNotes"]>[0],
  ): Promise<PrivacyNoteSnapshot> {
    this.#validateScope(input);
    if (input.blockIdentifier !== "latest") {
      throw invalidInput("Privacy note discovery must begin at the latest accepted block");
    }
    const discovered = await this.#discover("latest");
    return { blockReference: discovered.blockReference, notes: discovered.notes };
  }

  async findNoteTransactions(
    input: Parameters<PrivacyNoteSource["findNoteTransactions"]>[0],
  ): Promise<PrivacyHistorySnapshot> {
    this.#validateScope(input);
    const blockReference = inputBlockHash(input.blockReference);
    const noteReferences = inputNoteReferences(input.noteReferences, this.#maximumNotesPerSnapshot);
    if (noteReferences.length === 0) {
      return { blockReference, transactions: [] };
    }

    const discovered = await this.#discover(blockReference);
    if (discovered.blockReference !== blockReference) {
      throw new StarknetPrivacySdkNoteSourceError(
        "snapshot_conflict",
        "Privacy discovery did not honor the requested block hash",
      );
    }
    const discoveredByReference = new Map(
      discovered.notes.map((note) => [note.noteReference, note]),
    );
    if (
      discoveredByReference.size !== noteReferences.length ||
      noteReferences.some((reference) => !discoveredByReference.has(reference))
    ) {
      throw new StarknetPrivacySdkNoteSourceError(
        "snapshot_conflict",
        "Privacy notes changed between discovery and history lookup",
      );
    }

    let historyCursor: HistoryCursor | undefined;
    let scannedTransactions = 0;
    const matches = new Map<string, PrivacyHistorySnapshot["transactions"][number]>();
    const transactionBlocks = new Map<string, bigint>();
    for (let pageNumber = 0; pageNumber < this.#maximumHistoryPages; pageNumber += 1) {
      const options =
        historyCursor === undefined
          ? {
              maxTransactions: this.#maximumTransactionsPerPage,
              blockIdentifier: blockReference,
            }
          : {
              maxTransactions: this.#maximumTransactionsPerPage,
              blockIdentifier: blockReference,
              historyCursor,
            };
      const page = await this.#providerCall("history", () =>
        this.#discoveryProvider.fetchHistory(
          this.#recipientAddressValue,
          discovered.cursor,
          this.#emptyChannelCursor(),
          options,
        ),
      );
      const validated = validateHistoryPage<HistoryCursor>(
        page,
        blockReference,
        this.#maximumTransactionsPerHistoryResponse,
        discoveredByReference,
        matches,
        transactionBlocks,
      );
      scannedTransactions += validated.transactionCount;
      if (scannedTransactions > this.#maximumTransactionsPerHistoryLookup) {
        throw new StarknetPrivacySdkNoteSourceError(
          "history_incomplete",
          "Privacy history exceeded its configured transaction bound",
        );
      }
      historyCursor = validated.cursor;
      if (matches.size === noteReferences.length) {
        return {
          blockReference,
          transactions: [...matches.values()].sort((left, right) =>
            left.noteReference.localeCompare(right.noteReference),
          ),
        };
      }
      if (validated.historyComplete) {
        break;
      }
    }
    throw new StarknetPrivacySdkNoteSourceError(
      "history_incomplete",
      "Privacy history did not resolve every requested note within configured bounds",
    );
  }

  #validateScope(input: {
    readonly network: string;
    readonly poolContract: string;
    readonly recipientAddress: string;
    readonly tokenContract?: string;
  }): void {
    let poolContract: string;
    let recipientAddress: string;
    let tokenContract: string | undefined;
    try {
      poolContract = normalizeAddress(input.poolContract);
      recipientAddress = normalizeAddress(input.recipientAddress);
      tokenContract =
        input.tokenContract === undefined ? undefined : normalizeAddress(input.tokenContract);
    } catch {
      throw invalidInput("Privacy note discovery scope is invalid");
    }
    if (
      input.network !== this.#network ||
      poolContract !== this.#poolContract ||
      recipientAddress !== this.#recipientAddress ||
      (tokenContract !== undefined && tokenContract !== this.#tokenContract)
    ) {
      throw invalidInput("Privacy note discovery escaped its configured scope");
    }
  }

  async #discover(blockIdentifier: "latest" | string): Promise<NormalizedDiscovery<NotesCursor>> {
    const viewingKey = await this.#readViewingKey();
    const value = await this.#providerCall("note discovery", () =>
      this.#discoveryProvider.discoverNotes(this.#recipientAddressValue, viewingKey, {
        tokens: [this.#tokenContractValue],
        blockIdentifier,
      }),
    );
    return validateDiscoveryResponse(value, {
      poolContract: this.#poolContract,
      recipientAddress: this.#recipientAddress,
      tokenContract: this.#tokenContract,
      maximumNotes: this.#maximumNotesPerSnapshot,
    });
  }

  async #readViewingKey(): Promise<bigint> {
    const value = await this.#providerCall("viewing-key access", () =>
      this.#viewingKeyProvider.getViewingKey(),
    );
    let key: bigint;
    try {
      key = parseBigNumberish(value);
    } catch {
      throw new StarknetPrivacySdkNoteSourceError(
        "invalid_response",
        "Privacy viewing-key provider returned an invalid key",
      );
    }
    if (key <= 0n || key > ec.starkCurve.CURVE.n / 2n) {
      throw new StarknetPrivacySdkNoteSourceError(
        "invalid_response",
        "Privacy viewing-key provider returned an invalid key",
      );
    }
    return key;
  }

  #emptyChannelCursor(): ChannelCursor {
    let cursor: ChannelCursor;
    try {
      cursor = this.#createEmptyChannelCursor();
    } catch {
      throw new StarknetPrivacySdkNoteSourceError(
        "provider_failure",
        "Privacy SDK channel-cursor construction failed",
      );
    }
    if ((typeof cursor !== "object" && typeof cursor !== "function") || cursor === null) {
      throw new StarknetPrivacySdkNoteSourceError(
        "invalid_response",
        "Privacy SDK channel-cursor factory returned an invalid cursor",
      );
    }
    return cursor;
  }

  async #providerCall<Value>(label: string, operation: () => Promise<Value>): Promise<Value> {
    try {
      return await withTimeout(Promise.resolve().then(operation), this.#requestTimeoutMilliseconds);
    } catch (error) {
      if (error instanceof StarknetPrivacySdkNoteSourceError) {
        throw error;
      }
      throw new StarknetPrivacySdkNoteSourceError(
        "provider_failure",
        `Privacy SDK ${label} failed`,
      );
    }
  }
}

function validateDiscoveryResponse<NotesCursor>(
  value: unknown,
  expected: {
    readonly poolContract: string;
    readonly recipientAddress: string;
    readonly tokenContract: string;
    readonly maximumNotes: number;
  },
): NormalizedDiscovery<NotesCursor> {
  if (typeof value !== "object" || value === null || !("cursor" in value)) {
    throw invalidResponse("Privacy SDK returned a malformed note snapshot");
  }
  const response = value as {
    readonly timestamp?: unknown;
    readonly notes?: unknown;
    cursor: NotesCursor;
  };
  if (
    (typeof response.cursor !== "object" && typeof response.cursor !== "function") ||
    response.cursor === null
  ) {
    throw invalidResponse("Privacy SDK returned a malformed note cursor");
  }
  const blockReference = responseBlockHash(response.timestamp, "note snapshot");
  const tokenEntries = mapEntries(response.notes, "note collection");
  const notes: NormalizedSdkNote[] = [];
  for (const [rawToken, rawNotes] of tokenEntries) {
    const token = responseAddress(rawToken, "note token");
    if (token !== expected.tokenContract || !Array.isArray(rawNotes)) {
      throw invalidResponse("Privacy SDK returned notes outside the configured token");
    }
    if (notes.length + rawNotes.length > expected.maximumNotes) {
      throw invalidResponse("Privacy SDK returned too many notes");
    }
    for (const candidate of rawNotes) {
      notes.push(normalizeSdkNote(candidate, expected));
    }
  }
  const seen = new Set<string>();
  for (const note of notes) {
    if (seen.has(note.noteReference)) {
      throw invalidResponse("Privacy SDK returned a duplicate note");
    }
    seen.add(note.noteReference);
  }
  notes.sort((left, right) => left.noteReference.localeCompare(right.noteReference));
  return { blockReference, notes, cursor: response.cursor };
}

function normalizeSdkNote(
  candidate: unknown,
  expected: {
    readonly poolContract: string;
    readonly recipientAddress: string;
    readonly tokenContract: string;
  },
): NormalizedSdkNote {
  if (typeof candidate !== "object" || candidate === null) {
    throw invalidResponse("Privacy SDK returned a malformed note");
  }
  const note = candidate as StarknetPrivacySdkNote;
  if (note.open !== false) {
    throw invalidResponse("Privacy SDK returned an unsupported open note");
  }
  const amount = responsePositiveU128(note.amount, "note amount");
  const witness = responseNoteWitness(note.witness);
  const noteReference = responseFelt(note.id, "note ID");
  let computedNoteReference: string;
  try {
    computedNoteReference = computeStarknetPrivacySdkNoteReference({
      channelKey: witness.channelKey,
      tokenContract: BigInt(expected.tokenContract),
      noteNonce: Number(witness.nonce),
    });
  } catch {
    throw invalidResponse("Privacy SDK returned a malformed note witness");
  }
  if (noteReference !== computedNoteReference) {
    throw invalidResponse("Privacy SDK note ID disagreed with its witness");
  }
  return {
    poolContract: expected.poolContract,
    recipientAddress: expected.recipientAddress,
    senderAddress: responseAddress(note.sender, "note sender"),
    tokenContract: expected.tokenContract,
    amountBaseUnits: amount,
    noteReference,
    eventValue: encryptedNoteEventValue(
      witness.channelKey,
      BigInt(expected.tokenContract),
      witness.nonce,
      witness.salt,
      amount,
    ),
    blockNumber: responseBlockNumber(note.created, "note creation block"),
  };
}

function responseNoteWitness(value: unknown): {
  readonly channelKey: bigint;
  readonly nonce: bigint;
  readonly salt: bigint;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidResponse("Privacy SDK returned a malformed note witness");
  }
  const witness = value as {
    readonly channelKey?: unknown;
    readonly nonce?: unknown;
    readonly r?: unknown;
  };
  if (
    typeof witness.channelKey !== "bigint" ||
    witness.channelKey <= 0n ||
    witness.channelKey >= STARK_FIELD_PRIME ||
    typeof witness.nonce !== "number" ||
    !Number.isSafeInteger(witness.nonce) ||
    witness.nonce < 0 ||
    typeof witness.r !== "bigint" ||
    witness.r < MINIMUM_ENCRYPTED_NOTE_SALT ||
    witness.r >= TWO_POW_120
  ) {
    throw invalidResponse("Privacy SDK returned a malformed note witness");
  }
  return { channelKey: witness.channelKey, nonce: BigInt(witness.nonce), salt: witness.r };
}

function encryptedNoteEventValue(
  channelKey: bigint,
  token: bigint,
  nonce: bigint,
  salt: bigint,
  amount: bigint,
): string {
  const pad = privacyHash(ENC_AMOUNT_TAG, channelKey, token, nonce, 0n, salt);
  const encryptedAmount = (pad + amount) & MAX_U128;
  return normalizeComputedFelt((salt << 128n) + encryptedAmount);
}

function privacyHash(tag: bigint, ...values: readonly bigint[]): bigint {
  return ec.starkCurve.poseidonHashMany([tag, ...values]);
}

function normalizeComputedFelt(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function validateHistoryPage<HistoryCursor>(
  value: unknown,
  expectedBlockReference: string,
  maximumTransactions: number,
  discoveredByReference: ReadonlyMap<string, NormalizedSdkNote>,
  matches: Map<string, PrivacyHistorySnapshot["transactions"][number]>,
  transactionBlocks: Map<string, bigint>,
): {
  readonly cursor: HistoryCursor;
  readonly historyComplete: boolean;
  readonly transactionCount: number;
} {
  if (typeof value !== "object" || value === null || !("cursor" in value)) {
    throw invalidResponse("Privacy SDK returned a malformed history page");
  }
  const page = value as {
    readonly blockRef?: unknown;
    readonly transactions?: unknown;
    readonly cursor: HistoryCursor;
  };
  if (responseBlockHash(page.blockRef, "history page") !== expectedBlockReference) {
    throw new StarknetPrivacySdkNoteSourceError(
      "snapshot_conflict",
      "Privacy history did not honor the discovery block hash",
    );
  }
  if (!Array.isArray(page.transactions) || page.transactions.length > maximumTransactions) {
    throw invalidResponse("Privacy SDK returned an invalid history transaction batch");
  }
  if (typeof page.cursor !== "object" || page.cursor === null) {
    throw invalidResponse("Privacy SDK returned a malformed history cursor");
  }
  const historyComplete = Reflect.get(page.cursor as object, "historyComplete");
  if (typeof historyComplete !== "boolean") {
    throw invalidResponse("Privacy SDK returned a malformed history cursor");
  }

  for (const candidate of page.transactions) {
    validateHistoryTransaction(candidate, discoveredByReference, matches, transactionBlocks);
  }
  return { cursor: page.cursor, historyComplete, transactionCount: page.transactions.length };
}

function validateHistoryTransaction(
  candidate: unknown,
  discoveredByReference: ReadonlyMap<string, NormalizedSdkNote>,
  matches: Map<string, PrivacyHistorySnapshot["transactions"][number]>,
  transactionBlocks: Map<string, bigint>,
): void {
  if (typeof candidate !== "object" || candidate === null) {
    throw invalidResponse("Privacy SDK returned a malformed history transaction");
  }
  const transaction = candidate as StarknetPrivacySdkHistoryTransaction;
  const transactionReference = responseNonzeroFelt(
    transaction.transactionHash,
    "history transaction hash",
  );
  const blockNumber = responseBlockNumber(transaction.blockNumber, "history transaction block");
  if (
    !Array.isArray(transaction.notes) ||
    transaction.notes.length > MAXIMUM_NOTES_PER_TRANSACTION
  ) {
    throw invalidResponse("Privacy SDK returned a malformed history note collection");
  }
  for (const historyCandidate of transaction.notes) {
    if (typeof historyCandidate !== "object" || historyCandidate === null) {
      throw invalidResponse("Privacy SDK returned a malformed history note");
    }
    const historyNote = historyCandidate as StarknetPrivacySdkHistoryNote;
    const noteReference = responseFelt(historyNote.noteId, "history note ID");
    const discovered = discoveredByReference.get(noteReference);
    if (discovered === undefined) {
      continue;
    }
    if (matches.has(noteReference)) {
      throw invalidResponse("Privacy SDK returned a duplicate history note");
    }
    const knownBlock = transactionBlocks.get(transactionReference);
    if (knownBlock !== undefined && knownBlock !== blockNumber) {
      throw invalidResponse("Privacy SDK mapped one transaction to inconsistent blocks");
    }
    transactionBlocks.set(transactionReference, blockNumber);
    if (
      historyNote.channelKind !== "incoming" ||
      responseAddress(historyNote.token, "history note token") !== discovered.tokenContract ||
      responseAddress(historyNote.counterparty, "history counterparty") !==
        discovered.senderAddress ||
      responsePositiveU128(historyNote.amount, "history note amount") !==
        discovered.amountBaseUnits ||
      blockNumber !== discovered.blockNumber
    ) {
      throw invalidResponse("Privacy SDK history disagreed with a discovered note");
    }
    matches.set(noteReference, { noteReference, transactionReference, blockNumber });
  }
}

function inputNoteReferences(value: readonly string[], maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw invalidInput("Privacy history request contains an invalid note batch");
  }
  const seen = new Set<string>();
  return Array.from(value, (candidate) => {
    let reference: string;
    try {
      reference = normalizeFelt(candidate, false);
    } catch {
      throw invalidInput("Privacy history request contains an invalid note reference");
    }
    if (seen.has(reference)) {
      throw invalidInput("Privacy history request contains a duplicate note reference");
    }
    seen.add(reference);
    return reference;
  });
}

function inputBlockHash(value: unknown): string {
  try {
    return normalizeBlockHash(value);
  } catch {
    throw invalidInput("Privacy history request contains an invalid block hash");
  }
}

function responseBlockHash(value: unknown, label: string): string {
  try {
    return normalizeBlockHash(value);
  } catch {
    throw invalidResponse(`Privacy SDK returned an invalid ${label} block hash`);
  }
}

function normalizeBlockHash(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > MAXIMUM_FELT_TEXT_LENGTH ||
    !/^0x[0-9a-fA-F]+$/.test(value)
  ) {
    throw new Error("block hash is not hexadecimal");
  }
  return normalizeFelt(value, true);
}

function responseFelt(value: unknown, label: string): string {
  try {
    return normalizeFelt(value, false);
  } catch {
    throw invalidResponse(`Privacy SDK returned an invalid ${label}`);
  }
}

function responseNonzeroFelt(value: unknown, label: string): string {
  try {
    return normalizeFelt(value, true);
  } catch {
    throw invalidResponse(`Privacy SDK returned an invalid ${label}`);
  }
}

function configuredAddress(value: unknown, label: string): string {
  try {
    return normalizeAddress(value);
  } catch {
    throw new StarknetPrivacySdkNoteSourceConfigurationError(`Configured ${label} is invalid`);
  }
}

function responseAddress(value: unknown, label: string): string {
  try {
    return normalizeAddress(value);
  } catch {
    throw invalidResponse(`Privacy SDK returned an invalid ${label}`);
  }
}

function normalizeAddress(value: unknown): string {
  const address = parseBigNumberish(value);
  if (address === 0n || address >= STARKNET_ADDRESS_BOUND) {
    throw new Error("address outside supported Starknet range");
  }
  return `0x${address.toString(16)}`;
}

function normalizeFelt(value: unknown, nonzero: boolean): string {
  const felt = parseBigNumberish(value);
  if ((nonzero && felt === 0n) || felt < 0n || felt >= STARK_FIELD_PRIME) {
    throw new Error("felt outside Stark field");
  }
  return `0x${felt.toString(16)}`;
}

function parseBigNumberish(value: unknown): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("unsafe numeric value");
    }
    return BigInt(value);
  }
  if (
    typeof value === "string" &&
    value.length <= MAXIMUM_FELT_TEXT_LENGTH &&
    (/^0x[0-9a-fA-F]+$/.test(value) || /^(0|[1-9][0-9]*)$/.test(value))
  ) {
    return BigInt(value);
  }
  throw new Error("invalid big-number value");
}

function responsePositiveU128(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || value <= 0n || value > MAX_U128) {
    throw invalidResponse(`Privacy SDK returned an invalid ${label}`);
  }
  return value;
}

function responseBlockNumber(value: unknown, label: string): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidResponse(`Privacy SDK returned an invalid ${label}`);
  }
  return BigInt(value);
}

function mapEntries(value: unknown, label: string): readonly (readonly [unknown, unknown])[] {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null ||
    Array.isArray(value)
  ) {
    throw invalidResponse(`Privacy SDK returned a malformed ${label}`);
  }
  try {
    const candidate = value as {
      readonly size?: unknown;
      readonly get?: unknown;
      readonly has?: unknown;
      readonly entries?: unknown;
      readonly [Symbol.iterator]?: unknown;
    };
    if (
      !Number.isSafeInteger(candidate.size) ||
      (candidate.size as number) < 0 ||
      (candidate.size as number) > MAXIMUM_TOKEN_COLLECTIONS ||
      typeof candidate.get !== "function" ||
      typeof candidate.has !== "function" ||
      typeof candidate.entries !== "function" ||
      typeof candidate[Symbol.iterator] !== "function"
    ) {
      throw invalidResponse(`Privacy SDK returned a malformed ${label}`);
    }

    const iterator = (candidate.entries as () => Iterator<unknown>).call(value);
    if (
      (typeof iterator !== "object" && typeof iterator !== "function") ||
      iterator === null ||
      typeof iterator.next !== "function"
    ) {
      throw invalidResponse(`Privacy SDK returned a malformed ${label}`);
    }
    const result: (readonly [unknown, unknown])[] = [];
    for (;;) {
      const step = iterator.next();
      if (typeof step !== "object" || step === null || typeof step.done !== "boolean") {
        throw invalidResponse(`Privacy SDK returned a malformed ${label}`);
      }
      if (step.done) {
        break;
      }
      if (!Array.isArray(step.value) || step.value.length !== 2) {
        throw invalidResponse(`Privacy SDK returned a malformed ${label}`);
      }
      result.push([step.value[0], step.value[1]]);
      if (result.length > (candidate.size as number)) {
        throw invalidResponse(`Privacy SDK returned a malformed ${label}`);
      }
    }
    if (result.length !== candidate.size) {
      throw invalidResponse(`Privacy SDK returned a malformed ${label}`);
    }
    return result;
  } catch (error) {
    if (error instanceof StarknetPrivacySdkNoteSourceError) {
      throw error;
    }
    throw invalidResponse(`Privacy SDK returned a malformed ${label}`);
  }
}

function configuredPositiveInteger(value: unknown, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new StarknetPrivacySdkNoteSourceConfigurationError(`Configured ${label} is invalid`);
  }
  return value;
}

function invalidInput(message: string): StarknetPrivacySdkNoteSourceError {
  return new StarknetPrivacySdkNoteSourceError("invalid_input", message);
}

function invalidResponse(message: string): StarknetPrivacySdkNoteSourceError {
  return new StarknetPrivacySdkNoteSourceError("invalid_response", message);
}

async function withTimeout<Value>(
  operation: Promise<Value>,
  timeoutMilliseconds: number,
): Promise<Value> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<Value>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("operation timed out")), timeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

const MAXIMUM_NOTES_PER_SNAPSHOT = 10_000;
const MAXIMUM_NOTES_PER_TRANSACTION = 10_000;
const MAXIMUM_TOKEN_COLLECTIONS = 64;
const MAXIMUM_HISTORY_PAGES = 1_000;
const MAXIMUM_TRANSACTIONS_PER_PAGE = 10_000;
const MAXIMUM_TRANSACTIONS_PER_HISTORY_RESPONSE = 100_000;
const MAXIMUM_TRANSACTIONS_PER_HISTORY_LOOKUP = 1_000_000;
const MAXIMUM_REQUEST_TIMEOUT_MILLISECONDS = 120_000;
const MAXIMUM_FELT_TEXT_LENGTH = 80;
const MAX_U128 = (1n << 128n) - 1n;
const TWO_POW_120 = 1n << 120n;
const MINIMUM_ENCRYPTED_NOTE_SALT = 2n;
const ENC_AMOUNT_TAG = BigInt(shortString.encodeShortString("ENC_AMOUNT_TAG:V1"));
const STARKNET_ADDRESS_BOUND = (1n << 251n) - 256n;
const STARK_FIELD_PRIME = (1n << 251n) + (17n << 192n) + 1n;
