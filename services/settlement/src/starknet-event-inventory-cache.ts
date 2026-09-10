import type { EventFilter } from "starknet";

export const STARKNET_EVENT_INVENTORY_CACHE_VERSION =
  "starknet@10.5.0:bounded-selector-inventory-cache-v1";

export interface StarknetEventInventoryRpc {
  getEvents(eventFilter: EventFilter): Promise<unknown>;
}

export interface StarknetEventInventoryCacheConfig {
  readonly provider: StarknetEventInventoryRpc;
  readonly contractAddress: string;
  readonly fromBlockNumber: number;
  readonly throughBlockHash: string;
  readonly selectors: readonly string[];
}

export type StarknetEventInventoryCacheErrorCode = "invalid_filter" | "invalid_response";

export class StarknetEventInventoryCacheConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StarknetEventInventoryCacheConfigurationError";
  }
}

export class StarknetEventInventoryCacheError extends Error {
  readonly code: StarknetEventInventoryCacheErrorCode;

  constructor(code: StarknetEventInventoryCacheErrorCode, message: string) {
    super(message);
    this.name = "StarknetEventInventoryCacheError";
    this.code = code;
  }
}

interface ValidatedConfig {
  readonly provider: StarknetEventInventoryRpc;
  readonly contractAddress: string;
  readonly fromBlockNumber: number;
  readonly throughBlockHash: string;
  readonly selectors: readonly string[];
  readonly selectorSet: ReadonlySet<string>;
}

interface CachedEvent {
  readonly block_hash: unknown;
  readonly block_number: unknown;
  readonly transaction_hash: unknown;
  readonly from_address: unknown;
  readonly keys: readonly string[];
  readonly data: readonly unknown[];
}

interface InventoryPage {
  readonly events: readonly CachedEvent[];
  readonly continuationToken?: string;
}

interface RequestedFilter {
  readonly selectors: ReadonlySet<string>;
  readonly chunkSize: number;
}

/** Shares one complete multi-selector scan while preserving the callers' exact filtered views. */
export class StarknetEventInventoryCache implements StarknetEventInventoryRpc {
  readonly #config: ValidatedConfig;
  #inventoryPromise: Promise<readonly CachedEvent[]> | undefined;

  readonly cacheVersion = STARKNET_EVENT_INVENTORY_CACHE_VERSION;

  constructor(config: StarknetEventInventoryCacheConfig) {
    this.#config = validateConfig(config);
  }

  async getEvents(eventFilter: EventFilter): Promise<unknown> {
    const requested = requestedFilter(eventFilter, this.#config);
    const inventory = await this.#inventory();
    const events = inventory.filter((event) => requested.selectors.has(requiredSelector(event)));
    if (events.length > requested.chunkSize) {
      throw invalidFilter();
    }
    return {
      events: Object.freeze(events.map((event) => cloneEvent(event))),
    };
  }

  #inventory(): Promise<readonly CachedEvent[]> {
    this.#inventoryPromise ??= collectInventory(this.#config);
    return this.#inventoryPromise;
  }
}

async function collectInventory(config: ValidatedConfig): Promise<readonly CachedEvent[]> {
  const events: CachedEvent[] = [];
  const continuationTokens = new Set<string>();
  let continuationToken: string | undefined;
  for (let page = 0; page < MAXIMUM_INVENTORY_PAGES; page += 1) {
    const value = await config.provider.getEvents({
      from_block: { block_number: config.fromBlockNumber },
      to_block: { block_hash: config.throughBlockHash },
      address: config.contractAddress,
      keys: [[...config.selectors]],
      chunk_size: MAXIMUM_EVENTS_PER_PAGE,
      ...(continuationToken === undefined ? {} : { continuation_token: continuationToken }),
    });
    const parsed = inventoryPage(value, config.selectorSet);
    events.push(...parsed.events);
    if (events.length > MAXIMUM_CACHED_EVENTS) throw invalidResponse();
    if (parsed.continuationToken === undefined) return Object.freeze(events);
    if (continuationTokens.has(parsed.continuationToken)) throw invalidResponse();
    continuationTokens.add(parsed.continuationToken);
    continuationToken = parsed.continuationToken;
  }
  throw invalidResponse();
}

function inventoryPage(value: unknown, selectors: ReadonlySet<string>): InventoryPage {
  const page = plainRecord(value) as {
    readonly events?: unknown;
    readonly continuation_token?: unknown;
  };
  if (!Array.isArray(page.events)) throw invalidResponse();
  const events = Object.freeze(
    denseArray(page.events, MAXIMUM_EVENTS_PER_PAGE, invalidResponse).map((event) =>
      cachedEvent(event, selectors),
    ),
  );
  const hasContinuation = Object.hasOwn(page, "continuation_token");
  if (
    hasContinuation &&
    (typeof page.continuation_token !== "string" ||
      page.continuation_token.length === 0 ||
      page.continuation_token.length > MAXIMUM_CONTINUATION_TOKEN_LENGTH)
  ) {
    throw invalidResponse();
  }
  return {
    events,
    ...(hasContinuation ? { continuationToken: page.continuation_token as string } : {}),
  };
}

function cachedEvent(value: unknown, selectors: ReadonlySet<string>): CachedEvent {
  const event = plainRecord(value) as {
    readonly block_hash?: unknown;
    readonly block_number?: unknown;
    readonly transaction_hash?: unknown;
    readonly from_address?: unknown;
    readonly keys?: unknown;
    readonly data?: unknown;
  };
  if (!Array.isArray(event.keys) || !Array.isArray(event.data)) throw invalidResponse();
  const keys = Object.freeze(
    denseArray(event.keys, MAXIMUM_EVENT_VALUES, invalidResponse).map((key) => {
      if (typeof key !== "string") throw invalidResponse();
      return key;
    }),
  );
  const selector = canonicalFelt(keys[0]);
  if (!selectors.has(selector)) throw invalidResponse();
  return Object.freeze({
    block_hash: event.block_hash,
    block_number: event.block_number,
    transaction_hash: event.transaction_hash,
    from_address: event.from_address,
    keys: Object.freeze([selector, ...keys.slice(1)]),
    data: Object.freeze(denseArray(event.data, MAXIMUM_EVENT_VALUES, invalidResponse)),
  });
}

function requestedFilter(value: EventFilter, config: ValidatedConfig): RequestedFilter {
  if (typeof value !== "object" || value === null) throw invalidFilter();
  const filter = value as EventFilter & {
    readonly continuation_token?: unknown;
    readonly chunk_size?: unknown;
  };
  if (
    !Object.keys(filter).every((key) => REQUEST_FILTER_KEYS.has(key)) ||
    !sameAddress(filter.address, config.contractAddress) ||
    !sameBlockNumber(filter.from_block, config.fromBlockNumber) ||
    !sameBlockHash(filter.to_block, config.throughBlockHash) ||
    Object.hasOwn(filter, "continuation_token") ||
    !Number.isSafeInteger(filter.chunk_size) ||
    (filter.chunk_size as number) < 1 ||
    (filter.chunk_size as number) > MAXIMUM_EVENTS_PER_PAGE ||
    !Array.isArray(filter.keys) ||
    filter.keys.length !== 1 ||
    !Object.hasOwn(filter.keys, 0) ||
    !Array.isArray(filter.keys[0])
  ) {
    throw invalidFilter();
  }
  const selectorValues = denseArray(filter.keys[0], MAXIMUM_CONFIGURED_SELECTORS, invalidFilter);
  if (selectorValues.length === 0) throw invalidFilter();
  const selectors = new Set<string>();
  for (const value of selectorValues) {
    const selector = filterFelt(value);
    if (!config.selectorSet.has(selector) || selectors.has(selector)) throw invalidFilter();
    selectors.add(selector);
  }
  return { selectors, chunkSize: filter.chunk_size as number };
}

function validateConfig(value: unknown): ValidatedConfig {
  if (typeof value !== "object" || value === null) throw configurationInvalid();
  const config = value as {
    readonly provider?: unknown;
    readonly contractAddress?: unknown;
    readonly fromBlockNumber?: unknown;
    readonly throughBlockHash?: unknown;
    readonly selectors?: unknown;
  };
  if (
    typeof config.provider !== "object" ||
    config.provider === null ||
    !("getEvents" in config.provider) ||
    typeof config.provider.getEvents !== "function" ||
    !Number.isSafeInteger(config.fromBlockNumber) ||
    (config.fromBlockNumber as number) < 1 ||
    !Array.isArray(config.selectors) ||
    config.selectors.length === 0 ||
    config.selectors.length > MAXIMUM_CONFIGURED_SELECTORS
  ) {
    throw configurationInvalid();
  }
  const selectors = Object.freeze(
    denseArray(config.selectors, MAXIMUM_CONFIGURED_SELECTORS, configurationInvalid).map((value) =>
      configuredNonzeroFelt(value),
    ),
  );
  const selectorSet = new Set(selectors);
  if (selectorSet.size !== selectors.length) throw configurationInvalid();
  return {
    provider: config.provider as StarknetEventInventoryRpc,
    contractAddress: configuredAddress(config.contractAddress),
    fromBlockNumber: config.fromBlockNumber as number,
    throughBlockHash: configuredNonzeroFelt(config.throughBlockHash),
    selectors,
    selectorSet,
  };
}

function sameBlockNumber(value: unknown, expected: number): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    "block_number" in value &&
    value.block_number === expected
  );
}

function sameAddress(value: unknown, expected: string): boolean {
  try {
    const address = canonicalFelt(value);
    return address !== "0x0" && BigInt(address) < STARKNET_ADDRESS_BOUND && address === expected;
  } catch {
    return false;
  }
}

function sameBlockHash(value: unknown, expected: string): boolean {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("block_hash" in value)
  ) {
    return false;
  }
  try {
    return canonicalFelt(value.block_hash) === expected;
  } catch {
    return false;
  }
}

function cloneEvent(event: CachedEvent): CachedEvent {
  return {
    block_hash: event.block_hash,
    block_number: event.block_number,
    transaction_hash: event.transaction_hash,
    from_address: event.from_address,
    keys: [...event.keys],
    data: [...event.data],
  };
}

function requiredSelector(event: CachedEvent): string {
  const selector = event.keys[0];
  if (selector === undefined) throw invalidResponse();
  return selector;
}

function plainRecord(value: unknown): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidResponse();
  }
  return value;
}

function denseArray(
  value: readonly unknown[],
  maximum: number,
  error: () => Error,
): readonly unknown[] {
  if (value.length > maximum) throw error();
  return Array.from(value, (item, index) => {
    if (!Object.hasOwn(value, index)) throw error();
    return item;
  });
}

function configuredAddress(value: unknown): string {
  let address: string;
  try {
    address = configuredNonzeroFelt(value);
  } catch {
    throw configurationInvalid();
  }
  if (BigInt(address) >= STARKNET_ADDRESS_BOUND) throw configurationInvalid();
  return address;
}

function configuredNonzeroFelt(value: unknown): string {
  let felt: string;
  try {
    felt = canonicalFelt(value);
  } catch {
    throw configurationInvalid();
  }
  if (felt === "0x0") throw configurationInvalid();
  return felt;
}

function filterFelt(value: unknown): string {
  try {
    return canonicalFelt(value);
  } catch {
    throw invalidFilter();
  }
}

function canonicalFelt(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > MAXIMUM_FELT_TEXT_LENGTH ||
    !FELT_PATTERN.test(value)
  ) {
    throw invalidResponse();
  }
  const felt = BigInt(value);
  if (felt >= STARK_FIELD_PRIME) throw invalidResponse();
  return `0x${felt.toString(16)}`;
}

function configurationInvalid(): StarknetEventInventoryCacheConfigurationError {
  return new StarknetEventInventoryCacheConfigurationError(
    "Configured Starknet event inventory cache is invalid",
  );
}

function invalidFilter(): StarknetEventInventoryCacheError {
  return new StarknetEventInventoryCacheError(
    "invalid_filter",
    "Starknet event inventory cache received an unsupported filter",
  );
}

function invalidResponse(): StarknetEventInventoryCacheError {
  return new StarknetEventInventoryCacheError(
    "invalid_response",
    "Starknet event inventory cache received an invalid provider response",
  );
}

const MAXIMUM_CONFIGURED_SELECTORS = 16;
const MAXIMUM_INVENTORY_PAGES = 256;
const MAXIMUM_EVENTS_PER_PAGE = 100;
const MAXIMUM_CACHED_EVENTS = 100;
const MAXIMUM_EVENT_VALUES = 16;
const MAXIMUM_CONTINUATION_TOKEN_LENGTH = 1_024;
const MAXIMUM_FELT_TEXT_LENGTH = 66;
const STARKNET_ADDRESS_BOUND = (1n << 251n) - 256n;
const STARK_FIELD_PRIME = (1n << 251n) + (17n << 192n) + 1n;
const FELT_PATTERN = /^0x[0-9a-fA-F]+$/u;
const REQUEST_FILTER_KEYS = new Set(["from_block", "to_block", "address", "keys", "chunk_size"]);
