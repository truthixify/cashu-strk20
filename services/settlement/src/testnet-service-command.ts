import { RpcProvider } from "starknet";

import {
  type StarknetDiscoveryHeadRpc,
  StarknetDiscoveryHeadVerifierError,
} from "./starknet-discovery-head-verifier.js";
import {
  createTestnetDeploymentConfigFromEnvironment,
  type TestnetEnvironment,
  TestnetPreflightEnvironmentError,
} from "./testnet-preflight-config.js";
import {
  TestnetPrivacyServiceVerifierError,
  verifyTestnetPrivacyServices,
} from "./testnet-service-verifier.js";

export interface TestnetPrivacyServiceCommandInput {
  readonly environment: TestnetEnvironment;
  readonly createProvider?: (url: string) => StarknetDiscoveryHeadRpc;
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => Date;
  readonly writeOutput: (value: string) => void;
  readonly writeError: (value: string) => void;
}

export async function runTestnetPrivacyServiceVerificationCommand(
  input: TestnetPrivacyServiceCommandInput,
): Promise<0 | 1> {
  try {
    const now = input.now ?? (() => new Date());
    const config = createTestnetDeploymentConfigFromEnvironment(
      input.environment,
      timestamp(now()),
    );
    const createProvider = input.createProvider ?? defaultProvider;
    const evidence = await verifyTestnetPrivacyServices({
      config,
      providers: config.rpcProviders.map(({ id, url }) => ({
        id,
        provider: createProvider(url),
      })),
      ...(input.fetchImplementation ? { fetchImplementation: input.fetchImplementation } : {}),
      now,
    });
    input.writeOutput(`${JSON.stringify(evidence, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = knownError(error)
      ? error.message
      : "Testnet privacy service verification failed unexpectedly";
    input.writeError(`${message}\n`);
    return 1;
  }
}

function defaultProvider(url: string): StarknetDiscoveryHeadRpc {
  return new RpcProvider({ nodeUrl: url });
}

function timestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Invalid testnet service verification clock");
  }
  return value.toISOString();
}

function knownError(
  error: unknown,
): error is
  | StarknetDiscoveryHeadVerifierError
  | TestnetPreflightEnvironmentError
  | TestnetPrivacyServiceVerifierError {
  return (
    error instanceof StarknetDiscoveryHeadVerifierError ||
    error instanceof TestnetPreflightEnvironmentError ||
    error instanceof TestnetPrivacyServiceVerifierError
  );
}
