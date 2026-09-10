import type { StarknetNetwork } from "@cashu-strk20/strk20-method";
import {
  type BlockIdentifier,
  type Call,
  CallData,
  constants,
  shortString,
  type TypedData,
  typedData,
} from "starknet";

import type {
  PayerBindingSignatureVerification,
  PayerBindingSignatureVerifier,
  PayerBindingTypedData,
} from "./payer-bindings.js";

export type StarknetPayerBindingFinality = "L1" | "L2";

export const STARKNET_PAYER_BINDING_VERIFIER_VERSIONS = {
  L1: "starknet@10.5.0:snip12-funding-v2-rev1:snip6-block-pinned-l1-unanimous-v1",
  L2: "starknet@10.5.0:snip12-funding-v2-rev1:snip6-block-pinned-l2-unanimous-v1",
} as const satisfies Record<StarknetPayerBindingFinality, string>;

export interface StarknetPayerBindingRpc {
  getChainId(): Promise<string>;
  getBlockWithTxHashes(blockIdentifier?: BlockIdentifier): Promise<unknown>;
  callContract(call: Call, blockIdentifier?: BlockIdentifier): Promise<readonly string[]>;
}

export interface NamedStarknetPayerBindingProvider {
  readonly id: string;
  readonly provider: StarknetPayerBindingRpc;
}

export interface StarknetPayerBindingVerifierConfig {
  readonly network: StarknetNetwork;
  readonly finality: StarknetPayerBindingFinality;
  readonly providers: readonly NamedStarknetPayerBindingProvider[];
  readonly maximumBlockAgeSeconds: number;
  readonly maximumFutureBlockTimeSeconds: number;
  readonly requestTimeoutMilliseconds: number;
  readonly now?: () => Date;
}

export type StarknetPayerBindingVerifierErrorCode =
  | "finality_not_satisfied"
  | "invalid_input"
  | "invalid_response"
  | "provider_disagreement"
  | "provider_failure"
  | "stale_block";

export class StarknetPayerBindingVerifierConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StarknetPayerBindingVerifierConfigurationError";
  }
}

export class StarknetPayerBindingVerifierError extends Error {
  readonly code: StarknetPayerBindingVerifierErrorCode;

  constructor(code: StarknetPayerBindingVerifierErrorCode, message: string) {
    super(message);
    this.name = "StarknetPayerBindingVerifierError";
    this.code = code;
  }
}

interface VerificationBlock {
  readonly hash: string;
  readonly number: bigint;
  readonly timestamp: number;
}

interface ProviderSnapshot {
  readonly id: string;
  readonly provider: StarknetPayerBindingRpc;
  readonly block: VerificationBlock;
}

interface RpcVerificationBlock {
  readonly status?: unknown;
  readonly block_hash?: unknown;
  readonly block_number?: unknown;
  readonly timestamp?: unknown;
}

export class StarknetPayerBindingVerifier implements PayerBindingSignatureVerifier {
  readonly #network: "SN_SEPOLIA";
  readonly #finality: StarknetPayerBindingFinality;
  readonly #providers: readonly NamedStarknetPayerBindingProvider[];
  readonly #maximumBlockAgeSeconds: number;
  readonly #maximumFutureBlockTimeSeconds: number;
  readonly #requestTimeoutMilliseconds: number;
  readonly #now: () => Date;

  readonly verifierVersion: string;

  constructor(config: StarknetPayerBindingVerifierConfig) {
    if (config.network !== "SN_SEPOLIA") {
      throw new StarknetPayerBindingVerifierConfigurationError(
        "Only Starknet Sepolia payer binding verification is enabled",
      );
    }
    if (config.finality !== "L1" && config.finality !== "L2") {
      throw new StarknetPayerBindingVerifierConfigurationError(
        "Configured payer binding finality is invalid",
      );
    }
    this.#network = config.network;
    this.#finality = config.finality;
    this.#providers = validateProviders(config.providers);
    this.#maximumBlockAgeSeconds = positiveSafeInteger(
      config.maximumBlockAgeSeconds,
      "maximum block age",
    );
    this.#maximumFutureBlockTimeSeconds = nonnegativeSafeInteger(
      config.maximumFutureBlockTimeSeconds,
      "maximum future block time",
    );
    this.#requestTimeoutMilliseconds = positiveSafeInteger(
      config.requestTimeoutMilliseconds,
      "request timeout",
    );
    this.#now = config.now ?? (() => new Date());
    this.verifierVersion = STARKNET_PAYER_BINDING_VERIFIER_VERSIONS[config.finality];
  }

  async verify(input: {
    readonly network: StarknetNetwork;
    readonly payerAddress: string;
    readonly typedData: PayerBindingTypedData;
    readonly signature: readonly string[];
  }): Promise<PayerBindingSignatureVerification> {
    if (
      input.network !== this.#network ||
      typeof input.typedData !== "object" ||
      input.typedData === null ||
      typeof input.typedData.domain !== "object" ||
      input.typedData.domain === null ||
      input.typedData.domain.chainId !== this.#network
    ) {
      throw new StarknetPayerBindingVerifierError(
        "invalid_input",
        "Payer binding verification has the wrong Starknet network",
      );
    }

    const payerAddress = verifierInputAddress(input.payerAddress, "payer address");
    if (
      typeof input.typedData.message !== "object" ||
      input.typedData.message === null ||
      verifierInputAddress(input.typedData.message.Payer, "typed-data payer") !== payerAddress
    ) {
      throw new StarknetPayerBindingVerifierError(
        "invalid_input",
        "Payer binding typed data names a different payer",
      );
    }
    const signature = verifierSignature(input.signature);
    const messageHash = payerBindingMessageHash(input.typedData, payerAddress);
    const now = this.#nowSeconds();
    const blockIdentifier = this.#finality === "L1" ? "l1_accepted" : "latest";
    const snapshots = await Promise.all(
      this.#providers.map((provider) => this.#readProviderSnapshot(provider, blockIdentifier, now)),
    );
    const block = agreedBlock(snapshots);
    const call: Call = {
      contractAddress: payerAddress,
      entrypoint: SNIP6_SIGNATURE_ENTRYPOINT,
      calldata: CallData.compile({
        hash: BigInt(messageHash).toString(),
        signature,
      }),
    };
    const decisions = await Promise.all(
      snapshots.map((snapshot) => this.#callProvider(snapshot, call, block.hash)),
    );

    if (decisions.every((decision) => decision === false)) {
      return { valid: false };
    }
    if (!decisions.every((decision) => decision === true)) {
      throw new StarknetPayerBindingVerifierError(
        "provider_disagreement",
        "Starknet providers disagreed on the payer signature",
      );
    }
    return {
      valid: true,
      status: "FINAL",
      messageHash,
      blockHash: block.hash,
      blockNumber: block.number,
      verifierVersion: this.verifierVersion,
    };
  }

  async #readProviderSnapshot(
    namedProvider: NamedStarknetPayerBindingProvider,
    blockIdentifier: "l1_accepted" | "latest",
    now: number,
  ): Promise<ProviderSnapshot> {
    let chainId: string;
    let blockValue: unknown;
    try {
      [chainId, blockValue] = await withTimeout(
        Promise.all([
          namedProvider.provider.getChainId(),
          namedProvider.provider.getBlockWithTxHashes(blockIdentifier),
        ]),
        this.#requestTimeoutMilliseconds,
      );
    } catch {
      throw new StarknetPayerBindingVerifierError(
        "provider_failure",
        `Starknet provider ${namedProvider.id} could not read the verification block`,
      );
    }
    if (verifierFelt(chainId, `${namedProvider.id} chain ID`) !== STARKNET_SEPOLIA_CHAIN_ID) {
      throw new StarknetPayerBindingVerifierError(
        "provider_disagreement",
        `Starknet provider ${namedProvider.id} returned the wrong chain ID`,
      );
    }
    return {
      id: namedProvider.id,
      provider: namedProvider.provider,
      block: verificationBlock(
        blockValue,
        namedProvider.id,
        this.#finality,
        now,
        this.#maximumBlockAgeSeconds,
        this.#maximumFutureBlockTimeSeconds,
      ),
    };
  }

  async #callProvider(snapshot: ProviderSnapshot, call: Call, blockHash: string): Promise<boolean> {
    let response: readonly string[];
    try {
      response = await withTimeout(
        snapshot.provider.callContract(call, blockHash),
        this.#requestTimeoutMilliseconds,
      );
    } catch {
      throw new StarknetPayerBindingVerifierError(
        "provider_failure",
        `Starknet provider ${snapshot.id} could not verify the payer signature`,
      );
    }
    if (!Array.isArray(response) || response.length !== 1) {
      throw new StarknetPayerBindingVerifierError(
        "invalid_response",
        `Starknet provider ${snapshot.id} returned a malformed SNIP-6 response`,
      );
    }
    const result = verifierFelt(response[0], `${snapshot.id} SNIP-6 response`);
    if (result === SNIP6_VALID_RESPONSE || result === LEGACY_VALID_RESPONSE) {
      return true;
    }
    if (result === INVALID_RESPONSE) {
      return false;
    }
    throw new StarknetPayerBindingVerifierError(
      "invalid_response",
      `Starknet provider ${snapshot.id} returned an unknown SNIP-6 response`,
    );
  }

  #nowSeconds(): number {
    const now = this.#now();
    const milliseconds = now instanceof Date ? now.getTime() : Number.NaN;
    if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
      throw new StarknetPayerBindingVerifierError(
        "invalid_input",
        "Payer binding verifier clock returned an invalid time",
      );
    }
    return Math.floor(milliseconds / 1_000);
  }
}

function validateProviders(
  value: readonly NamedStarknetPayerBindingProvider[],
): readonly NamedStarknetPayerBindingProvider[] {
  if (
    !Array.isArray(value) ||
    value.length < MINIMUM_PROVIDER_COUNT ||
    value.length > MAXIMUM_PROVIDER_COUNT
  ) {
    throw new StarknetPayerBindingVerifierConfigurationError(
      "Between two and sixteen independent Starknet providers are required",
    );
  }
  const providerIds = new Set<string>();
  const providerInstances = new Set<StarknetPayerBindingRpc>();
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
      throw new StarknetPayerBindingVerifierConfigurationError(
        "Configured Starknet provider is invalid",
      );
    }
    if (providerIds.has(namedProvider.id) || providerInstances.has(namedProvider.provider)) {
      throw new StarknetPayerBindingVerifierConfigurationError(
        "Configured Starknet providers and provider IDs must be unique",
      );
    }
    providerIds.add(namedProvider.id);
    providerInstances.add(namedProvider.provider);
    return { id: namedProvider.id, provider: namedProvider.provider };
  });
  return Object.freeze(providers);
}

function verificationBlock(
  value: unknown,
  providerId: string,
  finality: StarknetPayerBindingFinality,
  now: number,
  maximumBlockAgeSeconds: number,
  maximumFutureBlockTimeSeconds: number,
): VerificationBlock {
  if (typeof value !== "object" || value === null) {
    throw invalidBlockResponse(providerId);
  }
  const block = value as RpcVerificationBlock;
  const expectedStatuses = finality === "L1" ? L1_FINAL_BLOCK_STATUSES : L2_FINAL_BLOCK_STATUSES;
  if (typeof block.status !== "string" || !expectedStatuses.has(block.status)) {
    throw new StarknetPayerBindingVerifierError(
      "finality_not_satisfied",
      `Starknet provider ${providerId} did not return a ${finality}-final block`,
    );
  }

  let hash: string;
  let number: bigint;
  let timestamp: number;
  try {
    hash = verifierNonzeroFelt(block.block_hash, `${providerId} block hash`);
    number = unsignedBlockNumber(block.block_number);
    timestamp = unixTimestamp(block.timestamp);
  } catch {
    throw invalidBlockResponse(providerId);
  }
  if (timestamp > now + maximumFutureBlockTimeSeconds) {
    throw new StarknetPayerBindingVerifierError(
      "stale_block",
      `Starknet provider ${providerId} returned a block too far in the future`,
    );
  }
  if (timestamp < now - maximumBlockAgeSeconds) {
    throw new StarknetPayerBindingVerifierError(
      "stale_block",
      `Starknet provider ${providerId} returned a stale verification block`,
    );
  }
  return { hash, number, timestamp };
}

function agreedBlock(snapshots: readonly ProviderSnapshot[]): VerificationBlock {
  const first = snapshots[0];
  if (first === undefined) {
    throw new StarknetPayerBindingVerifierError(
      "invalid_response",
      "Payer binding verification has no provider snapshots",
    );
  }
  if (
    snapshots.some(
      ({ block }) =>
        block.hash !== first.block.hash ||
        block.number !== first.block.number ||
        block.timestamp !== first.block.timestamp,
    )
  ) {
    throw new StarknetPayerBindingVerifierError(
      "provider_disagreement",
      "Starknet providers did not agree on one verification block",
    );
  }
  return first.block;
}

function payerBindingMessageHash(value: PayerBindingTypedData, payerAddress: string): string {
  let hash: string;
  try {
    hash = typedData.getMessageHash(toStarknetTypedData(value), payerAddress);
  } catch {
    throw new StarknetPayerBindingVerifierError(
      "invalid_input",
      "Payer binding typed data could not be hashed",
    );
  }
  return verifierFelt(hash, "payer binding message hash");
}

function toStarknetTypedData(value: PayerBindingTypedData): TypedData {
  return {
    types: Object.fromEntries(
      Object.entries(value.types).map(([name, fields]) => [
        name,
        Array.from(fields, (field) => ({ name: field.name, type: field.type })),
      ]),
    ),
    primaryType: value.primaryType,
    domain: { ...value.domain },
    message: { ...value.message },
  };
}

function verifierSignature(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SIGNATURE_FELTS) {
    throw new StarknetPayerBindingVerifierError("invalid_input", "Payer signature is malformed");
  }
  try {
    return Array.from(value, (felt) => inputFelt(felt, "signature felt"));
  } catch {
    throw new StarknetPayerBindingVerifierError("invalid_input", "Payer signature is malformed");
  }
}

function verifierInputAddress(value: unknown, label: string): string {
  let address: bigint;
  try {
    address = parseHex(value);
  } catch {
    throw new StarknetPayerBindingVerifierError(
      "invalid_input",
      `Payer binding ${label} is invalid`,
    );
  }
  if (address === 0n || address >= STARKNET_ADDRESS_BOUND) {
    throw new StarknetPayerBindingVerifierError(
      "invalid_input",
      `Payer binding ${label} is invalid`,
    );
  }
  return `0x${address.toString(16)}`;
}

function verifierNonzeroFelt(value: unknown, label: string): string {
  const felt = parseVerifierHex(value, label);
  if (felt === 0n || felt >= STARK_FIELD_PRIME) {
    throw new StarknetPayerBindingVerifierError("invalid_response", `${label} is invalid`);
  }
  return `0x${felt.toString(16)}`;
}

function verifierFelt(value: unknown, label: string): string {
  const felt = parseVerifierHex(value, label);
  if (felt >= STARK_FIELD_PRIME) {
    throw new StarknetPayerBindingVerifierError("invalid_response", `${label} is invalid`);
  }
  return `0x${felt.toString(16)}`;
}

function inputFelt(value: unknown, label: string): string {
  const felt = parseHex(value);
  if (felt >= STARK_FIELD_PRIME) {
    throw new StarknetPayerBindingVerifierError("invalid_input", `${label} is invalid`);
  }
  return `0x${felt.toString(16)}`;
}

function parseVerifierHex(value: unknown, label: string): bigint {
  try {
    return parseHex(value);
  } catch {
    throw new StarknetPayerBindingVerifierError("invalid_response", `${label} is invalid`);
  }
}

function parseHex(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    value.length > MAX_FELT_TEXT_LENGTH ||
    !/^0x[0-9a-fA-F]+$/.test(value)
  ) {
    throw new Error("Value is not a hexadecimal felt");
  }
  return BigInt(value);
}

function unsignedBlockNumber(value: unknown): bigint {
  const blockNumber =
    typeof value === "bigint"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? BigInt(value)
        : -1n;
  if (blockNumber < 0n || blockNumber > MAX_BLOCK_NUMBER) {
    throw new Error("Block number is invalid");
  }
  return blockNumber;
}

function unixTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Block timestamp is invalid");
  }
  return value;
}

function invalidBlockResponse(providerId: string): StarknetPayerBindingVerifierError {
  return new StarknetPayerBindingVerifierError(
    "invalid_response",
    `Starknet provider ${providerId} returned a malformed verification block`,
  );
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new StarknetPayerBindingVerifierConfigurationError(`Configured ${label} is invalid`);
  }
  return value;
}

function nonnegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StarknetPayerBindingVerifierConfigurationError(`Configured ${label} is invalid`);
  }
  return value;
}

function withTimeout<T>(promise: Promise<T>, timeoutMilliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Starknet provider request timed out")),
      timeoutMilliseconds,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const MINIMUM_PROVIDER_COUNT = 2;
const MAXIMUM_PROVIDER_COUNT = 16;
const MAX_SIGNATURE_FELTS = 256;
const MAX_FELT_TEXT_LENGTH = 66;
const MAX_BLOCK_NUMBER = (1n << 64n) - 1n;
const STARKNET_ADDRESS_BOUND = (1n << 251n) - 256n;
const STARK_FIELD_PRIME = (1n << 251n) + (17n << 192n) + 1n;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SNIP6_SIGNATURE_ENTRYPOINT = "is_valid_signature";
const INVALID_RESPONSE = "0x0";
const LEGACY_VALID_RESPONSE = "0x1";
const SNIP6_VALID_RESPONSE = `0x${BigInt(shortString.encodeShortString("VALID")).toString(16)}`;
const STARKNET_SEPOLIA_CHAIN_ID = `0x${BigInt(constants.StarknetChainId.SN_SEPOLIA).toString(16)}`;
const L1_FINAL_BLOCK_STATUSES = new Set(["ACCEPTED_ON_L1"]);
const L2_FINAL_BLOCK_STATUSES = new Set(["ACCEPTED_ON_L1", "ACCEPTED_ON_L2"]);
