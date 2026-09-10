import type { StarknetNetwork } from "@cashu-strk20/strk20-method";
import type { BlockIdentifier, Call } from "starknet";

export const STARKNET_PROVING_BLOCK_SELECTOR_VERSION =
  "starknet@10.5.0:accepted-pool-validity-unanimous-v1";

export interface StarknetProvingBlockRpc {
  getChainId(): Promise<string>;
  getBlockWithTxHashes(blockIdentifier?: BlockIdentifier): Promise<unknown>;
  callContract(call: Call, blockIdentifier?: BlockIdentifier): Promise<readonly string[]>;
}

export interface NamedStarknetProvingBlockProvider {
  readonly id: string;
  readonly provider: StarknetProvingBlockRpc;
}

export interface StarknetProvingBlockSelectorConfig {
  readonly network: StarknetNetwork;
  readonly poolContract: string;
  readonly providers: readonly NamedStarknetProvingBlockProvider[];
  readonly blocksBehind: number;
  readonly minimumRemainingValidityBlocks: number;
  readonly maximumHeadLagBlocks: number;
  readonly maximumBlockAgeSeconds: number;
  readonly maximumFutureBlockTimeSeconds: number;
  readonly requestTimeoutMilliseconds: number;
  readonly now?: () => Date;
}

export interface StarknetProvingBlockSelection {
  readonly blockHash: string;
  readonly blockNumber: bigint;
  readonly proofValidityBlocks: bigint;
  readonly remainingValidityBlocks: bigint;
  readonly selectorVersion: typeof STARKNET_PROVING_BLOCK_SELECTOR_VERSION;
}

export type StarknetProvingBlockSelectorErrorCode =
  | "finality_not_satisfied"
  | "insufficient_validity"
  | "invalid_response"
  | "provider_disagreement"
  | "provider_failure"
  | "stale_block";

export class StarknetProvingBlockSelectorConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StarknetProvingBlockSelectorConfigurationError";
  }
}

export class StarknetProvingBlockSelectorError extends Error {
  readonly code: StarknetProvingBlockSelectorErrorCode;

  constructor(code: StarknetProvingBlockSelectorErrorCode, message: string) {
    super(message);
    this.name = "StarknetProvingBlockSelectorError";
    this.code = code;
  }
}

interface AcceptedBlock {
  readonly hash: string;
  readonly number: bigint;
  readonly timestamp: number;
}

interface ProviderHead {
  readonly id: string;
  readonly provider: StarknetProvingBlockRpc;
  readonly block: AcceptedBlock;
}

interface RpcBlock {
  readonly status?: unknown;
  readonly block_hash?: unknown;
  readonly block_number?: unknown;
  readonly timestamp?: unknown;
}

export class StarknetProvingBlockSelector {
  readonly #poolContract: string;
  readonly #providers: readonly NamedStarknetProvingBlockProvider[];
  readonly #blocksBehind: bigint;
  readonly #minimumRemainingValidityBlocks: bigint;
  readonly #maximumHeadLagBlocks: bigint;
  readonly #maximumBlockAgeSeconds: number;
  readonly #maximumFutureBlockTimeSeconds: number;
  readonly #requestTimeoutMilliseconds: number;
  readonly #now: () => Date;

  readonly selectorVersion = STARKNET_PROVING_BLOCK_SELECTOR_VERSION;

  constructor(config: StarknetProvingBlockSelectorConfig) {
    if (config.network !== "SN_SEPOLIA") {
      throw new StarknetProvingBlockSelectorConfigurationError(
        "Only Starknet Sepolia proving blocks are enabled",
      );
    }
    this.#poolContract = configuredAddress(config.poolContract, "privacy pool");
    this.#providers = validateProviders(config.providers);
    this.#blocksBehind = BigInt(
      configuredPositiveInteger(config.blocksBehind, "blocks behind provider heads"),
    );
    this.#minimumRemainingValidityBlocks = BigInt(
      configuredPositiveInteger(
        config.minimumRemainingValidityBlocks,
        "minimum remaining proof validity",
      ),
    );
    this.#maximumHeadLagBlocks = BigInt(
      configuredNonnegativeInteger(config.maximumHeadLagBlocks, "maximum provider head lag"),
    );
    this.#maximumBlockAgeSeconds = configuredPositiveInteger(
      config.maximumBlockAgeSeconds,
      "maximum proving block age",
    );
    this.#maximumFutureBlockTimeSeconds = configuredNonnegativeInteger(
      config.maximumFutureBlockTimeSeconds,
      "maximum future block time",
    );
    this.#requestTimeoutMilliseconds = configuredPositiveInteger(
      config.requestTimeoutMilliseconds,
      "request timeout",
    );
    this.#now = config.now ?? (() => new Date());
  }

  readonly selectProvingBlock = async (): Promise<StarknetProvingBlockSelection> => {
    return this.select();
  };

  async select(): Promise<StarknetProvingBlockSelection> {
    const now = this.#nowSeconds();
    const heads = await Promise.all(
      this.#providers.map((provider) => this.#readHead(provider, now)),
    );
    const headNumbers = heads.map(({ block }) => block.number);
    const minimumHead = minimumBigInt(headNumbers);
    const maximumHead = maximumBigInt(headNumbers);
    if (maximumHead - minimumHead > this.#maximumHeadLagBlocks) {
      throw new StarknetProvingBlockSelectorError(
        "provider_disagreement",
        "Starknet providers exceed the configured head-lag policy",
      );
    }
    if (minimumHead < this.#blocksBehind) {
      throw new StarknetProvingBlockSelectorError(
        "insufficient_validity",
        "Starknet provider heads are too low for the proving-block offset",
      );
    }

    const targetNumber = minimumHead - this.#blocksBehind;
    const targetBlocks = await Promise.all(
      heads.map((head) => this.#readTargetBlock(head, targetNumber, now)),
    );
    const targetBlock = agreedBlock(targetBlocks);
    const proofValidityBlocks = await this.#readAgreedProofValidity(targetBlock.hash);
    const selectedAgeBlocks = maximumHead - targetNumber;
    if (selectedAgeBlocks + this.#minimumRemainingValidityBlocks > proofValidityBlocks) {
      throw new StarknetProvingBlockSelectorError(
        "insufficient_validity",
        "Selected proving block does not preserve the configured proof-validity margin",
      );
    }

    return {
      blockHash: targetBlock.hash,
      blockNumber: targetBlock.number,
      proofValidityBlocks,
      remainingValidityBlocks: proofValidityBlocks - selectedAgeBlocks,
      selectorVersion: this.selectorVersion,
    };
  }

  async #readHead(
    namedProvider: NamedStarknetProvingBlockProvider,
    now: number,
  ): Promise<ProviderHead> {
    let chainId: string;
    let blockValue: unknown;
    try {
      [chainId, blockValue] = await withTimeout(
        Promise.all([
          namedProvider.provider.getChainId(),
          namedProvider.provider.getBlockWithTxHashes("latest"),
        ]),
        this.#requestTimeoutMilliseconds,
      );
    } catch {
      throw providerFailure(namedProvider.id, "read its accepted head");
    }
    if (inputFelt(chainId, `${namedProvider.id} chain ID`, true) !== SEPOLIA_CHAIN_ID) {
      throw new StarknetProvingBlockSelectorError(
        "provider_disagreement",
        `Starknet provider ${namedProvider.id} returned the wrong chain ID`,
      );
    }
    return {
      id: namedProvider.id,
      provider: namedProvider.provider,
      block: acceptedBlock(
        blockValue,
        namedProvider.id,
        now,
        this.#maximumBlockAgeSeconds,
        this.#maximumFutureBlockTimeSeconds,
      ),
    };
  }

  async #readTargetBlock(
    head: ProviderHead,
    targetNumber: bigint,
    now: number,
  ): Promise<AcceptedBlock> {
    let value: unknown;
    try {
      value = await withTimeout(
        head.provider.getBlockWithTxHashes(targetNumber.toString(10)),
        this.#requestTimeoutMilliseconds,
      );
    } catch {
      throw providerFailure(head.id, "read the selected proving block");
    }
    const block = acceptedBlock(
      value,
      head.id,
      now,
      this.#maximumBlockAgeSeconds,
      this.#maximumFutureBlockTimeSeconds,
    );
    if (block.number !== targetNumber) {
      throw new StarknetProvingBlockSelectorError(
        "invalid_response",
        `Starknet provider ${head.id} returned the wrong proving block number`,
      );
    }
    if (block.timestamp > head.block.timestamp || block.hash === head.block.hash) {
      throw new StarknetProvingBlockSelectorError(
        "invalid_response",
        `Starknet provider ${head.id} returned an inconsistent proving-block history`,
      );
    }
    return block;
  }

  async #readAgreedProofValidity(blockHash: string): Promise<bigint> {
    const call: Call = {
      contractAddress: this.#poolContract,
      entrypoint: PROOF_VALIDITY_ENTRYPOINT,
      calldata: [],
    };
    const values = await Promise.all(
      this.#providers.map(async ({ id, provider }) => {
        let response: readonly string[];
        try {
          response = await withTimeout(
            provider.callContract(call, blockHash),
            this.#requestTimeoutMilliseconds,
          );
        } catch {
          throw providerFailure(id, "read the pool proof-validity window");
        }
        if (!Array.isArray(response) || response.length !== 1) {
          throw new StarknetProvingBlockSelectorError(
            "invalid_response",
            `Starknet provider ${id} returned a malformed proof-validity window`,
          );
        }
        const validity = inputUnsignedFelt(response[0], `${id} proof-validity window`);
        if (validity === 0n) {
          throw new StarknetProvingBlockSelectorError(
            "invalid_response",
            `Starknet provider ${id} returned a zero proof-validity window`,
          );
        }
        return validity;
      }),
    );
    const first = values[0];
    if (first === undefined || values.some((value) => value !== first)) {
      throw new StarknetProvingBlockSelectorError(
        "provider_disagreement",
        "Starknet providers disagreed on the pool proof-validity window",
      );
    }
    return first;
  }

  #nowSeconds(): number {
    const value = this.#now();
    const milliseconds = value instanceof Date ? value.getTime() : Number.NaN;
    if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
      throw new StarknetProvingBlockSelectorError(
        "invalid_response",
        "Proving-block selector clock returned an invalid time",
      );
    }
    return Math.floor(milliseconds / 1_000);
  }
}

function validateProviders(
  value: readonly NamedStarknetProvingBlockProvider[],
): readonly NamedStarknetProvingBlockProvider[] {
  if (
    !Array.isArray(value) ||
    value.length < MINIMUM_PROVIDER_COUNT ||
    value.length > MAXIMUM_PROVIDER_COUNT
  ) {
    throw new StarknetProvingBlockSelectorConfigurationError(
      "Between two and sixteen independent Starknet providers are required",
    );
  }
  const ids = new Set<string>();
  const instances = new Set<StarknetProvingBlockRpc>();
  const providers = Array.from(value, (namedProvider) => {
    if (
      typeof namedProvider !== "object" ||
      namedProvider === null ||
      typeof namedProvider.id !== "string" ||
      !PROVIDER_ID_PATTERN.test(namedProvider.id) ||
      typeof namedProvider.provider !== "object" ||
      namedProvider.provider === null ||
      typeof namedProvider.provider.getChainId !== "function" ||
      typeof namedProvider.provider.getBlockWithTxHashes !== "function" ||
      typeof namedProvider.provider.callContract !== "function"
    ) {
      throw new StarknetProvingBlockSelectorConfigurationError(
        "Configured Starknet proving-block provider is invalid",
      );
    }
    if (ids.has(namedProvider.id) || instances.has(namedProvider.provider)) {
      throw new StarknetProvingBlockSelectorConfigurationError(
        "Configured Starknet proving-block providers and IDs must be unique",
      );
    }
    ids.add(namedProvider.id);
    instances.add(namedProvider.provider);
    return { id: namedProvider.id, provider: namedProvider.provider };
  });
  return Object.freeze(providers);
}

function acceptedBlock(
  value: unknown,
  providerId: string,
  now: number,
  maximumBlockAgeSeconds: number,
  maximumFutureBlockTimeSeconds: number,
): AcceptedBlock {
  if (typeof value !== "object" || value === null) {
    throw invalidBlock(providerId);
  }
  const block = value as RpcBlock;
  if (typeof block.status !== "string" || !ACCEPTED_BLOCK_STATUSES.has(block.status)) {
    throw new StarknetProvingBlockSelectorError(
      "finality_not_satisfied",
      `Starknet provider ${providerId} did not return an accepted block`,
    );
  }
  let hash: string;
  let number: bigint;
  let timestamp: number;
  try {
    hash = inputFelt(block.block_hash, `${providerId} block hash`, false);
    number = inputUnsignedInteger(block.block_number, `${providerId} block number`);
    timestamp = inputTimestamp(block.timestamp);
  } catch (error) {
    if (error instanceof StarknetProvingBlockSelectorError) {
      throw invalidBlock(providerId);
    }
    throw error;
  }
  if (timestamp > now + maximumFutureBlockTimeSeconds) {
    throw new StarknetProvingBlockSelectorError(
      "stale_block",
      `Starknet provider ${providerId} returned a block too far in the future`,
    );
  }
  if (timestamp < now - maximumBlockAgeSeconds) {
    throw new StarknetProvingBlockSelectorError(
      "stale_block",
      `Starknet provider ${providerId} returned a stale block`,
    );
  }
  return { hash, number, timestamp };
}

function agreedBlock(blocks: readonly AcceptedBlock[]): AcceptedBlock {
  const first = blocks[0];
  if (first === undefined) {
    throw new StarknetProvingBlockSelectorError(
      "invalid_response",
      "Proving-block selection has no provider responses",
    );
  }
  if (
    blocks.some(
      (block) =>
        block.hash !== first.hash ||
        block.number !== first.number ||
        block.timestamp !== first.timestamp,
    )
  ) {
    throw new StarknetProvingBlockSelectorError(
      "provider_disagreement",
      "Starknet providers did not agree on the selected proving block",
    );
  }
  return first;
}

function inputFelt(value: unknown, label: string, allowZero: boolean): string {
  if (
    typeof value !== "string" ||
    value.length > MAXIMUM_FELT_TEXT_LENGTH ||
    !/^0x[0-9a-fA-F]+$/.test(value)
  ) {
    throw new StarknetProvingBlockSelectorError("invalid_response", `${label} is invalid`);
  }
  const parsed = BigInt(value);
  if ((!allowZero && parsed === 0n) || parsed >= STARK_FIELD_PRIME) {
    throw new StarknetProvingBlockSelectorError("invalid_response", `${label} is invalid`);
  }
  return `0x${parsed.toString(16)}`;
}

function inputUnsignedInteger(value: unknown, label: string): bigint {
  const parsed =
    typeof value === "bigint"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? BigInt(value)
        : typeof value === "string" &&
            value.length <= MAXIMUM_U64_TEXT_LENGTH &&
            /^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(value)
          ? BigInt(value)
          : -1n;
  if (parsed < 0n || parsed > MAXIMUM_U64) {
    throw new StarknetProvingBlockSelectorError("invalid_response", `${label} is invalid`);
  }
  return parsed;
}

function inputUnsignedFelt(value: unknown, label: string): bigint {
  if (
    typeof value !== "string" ||
    value.length > MAXIMUM_FELT_TEXT_LENGTH ||
    !/^0x[0-9a-fA-F]+$/.test(value)
  ) {
    throw new StarknetProvingBlockSelectorError("invalid_response", `${label} is invalid`);
  }
  return inputUnsignedInteger(value, label);
}

function inputTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new StarknetProvingBlockSelectorError(
      "invalid_response",
      "Starknet block timestamp is invalid",
    );
  }
  return value;
}

function configuredAddress(value: unknown, label: string): string {
  try {
    const address = inputFelt(value, label, false);
    if (BigInt(address) >= STARKNET_ADDRESS_BOUND) {
      throw new Error("Address out of range");
    }
    return address;
  } catch {
    throw new StarknetProvingBlockSelectorConfigurationError(`Configured ${label} is invalid`);
  }
}

function configuredPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAXIMUM_CONFIGURED_INTEGER) {
    throw new StarknetProvingBlockSelectorConfigurationError(`Configured ${label} is invalid`);
  }
  return value;
}

function configuredNonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAXIMUM_CONFIGURED_INTEGER) {
    throw new StarknetProvingBlockSelectorConfigurationError(`Configured ${label} is invalid`);
  }
  return value;
}

function minimumBigInt(values: readonly bigint[]): bigint {
  return values.reduce((minimum, value) => (value < minimum ? value : minimum));
}

function maximumBigInt(values: readonly bigint[]): bigint {
  return values.reduce((maximum, value) => (value > maximum ? value : maximum));
}

function providerFailure(providerId: string, operation: string): StarknetProvingBlockSelectorError {
  return new StarknetProvingBlockSelectorError(
    "provider_failure",
    `Starknet provider ${providerId} could not ${operation}`,
  );
}

function invalidBlock(providerId: string): StarknetProvingBlockSelectorError {
  return new StarknetProvingBlockSelectorError(
    "invalid_response",
    `Starknet provider ${providerId} returned a malformed block`,
  );
}

function withTimeout<Value>(
  operation: Promise<Value>,
  timeoutMilliseconds: number,
): Promise<Value> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Starknet proving-block request timed out")),
      timeoutMilliseconds,
    );
    timeout.unref?.();
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

const PROOF_VALIDITY_ENTRYPOINT = "get_proof_validity_blocks";
const SEPOLIA_CHAIN_ID = "0x534e5f5345504f4c4941";
const ACCEPTED_BLOCK_STATUSES = new Set(["ACCEPTED_ON_L1", "ACCEPTED_ON_L2"]);
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MINIMUM_PROVIDER_COUNT = 2;
const MAXIMUM_PROVIDER_COUNT = 16;
const MAXIMUM_CONFIGURED_INTEGER = 1_000_000;
const MAXIMUM_FELT_TEXT_LENGTH = 66;
const MAXIMUM_U64_TEXT_LENGTH = 22;
const MAXIMUM_U64 = (1n << 64n) - 1n;
const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
const STARKNET_ADDRESS_BOUND = (1n << 251n) - 256n;
