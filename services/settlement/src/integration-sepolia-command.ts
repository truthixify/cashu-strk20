import { RpcProvider } from "starknet";

import {
  IntegrationSepoliaObserverError,
  type IntegrationSepoliaRpc,
  observeStarkwareIntegrationSepolia,
  STARKWARE_INTEGRATION_SEPOLIA_PROFILE,
} from "./integration-sepolia-observer.js";
import {
  StarknetCommonRolesAuthorityVerifierConfigurationError,
  StarknetCommonRolesAuthorityVerifierError,
} from "./starknet-common-roles-authority-verifier.js";
import {
  StarknetContractUpgradeVerifierConfigurationError,
  StarknetContractUpgradeVerifierError,
} from "./starknet-contract-upgrade-verifier.js";
import {
  StarknetDeploymentOriginVerifierConfigurationError,
  StarknetDeploymentOriginVerifierError,
} from "./starknet-deployment-origin-verifier.js";
import {
  StarknetDiscoveryHeadVerifierConfigurationError,
  StarknetDiscoveryHeadVerifierError,
} from "./starknet-discovery-head-verifier.js";

export interface IntegrationSepoliaObservationCommandInput {
  readonly createProvider?: (url: string) => IntegrationSepoliaRpc;
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => Date;
  readonly requestTimeoutMilliseconds?: number;
  readonly writeOutput: (value: string) => void;
  readonly writeError: (value: string) => void;
}

export async function runIntegrationSepoliaObservationCommand(
  input: IntegrationSepoliaObservationCommandInput,
): Promise<0 | 1> {
  try {
    const createProvider = input.createProvider ?? defaultProvider;
    const evidence = await observeStarkwareIntegrationSepolia({
      providers: STARKWARE_INTEGRATION_SEPOLIA_PROFILE.rpcProviders.map(({ id, url }) => ({
        id,
        provider: createProvider(url),
      })),
      ...(input.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: input.fetchImplementation }),
      ...(input.now === undefined ? {} : { now: input.now }),
      ...(input.requestTimeoutMilliseconds === undefined
        ? {}
        : { requestTimeoutMilliseconds: input.requestTimeoutMilliseconds }),
    });
    input.writeOutput(`${JSON.stringify(evidence, null, 2)}\n`);
    return 0;
  } catch (error) {
    input.writeError(
      `${knownError(error) ? error.message : "Integration Sepolia observation failed unexpectedly"}\n`,
    );
    return 1;
  }
}

function defaultProvider(url: string): IntegrationSepoliaRpc {
  return new RpcProvider({ nodeUrl: url });
}

function knownError(
  error: unknown,
): error is
  | IntegrationSepoliaObserverError
  | StarknetCommonRolesAuthorityVerifierConfigurationError
  | StarknetCommonRolesAuthorityVerifierError
  | StarknetContractUpgradeVerifierConfigurationError
  | StarknetContractUpgradeVerifierError
  | StarknetDeploymentOriginVerifierConfigurationError
  | StarknetDeploymentOriginVerifierError
  | StarknetDiscoveryHeadVerifierConfigurationError
  | StarknetDiscoveryHeadVerifierError {
  return (
    error instanceof IntegrationSepoliaObserverError ||
    error instanceof StarknetCommonRolesAuthorityVerifierConfigurationError ||
    error instanceof StarknetCommonRolesAuthorityVerifierError ||
    error instanceof StarknetContractUpgradeVerifierConfigurationError ||
    error instanceof StarknetContractUpgradeVerifierError ||
    error instanceof StarknetDeploymentOriginVerifierConfigurationError ||
    error instanceof StarknetDeploymentOriginVerifierError ||
    error instanceof StarknetDiscoveryHeadVerifierConfigurationError ||
    error instanceof StarknetDiscoveryHeadVerifierError
  );
}
