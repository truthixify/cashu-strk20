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
  assertTestnetDeploymentManifestsDoNotExposeAddresses,
  TestnetDeploymentManifestError,
  verifyTestnetDeploymentManifests,
} from "./testnet-deployment-manifest.js";
import {
  createTestnetDeploymentEvidence,
  createTestnetVerifiedDeploymentEvidence,
  TestnetEvidenceError,
} from "./testnet-evidence.js";
import {
  createTestnetDeploymentConfigFromEnvironment,
  type TestnetEnvironment,
  TestnetPreflightEnvironmentError,
} from "./testnet-preflight-config.js";

export interface TestnetDeploymentVerificationRpc
  extends StarknetDeploymentRpc,
    StarknetDeploymentOriginRpc {}

export interface TestnetDeploymentVerificationCommandInput {
  readonly environment: TestnetEnvironment;
  readonly createProvider?: (url: string) => TestnetDeploymentVerificationRpc;
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => Date;
  readonly writeOutput: (value: string) => void;
  readonly writeError: (value: string) => void;
}

export async function runTestnetDeploymentVerificationCommand(
  input: TestnetDeploymentVerificationCommandInput,
): Promise<0 | 1> {
  try {
    const now = input.now ?? (() => new Date());
    const recordedAt = timestamp(now());
    const config = createTestnetDeploymentConfigFromEnvironment(input.environment, recordedAt);
    const deployment = createTestnetDeploymentEvidence(config);
    const manifestVerification = await verifyTestnetDeploymentManifests({
      profile: deployment,
      ...(input.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: input.fetchImplementation }),
      now,
    });
    assertTestnetDeploymentManifestsDoNotExposeAddresses(manifestVerification, [
      config.account.address,
    ]);
    const createProvider = input.createProvider ?? defaultProvider;
    const providers = config.rpcProviders.map(({ id, url }) => ({
      id,
      provider: createProvider(url),
    }));
    const originVerification = await new StarknetDeploymentOriginVerifier({
      network: config.network,
      finalityPolicy: config.finalityPolicy,
      contracts: manifestVerification.contracts,
      providers,
      requestTimeoutMilliseconds: config.provingPolicy.requestTimeoutMilliseconds,
    }).verify();
    const verification = await new StarknetDeploymentVerifier({
      network: config.network,
      finalityPolicy: config.finalityPolicy,
      poolContract: config.pool.address,
      expectedPoolClassHash: config.pool.classHash,
      tokenContract: config.token.address,
      expectedTokenClassHash: config.token.classHash,
      settlementAccount: config.account.address,
      expectedAccountClassHash: config.account.classHash,
      providers,
      maximumHeadLagBlocks: config.provingPolicy.maximumHeadLagBlocks,
      maximumBlockAgeSeconds: config.provingPolicy.maximumBlockAgeSeconds,
      maximumFutureBlockTimeSeconds: config.provingPolicy.maximumFutureBlockTimeSeconds,
      requestTimeoutMilliseconds: config.provingPolicy.requestTimeoutMilliseconds,
      now,
    }).verify();
    const evidence = createTestnetVerifiedDeploymentEvidence({
      deployment,
      manifestVerification,
      originVerification,
      verification,
      verifiedAt: timestamp(now()),
    });
    input.writeOutput(`${JSON.stringify(evidence, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = knownError(error)
      ? error.message
      : "Testnet deployment verification failed unexpectedly";
    input.writeError(`${message}\n`);
    return 1;
  }
}

function defaultProvider(url: string): TestnetDeploymentVerificationRpc {
  return new RpcProvider({ nodeUrl: url });
}

function timestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Invalid testnet verification clock");
  }
  return value.toISOString();
}

function knownError(
  error: unknown,
): error is
  | StarknetDeploymentOriginVerifierConfigurationError
  | StarknetDeploymentOriginVerifierError
  | StarknetDeploymentVerifierConfigurationError
  | StarknetDeploymentVerifierError
  | TestnetDeploymentManifestError
  | TestnetEvidenceError
  | TestnetPreflightEnvironmentError {
  return (
    error instanceof StarknetDeploymentOriginVerifierConfigurationError ||
    error instanceof StarknetDeploymentOriginVerifierError ||
    error instanceof StarknetDeploymentVerifierConfigurationError ||
    error instanceof StarknetDeploymentVerifierError ||
    error instanceof TestnetDeploymentManifestError ||
    error instanceof TestnetEvidenceError ||
    error instanceof TestnetPreflightEnvironmentError
  );
}
