import { STARKNET_PRIVACY_SDK_COMMIT, STARKNET_PRIVACY_SDK_VERSION } from "./privacy-evidence.js";
import { STARKNET_TRANSACTION_FINALITY_POLICIES } from "./starknet-transaction-observer.js";
import {
  assertTestnetPreflightSecrets,
  createTestnetDeploymentEvidence,
  TESTNET_CDK_VERSION,
  TESTNET_SCREENING_POLICY,
  TESTNET_STARKNET_JS_VERSION,
  type TestnetDeploymentConfig,
  TestnetEvidenceError,
  type TestnetPreflightConfig,
} from "./testnet-evidence.js";

export type TestnetEnvironment = Readonly<Record<string, string | undefined>>;

export type TestnetPreflightEnvironmentErrorCode =
  | "invalid_environment"
  | "invalid_variable"
  | "missing_variable";

export class TestnetPreflightEnvironmentError extends Error {
  readonly code: TestnetPreflightEnvironmentErrorCode;

  constructor(code: TestnetPreflightEnvironmentErrorCode, message: string) {
    super(message);
    this.name = "TestnetPreflightEnvironmentError";
    this.code = code;
  }
}

export interface TestnetPreflightCommandInput {
  readonly environment: TestnetEnvironment;
  readonly recordedAt: string;
  readonly writeOutput: (value: string) => void;
  readonly writeError: (value: string) => void;
}

export function createTestnetPreflightConfigFromEnvironment(
  environment: TestnetEnvironment,
  recordedAt: string,
): TestnetPreflightConfig {
  const deployment = createTestnetDeploymentConfigFromEnvironment(environment, recordedAt);
  const config: TestnetPreflightConfig = {
    ...deployment,
    signerPrivateKey: requiredVariable(environment, "SETTLEMENT_SIGNER_PRIVATE_KEY"),
    viewingKey: requiredVariable(environment, "SETTLEMENT_VIEWING_KEY"),
    screeningCredentials: {
      partnerName: requiredVariable(environment, "STRK20_SCREENING_PARTNER_NAME"),
      partnerSecret: requiredVariable(environment, "STRK20_SCREENING_PARTNER_SECRET"),
    },
  };
  assertTestnetPreflightSecrets(config);
  return config;
}

export function createTestnetDeploymentConfigFromEnvironment(
  environment: TestnetEnvironment,
  recordedAt: string,
): TestnetDeploymentConfig {
  if (typeof environment !== "object" || environment === null || Array.isArray(environment)) {
    throw new TestnetPreflightEnvironmentError(
      "invalid_environment",
      "Testnet environment is invalid",
    );
  }
  const network = requiredVariable(environment, "STARKNET_NETWORK");
  if (network !== "sepolia") {
    throw invalidVariable("STARKNET_NETWORK");
  }

  return {
    network: "SN_SEPOLIA",
    chainId: requiredVariable(environment, "STARKNET_CHAIN_ID"),
    recordedAt,
    pool: {
      address: requiredVariable(environment, "STRK20_POOL_ADDRESS"),
      classHash: requiredVariable(environment, "STRK20_POOL_CLASS_HASH"),
      version: requiredVariable(environment, "STRK20_POOL_VERSION"),
      deployment: {
        transactionReference: requiredVariable(
          environment,
          "STRK20_POOL_DEPLOYMENT_TRANSACTION_REFERENCE",
        ),
        manifestUrl: requiredVariable(environment, "STRK20_POOL_DEPLOYMENT_MANIFEST_URL"),
        manifestSha256: requiredVariable(environment, "STRK20_POOL_DEPLOYMENT_MANIFEST_SHA256"),
      },
    },
    token: {
      address: requiredVariable(environment, "STRK20_USDC_TOKEN_ADDRESS"),
      classHash: requiredVariable(environment, "STRK20_USDC_TOKEN_CLASS_HASH"),
      version: requiredVariable(environment, "STRK20_USDC_TOKEN_VERSION"),
      symbol: "USDC",
      decimals: 6,
      deployment: {
        transactionReference: requiredVariable(
          environment,
          "STRK20_USDC_TOKEN_DEPLOYMENT_TRANSACTION_REFERENCE",
        ),
        manifestUrl: requiredVariable(environment, "STRK20_USDC_TOKEN_DEPLOYMENT_MANIFEST_URL"),
        manifestSha256: requiredVariable(
          environment,
          "STRK20_USDC_TOKEN_DEPLOYMENT_MANIFEST_SHA256",
        ),
      },
    },
    account: {
      address: requiredVariable(environment, "SETTLEMENT_ACCOUNT_ADDRESS"),
      classHash: requiredVariable(environment, "SETTLEMENT_ACCOUNT_CLASS_HASH"),
      version: requiredVariable(environment, "SETTLEMENT_ACCOUNT_VERSION"),
    },
    rpcProviders: [
      {
        id: "rpc-primary",
        operator: requiredVariable(environment, "STARKNET_RPC_PRIMARY_OPERATOR"),
        url: requiredVariable(environment, "STARKNET_RPC_PRIMARY_URL"),
      },
      {
        id: "rpc-secondary",
        operator: requiredVariable(environment, "STARKNET_RPC_SECONDARY_OPERATOR"),
        url: requiredVariable(environment, "STARKNET_RPC_SECONDARY_URL"),
      },
    ],
    prover: {
      operator: requiredVariable(environment, "STRK20_PROVING_OPERATOR"),
      url: requiredVariable(environment, "STRK20_PROVING_URL"),
      version: requiredVariable(environment, "STRK20_PROVING_VERSION"),
    },
    discovery: {
      operator: requiredVariable(environment, "STRK20_DISCOVERY_OPERATOR"),
      url: requiredVariable(environment, "STRK20_DISCOVERY_URL"),
      version: requiredVariable(environment, "STRK20_DISCOVERY_VERSION"),
    },
    screening: {
      interceptor: {
        operator: requiredVariable(environment, "STRK20_PROOF_INTERCEPTOR_OPERATOR"),
        url: requiredVariable(environment, "STRK20_PROOF_INTERCEPTOR_URL"),
        version: requiredVariable(environment, "STRK20_PROOF_INTERCEPTOR_VERSION"),
      },
      provider: {
        operator: requiredVariable(environment, "STRK20_SCREENING_PROVIDER_OPERATOR"),
        url: requiredVariable(environment, "STRK20_SCREENING_PROVIDER_URL"),
      },
      rpcProviderId: requiredVariable(environment, "STRK20_SCREENING_RPC_PROVIDER_ID"),
      poolAddress: requiredVariable(environment, "STRK20_SCREENING_POOL_ADDRESS"),
      policy: screeningPolicy(environment),
      blockNonPoolTransactions: requiredBoolean(
        environment,
        "STRK20_SCREENING_BLOCK_NON_POOL_TRANSACTIONS",
        true,
      ),
      interceptorFailOpen: requiredBoolean(environment, "STRK20_SCREENING_FAIL_OPEN", false),
      proverFailOpen: requiredBoolean(environment, "STRK20_PROVER_SCREENING_FAIL_OPEN", false),
    },
    walletApiVersion: requiredVariable(environment, "STRK20_WALLET_API_VERSION"),
    privacySdkVersion: STARKNET_PRIVACY_SDK_VERSION,
    privacySdkCommit: STARKNET_PRIVACY_SDK_COMMIT,
    starknetJsVersion: TESTNET_STARKNET_JS_VERSION,
    cdkVersion: TESTNET_CDK_VERSION,
    finalityPolicy: finalityPolicy(environment),
    provingPolicy: {
      blocksBehind: positiveInteger(environment, "STARKNET_PROVING_BLOCKS_BEHIND"),
      minimumRemainingValidityBlocks: positiveInteger(
        environment,
        "STARKNET_MINIMUM_REMAINING_VALIDITY_BLOCKS",
      ),
      maximumHeadLagBlocks: nonnegativeInteger(environment, "STARKNET_MAXIMUM_HEAD_LAG_BLOCKS"),
      maximumBlockAgeSeconds: positiveInteger(environment, "STARKNET_MAXIMUM_BLOCK_AGE_SECONDS"),
      maximumFutureBlockTimeSeconds: nonnegativeInteger(
        environment,
        "STARKNET_MAXIMUM_FUTURE_BLOCK_TIME_SECONDS",
      ),
      requestTimeoutMilliseconds: positiveInteger(
        environment,
        "STARKNET_RPC_REQUEST_TIMEOUT_MILLISECONDS",
      ),
    },
    safety: {
      testOnlyAccount: acknowledgement(environment, "TESTNET_ACCOUNT_CONFIRMED"),
      cappedFunds: acknowledgement(environment, "TESTNET_FUNDS_CAPPED"),
    },
  };
}

export function runTestnetPreflightCommand(input: TestnetPreflightCommandInput): 0 | 1 {
  try {
    const config = createTestnetPreflightConfigFromEnvironment(input.environment, input.recordedAt);
    const evidence = createTestnetDeploymentEvidence(config);
    input.writeOutput(`${JSON.stringify(evidence, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message =
      error instanceof TestnetPreflightEnvironmentError || error instanceof TestnetEvidenceError
        ? error.message
        : "Testnet preflight failed unexpectedly";
    input.writeError(`${message}\n`);
    return 1;
  }
}

function requiredVariable(environment: TestnetEnvironment, name: string): string {
  let value: string | undefined;
  try {
    value = environment[name];
  } catch {
    throw invalidVariable(name);
  }
  if (value === undefined || value === "") {
    throw new TestnetPreflightEnvironmentError(
      "missing_variable",
      `Required testnet variable ${name} is missing`,
    );
  }
  if (
    typeof value !== "string" ||
    value.length > MAXIMUM_ENVIRONMENT_VALUE_LENGTH ||
    value !== value.trim()
  ) {
    throw invalidVariable(name);
  }
  return value;
}

function positiveInteger(environment: TestnetEnvironment, name: string): number {
  const value = nonnegativeInteger(environment, name);
  if (value === 0) {
    throw invalidVariable(name);
  }
  return value;
}

function nonnegativeInteger(environment: TestnetEnvironment, name: string): number {
  const value = requiredVariable(environment, name);
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw invalidVariable(name);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw invalidVariable(name);
  }
  return parsed;
}

function finalityPolicy(
  environment: TestnetEnvironment,
): TestnetDeploymentConfig["finalityPolicy"] {
  const value = requiredVariable(environment, "STARKNET_FINALITY_POLICY");
  if (
    value !== STARKNET_TRANSACTION_FINALITY_POLICIES.L1 &&
    value !== STARKNET_TRANSACTION_FINALITY_POLICIES.L2
  ) {
    throw invalidVariable("STARKNET_FINALITY_POLICY");
  }
  return value;
}

function acknowledgement(environment: TestnetEnvironment, name: string): true {
  return requiredBoolean(environment, name, true);
}

function screeningPolicy(environment: TestnetEnvironment): typeof TESTNET_SCREENING_POLICY {
  if (requiredVariable(environment, "STRK20_SCREENING_POLICY") !== TESTNET_SCREENING_POLICY) {
    throw invalidVariable("STRK20_SCREENING_POLICY");
  }
  return TESTNET_SCREENING_POLICY;
}

function requiredBoolean<Expected extends boolean>(
  environment: TestnetEnvironment,
  name: string,
  expected: Expected,
): Expected {
  if (requiredVariable(environment, name) !== String(expected)) {
    throw invalidVariable(name);
  }
  return expected;
}

function invalidVariable(name: string): TestnetPreflightEnvironmentError {
  return new TestnetPreflightEnvironmentError(
    "invalid_variable",
    `Testnet variable ${name} is invalid`,
  );
}

const MAXIMUM_ENVIRONMENT_VALUE_LENGTH = 4_096;
