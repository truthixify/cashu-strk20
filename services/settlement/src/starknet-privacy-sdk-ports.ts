import type { BigNumberish, BlockIdentifier } from "starknet";

export interface StarknetPrivacySdkViewingKeyProvider {
  getViewingKey(): Promise<BigNumberish>;
}

export interface StarknetPrivacySdkNote {
  readonly id: unknown;
  readonly amount: unknown;
  readonly created?: unknown;
  readonly sender: unknown;
  readonly open?: unknown;
  readonly witness: unknown;
}

export interface StarknetPrivacySdkHistoryNote {
  readonly channelKind: unknown;
  readonly token: unknown;
  readonly noteId: unknown;
  readonly counterparty: unknown;
  readonly amount: unknown;
}

export interface StarknetPrivacySdkHistoryTransaction {
  readonly blockNumber: unknown;
  readonly transactionHash: unknown;
  readonly notes: unknown;
}

export interface StarknetPrivacySdkHistoryCursor {
  readonly historyComplete: unknown;
}

/** Structural subset shared by the SDK's `AddressMap` and a native `Map`. */
export interface StarknetPrivacySdkAddressMap<Value> {
  readonly size: number;
  get(key: bigint): Value | undefined;
  has(key: bigint): boolean;
  entries(): IterableIterator<[bigint, Value]>;
  [Symbol.iterator](): IterableIterator<[bigint, Value]>;
}

/** Structural subset of RC.6 `IndexerDiscoveryProvider`. */
export interface StarknetPrivacySdkIndexer<NotesCursor, ChannelCursor, HistoryCursor> {
  discoverNotes(
    address: bigint,
    viewingKey: BigNumberish,
    params?: {
      readonly cursor?: NotesCursor;
      readonly tokens?: bigint[];
      readonly blockIdentifier?: BlockIdentifier;
    },
  ): Promise<{
    readonly timestamp: BlockIdentifier;
    readonly notes: StarknetPrivacySdkAddressMap<readonly StarknetPrivacySdkNote[]>;
    readonly cursor: NotesCursor;
  }>;
  fetchHistory(
    userAddress: bigint,
    notesCursor: NotesCursor,
    channelCursor: ChannelCursor,
    options?: {
      readonly maxTransactions?: number;
      readonly lastKnownBlock?: string;
      readonly blockIdentifier?: BlockIdentifier;
      readonly historyCursor?: HistoryCursor;
    },
  ): Promise<{
    readonly blockRef: BlockIdentifier;
    readonly transactions: readonly StarknetPrivacySdkHistoryTransaction[];
    readonly cursor: HistoryCursor;
  }>;
}

export interface StarknetPrivacySdkChannelSnapshot {
  readonly key?: unknown;
  readonly tokens?: unknown;
}

export interface StarknetPrivacySdkPayoutExecuteResult {
  readonly callAndProof: unknown;
  readonly warnings: unknown;
}

export interface StarknetPrivacySdkPayoutTokenBuilder {
  transfer(output: { readonly recipient: bigint; readonly amount: bigint }): this;
  surplusTo(recipient: bigint, withdraw?: boolean): this;
  execute(): Promise<StarknetPrivacySdkPayoutExecuteResult>;
}

export interface StarknetPrivacySdkPayoutBuilder {
  with(token: bigint): StarknetPrivacySdkPayoutTokenBuilder;
}

/** Structural subset of RC.6 used to compile and prove one private transfer. */
export interface StarknetPrivacySdkPayoutTransfers {
  readonly user: unknown;
  build(options: {
    readonly autoRegister: false;
    readonly autoDiscover: { readonly notes: "refresh"; readonly channels: "refresh" };
    readonly autoSetup: false;
    readonly autoSelectNotes: "naive";
    readonly registryConst: true;
    readonly provingBlockId: string;
  }): StarknetPrivacySdkPayoutBuilder;
}
