import type { StarknetNetwork } from "@cashu-strk20/strk20-method";
import type { BlockIdentifier } from "starknet";

export const STARKNET_DISCOVERY_HEAD_VERIFIER_VERSION =
  "starknet@10.5.0:sepolia-discovery-head-consensus-v1";

export interface StarknetDiscoveryHead {
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly blockTimestamp: number;
}

export interface StarknetDiscoveryHeadRpc {
  getChainId(): Promise<string>;
  getBlockWithTxHashes(blockIdentifier?: BlockIdentifier): Promise<unknown>;
}

export interface NamedStarknetDiscoveryHeadProvider {
  readonly id: string;
  readonly provider: StarknetDiscoveryHeadRpc;
}

export interface StarknetDiscoveryHeadVerifierConfig {
  readonly network: StarknetNetwork;
  readonly providers: readonly NamedStarknetDiscoveryHeadProvider[];
  readonly requestTimeoutMilliseconds: number;
}

export interface StarknetDiscoveryHeadVerification extends StarknetDiscoveryHead {
  readonly minimumAcceptedStatus: "ACCEPTED_ON_L1" | "ACCEPTED_ON_L2";
  readonly providerIds: readonly string[];
  readonly verifierVersion: typeof STARKNET_DISCOVERY_HEAD_VERIFIER_VERSION;
}

export type StarknetDiscoveryHeadVerifierErrorCode =
  | "discovery_mismatch"
  | "finality_not_satisfied"
  | "invalid_response"
  | "provider_disagreement"
  | "provider_failure";

export class StarknetDiscoveryHeadVerifierConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StarknetDiscoveryHeadVerifierConfigurationError";
  }
}

export class StarknetDiscoveryHeadVerifierError extends Error {
  readonly code: StarknetDiscoveryHeadVerifierErrorCode;

  constructor(code: StarknetDiscoveryHeadVerifierErrorCode, message: string) {
    super(message);
    this.name = "StarknetDiscoveryHeadVerifierError";
    this.code = code;
  }
}

interface ProviderObservation {
  readonly acceptedStatus: "ACCEPTED_ON_L1" | "ACCEPTED_ON_L2";
}

interface AcceptedBlock extends StarknetDiscoveryHead, ProviderObservation {}

interface RpcBlock {
  readonly status?: unknown;
  readonly block_hash?: unknown;
  readonly block_number?: unknown;
  readonly timestamp?: unknown;
}

export class StarknetDiscoveryHeadVerifier {
  readonly #providers: readonly NamedStarknetDiscoveryHeadProvider[];
  readonly #requestTimeoutMilliseconds: number;

  readonly verifierVersion = STARKNET_DISCOVERY_HEAD_VERIFIER_VERSION;

  constructor(config: StarknetDiscoveryHeadVerifierConfig) {
    try {
      if (typeof config !== "object" || config === null || config.network !== "SN_SEPOLIA") {
        throw new StarknetDiscoveryHeadVerifierConfigurationError(
          "Only Starknet Sepolia discovery heads can be verified",
        );
      }
      this.#providers = validateProviders(config.providers);
      this.#requestTimeoutMilliseconds = configuredBoundedPositiveInteger(
        config.requestTimeoutMilliseconds,
        MAXIMUM_REQUEST_TIMEOUT_MILLISECONDS,
        "request timeout",
      );
    } catch (error) {
      if (error instanceof StarknetDiscoveryHeadVerifierConfigurationError) {
        throw error;
      }
      throw new StarknetDiscoveryHeadVerifierConfigurationError(
        "Configured Starknet discovery-head verifier is invalid",
      );
    }
  }

  async verify(value: StarknetDiscoveryHead): Promise<StarknetDiscoveryHeadVerification> {
    const head = configuredHead(value);
    const results = await Promise.allSettled(
      this.#providers.map((namedProvider) => this.#readProvider(namedProvider, head)),
    );
    const observations = results.map((result, index) => {
      if (result.status === "fulfilled") {
        return result.value;
      }
      if (result.reason instanceof StarknetDiscoveryHeadVerifierError) {
        throw result.reason;
      }
      throw providerFailure(requiredProvider(this.#providers, index).id);
    });
    const minimumAcceptedStatus = observations.every(
      (observation) => observation.acceptedStatus === "ACCEPTED_ON_L1",
    )
      ? "ACCEPTED_ON_L1"
      : "ACCEPTED_ON_L2";

    return {
      ...head,
      minimumAcceptedStatus,
      providerIds: Object.freeze(this.#providers.map(({ id }) => id)),
      verifierVersion: this.verifierVersion,
    };
  }

  async #readProvider(
    namedProvider: NamedStarknetDiscoveryHeadProvider,
    expected: StarknetDiscoveryHead,
  ): Promise<ProviderObservation> {
    const [chainResult, blockResult] = await Promise.allSettled([
      withTimeout(
        invoke(() => namedProvider.provider.getChainId()),
        this.#requestTimeoutMilliseconds,
      ),
      withTimeout(
        invoke(() => namedProvider.provider.getBlockWithTxHashes(expected.blockNumber)),
        this.#requestTimeoutMilliseconds,
      ),
    ]);
    if (chainResult.status === "rejected" || blockResult.status === "rejected") {
      throw providerFailure(namedProvider.id);
    }
    try {
      if (responseFelt(chainResult.value, namedProvider.id, "chain ID") !== SEPOLIA_CHAIN_ID) {
        throw new StarknetDiscoveryHeadVerifierError(
          "provider_disagreement",
          `Starknet provider ${namedProvider.id} returned the wrong chain ID`,
        );
      }
      const observed = acceptedBlock(blockResult.value, namedProvider.id);
      if (
        observed.blockNumber !== expected.blockNumber ||
        observed.blockHash !== expected.blockHash ||
        observed.blockTimestamp !== expected.blockTimestamp
      ) {
        throw new StarknetDiscoveryHeadVerifierError(
          "discovery_mismatch",
          `Starknet provider ${namedProvider.id} did not confirm the discovery head`,
        );
      }
      return { acceptedStatus: observed.acceptedStatus };
    } catch (error) {
      if (error instanceof StarknetDiscoveryHeadVerifierError) {
        throw error;
      }
      throw invalidResponse(namedProvider.id);
    }
  }
}

function configuredHead(value: StarknetDiscoveryHead): StarknetDiscoveryHead {
  try {
    if (typeof value !== "object" || value === null) {
      throw new Error("invalid head");
    }
    return {
      blockNumber: configuredNonnegativeSafeInteger(value.blockNumber, "discovery block number"),
      blockHash: configuredFelt(value.blockHash, "discovery block hash"),
      blockTimestamp: configuredPositiveSafeInteger(
        value.blockTimestamp,
        "discovery block timestamp",
      ),
    };
  } catch (error) {
    if (error instanceof StarknetDiscoveryHeadVerifierConfigurationError) {
      throw error;
    }
    throw new StarknetDiscoveryHeadVerifierConfigurationError(
      "Configured Starknet discovery head is invalid",
    );
  }
}

function validateProviders(
  value: readonly NamedStarknetDiscoveryHeadProvider[],
): readonly NamedStarknetDiscoveryHeadProvider[] {
  if (
    !Array.isArray(value) ||
    value.length < MINIMUM_PROVIDER_COUNT ||
    value.length > MAXIMUM_PROVIDER_COUNT
  ) {
    throw new StarknetDiscoveryHeadVerifierConfigurationError(
      "Between two and sixteen independent Starknet discovery-head providers are required",
    );
  }
  const ids = new Set<string>();
  const instances = new Set<StarknetDiscoveryHeadRpc>();
  const providers = Array.from(value, (namedProvider) => {
    if (
      typeof namedProvider !== "object" ||
      namedProvider === null ||
      typeof namedProvider.id !== "string" ||
      !PROVIDER_ID_PATTERN.test(namedProvider.id) ||
      typeof namedProvider.provider !== "object" ||
      namedProvider.provider === null ||
      typeof namedProvider.provider.getChainId !== "function" ||
      typeof namedProvider.provider.getBlockWithTxHashes !== "function"
    ) {
      throw new StarknetDiscoveryHeadVerifierConfigurationError(
        "Configured Starknet discovery-head provider is invalid",
      );
    }
    if (ids.has(namedProvider.id) || instances.has(namedProvider.provider)) {
      throw new StarknetDiscoveryHeadVerifierConfigurationError(
        "Configured Starknet discovery-head providers and IDs must be unique",
      );
    }
    ids.add(namedProvider.id);
    instances.add(namedProvider.provider);
    return { id: namedProvider.id, provider: namedProvider.provider };
  });
  return Object.freeze(providers);
}

function acceptedBlock(value: unknown, providerId: string): AcceptedBlock {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidResponse(providerId);
  }
  const block = value as RpcBlock;
  if (block.status !== "ACCEPTED_ON_L1" && block.status !== "ACCEPTED_ON_L2") {
    throw new StarknetDiscoveryHeadVerifierError(
      "finality_not_satisfied",
      `Starknet provider ${providerId} did not return an accepted discovery block`,
    );
  }
  return {
    blockNumber: responseUnsignedInteger(block.block_number, providerId),
    blockHash: responseFelt(block.block_hash, providerId, "block hash"),
    blockTimestamp: responseTimestamp(block.timestamp, providerId),
    acceptedStatus: block.status,
  };
}

function responseFelt(value: unknown, providerId: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length > MAXIMUM_FELT_TEXT_LENGTH ||
    !/^0x[0-9a-fA-F]+$/u.test(value)
  ) {
    throw invalidResponse(providerId, label);
  }
  const parsed = BigInt(value);
  if (parsed === 0n || parsed >= STARK_FIELD_PRIME) {
    throw invalidResponse(providerId, label);
  }
  return `0x${parsed.toString(16)}`;
}

function responseUnsignedInteger(value: unknown, providerId: string): number {
  const parsed =
    typeof value === "number" && Number.isSafeInteger(value)
      ? value
      : typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : typeof value === "string" &&
            value.length <= MAXIMUM_SAFE_INTEGER_TEXT_LENGTH &&
            /^(?:0x[0-9a-fA-F]+|[0-9]+)$/u.test(value)
          ? Number(BigInt(value))
          : -1;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw invalidResponse(providerId, "block number");
  }
  return parsed;
}

function responseTimestamp(value: unknown, providerId: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw invalidResponse(providerId, "block timestamp");
  }
  return value;
}

function configuredFelt(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length > MAXIMUM_FELT_TEXT_LENGTH ||
    !/^0x[0-9a-fA-F]+$/u.test(value)
  ) {
    throw new StarknetDiscoveryHeadVerifierConfigurationError(`Configured ${label} is invalid`);
  }
  const parsed = BigInt(value);
  if (parsed === 0n || parsed >= STARK_FIELD_PRIME) {
    throw new StarknetDiscoveryHeadVerifierConfigurationError(`Configured ${label} is invalid`);
  }
  return `0x${parsed.toString(16)}`;
}

function configuredPositiveSafeInteger(value: unknown, label: string): number {
  const parsed = configuredNonnegativeSafeInteger(value, label);
  if (parsed === 0) {
    throw new StarknetDiscoveryHeadVerifierConfigurationError(`Configured ${label} is invalid`);
  }
  return parsed;
}

function configuredNonnegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new StarknetDiscoveryHeadVerifierConfigurationError(`Configured ${label} is invalid`);
  }
  return value;
}

function configuredBoundedPositiveInteger(value: unknown, maximum: number, label: string): number {
  const parsed = configuredPositiveSafeInteger(value, label);
  if (parsed > maximum) {
    throw new StarknetDiscoveryHeadVerifierConfigurationError(`Configured ${label} is invalid`);
  }
  return parsed;
}

function requiredProvider(
  providers: readonly NamedStarknetDiscoveryHeadProvider[],
  index: number,
): NamedStarknetDiscoveryHeadProvider {
  const provider = providers[index];
  if (provider === undefined) {
    throw new StarknetDiscoveryHeadVerifierError(
      "invalid_response",
      "Discovery-head verification lost a configured provider",
    );
  }
  return provider;
}

function providerFailure(providerId: string): StarknetDiscoveryHeadVerifierError {
  return new StarknetDiscoveryHeadVerifierError(
    "provider_failure",
    `Starknet provider ${providerId} could not verify the discovery head`,
  );
}

function invalidResponse(
  providerId: string,
  label = "discovery block",
): StarknetDiscoveryHeadVerifierError {
  return new StarknetDiscoveryHeadVerifierError(
    "invalid_response",
    `Starknet provider ${providerId} returned an invalid ${label}`,
  );
}

function invoke<Value>(operation: () => Promise<Value>): Promise<Value> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
}

function withTimeout<Value>(
  operation: Promise<Value>,
  timeoutMilliseconds: number,
): Promise<Value> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Starknet discovery-head request timed out")),
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

const SEPOLIA_CHAIN_ID = "0x534e5f5345504f4c4941";
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const MINIMUM_PROVIDER_COUNT = 2;
const MAXIMUM_PROVIDER_COUNT = 16;
const MAXIMUM_REQUEST_TIMEOUT_MILLISECONDS = 60_000;
const MAXIMUM_FELT_TEXT_LENGTH = 66;
const MAXIMUM_SAFE_INTEGER_TEXT_LENGTH = 18;
const STARK_FIELD_PRIME = 2n ** 251n + 17n * 2n ** 192n + 1n;
