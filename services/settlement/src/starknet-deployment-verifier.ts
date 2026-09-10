import type { StarknetNetwork } from "@cashu-strk20/strk20-method";
import type { BlockIdentifier } from "starknet";

import {
  STARKNET_TRANSACTION_FINALITY_POLICIES,
  type StarknetTransactionFinalityPolicy,
} from "./starknet-transaction-observer.js";

export const STARKNET_DEPLOYMENT_VERIFIER_VERSION =
  "starknet@10.5.0:sepolia-class-hash-block-consensus-v1";

export interface StarknetDeploymentRpc {
  getChainId(): Promise<string>;
  getBlockWithTxHashes(blockIdentifier?: BlockIdentifier): Promise<unknown>;
  getClassHashAt(contractAddress: string, blockIdentifier?: BlockIdentifier): Promise<string>;
}

export interface NamedStarknetDeploymentProvider {
  readonly id: string;
  readonly provider: StarknetDeploymentRpc;
}

export interface StarknetDeploymentVerifierConfig {
  readonly network: StarknetNetwork;
  readonly finalityPolicy: StarknetTransactionFinalityPolicy;
  readonly poolContract: string;
  readonly expectedPoolClassHash: string;
  readonly tokenContract: string;
  readonly expectedTokenClassHash: string;
  readonly settlementAccount: string;
  readonly expectedAccountClassHash: string;
  readonly providers: readonly NamedStarknetDeploymentProvider[];
  readonly maximumHeadLagBlocks: number;
  readonly maximumBlockAgeSeconds: number;
  readonly maximumFutureBlockTimeSeconds: number;
  readonly requestTimeoutMilliseconds: number;
  readonly now?: () => Date;
}

export interface StarknetDeploymentVerification {
  readonly blockHash: string;
  readonly blockNumber: bigint;
  readonly blockTimestamp: number;
  readonly poolClassHash: string;
  readonly tokenClassHash: string;
  readonly accountClassHash: string;
  readonly providerIds: readonly string[];
  readonly verifierVersion: typeof STARKNET_DEPLOYMENT_VERIFIER_VERSION;
}

export type StarknetDeploymentVerifierErrorCode =
  | "deployment_mismatch"
  | "finality_not_satisfied"
  | "invalid_response"
  | "provider_disagreement"
  | "provider_failure"
  | "stale_block";

export class StarknetDeploymentVerifierConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StarknetDeploymentVerifierConfigurationError";
  }
}

export class StarknetDeploymentVerifierError extends Error {
  readonly code: StarknetDeploymentVerifierErrorCode;

  constructor(code: StarknetDeploymentVerifierErrorCode, message: string) {
    super(message);
    this.name = "StarknetDeploymentVerifierError";
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
  readonly provider: StarknetDeploymentRpc;
  readonly block: AcceptedBlock;
}

interface DeploymentClasses {
  readonly pool: string;
  readonly token: string;
  readonly account: string;
}

interface RpcBlock {
  readonly status?: unknown;
  readonly block_hash?: unknown;
  readonly block_number?: unknown;
  readonly timestamp?: unknown;
}

export class StarknetDeploymentVerifier {
  readonly #finalityPolicy: StarknetTransactionFinalityPolicy;
  readonly #poolContract: string;
  readonly #expectedPoolClassHash: string;
  readonly #tokenContract: string;
  readonly #expectedTokenClassHash: string;
  readonly #settlementAccount: string;
  readonly #expectedAccountClassHash: string;
  readonly #providers: readonly NamedStarknetDeploymentProvider[];
  readonly #maximumHeadLagBlocks: bigint;
  readonly #maximumBlockAgeSeconds: number;
  readonly #maximumFutureBlockTimeSeconds: number;
  readonly #requestTimeoutMilliseconds: number;
  readonly #now: () => Date;

  readonly verifierVersion = STARKNET_DEPLOYMENT_VERIFIER_VERSION;

  constructor(config: StarknetDeploymentVerifierConfig) {
    if (config.network !== "SN_SEPOLIA") {
      throw new StarknetDeploymentVerifierConfigurationError(
        "Only Starknet Sepolia deployment verification is enabled",
      );
    }
    if (
      config.finalityPolicy !== STARKNET_TRANSACTION_FINALITY_POLICIES.L1 &&
      config.finalityPolicy !== STARKNET_TRANSACTION_FINALITY_POLICIES.L2
    ) {
      throw new StarknetDeploymentVerifierConfigurationError(
        "Configured deployment finality policy is invalid",
      );
    }
    this.#finalityPolicy = config.finalityPolicy;
    this.#poolContract = configuredAddress(config.poolContract, "privacy pool");
    this.#expectedPoolClassHash = configuredFelt(
      config.expectedPoolClassHash,
      "privacy pool class hash",
    );
    this.#tokenContract = configuredAddress(config.tokenContract, "token");
    this.#expectedTokenClassHash = configuredFelt(
      config.expectedTokenClassHash,
      "token class hash",
    );
    this.#settlementAccount = configuredAddress(config.settlementAccount, "settlement account");
    if (new Set([this.#poolContract, this.#tokenContract, this.#settlementAccount]).size !== 3) {
      throw new StarknetDeploymentVerifierConfigurationError(
        "Configured deployment addresses must be distinct",
      );
    }
    this.#expectedAccountClassHash = configuredFelt(
      config.expectedAccountClassHash,
      "settlement account class hash",
    );
    this.#providers = validateProviders(config.providers);
    this.#maximumHeadLagBlocks = BigInt(
      configuredNonnegativeInteger(config.maximumHeadLagBlocks, "maximum provider head lag"),
    );
    this.#maximumBlockAgeSeconds = configuredPositiveInteger(
      config.maximumBlockAgeSeconds,
      "maximum block age",
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

  async verify(): Promise<StarknetDeploymentVerification> {
    const now = this.#nowSeconds();
    const headIdentifier =
      this.#finalityPolicy === STARKNET_TRANSACTION_FINALITY_POLICIES.L1 ? "l1_accepted" : "latest";
    const heads = await Promise.all(
      this.#providers.map((provider) => this.#readHead(provider, headIdentifier, now)),
    );
    const headNumbers = heads.map(({ block }) => block.number);
    const minimumHead = minimumBigInt(headNumbers);
    const maximumHead = maximumBigInt(headNumbers);
    if (maximumHead - minimumHead > this.#maximumHeadLagBlocks) {
      throw new StarknetDeploymentVerifierError(
        "provider_disagreement",
        "Starknet deployment providers exceed the configured head-lag policy",
      );
    }

    const blocks = await Promise.all(
      heads.map((head) => this.#readTargetBlock(head, minimumHead, now)),
    );
    const block = agreedBlock(blocks);
    const deployments = await Promise.all(
      heads.map((head) => this.#readDeploymentClasses(head, block.hash)),
    );
    const deployment = agreedDeployment(deployments);
    if (
      deployment.pool !== this.#expectedPoolClassHash ||
      deployment.token !== this.#expectedTokenClassHash ||
      deployment.account !== this.#expectedAccountClassHash
    ) {
      throw new StarknetDeploymentVerifierError(
        "deployment_mismatch",
        "The observed contract classes do not match the configured deployment pins",
      );
    }

    return {
      blockHash: block.hash,
      blockNumber: block.number,
      blockTimestamp: block.timestamp,
      poolClassHash: deployment.pool,
      tokenClassHash: deployment.token,
      accountClassHash: deployment.account,
      providerIds: Object.freeze(this.#providers.map(({ id }) => id)),
      verifierVersion: this.verifierVersion,
    };
  }

  async #readHead(
    namedProvider: NamedStarknetDeploymentProvider,
    blockIdentifier: "l1_accepted" | "latest",
    now: number,
  ): Promise<ProviderHead> {
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
      throw providerFailure(namedProvider.id, "read its accepted deployment head");
    }
    if (responseFelt(chainId, namedProvider.id, "chain ID") !== STARKNET_SEPOLIA_CHAIN_ID) {
      throw new StarknetDeploymentVerifierError(
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
        this.#finalityPolicy,
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
      throw providerFailure(head.id, "read the agreed deployment block");
    }
    const block = acceptedBlock(
      value,
      head.id,
      this.#finalityPolicy,
      now,
      this.#maximumBlockAgeSeconds,
      this.#maximumFutureBlockTimeSeconds,
    );
    if (
      block.number !== targetNumber ||
      block.timestamp > head.block.timestamp ||
      (block.number === head.block.number && block.hash !== head.block.hash)
    ) {
      throw new StarknetDeploymentVerifierError(
        "invalid_response",
        `Starknet provider ${head.id} returned an inconsistent deployment block`,
      );
    }
    return block;
  }

  async #readDeploymentClasses(head: ProviderHead, blockHash: string): Promise<DeploymentClasses> {
    let values: readonly [string, string, string];
    try {
      values = await withTimeout(
        Promise.all([
          head.provider.getClassHashAt(this.#poolContract, blockHash),
          head.provider.getClassHashAt(this.#tokenContract, blockHash),
          head.provider.getClassHashAt(this.#settlementAccount, blockHash),
        ]),
        this.#requestTimeoutMilliseconds,
      );
    } catch {
      throw providerFailure(head.id, "read the deployed contract classes");
    }
    return {
      pool: responseFelt(values[0], head.id, "privacy pool class hash"),
      token: responseFelt(values[1], head.id, "token class hash"),
      account: responseFelt(values[2], head.id, "settlement account class hash"),
    };
  }

  #nowSeconds(): number {
    const value = this.#now();
    const milliseconds = value instanceof Date ? value.getTime() : Number.NaN;
    if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
      throw new StarknetDeploymentVerifierError(
        "invalid_response",
        "Deployment verifier clock returned an invalid time",
      );
    }
    return Math.floor(milliseconds / 1_000);
  }
}

function validateProviders(
  value: readonly NamedStarknetDeploymentProvider[],
): readonly NamedStarknetDeploymentProvider[] {
  if (
    !Array.isArray(value) ||
    value.length < MINIMUM_PROVIDER_COUNT ||
    value.length > MAXIMUM_PROVIDER_COUNT
  ) {
    throw new StarknetDeploymentVerifierConfigurationError(
      "Between two and sixteen independent Starknet deployment providers are required",
    );
  }
  const ids = new Set<string>();
  const instances = new Set<StarknetDeploymentRpc>();
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
      typeof namedProvider.provider.getClassHashAt !== "function"
    ) {
      throw new StarknetDeploymentVerifierConfigurationError(
        "Configured Starknet deployment provider is invalid",
      );
    }
    if (ids.has(namedProvider.id) || instances.has(namedProvider.provider)) {
      throw new StarknetDeploymentVerifierConfigurationError(
        "Configured Starknet deployment providers and IDs must be unique",
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
  finalityPolicy: StarknetTransactionFinalityPolicy,
  now: number,
  maximumBlockAgeSeconds: number,
  maximumFutureBlockTimeSeconds: number,
): AcceptedBlock {
  if (typeof value !== "object" || value === null) {
    throw invalidBlock(providerId);
  }
  const block = value as RpcBlock;
  if (typeof block.status !== "string" || !satisfiesFinality(block.status, finalityPolicy)) {
    throw new StarknetDeploymentVerifierError(
      "finality_not_satisfied",
      `Starknet provider ${providerId} did not return a policy-accepted block`,
    );
  }
  let hash: string;
  let number: bigint;
  let timestamp: number;
  try {
    hash = responseFelt(block.block_hash, providerId, "block hash");
    number = responseUnsignedInteger(block.block_number);
    timestamp = responseTimestamp(block.timestamp);
  } catch (error) {
    if (error instanceof StarknetDeploymentVerifierError) {
      throw invalidBlock(providerId);
    }
    throw error;
  }
  if (timestamp > now + maximumFutureBlockTimeSeconds) {
    throw new StarknetDeploymentVerifierError(
      "stale_block",
      `Starknet provider ${providerId} returned a block too far in the future`,
    );
  }
  if (timestamp < now - maximumBlockAgeSeconds) {
    throw new StarknetDeploymentVerifierError(
      "stale_block",
      `Starknet provider ${providerId} returned a stale block`,
    );
  }
  return { hash, number, timestamp };
}

function agreedBlock(blocks: readonly AcceptedBlock[]): AcceptedBlock {
  const first = blocks[0];
  if (first === undefined) {
    throw new StarknetDeploymentVerifierError(
      "invalid_response",
      "Deployment verification has no provider block responses",
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
    throw new StarknetDeploymentVerifierError(
      "provider_disagreement",
      "Starknet providers did not agree on the deployment block",
    );
  }
  return first;
}

function agreedDeployment(deployments: readonly DeploymentClasses[]): DeploymentClasses {
  const first = deployments[0];
  if (first === undefined) {
    throw new StarknetDeploymentVerifierError(
      "invalid_response",
      "Deployment verification has no class-hash responses",
    );
  }
  if (
    deployments.some(
      (deployment) =>
        deployment.pool !== first.pool ||
        deployment.token !== first.token ||
        deployment.account !== first.account,
    )
  ) {
    throw new StarknetDeploymentVerifierError(
      "provider_disagreement",
      "Starknet providers did not agree on the deployed contract classes",
    );
  }
  return first;
}

function satisfiesFinality(status: string, policy: StarknetTransactionFinalityPolicy): boolean {
  return (
    status === "ACCEPTED_ON_L1" ||
    (policy === STARKNET_TRANSACTION_FINALITY_POLICIES.L2 && status === "ACCEPTED_ON_L2")
  );
}

function responseFelt(value: unknown, providerId: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length > MAXIMUM_FELT_TEXT_LENGTH ||
    !/^0x[0-9a-fA-F]+$/.test(value)
  ) {
    throw new StarknetDeploymentVerifierError(
      "invalid_response",
      `Starknet provider ${providerId} returned an invalid ${label}`,
    );
  }
  const parsed = BigInt(value);
  if (parsed === 0n || parsed >= STARK_FIELD_PRIME) {
    throw new StarknetDeploymentVerifierError(
      "invalid_response",
      `Starknet provider ${providerId} returned an invalid ${label}`,
    );
  }
  return `0x${parsed.toString(16)}`;
}

function responseUnsignedInteger(value: unknown): bigint {
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
    throw new StarknetDeploymentVerifierError(
      "invalid_response",
      "Starknet provider returned an invalid block number",
    );
  }
  return parsed;
}

function responseTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new StarknetDeploymentVerifierError(
      "invalid_response",
      "Starknet provider returned an invalid block timestamp",
    );
  }
  return value;
}

function configuredAddress(value: unknown, label: string): string {
  const felt = configuredFelt(value, label);
  if (BigInt(felt) >= STARKNET_ADDRESS_BOUND) {
    throw new StarknetDeploymentVerifierConfigurationError(`Configured ${label} is invalid`);
  }
  return felt;
}

function configuredFelt(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length > MAXIMUM_FELT_TEXT_LENGTH ||
    !/^0x[0-9a-fA-F]+$/.test(value)
  ) {
    throw new StarknetDeploymentVerifierConfigurationError(`Configured ${label} is invalid`);
  }
  const parsed = BigInt(value);
  if (parsed === 0n || parsed >= STARK_FIELD_PRIME) {
    throw new StarknetDeploymentVerifierConfigurationError(`Configured ${label} is invalid`);
  }
  return `0x${parsed.toString(16)}`;
}

function configuredPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAXIMUM_CONFIGURED_INTEGER) {
    throw new StarknetDeploymentVerifierConfigurationError(`Configured ${label} is invalid`);
  }
  return value;
}

function configuredNonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAXIMUM_CONFIGURED_INTEGER) {
    throw new StarknetDeploymentVerifierConfigurationError(`Configured ${label} is invalid`);
  }
  return value;
}

function minimumBigInt(values: readonly bigint[]): bigint {
  return values.reduce((minimum, value) => (value < minimum ? value : minimum));
}

function maximumBigInt(values: readonly bigint[]): bigint {
  return values.reduce((maximum, value) => (value > maximum ? value : maximum));
}

function providerFailure(providerId: string, operation: string): StarknetDeploymentVerifierError {
  return new StarknetDeploymentVerifierError(
    "provider_failure",
    `Starknet provider ${providerId} could not ${operation}`,
  );
}

function invalidBlock(providerId: string): StarknetDeploymentVerifierError {
  return new StarknetDeploymentVerifierError(
    "invalid_response",
    `Starknet provider ${providerId} returned a malformed deployment block`,
  );
}

function withTimeout<Value>(
  operation: Promise<Value>,
  timeoutMilliseconds: number,
): Promise<Value> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Starknet deployment request timed out")),
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

const STARKNET_SEPOLIA_CHAIN_ID = "0x534e5f5345504f4c4941";
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MINIMUM_PROVIDER_COUNT = 2;
const MAXIMUM_PROVIDER_COUNT = 16;
const MAXIMUM_CONFIGURED_INTEGER = 1_000_000;
const MAXIMUM_FELT_TEXT_LENGTH = 66;
const MAXIMUM_U64_TEXT_LENGTH = 22;
const MAXIMUM_U64 = (1n << 64n) - 1n;
const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
const STARKNET_ADDRESS_BOUND = (1n << 251n) - 256n;
