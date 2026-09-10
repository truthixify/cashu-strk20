import { ec, shortString } from "starknet";

import type { StarknetPrivacySdkChannelSnapshot } from "./starknet-privacy-sdk-ports.js";

export type { StarknetPrivacySdkChannelSnapshot } from "./starknet-privacy-sdk-ports.js";

export const STARKNET_PRIVACY_SDK_NOTE_REFERENCE_VERSION =
  "starknet-privacy-sdk@0.14.3-rc.6:note-id-v1";

export interface StarknetPrivacySdkNoteReferenceInput {
  readonly channelKey: bigint;
  readonly tokenContract: bigint;
  readonly noteNonce: number;
}

export interface StarknetPrivacySdkExpectedNoteReference {
  readonly noteNonce: number;
  readonly noteReference: string;
}

export interface StarknetPrivacySdkNoteReferenceLease {
  readonly expected: StarknetPrivacySdkExpectedNoteReference;
  assertCurrent(): void;
}

export interface StarknetPrivacySdkNoteReferenceOperationInput {
  readonly operationScope: object;
  readonly channel: StarknetPrivacySdkChannelSnapshot;
  readonly tokenContract: bigint;
}

export class StarknetPrivacySdkNoteReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StarknetPrivacySdkNoteReferenceError";
  }
}

export class StarknetPrivacySdkNoteReferenceCoordinator {
  readonly #tails = new WeakMap<object, Promise<void>>();

  async withExpectedNoteReference<T>(
    input: StarknetPrivacySdkNoteReferenceOperationInput,
    operation: (lease: StarknetPrivacySdkNoteReferenceLease) => T | Promise<T>,
  ): Promise<T> {
    if (typeof operation !== "function") {
      throw new StarknetPrivacySdkNoteReferenceError("Note-reference operation is invalid");
    }
    const { operationScope, channel, tokenContract } = readOperationInput(input);
    const predecessor = this.#tails.get(operationScope) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.then(
      () => gate,
      () => gate,
    );
    this.#tails.set(operationScope, tail);

    await predecessor;
    try {
      const expected = Object.freeze(
        deriveStarknetPrivacySdkExpectedNoteReference({ channel, tokenContract }),
      );
      const lease = Object.freeze({
        expected,
        assertCurrent: (): void => {
          assertStarknetPrivacySdkExpectedNoteReference({
            channel,
            tokenContract,
            expected,
          });
        },
      });
      return await operation(lease);
    } finally {
      release();
      if (this.#tails.get(operationScope) === tail) {
        this.#tails.delete(operationScope);
      }
    }
  }
}

export function computeStarknetPrivacySdkNoteReference(
  input: StarknetPrivacySdkNoteReferenceInput,
): string {
  if (typeof input !== "object" || input === null) {
    throw new StarknetPrivacySdkNoteReferenceError("Note-reference input is invalid");
  }
  let channelKeyValue: unknown;
  let tokenContractValue: unknown;
  let noteNonceValue: unknown;
  try {
    channelKeyValue = input.channelKey;
    tokenContractValue = input.tokenContract;
    noteNonceValue = input.noteNonce;
  } catch {
    throw new StarknetPrivacySdkNoteReferenceError("Note-reference input is invalid");
  }
  const channelKey = inputFelt(channelKeyValue, "channel key");
  const tokenContract = inputAddress(tokenContractValue, "token contract");
  const noteNonce = inputNonce(noteNonceValue);
  const noteReference = ec.starkCurve.poseidonHashMany([
    NOTE_ID_TAG,
    channelKey,
    tokenContract,
    BigInt(noteNonce),
    0n,
  ]);
  if (noteReference === 0n || noteReference >= STARK_FIELD_PRIME) {
    throw new StarknetPrivacySdkNoteReferenceError("Computed note reference is invalid");
  }
  return `0x${noteReference.toString(16)}`;
}

export function deriveStarknetPrivacySdkExpectedNoteReference(input: {
  readonly channel: StarknetPrivacySdkChannelSnapshot;
  readonly tokenContract: bigint;
}): StarknetPrivacySdkExpectedNoteReference {
  const { channel, tokenContract } = readChannelInput(input);
  let channelKeyValue: unknown;
  let tokens: unknown;
  try {
    channelKeyValue = (channel as StarknetPrivacySdkChannelSnapshot).key;
    tokens = (channel as StarknetPrivacySdkChannelSnapshot).tokens;
  } catch {
    throw new StarknetPrivacySdkNoteReferenceError("Channel snapshot is invalid");
  }
  const channelKey = inputFelt(channelKeyValue, "channel key");
  if (tokens === undefined || typeof tokens !== "object" || tokens === null) {
    throw new StarknetPrivacySdkNoteReferenceError("Channel token state is invalid");
  }

  let getTokenState: unknown;
  try {
    getTokenState = (tokens as { readonly get?: unknown }).get;
  } catch {
    throw new StarknetPrivacySdkNoteReferenceError("Channel token state is invalid");
  }
  if (typeof getTokenState !== "function") {
    throw new StarknetPrivacySdkNoteReferenceError("Channel token state is invalid");
  }
  let tokenState: unknown;
  try {
    tokenState = (getTokenState as (token: bigint) => unknown).call(tokens, tokenContract);
  } catch {
    throw new StarknetPrivacySdkNoteReferenceError("Channel token state is unavailable");
  }
  if (typeof tokenState !== "object" || tokenState === null) {
    throw new StarknetPrivacySdkNoteReferenceError("Channel token state is unavailable");
  }
  let noteNonceValue: unknown;
  try {
    noteNonceValue = (tokenState as { readonly noteNonce?: unknown }).noteNonce;
  } catch {
    throw new StarknetPrivacySdkNoteReferenceError("Channel token state is invalid");
  }
  const noteNonce = inputNonce(noteNonceValue);
  return {
    noteNonce,
    noteReference: computeStarknetPrivacySdkNoteReference({
      channelKey,
      tokenContract,
      noteNonce,
    }),
  };
}

export function assertStarknetPrivacySdkExpectedNoteReference(input: {
  readonly channel: StarknetPrivacySdkChannelSnapshot;
  readonly tokenContract: bigint;
  readonly expected: StarknetPrivacySdkExpectedNoteReference;
}): void {
  const { channel, tokenContract } = readChannelInput(input);
  let expectedValue: unknown;
  try {
    expectedValue = input.expected;
  } catch {
    throw new StarknetPrivacySdkNoteReferenceError("Expected note reference is invalid");
  }
  const expected = readExpectedNoteReference(expectedValue);
  const current = deriveStarknetPrivacySdkExpectedNoteReference({ channel, tokenContract });
  if (
    current.noteNonce !== expected.noteNonce ||
    current.noteReference !== expected.noteReference
  ) {
    throw new StarknetPrivacySdkNoteReferenceError("Expected note reference is stale");
  }
}

function readOperationInput(input: unknown): {
  readonly operationScope: object;
  readonly channel: StarknetPrivacySdkChannelSnapshot;
  readonly tokenContract: bigint;
} {
  if (typeof input !== "object" || input === null) {
    throw new StarknetPrivacySdkNoteReferenceError("Note-reference operation input is invalid");
  }
  let operationScope: unknown;
  let channel: unknown;
  let tokenContract: unknown;
  try {
    operationScope = (input as StarknetPrivacySdkNoteReferenceOperationInput).operationScope;
    channel = (input as StarknetPrivacySdkNoteReferenceOperationInput).channel;
    tokenContract = (input as StarknetPrivacySdkNoteReferenceOperationInput).tokenContract;
  } catch {
    throw new StarknetPrivacySdkNoteReferenceError("Note-reference operation input is invalid");
  }
  if (typeof operationScope !== "object" || operationScope === null) {
    throw new StarknetPrivacySdkNoteReferenceError("Note-reference operation scope is invalid");
  }
  const parsed = readChannelInput({ channel, tokenContract });
  return { operationScope, ...parsed };
}

function readChannelInput(input: unknown): {
  readonly channel: StarknetPrivacySdkChannelSnapshot;
  readonly tokenContract: bigint;
} {
  if (typeof input !== "object" || input === null) {
    throw new StarknetPrivacySdkNoteReferenceError("Channel snapshot is invalid");
  }
  let channel: unknown;
  let tokenContractValue: unknown;
  try {
    channel = (input as { readonly channel?: unknown }).channel;
    tokenContractValue = (input as { readonly tokenContract?: unknown }).tokenContract;
  } catch {
    throw new StarknetPrivacySdkNoteReferenceError("Channel snapshot is invalid");
  }
  if (typeof channel !== "object" || channel === null) {
    throw new StarknetPrivacySdkNoteReferenceError("Channel snapshot is invalid");
  }
  return {
    channel: channel as StarknetPrivacySdkChannelSnapshot,
    tokenContract: inputAddress(tokenContractValue, "token contract"),
  };
}

function readExpectedNoteReference(value: unknown): StarknetPrivacySdkExpectedNoteReference {
  if (typeof value !== "object" || value === null) {
    throw new StarknetPrivacySdkNoteReferenceError("Expected note reference is invalid");
  }
  let noteNonceValue: unknown;
  let noteReferenceValue: unknown;
  try {
    noteNonceValue = (value as { readonly noteNonce?: unknown }).noteNonce;
    noteReferenceValue = (value as { readonly noteReference?: unknown }).noteReference;
  } catch {
    throw new StarknetPrivacySdkNoteReferenceError("Expected note reference is invalid");
  }
  const noteNonce = inputNonce(noteNonceValue);
  if (typeof noteReferenceValue !== "string" || !/^0x[0-9a-f]+$/.test(noteReferenceValue)) {
    throw new StarknetPrivacySdkNoteReferenceError("Expected note reference is invalid");
  }
  let noteReference: bigint;
  try {
    noteReference = BigInt(noteReferenceValue);
  } catch {
    throw new StarknetPrivacySdkNoteReferenceError("Expected note reference is invalid");
  }
  if (
    noteReference <= 0n ||
    noteReference >= STARK_FIELD_PRIME ||
    noteReferenceValue !== `0x${noteReference.toString(16)}`
  ) {
    throw new StarknetPrivacySdkNoteReferenceError("Expected note reference is invalid");
  }
  return { noteNonce, noteReference: noteReferenceValue };
}

function inputFelt(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || value <= 0n || value >= STARK_FIELD_PRIME) {
    throw new StarknetPrivacySdkNoteReferenceError(`Note-reference ${label} is invalid`);
  }
  return value;
}

function inputAddress(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || value <= 0n || value >= STARKNET_ADDRESS_BOUND) {
    throw new StarknetPrivacySdkNoteReferenceError(`Note-reference ${label} is invalid`);
  }
  return value;
}

function inputNonce(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new StarknetPrivacySdkNoteReferenceError("Note-reference nonce is invalid");
  }
  return value;
}

const NOTE_ID_TAG = BigInt(shortString.encodeShortString("NOTE_ID_TAG:V1"));
const STARKNET_ADDRESS_BOUND = (1n << 251n) - 256n;
const STARK_FIELD_PRIME = (1n << 251n) + (17n << 192n) + 1n;
