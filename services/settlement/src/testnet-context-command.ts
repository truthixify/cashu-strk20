import { RpcProvider } from "starknet";

import {
  type StarknetDeploymentOriginRpc,
  StarknetDeploymentOriginVerifier,
  StarknetDeploymentOriginVerifierConfigurationError,
  StarknetDeploymentOriginVerifierError,
} from "./starknet-deployment-origin-verifier.js";
import {
  type StarknetDeploymentRpc,
  StarknetDeploymentVerifier,
  StarknetDeploymentVerifierConfigurationError,
  StarknetDeploymentVerifierError,
} from "./starknet-deployment-verifier.js";
import {
  type NamedStarknetDiscoveryHeadProvider,
  type StarknetDiscoveryHeadRpc,
  StarknetDiscoveryHeadVerifierError,
} from "./starknet-discovery-head-verifier.js";
import {
  assertTestnetDeploymentManifestsDoNotExposeAddresses,
  TestnetDeploymentManifestError,
  verifyTestnetDeploymentManifests,
} from "./testnet-deployment-manifest.js";
import {
  createTestnetDeploymentEvidence,
  createTestnetVerifiedContextEvidence,
  createTestnetVerifiedDeploymentEvidence,
  type TestnetDeploymentConfig,
  TestnetEvidenceError,
  type TestnetVerifiedContextEvidence,
} from "./testnet-evidence.js";
import {
  createTestnetDeploymentConfigFromEnvironment,
  type TestnetEnvironment,
  TestnetPreflightEnvironmentError,
} from "./testnet-preflight-config.js";
import {
  TestnetPrivacyServiceVerifierError,
  verifyTestnetPrivacyServices,
} from "./testnet-service-verifier.js";

export interface TestnetContextRpc
  extends StarknetDeploymentRpc,
    StarknetDeploymentOriginRpc,
    StarknetDiscoveryHeadRpc {}

export interface NamedTestnetContextProvider {
  readonly id: string;
  readonly provider: TestnetContextRpc;
}

interface TestnetContextVerificationInput {
  readonly config: TestnetDeploymentConfig;
  readonly createProvider: (url: string) => TestnetContextRpc;
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => Date;
}

export interface TestnetContextVerificationCommandInput {
  readonly environment: TestnetEnvironment;
  readonly createProvider?: (url: string) => TestnetContextRpc;
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => Date;
  readonly writeOutput: (value: string) => void;
  readonly writeError: (value: string) => void;
}

async function verifyTestnetContext(
  input: TestnetContextVerificationInput,
): Promise<TestnetVerifiedContextEvidence> {
  const now = input.now ?? (() => new Date());
  const deployment = createTestnetDeploymentEvidence(input.config);
  const manifestVerification = await verifyTestnetDeploymentManifests({
    profile: deployment,
    ...(input.fetchImplementation === undefined
      ? {}
      : { fetchImplementation: input.fetchImplementation }),
    now,
  });
  assertTestnetDeploymentManifestsDoNotExposeAddresses(manifestVerification, [
    input.config.account.address,
  ]);
  const providers = input.config.rpcProviders.map(({ id, url }) => ({
    id,
    provider: input.createProvider(url),
  }));
  const originVerification = await new StarknetDeploymentOriginVerifier({
    network: input.config.network,
    finalityPolicy: input.config.finalityPolicy,
    contracts: manifestVerification.contracts,
    providers,
    requestTimeoutMilliseconds: input.config.provingPolicy.requestTimeoutMilliseconds,
  }).verify();
  const verification = await new StarknetDeploymentVerifier({
    network: input.config.network,
    finalityPolicy: input.config.finalityPolicy,
    poolContract: input.config.pool.address,
    expectedPoolClassHash: input.config.pool.classHash,
    tokenContract: input.config.token.address,
    expectedTokenClassHash: input.config.token.classHash,
    settlementAccount: input.config.account.address,
    expectedAccountClassHash: input.config.account.classHash,
    providers,
    maximumHeadLagBlocks: input.config.provingPolicy.maximumHeadLagBlocks,
    maximumBlockAgeSeconds: input.config.provingPolicy.maximumBlockAgeSeconds,
    maximumFutureBlockTimeSeconds: input.config.provingPolicy.maximumFutureBlockTimeSeconds,
    requestTimeoutMilliseconds: input.config.provingPolicy.requestTimeoutMilliseconds,
    now,
  }).verify();
  const verifiedDeployment = createTestnetVerifiedDeploymentEvidence({
    deployment,
    manifestVerification,
    originVerification,
    verification,
    verifiedAt: contextTimestamp(now),
  });
  const serviceVerification = await verifyTestnetPrivacyServices({
    config: input.config,
    providers: discoveryProviders(providers),
    ...(input.fetchImplementation === undefined
      ? {}
      : { fetchImplementation: input.fetchImplementation }),
    now,
  });
  return createTestnetVerifiedContextEvidence({ verifiedDeployment, serviceVerification });
}

export async function runTestnetContextVerificationCommand(
  input: TestnetContextVerificationCommandInput,
): Promise<0 | 1> {
  try {
    const now = input.now ?? (() => new Date());
    const config = createTestnetDeploymentConfigFromEnvironment(
      input.environment,
      contextTimestamp(now),
    );
    const createProvider = input.createProvider ?? defaultProvider;
    const evidence = await verifyTestnetContext({
      config,
      createProvider,
      ...(input.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: input.fetchImplementation }),
      now,
    });
    input.writeOutput(`${JSON.stringify(evidence, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = knownError(error)
      ? error.message
      : "Testnet context verification failed unexpectedly";
    input.writeError(`${message}\n`);
    return 1;
  }
}

function discoveryProviders(
  providers: readonly NamedTestnetContextProvider[],
): readonly NamedStarknetDiscoveryHeadProvider[] {
  return Array.from(providers, ({ id, provider }) => ({ id, provider }));
}

function defaultProvider(url: string): TestnetContextRpc {
  return new RpcProvider({ nodeUrl: url });
}

function contextTimestamp(now: () => Date): string {
  try {
    const value: unknown = now();
    if (!(value instanceof Date)) {
      throw new Error("invalid clock");
    }
    const milliseconds = Date.prototype.getTime.call(value);
    if (!Number.isFinite(milliseconds)) {
      throw new Error("invalid clock");
    }
    return new Date(milliseconds).toISOString();
  } catch {
    throw new Error("Invalid testnet context verification clock");
  }
}

function knownError(
  error: unknown,
): error is
  | StarknetDeploymentOriginVerifierConfigurationError
  | StarknetDeploymentOriginVerifierError
  | StarknetDeploymentVerifierConfigurationError
  | StarknetDeploymentVerifierError
  | TestnetDeploymentManifestError
  | StarknetDiscoveryHeadVerifierError
  | TestnetEvidenceError
  | TestnetPreflightEnvironmentError
  | TestnetPrivacyServiceVerifierError {
  return (
    error instanceof StarknetDeploymentOriginVerifierConfigurationError ||
    error instanceof StarknetDeploymentOriginVerifierError ||
    error instanceof StarknetDeploymentVerifierConfigurationError ||
    error instanceof StarknetDeploymentVerifierError ||
    error instanceof TestnetDeploymentManifestError ||
    error instanceof StarknetDiscoveryHeadVerifierError ||
    error instanceof TestnetEvidenceError ||
    error instanceof TestnetPreflightEnvironmentError ||
    error instanceof TestnetPrivacyServiceVerifierError
  );
}
