import {
  createTestnetPoolDeploymentPlan,
  TestnetPoolDeploymentPlanError,
  type TestnetPoolDeploymentPlanInput,
} from "./testnet-pool-deployment-plan.js";

export type TestnetPoolDeploymentPlanEnvironment = Readonly<Record<string, string | undefined>>;

export interface TestnetPoolDeploymentPlanCommandInput {
  readonly environment: TestnetPoolDeploymentPlanEnvironment;
  readonly now?: () => Date;
  readonly writeOutput: (value: string) => void;
  readonly writeError: (value: string) => void;
}

export type TestnetPoolDeploymentPlanEnvironmentErrorCode =
  | "invalid_environment"
  | "invalid_variable"
  | "missing_variable";

export class TestnetPoolDeploymentPlanEnvironmentError extends Error {
  readonly code: TestnetPoolDeploymentPlanEnvironmentErrorCode;

  constructor(code: TestnetPoolDeploymentPlanEnvironmentErrorCode, message: string) {
    super(message);
    this.name = "TestnetPoolDeploymentPlanEnvironmentError";
    this.code = code;
  }
}

export function createTestnetPoolDeploymentPlanInputFromEnvironment(
  environment: TestnetPoolDeploymentPlanEnvironment,
  createdAt: string,
): TestnetPoolDeploymentPlanInput {
  if (typeof environment !== "object" || environment === null || Array.isArray(environment)) {
    throw new TestnetPoolDeploymentPlanEnvironmentError(
      "invalid_environment",
      "Testnet pool deployment plan environment is invalid",
    );
  }
  if (requiredVariable(environment, "STARKNET_NETWORK") !== "sepolia") {
    throw invalidVariable("STARKNET_NETWORK");
  }
  if (requiredVariable(environment, "STRK20_POOL_DEPLOYMENT_UNIQUE") !== "true") {
    throw invalidVariable("STRK20_POOL_DEPLOYMENT_UNIQUE");
  }
  return {
    createdAt,
    network: "SN_SEPOLIA",
    chainId: requiredVariable(environment, "STARKNET_CHAIN_ID"),
    poolClassHash: requiredVariable(environment, "STRK20_POOL_CLASS_HASH"),
    poolVersion: requiredVariable(environment, "STRK20_POOL_VERSION"),
    deployer: requiredVariable(environment, "STRK20_POOL_DEPLOYER_ADDRESS"),
    governanceAdmin: requiredVariable(environment, "STRK20_POOL_GOVERNANCE_ADMIN"),
    auditorPublicKey: requiredVariable(environment, "STRK20_POOL_AUDITOR_PUBLIC_KEY"),
    screenerPublicKey: requiredVariable(environment, "STRK20_POOL_SCREENER_PUBLIC_KEY"),
    proofValidityBlocks: requiredVariable(environment, "STRK20_POOL_PROOF_VALIDITY_BLOCKS"),
    salt: requiredVariable(environment, "STRK20_POOL_DEPLOYMENT_SALT"),
    unique: true,
    settlementAccount: requiredVariable(environment, "SETTLEMENT_ACCOUNT_ADDRESS"),
  };
}

export function runTestnetPoolDeploymentPlanCommand(
  input: TestnetPoolDeploymentPlanCommandInput,
): 0 | 1 {
  try {
    const createdAt = timestamp((input.now ?? (() => new Date()))());
    const planInput = createTestnetPoolDeploymentPlanInputFromEnvironment(
      input.environment,
      createdAt,
    );
    const plan = createTestnetPoolDeploymentPlan(planInput);
    input.writeOutput(`${JSON.stringify(plan, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message =
      error instanceof TestnetPoolDeploymentPlanEnvironmentError ||
      error instanceof TestnetPoolDeploymentPlanError
        ? error.message
        : "Testnet pool deployment planning failed unexpectedly";
    input.writeError(`${message}\n`);
    return 1;
  }
}

function requiredVariable(environment: TestnetPoolDeploymentPlanEnvironment, name: string): string {
  let value: unknown;
  try {
    value = Reflect.get(environment, name);
  } catch {
    throw invalidVariable(name);
  }
  if (value === undefined || value === "") {
    throw new TestnetPoolDeploymentPlanEnvironmentError(
      "missing_variable",
      `Required testnet pool deployment variable ${name} is missing`,
    );
  }
  if (
    typeof value !== "string" ||
    value.length > MAXIMUM_ENVIRONMENT_VALUE_LENGTH ||
    value !== value.trim() ||
    containsControlCharacter(value)
  ) {
    throw invalidVariable(name);
  }
  return value;
}

function timestamp(value: Date): string {
  try {
    const milliseconds = Date.prototype.getTime.call(value);
    if (!Number.isFinite(milliseconds)) throw new Error("invalid clock");
    return new Date(milliseconds).toISOString();
  } catch {
    throw new TestnetPoolDeploymentPlanEnvironmentError(
      "invalid_variable",
      "Testnet pool deployment plan clock is invalid",
    );
  }
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function invalidVariable(name: string): TestnetPoolDeploymentPlanEnvironmentError {
  return new TestnetPoolDeploymentPlanEnvironmentError(
    "invalid_variable",
    `Testnet pool deployment variable ${name} is invalid`,
  );
}

const MAXIMUM_ENVIRONMENT_VALUE_LENGTH = 4_096;
