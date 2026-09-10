import type { StarknetNetwork } from "@cashu-strk20/strk20-method";
import { type BlockIdentifier, constants, ec, hash } from "starknet";

import {
  STARKNET_TRANSACTION_FINALITY_POLICIES,
  type StarknetTransactionFinalityPolicy,
} from "./starknet-transaction-observer.js";
import type { TestnetDeploymentContractRole } from "./testnet-deployment-manifest.js";

export const STARKNET_DEPLOYMENT_ORIGIN_VERIFIER_VERSION =
  "starknet@10.5.0:udc-receipt-address-consensus-v1";
export const STARKNET_UDC_ADDRESS =
  "0x2ceed65a4bd731034c01113685c831b01c15d7d432f71afb1cf1634b53a2125";
export const STARKNET_UDC_CLASS_HASH =
  "0x1b2df6d8861670d4a8ca4670433b2418d78169c2947f46dc614e69f333745c8";
export const STARKNET_UDC_CONTRACT_DEPLOYED_SELECTOR =
  "0x26b160f10156dea0639bec90696772c640b9706a47f5b8c52ea1abe5858b34d";

export interface StarknetDeploymentOriginClaim {
  readonly role: TestnetDeploymentContractRole;
  readonly address: string;
  readonly classHash: string;
  readonly deployment: {
    readonly transactionReference: string;
    readonly acceptedBlockHash: string;
    readonly acceptedBlockNumber: string;
    readonly deployer: string;
    readonly salt: string;
    readonly unique: boolean;
    readonly constructorCalldata: readonly string[];
  };
}

export interface StarknetUdcDeploymentAddressInput {
  readonly classHash: string;
  readonly deployer: string;
  readonly salt: string;
  readonly unique: boolean;
  readonly constructorCalldata: readonly string[];
}

export interface StarknetDeploymentOriginRpc {
  getChainId(): Promise<string>;
  getTransactionReceipt(transactionHash: string): Promise<unknown>;
  getBlockWithTxHashes(blockIdentifier?: BlockIdentifier): Promise<unknown>;
  getClassHashAt(contractAddress: string, blockIdentifier?: BlockIdentifier): Promise<string>;
}

export interface NamedStarknetDeploymentOriginProvider {
  readonly id: string;
  readonly provider: StarknetDeploymentOriginRpc;
}

export interface StarknetDeploymentOriginVerifierConfig {
  readonly network: StarknetNetwork;
  readonly finalityPolicy: StarknetTransactionFinalityPolicy;
  readonly contracts: readonly StarknetDeploymentOriginClaim[];
  readonly providers: readonly NamedStarknetDeploymentOriginProvider[];
  readonly requestTimeoutMilliseconds: number;
}

export interface StarknetDeploymentOriginContractVerification {
  readonly role: TestnetDeploymentContractRole;
  readonly address: string;
  readonly classHash: string;
  readonly transactionReference: string;
  readonly blockHash: string;
  readonly blockNumber: bigint;
  readonly deployer: string;
  readonly salt: string;
  readonly unique: boolean;
  readonly constructorCalldata: readonly string[];
}

export interface StarknetDeploymentOriginVerification {
  readonly network: "SN_SEPOLIA";
  readonly finalityPolicy: StarknetTransactionFinalityPolicy;
  readonly udcAddress: typeof STARKNET_UDC_ADDRESS;
  readonly udcClassHash: typeof STARKNET_UDC_CLASS_HASH;
  readonly deploymentEventSelector: typeof STARKNET_UDC_CONTRACT_DEPLOYED_SELECTOR;
  readonly contracts: readonly [
    StarknetDeploymentOriginContractVerification & { readonly role: "privacy_pool" },
    StarknetDeploymentOriginContractVerification & { readonly role: "usdc_token" },
  ];
  readonly providerIds: readonly string[];
  readonly verifierVersion: typeof STARKNET_DEPLOYMENT_ORIGIN_VERIFIER_VERSION;
}

export interface StarknetUdcDeploymentOriginVerifierConfig {
  readonly network: StarknetNetwork;
  readonly finalityPolicy: StarknetTransactionFinalityPolicy;
  readonly contract: StarknetDeploymentOriginClaim;
  readonly providers: readonly NamedStarknetDeploymentOriginProvider[];
  readonly requestTimeoutMilliseconds: number;
}

export interface StarknetUdcDeploymentOriginVerification {
  readonly network: "SN_SEPOLIA";
  readonly finalityPolicy: StarknetTransactionFinalityPolicy;
  readonly udcAddress: typeof STARKNET_UDC_ADDRESS;
  readonly udcClassHash: typeof STARKNET_UDC_CLASS_HASH;
  readonly deploymentEventSelector: typeof STARKNET_UDC_CONTRACT_DEPLOYED_SELECTOR;
  readonly contract: StarknetDeploymentOriginContractVerification;
  readonly providerIds: readonly string[];
  readonly verifierVersion: typeof STARKNET_DEPLOYMENT_ORIGIN_VERIFIER_VERSION;
}

export type StarknetDeploymentOriginVerifierErrorCode =
  | "deployment_mismatch"
  | "finality_not_satisfied"
  | "invalid_response"
  | "provider_disagreement"
  | "provider_failure";

export class StarknetDeploymentOriginVerifierConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StarknetDeploymentOriginVerifierConfigurationError";
  }
}

export class StarknetDeploymentOriginVerifierError extends Error {
  readonly code: StarknetDeploymentOriginVerifierErrorCode;

  constructor(code: StarknetDeploymentOriginVerifierErrorCode, message: string) {
    super(message);
    this.name = "StarknetDeploymentOriginVerifierError";
    this.code = code;
  }
}

interface ValidatedClaim<
  Role extends TestnetDeploymentContractRole = TestnetDeploymentContractRole,
> {
  readonly role: Role;
  readonly address: string;
  readonly classHash: string;
  readonly deployment: {
    readonly transactionReference: string;
    readonly acceptedBlockHash: string;
    readonly acceptedBlockNumber: string;
    readonly deployer: string;
    readonly salt: string;
    readonly unique: boolean;
    readonly constructorCalldata: readonly string[];
  };
}

interface ProviderObservation {
  readonly providerId: string;
  readonly transactionHash: string;
  readonly receiptBlockHash: string;
  readonly receiptBlockNumber: bigint;
  readonly receiptFinality: "ACCEPTED_ON_L1" | "ACCEPTED_ON_L2";
  readonly execution: "REVERTED" | "SUCCEEDED";
  readonly matchingDeploymentEvents: number;
  readonly blockHash: string;
  readonly blockNumber: bigint;
  readonly blockFinality: "ACCEPTED_ON_L1" | "ACCEPTED_ON_L2";
  readonly transactionIncluded: boolean;
  readonly classHash: string;
  readonly udcClassHash: string;
}

export class StarknetDeploymentOriginVerifier {
  readonly #network: "SN_SEPOLIA";
  readonly #finalityPolicy: StarknetTransactionFinalityPolicy;
  readonly #contracts: readonly [ValidatedClaim<"privacy_pool">, ValidatedClaim<"usdc_token">];
  readonly #providers: readonly NamedStarknetDeploymentOriginProvider[];
  readonly #requestTimeoutMilliseconds: number;

  readonly verifierVersion = STARKNET_DEPLOYMENT_ORIGIN_VERIFIER_VERSION;

  constructor(config: StarknetDeploymentOriginVerifierConfig) {
    if (config.network !== "SN_SEPOLIA") {
      throw new StarknetDeploymentOriginVerifierConfigurationError(
        "Only Starknet Sepolia deployment-origin verification is enabled",
      );
    }
    if (
      config.finalityPolicy !== STARKNET_TRANSACTION_FINALITY_POLICIES.L1 &&
      config.finalityPolicy !== STARKNET_TRANSACTION_FINALITY_POLICIES.L2
    ) {
      throw new StarknetDeploymentOriginVerifierConfigurationError(
        "Configured deployment-origin finality policy is invalid",
      );
    }
    this.#network = config.network;
    this.#finalityPolicy = config.finalityPolicy;
    this.#contracts = validatedClaims(config.contracts);
    this.#providers = validatedProviders(config.providers);
    this.#requestTimeoutMilliseconds = configuredPositiveInteger(
      config.requestTimeoutMilliseconds,
      "request timeout",
    );
  }

  async verify(): Promise<StarknetDeploymentOriginVerification> {
    for (const contract of this.#contracts) {
      if (calculateStarknetUdcDeploymentAddress(contract) !== contract.address) {
        throw new StarknetDeploymentOriginVerifierError(
          "deployment_mismatch",
          `The ${contract.role} address does not match its declared UDC deployment inputs`,
        );
      }
    }

    await Promise.all(
      this.#providers.map((provider) =>
        verifyProviderChain(provider, this.#requestTimeoutMilliseconds),
      ),
    );
    const verifyContract = async <Role extends TestnetDeploymentContractRole>(
      contract: ValidatedClaim<Role>,
    ): Promise<StarknetDeploymentOriginContractVerification & { readonly role: Role }> => {
      const observations = await Promise.all(
        this.#providers.map((provider) =>
          observeDeploymentContract(provider, contract, this.#requestTimeoutMilliseconds),
        ),
      );
      assertProviderAgreement(observations, contract.role);
      assertObservationMatchesClaim(observations, contract, this.#finalityPolicy);
      return verifiedContract(contract);
    };
    const [pool, token] = await Promise.all([
      verifyContract(this.#contracts[0]),
      verifyContract(this.#contracts[1]),
    ]);

    return {
      network: this.#network,
      finalityPolicy: this.#finalityPolicy,
      udcAddress: STARKNET_UDC_ADDRESS,
      udcClassHash: STARKNET_UDC_CLASS_HASH,
      deploymentEventSelector: STARKNET_UDC_CONTRACT_DEPLOYED_SELECTOR,
      contracts: [pool, token],
      providerIds: Object.freeze(this.#providers.map(({ id }) => id)),
      verifierVersion: this.verifierVersion,
    };
  }
}

export class StarknetUdcDeploymentOriginVerifier {
  readonly #network: "SN_SEPOLIA";
  readonly #finalityPolicy: StarknetTransactionFinalityPolicy;
  readonly #contract: ValidatedClaim;
  readonly #providers: readonly NamedStarknetDeploymentOriginProvider[];
  readonly #requestTimeoutMilliseconds: number;

  readonly verifierVersion = STARKNET_DEPLOYMENT_ORIGIN_VERIFIER_VERSION;

  constructor(config: StarknetUdcDeploymentOriginVerifierConfig) {
    if (config.network !== "SN_SEPOLIA") {
      throw new StarknetDeploymentOriginVerifierConfigurationError(
        "Only Starknet Sepolia deployment-origin verification is enabled",
      );
    }
    if (
      config.finalityPolicy !== STARKNET_TRANSACTION_FINALITY_POLICIES.L1 &&
      config.finalityPolicy !== STARKNET_TRANSACTION_FINALITY_POLICIES.L2
    ) {
      throw new StarknetDeploymentOriginVerifierConfigurationError(
        "Configured deployment-origin finality policy is invalid",
      );
    }
    this.#network = config.network;
    this.#finalityPolicy = config.finalityPolicy;
    this.#contract = validatedClaim(config.contract);
    this.#providers = validatedProviders(config.providers);
    this.#requestTimeoutMilliseconds = configuredPositiveInteger(
      config.requestTimeoutMilliseconds,
      "request timeout",
    );
  }

  async verify(): Promise<StarknetUdcDeploymentOriginVerification> {
    if (calculateStarknetUdcDeploymentAddress(this.#contract) !== this.#contract.address) {
      throw new StarknetDeploymentOriginVerifierError(
        "deployment_mismatch",
        `The ${this.#contract.role} address does not match its declared UDC deployment inputs`,
      );
    }

    await Promise.all(
      this.#providers.map((provider) =>
        verifyProviderChain(provider, this.#requestTimeoutMilliseconds),
      ),
    );
    const observations = await Promise.all(
      this.#providers.map((provider) =>
        observeDeploymentContract(provider, this.#contract, this.#requestTimeoutMilliseconds),
      ),
    );
    assertProviderAgreement(observations, this.#contract.role);
    assertObservationMatchesClaim(observations, this.#contract, this.#finalityPolicy);

    return {
      network: this.#network,
      finalityPolicy: this.#finalityPolicy,
      udcAddress: STARKNET_UDC_ADDRESS,
      udcClassHash: STARKNET_UDC_CLASS_HASH,
      deploymentEventSelector: STARKNET_UDC_CONTRACT_DEPLOYED_SELECTOR,
      contract: verifiedContract(this.#contract),
      providerIds: Object.freeze(this.#providers.map(({ id }) => id)),
      verifierVersion: this.verifierVersion,
    };
  }
}

async function verifyProviderChain(
  namedProvider: NamedStarknetDeploymentOriginProvider,
  requestTimeoutMilliseconds: number,
): Promise<void> {
  let chainId: string;
  try {
    chainId = await withTimeout(namedProvider.provider.getChainId(), requestTimeoutMilliseconds);
  } catch {
    throw providerFailure(namedProvider.id, "report its chain ID");
  }
  if (providerNonzeroFelt(chainId, namedProvider.id, "chain ID") !== STARKNET_SEPOLIA_CHAIN_ID) {
    throw new StarknetDeploymentOriginVerifierError(
      "provider_disagreement",
      `Starknet provider ${namedProvider.id} returned the wrong chain ID`,
    );
  }
}

async function observeDeploymentContract(
  namedProvider: NamedStarknetDeploymentOriginProvider,
  contract: ValidatedClaim,
  requestTimeoutMilliseconds: number,
): Promise<ProviderObservation> {
  let receiptValue: unknown;
  let blockValue: unknown;
  let classHashValue: string;
  let udcClassHashValue: string;
  try {
    [receiptValue, blockValue, classHashValue, udcClassHashValue] = await withTimeout(
      Promise.all([
        namedProvider.provider.getTransactionReceipt(contract.deployment.transactionReference),
        namedProvider.provider.getBlockWithTxHashes(contract.deployment.acceptedBlockNumber),
        namedProvider.provider.getClassHashAt(
          contract.address,
          contract.deployment.acceptedBlockHash,
        ),
        namedProvider.provider.getClassHashAt(
          STARKNET_UDC_ADDRESS,
          contract.deployment.acceptedBlockHash,
        ),
      ]),
      requestTimeoutMilliseconds,
    );
  } catch {
    throw providerFailure(namedProvider.id, `read the ${contract.role} deployment`);
  }
  const receipt = providerReceipt(receiptValue, namedProvider.id, contract);
  const block = providerBlock(
    blockValue,
    namedProvider.id,
    contract.deployment.transactionReference,
  );
  return {
    providerId: namedProvider.id,
    ...receipt,
    ...block,
    classHash: providerNonzeroFelt(classHashValue, namedProvider.id, "deployed class hash"),
    udcClassHash: providerNonzeroFelt(udcClassHashValue, namedProvider.id, "UDC class hash"),
  };
}

export function calculateStarknetUdcDeploymentAddress(
  claim: StarknetDeploymentOriginClaim,
): string {
  const contract = validatedClaim(claim);
  return calculateStarknetUdcAddress({
    classHash: contract.classHash,
    deployer: contract.deployment.deployer,
    salt: contract.deployment.salt,
    unique: contract.deployment.unique,
    constructorCalldata: contract.deployment.constructorCalldata,
  });
}

export function calculateStarknetUdcAddress(input: StarknetUdcDeploymentAddressInput): string {
  try {
    if (typeof input !== "object" || input === null || typeof input.unique !== "boolean") {
      throw configurationInvalid("deployment address inputs");
    }
    const classHash = configuredNonzeroFelt(input.classHash, "contract class hash");
    const deployer = configuredAddress(input.deployer, "deployment origin");
    const salt = configuredFelt(input.salt, "deployment salt");
    const constructorCalldata = configuredCalldata(input.constructorCalldata);
    const effectiveSalt = input.unique ? ec.starkCurve.pedersen(deployer, salt) : salt;
    return canonicalAddress(
      hash.calculateContractAddressFromHash(
        effectiveSalt,
        classHash,
        [...constructorCalldata],
        input.unique ? STARKNET_UDC_ADDRESS : 0,
      ),
    );
  } catch (error) {
    if (error instanceof StarknetDeploymentOriginVerifierConfigurationError) {
      throw error;
    }
    throw configurationInvalid("deployment address inputs");
  }
}

function validatedClaims(
  value: readonly StarknetDeploymentOriginClaim[],
): readonly [ValidatedClaim<"privacy_pool">, ValidatedClaim<"usdc_token">] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !Object.hasOwn(value, 0) ||
    !Object.hasOwn(value, 1)
  ) {
    throw configurationInvalid("deployment contracts");
  }
  const pool = validatedClaim(value[0]);
  const token = validatedClaim(value[1]);
  if (
    pool.role !== "privacy_pool" ||
    token.role !== "usdc_token" ||
    pool.address === token.address
  ) {
    throw configurationInvalid("deployment contracts");
  }
  return [
    { ...pool, role: "privacy_pool" },
    { ...token, role: "usdc_token" },
  ];
}

function validatedClaim(value: unknown): ValidatedClaim {
  if (typeof value !== "object" || value === null) {
    throw configurationInvalid("deployment contract");
  }
  const candidate = value as Partial<StarknetDeploymentOriginClaim>;
  if (candidate.role !== "privacy_pool" && candidate.role !== "usdc_token") {
    throw configurationInvalid("deployment contract role");
  }
  if (typeof candidate.deployment !== "object" || candidate.deployment === null) {
    throw configurationInvalid("deployment transaction");
  }
  const deployment = candidate.deployment;
  if (typeof deployment.unique !== "boolean") {
    throw configurationInvalid("deployment uniqueness mode");
  }
  return {
    role: candidate.role,
    address: configuredAddress(candidate.address, "contract address"),
    classHash: configuredNonzeroFelt(candidate.classHash, "contract class hash"),
    deployment: {
      transactionReference: configuredNonzeroFelt(
        deployment.transactionReference,
        "deployment transaction reference",
      ),
      acceptedBlockHash: configuredNonzeroFelt(
        deployment.acceptedBlockHash,
        "deployment block hash",
      ),
      acceptedBlockNumber: configuredBlockNumber(deployment.acceptedBlockNumber),
      deployer: configuredAddress(deployment.deployer, "deployment origin"),
      salt: configuredFelt(deployment.salt, "deployment salt"),
      unique: deployment.unique,
      constructorCalldata: configuredCalldata(deployment.constructorCalldata),
    },
  };
}

function validatedProviders(
  value: readonly NamedStarknetDeploymentOriginProvider[],
): readonly NamedStarknetDeploymentOriginProvider[] {
  if (
    !Array.isArray(value) ||
    value.length < MINIMUM_PROVIDER_COUNT ||
    value.length > MAXIMUM_PROVIDER_COUNT
  ) {
    throw configurationInvalid("deployment-origin providers");
  }
  const ids = new Set<string>();
  const instances = new Set<StarknetDeploymentOriginRpc>();
  return Object.freeze(
    Array.from(value, (namedProvider) => {
      if (
        typeof namedProvider !== "object" ||
        namedProvider === null ||
        typeof namedProvider.id !== "string" ||
        !PROVIDER_ID_PATTERN.test(namedProvider.id) ||
        typeof namedProvider.provider !== "object" ||
        namedProvider.provider === null ||
        typeof namedProvider.provider.getChainId !== "function" ||
        typeof namedProvider.provider.getTransactionReceipt !== "function" ||
        typeof namedProvider.provider.getBlockWithTxHashes !== "function" ||
        typeof namedProvider.provider.getClassHashAt !== "function" ||
        ids.has(namedProvider.id) ||
        instances.has(namedProvider.provider)
      ) {
        throw configurationInvalid("deployment-origin providers");
      }
      ids.add(namedProvider.id);
      instances.add(namedProvider.provider);
      return { id: namedProvider.id, provider: namedProvider.provider };
    }),
  );
}

function providerReceipt(
  value: unknown,
  providerId: string,
  contract: ValidatedClaim,
): Pick<
  ProviderObservation,
  | "execution"
  | "matchingDeploymentEvents"
  | "receiptBlockHash"
  | "receiptBlockNumber"
  | "receiptFinality"
  | "transactionHash"
> {
  if (typeof value !== "object" || value === null) {
    throw invalidResponse(providerId, "transaction receipt");
  }
  const receipt = value as {
    readonly type?: unknown;
    readonly transaction_hash?: unknown;
    readonly block_hash?: unknown;
    readonly block_number?: unknown;
    readonly finality_status?: unknown;
    readonly execution_status?: unknown;
    readonly events?: unknown;
  };
  if (
    receipt.type !== "INVOKE" ||
    (receipt.execution_status !== "SUCCEEDED" && receipt.execution_status !== "REVERTED") ||
    (receipt.finality_status !== "ACCEPTED_ON_L1" && receipt.finality_status !== "ACCEPTED_ON_L2")
  ) {
    throw invalidResponse(providerId, "transaction receipt");
  }
  const events = providerEvents(receipt.events, providerId);
  return {
    transactionHash: providerNonzeroFelt(receipt.transaction_hash, providerId, "transaction hash"),
    receiptBlockHash: providerNonzeroFelt(receipt.block_hash, providerId, "receipt block hash"),
    receiptBlockNumber: providerBlockNumber(
      receipt.block_number,
      providerId,
      "receipt block number",
    ),
    receiptFinality: receipt.finality_status,
    execution: receipt.execution_status,
    matchingDeploymentEvents: events.filter((event) => deploymentEventMatches(event, contract))
      .length,
  };
}

function providerBlock(
  value: unknown,
  providerId: string,
  transactionReference: string,
): Pick<
  ProviderObservation,
  "blockFinality" | "blockHash" | "blockNumber" | "transactionIncluded"
> {
  if (typeof value !== "object" || value === null) {
    throw invalidResponse(providerId, "deployment block");
  }
  const block = value as {
    readonly status?: unknown;
    readonly block_hash?: unknown;
    readonly block_number?: unknown;
    readonly transactions?: unknown;
  };
  if (
    (block.status !== "ACCEPTED_ON_L1" && block.status !== "ACCEPTED_ON_L2") ||
    !Array.isArray(block.transactions) ||
    block.transactions.length > MAXIMUM_TRANSACTIONS_PER_BLOCK
  ) {
    throw invalidResponse(providerId, "deployment block");
  }
  const transactions = denseArray(block.transactions, MAXIMUM_TRANSACTIONS_PER_BLOCK, () =>
    invalidResponse(providerId, "deployment block"),
  ).map((transaction) => providerNonzeroFelt(transaction, providerId, "block transaction"));
  if (new Set(transactions).size !== transactions.length) {
    throw invalidResponse(providerId, "deployment block");
  }
  return {
    blockHash: providerNonzeroFelt(block.block_hash, providerId, "block hash"),
    blockNumber: providerBlockNumber(block.block_number, providerId, "block number"),
    blockFinality: block.status,
    transactionIncluded: transactions.includes(transactionReference),
  };
}

interface ProviderEvent {
  readonly fromAddress: string;
  readonly keys: readonly string[];
  readonly data: readonly string[];
}

function providerEvents(value: unknown, providerId: string): readonly ProviderEvent[] {
  if (!Array.isArray(value) || value.length > MAXIMUM_EVENTS_PER_RECEIPT) {
    throw invalidResponse(providerId, "transaction receipt");
  }
  return denseArray(value, MAXIMUM_EVENTS_PER_RECEIPT, () =>
    invalidResponse(providerId, "transaction receipt"),
  ).map((candidate) => {
    if (typeof candidate !== "object" || candidate === null) {
      throw invalidResponse(providerId, "transaction receipt");
    }
    const event = candidate as {
      readonly from_address?: unknown;
      readonly keys?: unknown;
      readonly data?: unknown;
    };
    if (!Array.isArray(event.keys) || !Array.isArray(event.data)) {
      throw invalidResponse(providerId, "transaction receipt");
    }
    return {
      fromAddress: providerAddress(event.from_address, providerId, "event address"),
      keys: denseArray(event.keys, MAXIMUM_EVENT_VALUES, () =>
        invalidResponse(providerId, "transaction receipt"),
      ).map((item) => providerFelt(item, providerId, "event key")),
      data: denseArray(event.data, MAXIMUM_EVENT_VALUES, () =>
        invalidResponse(providerId, "transaction receipt"),
      ).map((item) => providerFelt(item, providerId, "event data")),
    };
  });
}

function deploymentEventMatches(event: ProviderEvent, contract: ValidatedClaim): boolean {
  const expectedData = [
    contract.address,
    contract.deployment.deployer,
    contract.deployment.unique ? "0x1" : "0x0",
    contract.classHash,
    `0x${contract.deployment.constructorCalldata.length.toString(16)}`,
    ...contract.deployment.constructorCalldata,
    contract.deployment.salt,
  ];
  return (
    event.fromAddress === STARKNET_UDC_ADDRESS &&
    event.keys.length === 1 &&
    event.keys[0] === STARKNET_UDC_CONTRACT_DEPLOYED_SELECTOR &&
    event.data.length === expectedData.length &&
    event.data.every((item, index) => item === expectedData[index])
  );
}

function assertProviderAgreement(
  observations: readonly ProviderObservation[],
  role: TestnetDeploymentContractRole,
): void {
  const first = observations[0];
  if (first === undefined) {
    throw new StarknetDeploymentOriginVerifierError(
      "invalid_response",
      `The ${role} deployment has no provider evidence`,
    );
  }
  if (observations.some((observation) => !sameObservation(first, observation))) {
    throw new StarknetDeploymentOriginVerifierError(
      "provider_disagreement",
      `Starknet providers disagreed on the ${role} deployment origin`,
    );
  }
}

function sameObservation(left: ProviderObservation, right: ProviderObservation): boolean {
  return (
    left.transactionHash === right.transactionHash &&
    left.receiptBlockHash === right.receiptBlockHash &&
    left.receiptBlockNumber === right.receiptBlockNumber &&
    left.receiptFinality === right.receiptFinality &&
    left.execution === right.execution &&
    left.matchingDeploymentEvents === right.matchingDeploymentEvents &&
    left.blockHash === right.blockHash &&
    left.blockNumber === right.blockNumber &&
    left.blockFinality === right.blockFinality &&
    left.transactionIncluded === right.transactionIncluded &&
    left.classHash === right.classHash &&
    left.udcClassHash === right.udcClassHash
  );
}

function assertObservationMatchesClaim(
  observations: readonly ProviderObservation[],
  contract: ValidatedClaim,
  finalityPolicy: StarknetTransactionFinalityPolicy,
): void {
  const observation = observations[0];
  if (observation === undefined) {
    throw new StarknetDeploymentOriginVerifierError(
      "invalid_response",
      `The ${contract.role} deployment has no provider evidence`,
    );
  }
  if (
    !satisfiesFinality(observation.receiptFinality, finalityPolicy) ||
    !satisfiesFinality(observation.blockFinality, finalityPolicy)
  ) {
    throw new StarknetDeploymentOriginVerifierError(
      "finality_not_satisfied",
      `The ${contract.role} deployment does not satisfy the configured finality policy`,
    );
  }
  if (
    observation.transactionHash !== contract.deployment.transactionReference ||
    observation.receiptBlockHash !== contract.deployment.acceptedBlockHash ||
    observation.receiptBlockNumber !== BigInt(contract.deployment.acceptedBlockNumber) ||
    observation.execution !== "SUCCEEDED" ||
    observation.matchingDeploymentEvents !== 1 ||
    observation.blockHash !== contract.deployment.acceptedBlockHash ||
    observation.blockNumber !== BigInt(contract.deployment.acceptedBlockNumber) ||
    !observation.transactionIncluded ||
    observation.classHash !== contract.classHash ||
    observation.udcClassHash !== STARKNET_UDC_CLASS_HASH
  ) {
    throw new StarknetDeploymentOriginVerifierError(
      "deployment_mismatch",
      `The ${contract.role} transaction does not prove the declared deployment`,
    );
  }
}

function verifiedContract<Role extends TestnetDeploymentContractRole>(
  contract: ValidatedClaim<Role>,
): StarknetDeploymentOriginContractVerification & { readonly role: Role } {
  return {
    role: contract.role,
    address: contract.address,
    classHash: contract.classHash,
    transactionReference: contract.deployment.transactionReference,
    blockHash: contract.deployment.acceptedBlockHash,
    blockNumber: BigInt(contract.deployment.acceptedBlockNumber),
    deployer: contract.deployment.deployer,
    salt: contract.deployment.salt,
    unique: contract.deployment.unique,
    constructorCalldata: Object.freeze([...contract.deployment.constructorCalldata]),
  };
}

function configuredAddress(value: unknown, label: string): string {
  const address = configuredNonzeroFelt(value, label);
  if (BigInt(address) >= STARKNET_ADDRESS_BOUND) {
    throw configurationInvalid(label);
  }
  return address;
}

function configuredNonzeroFelt(value: unknown, label: string): string {
  const felt = configuredFelt(value, label);
  if (felt === "0x0") {
    throw configurationInvalid(label);
  }
  return felt;
}

function configuredFelt(value: unknown, label: string): string {
  try {
    return canonicalFelt(value);
  } catch {
    throw configurationInvalid(label);
  }
}

function configuredBlockNumber(value: unknown): string {
  if (
    typeof value !== "string" ||
    !UNSIGNED_DECIMAL_PATTERN.test(value) ||
    value.length > MAXIMUM_BLOCK_NUMBER_TEXT_LENGTH
  ) {
    throw configurationInvalid("deployment block number");
  }
  const number = BigInt(value);
  if (number > MAXIMUM_BLOCK_NUMBER) {
    throw configurationInvalid("deployment block number");
  }
  return value;
}

function configuredCalldata(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAXIMUM_CONSTRUCTOR_CALLDATA) {
    throw configurationInvalid("constructor calldata");
  }
  return Object.freeze(
    denseArray(value, MAXIMUM_CONSTRUCTOR_CALLDATA, () =>
      configurationInvalid("constructor calldata"),
    ).map((item) => configuredFelt(item, "constructor calldata")),
  );
}

function providerAddress(value: unknown, providerId: string, label: string): string {
  const address = providerNonzeroFelt(value, providerId, label);
  if (BigInt(address) >= STARKNET_ADDRESS_BOUND) {
    throw invalidResponse(providerId, label);
  }
  return address;
}

function providerNonzeroFelt(value: unknown, providerId: string, label: string): string {
  const felt = providerFelt(value, providerId, label);
  if (felt === "0x0") {
    throw invalidResponse(providerId, label);
  }
  return felt;
}

function providerFelt(value: unknown, providerId: string, label: string): string {
  try {
    return canonicalFelt(value);
  } catch {
    throw invalidResponse(providerId, label);
  }
}

function canonicalAddress(value: unknown): string {
  const felt = canonicalFelt(value);
  if (felt === "0x0" || BigInt(felt) >= STARKNET_ADDRESS_BOUND) {
    throw new Error("Invalid Starknet address");
  }
  return felt;
}

function canonicalFelt(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > MAXIMUM_FELT_TEXT_LENGTH ||
    !FELT_PATTERN.test(value)
  ) {
    throw new Error("Invalid Starknet felt");
  }
  const felt = BigInt(value);
  if (felt >= STARK_FIELD_PRIME) {
    throw new Error("Invalid Starknet felt");
  }
  return `0x${felt.toString(16)}`;
}

function providerBlockNumber(value: unknown, providerId: string, label: string): bigint {
  const number =
    typeof value === "bigint"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? BigInt(value)
        : -1n;
  if (number < 0n || number > MAXIMUM_BLOCK_NUMBER) {
    throw invalidResponse(providerId, label);
  }
  return number;
}

function denseArray(
  value: readonly unknown[],
  maximum: number,
  error: () => Error,
): readonly unknown[] {
  if (value.length > maximum) {
    throw error();
  }
  return Array.from(value, (item, index) => {
    if (!Object.hasOwn(value, index)) {
      throw error();
    }
    return item;
  });
}

function satisfiesFinality(
  status: "ACCEPTED_ON_L1" | "ACCEPTED_ON_L2",
  policy: StarknetTransactionFinalityPolicy,
): boolean {
  return policy === STARKNET_TRANSACTION_FINALITY_POLICIES.L2 || status === "ACCEPTED_ON_L1";
}

function configuredPositiveInteger(value: unknown, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > MAXIMUM_REQUEST_TIMEOUT_MILLISECONDS
  ) {
    throw configurationInvalid(label);
  }
  return value as number;
}

function configurationInvalid(label: string): StarknetDeploymentOriginVerifierConfigurationError {
  return new StarknetDeploymentOriginVerifierConfigurationError(`Configured ${label} is invalid`);
}

function invalidResponse(providerId: string, label: string): StarknetDeploymentOriginVerifierError {
  return new StarknetDeploymentOriginVerifierError(
    "invalid_response",
    `Starknet provider ${providerId} returned an invalid ${label}`,
  );
}

function providerFailure(
  providerId: string,
  operation: string,
): StarknetDeploymentOriginVerifierError {
  return new StarknetDeploymentOriginVerifierError(
    "provider_failure",
    `Starknet provider ${providerId} could not ${operation}`,
  );
}

function withTimeout<Value>(promise: Promise<Value>, timeoutMilliseconds: number): Promise<Value> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Starknet deployment-origin request timed out")),
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
const MAXIMUM_REQUEST_TIMEOUT_MILLISECONDS = 120_000;
const MAXIMUM_TRANSACTIONS_PER_BLOCK = 100_000;
const MAXIMUM_EVENTS_PER_RECEIPT = 10_000;
const MAXIMUM_EVENT_VALUES = 256;
const MAXIMUM_CONSTRUCTOR_CALLDATA = 64;
const MAXIMUM_FELT_TEXT_LENGTH = 66;
const MAXIMUM_BLOCK_NUMBER_TEXT_LENGTH = 20;
const MAXIMUM_BLOCK_NUMBER = (1n << 64n) - 1n;
const STARKNET_ADDRESS_BOUND = (1n << 251n) - 256n;
const STARK_FIELD_PRIME = (1n << 251n) + (17n << 192n) + 1n;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const FELT_PATTERN = /^0x[0-9a-fA-F]+$/u;
const UNSIGNED_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/u;
const STARKNET_SEPOLIA_CHAIN_ID = canonicalFelt(constants.StarknetChainId.SN_SEPOLIA);

if (
  canonicalAddress(constants.UDC.ADDRESS) !== STARKNET_UDC_ADDRESS ||
  hash.getSelectorFromName("ContractDeployed") !== STARKNET_UDC_CONTRACT_DEPLOYED_SELECTOR
) {
  throw new Error("starknet@10.5.0 UDC constants do not match the deployment-origin verifier");
}
