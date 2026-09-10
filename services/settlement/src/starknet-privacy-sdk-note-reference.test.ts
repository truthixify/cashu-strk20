import { describe, expect, it } from "vitest";

import {
  assertStarknetPrivacySdkExpectedNoteReference,
  computeStarknetPrivacySdkNoteReference,
  deriveStarknetPrivacySdkExpectedNoteReference,
  StarknetPrivacySdkNoteReferenceCoordinator,
  StarknetPrivacySdkNoteReferenceError,
  STARKNET_PRIVACY_SDK_NOTE_REFERENCE_VERSION,
} from "./starknet-privacy-sdk-note-reference.js";

const CHANNEL_KEY = 0xdefn;
const TOKEN_CONTRACT = 0x1234n;
const NOTE_NONCE = 5;
const NOTE_REFERENCE = "0x6b098ad0b0b4b1881a77f962eb0650de748f24efcabd5a64ac941e9a05777e8";
const STARK_FIELD_PRIME = (1n << 251n) + (17n << 192n) + 1n;

describe("Starknet Privacy SDK note reference", () => {
  it("matches the pinned RC.6 note-ID formula", () => {
    expect(
      computeStarknetPrivacySdkNoteReference({
        channelKey: CHANNEL_KEY,
        tokenContract: TOKEN_CONTRACT,
        noteNonce: NOTE_NONCE,
      }),
    ).toBe(NOTE_REFERENCE);
    expect(STARKNET_PRIVACY_SDK_NOTE_REFERENCE_VERSION).toBe(
      "starknet-privacy-sdk@0.14.3-rc.6:note-id-v1",
    );
  });

  it("derives the expected reference from a public RC.6 Channel shape without mutating it", () => {
    const tokenState = { tokenIndex: 2, noteNonce: NOTE_NONCE };
    const channel = {
      publicKey: 0xabcn,
      key: CHANNEL_KEY,
      tokens: new Map([[TOKEN_CONTRACT, tokenState]]),
    };

    expect(
      deriveStarknetPrivacySdkExpectedNoteReference({ channel, tokenContract: TOKEN_CONTRACT }),
    ).toEqual({ noteNonce: NOTE_NONCE, noteReference: NOTE_REFERENCE });
    expect(tokenState).toEqual({ tokenIndex: 2, noteNonce: NOTE_NONCE });
  });

  it("changes the reference when the compiler's next nonce changes", () => {
    const first = computeStarknetPrivacySdkNoteReference({
      channelKey: CHANNEL_KEY,
      tokenContract: TOKEN_CONTRACT,
      noteNonce: NOTE_NONCE,
    });
    const second = computeStarknetPrivacySdkNoteReference({
      channelKey: CHANNEL_KEY,
      tokenContract: TOKEN_CONTRACT,
      noteNonce: NOTE_NONCE + 1,
    });

    expect(second).not.toBe(first);
  });

  it("rejects an expected reference after the channel nonce changes", () => {
    const tokenState = { noteNonce: NOTE_NONCE };
    const channel = {
      key: CHANNEL_KEY,
      tokens: new Map([[TOKEN_CONTRACT, tokenState]]),
    };
    const expected = deriveStarknetPrivacySdkExpectedNoteReference({
      channel,
      tokenContract: TOKEN_CONTRACT,
    });

    expect(() =>
      assertStarknetPrivacySdkExpectedNoteReference({
        channel,
        tokenContract: TOKEN_CONTRACT,
        expected,
      }),
    ).not.toThrow();

    tokenState.noteNonce += 1;
    expect(() =>
      assertStarknetPrivacySdkExpectedNoteReference({
        channel,
        tokenContract: TOKEN_CONTRACT,
        expected,
      }),
    ).toThrow("Expected note reference is stale");
  });

  it.each([
    { noteNonce: NOTE_NONCE, noteReference: "0x00" },
    { noteNonce: NOTE_NONCE, noteReference: "0X1" },
    { noteNonce: NOTE_NONCE, noteReference: "0x01" },
    { noteNonce: NOTE_NONCE, noteReference: "0x0" },
    { noteNonce: -1, noteReference: NOTE_REFERENCE },
  ])("rejects malformed expected reference %#", (expected) => {
    expect(() =>
      assertStarknetPrivacySdkExpectedNoteReference({
        channel: {
          key: CHANNEL_KEY,
          tokens: new Map([[TOKEN_CONTRACT, { noteNonce: NOTE_NONCE }]]),
        },
        tokenContract: TOKEN_CONTRACT,
        expected,
      }),
    ).toThrowError(StarknetPrivacySdkNoteReferenceError);
  });

  it("serializes one shared SDK operation scope and derives after acquiring the queue", async () => {
    const coordinator = new StarknetPrivacySdkNoteReferenceCoordinator();
    const operationScope = {};
    const tokenState = { noteNonce: NOTE_NONCE };
    const channel = {
      key: CHANNEL_KEY,
      tokens: new Map([[TOKEN_CONTRACT, tokenState]]),
    };
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const order: string[] = [];

    const first = coordinator.withExpectedNoteReference(
      { operationScope, channel, tokenContract: TOKEN_CONTRACT },
      async (lease) => {
        order.push("first:start");
        expect(lease.expected).toEqual({
          noteNonce: NOTE_NONCE,
          noteReference: NOTE_REFERENCE,
        });
        expect(Object.isFrozen(lease)).toBe(true);
        expect(Object.isFrozen(lease.expected)).toBe(true);
        expect(lease).not.toHaveProperty("channel");
        firstStarted.resolve();
        await releaseFirst.promise;
        lease.assertCurrent();
        tokenState.noteNonce += 1;
        order.push("first:end");
        return "first";
      },
    );
    await firstStarted.promise;

    const secondStarted = deferred<void>();
    const second = coordinator.withExpectedNoteReference(
      { operationScope, channel, tokenContract: TOKEN_CONTRACT },
      (lease) => {
        order.push("second:start");
        expect(lease.expected).toEqual({
          noteNonce: NOTE_NONCE + 1,
          noteReference: computeStarknetPrivacySdkNoteReference({
            channelKey: CHANNEL_KEY,
            tokenContract: TOKEN_CONTRACT,
            noteNonce: NOTE_NONCE + 1,
          }),
        });
        secondStarted.resolve();
        return "second";
      },
    );

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    await secondStarted.promise;
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("releases a shared SDK operation scope after a failed operation", async () => {
    const coordinator = new StarknetPrivacySdkNoteReferenceCoordinator();
    const operationScope = {};
    const channel = {
      key: CHANNEL_KEY,
      tokens: new Map([[TOKEN_CONTRACT, { noteNonce: NOTE_NONCE }]]),
    };

    const failed = coordinator.withExpectedNoteReference(
      { operationScope, channel, tokenContract: TOKEN_CONTRACT },
      () => {
        throw new Error("expected operation failure");
      },
    );
    const recovered = coordinator.withExpectedNoteReference(
      { operationScope, channel, tokenContract: TOKEN_CONTRACT },
      ({ expected }) => expected.noteReference,
    );

    await expect(failed).rejects.toThrow("expected operation failure");
    await expect(recovered).resolves.toBe(NOTE_REFERENCE);
  });

  it("reports stale coordination without including private channel material", async () => {
    const coordinator = new StarknetPrivacySdkNoteReferenceCoordinator();
    const tokenState = { noteNonce: NOTE_NONCE };
    const channel = {
      key: CHANNEL_KEY,
      tokens: new Map([[TOKEN_CONTRACT, tokenState]]),
    };

    await expect(
      coordinator.withExpectedNoteReference(
        { operationScope: {}, channel, tokenContract: TOKEN_CONTRACT },
        ({ assertCurrent }) => {
          tokenState.noteNonce += 1;
          assertCurrent();
        },
      ),
    ).rejects.toMatchObject({
      name: "StarknetPrivacySdkNoteReferenceError",
      message: "Expected note reference is stale",
    });
  });

  it.each([
    { name: "zero channel key", input: { channelKey: 0n } },
    { name: "out-of-field channel key", input: { channelKey: STARK_FIELD_PRIME } },
    { name: "zero token", input: { tokenContract: 0n } },
    { name: "negative nonce", input: { noteNonce: -1 } },
    { name: "fractional nonce", input: { noteNonce: 1.5 } },
    { name: "unsafe nonce", input: { noteNonce: Number.MAX_SAFE_INTEGER + 1 } },
  ])("rejects $name", ({ input }) => {
    expect(() =>
      computeStarknetPrivacySdkNoteReference({
        channelKey: CHANNEL_KEY,
        tokenContract: TOKEN_CONTRACT,
        noteNonce: NOTE_NONCE,
        ...input,
      }),
    ).toThrowError(StarknetPrivacySdkNoteReferenceError);
  });

  it.each([
    { name: "missing channel key", channel: { tokens: new Map() } },
    { name: "missing token map", channel: { key: CHANNEL_KEY } },
    { name: "missing token state", channel: { key: CHANNEL_KEY, tokens: new Map() } },
    {
      name: "invalid next nonce",
      channel: {
        key: CHANNEL_KEY,
        tokens: new Map([[TOKEN_CONTRACT, { noteNonce: Number.NaN }]]),
      },
    },
  ])("rejects a channel snapshot with $name", ({ channel }) => {
    expect(() =>
      deriveStarknetPrivacySdkExpectedNoteReference({ channel, tokenContract: TOKEN_CONTRACT }),
    ).toThrowError(StarknetPrivacySdkNoteReferenceError);
  });

  it("redacts an upstream token-state failure", () => {
    const channel = {
      key: CHANNEL_KEY,
      tokens: {
        get() {
          throw new Error("private-channel-marker");
        },
      },
    };

    expect(() =>
      deriveStarknetPrivacySdkExpectedNoteReference({ channel, tokenContract: TOKEN_CONTRACT }),
    ).toThrow("Channel token state is unavailable");
    try {
      deriveStarknetPrivacySdkExpectedNoteReference({ channel, tokenContract: TOKEN_CONTRACT });
    } catch (error) {
      expect(error).not.toHaveProperty(
        "message",
        expect.stringContaining("private-channel-marker"),
      );
    }
  });

  it("redacts a hostile nonce getter", () => {
    const channel = {
      key: CHANNEL_KEY,
      tokens: new Map([
        [
          TOKEN_CONTRACT,
          {
            get noteNonce(): number {
              throw new Error("private-nonce-marker");
            },
          },
        ],
      ]),
    };

    try {
      deriveStarknetPrivacySdkExpectedNoteReference({ channel, tokenContract: TOKEN_CONTRACT });
      throw new Error("Expected note derivation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(StarknetPrivacySdkNoteReferenceError);
      expect(error).not.toHaveProperty("message", expect.stringContaining("private-nonce-marker"));
    }
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}
