import type { EventFilter } from "starknet";
import { describe, expect, it } from "vitest";

import {
  StarknetEventInventoryCache,
  StarknetEventInventoryCacheConfigurationError,
  type StarknetEventInventoryRpc,
} from "./starknet-event-inventory-cache.js";

const CONTRACT = "0x254";
const HEAD = "0x999";
const FIRST_SELECTOR = "0x111";
const SECOND_SELECTOR = "0x222";

describe("Starknet event inventory cache", () => {
  it("shares one paginated union scan across concurrent filtered reads", async () => {
    const provider = new FakeEventRpc();
    provider.pages = [
      { events: [], continuation_token: "next" },
      {
        events: [event(FIRST_SELECTOR, 101), event(SECOND_SELECTOR, 102)],
      },
    ];
    const cache = eventCache(provider);

    const [first, second] = await Promise.all([
      cache.getEvents(filter([FIRST_SELECTOR])),
      cache.getEvents(filter([SECOND_SELECTOR])),
    ]);

    expect(first).toEqual({ events: [event(FIRST_SELECTOR, 101)] });
    expect(second).toEqual({ events: [event(SECOND_SELECTOR, 102)] });
    expect(provider.filters).toEqual([
      filter([FIRST_SELECTOR, SECOND_SELECTOR]),
      { ...filter([FIRST_SELECTOR, SECOND_SELECTOR]), continuation_token: "next" },
    ]);
  });

  it("preserves relative event order within each requested selector set", async () => {
    const provider = new FakeEventRpc();
    provider.pages = [
      {
        events: [
          event(SECOND_SELECTOR, 100),
          event(FIRST_SELECTOR, 101),
          event(SECOND_SELECTOR, 102),
        ],
      },
    ];
    const cache = eventCache(provider);

    await expect(cache.getEvents(filter([SECOND_SELECTOR]))).resolves.toEqual({
      events: [event(SECOND_SELECTOR, 100), event(SECOND_SELECTOR, 102)],
    });
  });

  it.each([
    { name: "wrong contract", change: { address: "0x255" } },
    { name: "malformed contract", change: { address: "not-a-felt" } },
    { name: "wrong start block", change: { from_block: { block_number: 99 } } },
    { name: "wrong head", change: { to_block: { block_hash: "0x998" } } },
    { name: "unknown selector", change: { keys: [["0x333"]] } },
    { name: "continuation token", change: { continuation_token: "skip" } },
    { name: "unsupported field", change: { unrelated: true } },
  ])("rejects a caller filter with $name before reading the provider", async ({ change }) => {
    const provider = new FakeEventRpc();
    const cache = eventCache(provider);

    await expect(cache.getEvents({ ...filter([FIRST_SELECTOR]), ...change })).rejects.toMatchObject(
      {
        code: "invalid_filter",
      },
    );
    expect(provider.filters).toEqual([]);
  });

  it("rejects an event outside the configured selector union", async () => {
    const provider = new FakeEventRpc();
    provider.pages = [{ events: [event("0x333", 101)] }];

    await expect(eventCache(provider).getEvents(filter([FIRST_SELECTOR]))).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("rejects repeated provider continuation tokens", async () => {
    const provider = new FakeEventRpc();
    provider.pages = [
      { events: [], continuation_token: "same" },
      { events: [], continuation_token: "same" },
    ];

    await expect(eventCache(provider).getEvents(filter([FIRST_SELECTOR]))).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("rejects invalid configuration before reading the provider", () => {
    const provider = new FakeEventRpc();
    expect(
      () =>
        new StarknetEventInventoryCache({
          provider,
          contractAddress: CONTRACT,
          fromBlockNumber: 100,
          throughBlockHash: HEAD,
          selectors: [FIRST_SELECTOR, FIRST_SELECTOR],
        }),
    ).toThrow(StarknetEventInventoryCacheConfigurationError);
    expect(provider.filters).toEqual([]);
  });
});

class FakeEventRpc implements StarknetEventInventoryRpc {
  pages: unknown[] = [{ events: [] }];
  readonly filters: EventFilter[] = [];

  async getEvents(eventFilter: EventFilter): Promise<unknown> {
    this.filters.push(eventFilter);
    const page = this.pages[this.filters.length - 1];
    if (page === undefined) throw new Error("missing page");
    await Promise.resolve();
    return page;
  }
}

function event(selector: string, blockNumber: number) {
  return {
    block_hash: `0x${blockNumber.toString(16)}`,
    block_number: blockNumber,
    transaction_hash: `0x${(blockNumber + 1).toString(16)}`,
    from_address: CONTRACT,
    keys: [selector],
    data: ["0x1"],
  };
}

function eventCache(provider: StarknetEventInventoryRpc): StarknetEventInventoryCache {
  return new StarknetEventInventoryCache({
    provider,
    contractAddress: CONTRACT,
    fromBlockNumber: 100,
    throughBlockHash: HEAD,
    selectors: [FIRST_SELECTOR, SECOND_SELECTOR],
  });
}

function filter(selectors: readonly string[]): EventFilter {
  return {
    from_block: { block_number: 100 },
    to_block: { block_hash: HEAD },
    address: CONTRACT,
    keys: [[...selectors]],
    chunk_size: 100,
  };
}
