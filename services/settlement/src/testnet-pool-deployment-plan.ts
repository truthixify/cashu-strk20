import { defaultDeployer, ec } from "starknet";

import {
  STARKNET_PRIVACY_POOL_CLASS_HASH,
  STARKNET_PRIVACY_POOL_VERSION,
  STARKNET_PRIVACY_SDK_COMMIT,
} from "./privacy-evidence.js";
import {
  calculateStarknetUdcAddress,
  STARKNET_UDC_ADDRESS,
  STARKNET_UDC_CLASS_HASH,
} from "./starknet-deployment-origin-verifier.js";
import {
  STARKNET_PRIVACY_CONTRACT_PATH,
  STARKNET_PRIVACY_SOURCE_REPOSITORY,
} from "./testnet-deployment-manifest.js";
import { STARKNET_SEPOLIA_CHAIN_ID, TESTNET_STARKNET_JS_VERSION } from "./testnet-evidence.js";

export const TESTNET_POOL_DEPLOYMENT_PLAN_SCHEMA_VERSION =
  "cashu-strk20-testnet-pool-deployment-plan-v1";
export const TESTNET_POOL_DEPLOYMENT_PLANNER_VERSION =
  "starknet@10.5.0:privacy-0.14.3-rc.6:udc-unique-v1";

export interface TestnetPoolDeploymentPlanInput {
  readonly createdAt: string;
  readonly network: "SN_SEPOLIA";
  readonly chainId: string;
  readonly poolClassHash: string;
  readonly poolVersion: string;
  readonly deployer: string;
  readonly governanceAdmin: string;
  readonly auditorPublicKey: string;
  readonly screenerPublicKey: string;
  readonly proofValidityBlocks: string;
  readonly salt: string;
  readonly unique: true;
  readonly settlementAccount: string;
}

export interface TestnetPoolDeploymentPlan {
  readonly schemaVersion: typeof TESTNET_POOL_DEPLOYMENT_PLAN_SCHEMA_VERSION;
  readonly plannerVersion: typeof TESTNET_POOL_DEPLOYMENT_PLANNER_VERSION;
  readonly createdAt: string;
  readonly network: "SN_SEPOLIA";
  readonly chainId: typeof STARKNET_SEPOLIA_CHAIN_ID;
  readonly source: {
    readonly repository: typeof STARKNET_PRIVACY_SOURCE_REPOSITORY;
    readonly commit: typeof STARKNET_PRIVACY_SDK_COMMIT;
    readonly contractPath: typeof STARKNET_PRIVACY_CONTRACT_PATH;
  };
  readonly contract: {
    readonly predictedAddress: string;
    readonly classHash: typeof STARKNET_PRIVACY_POOL_CLASS_HASH;
    readonly version: typeof STARKNET_PRIVACY_POOL_VERSION;
    readonly configuration: {
      readonly governanceAdmin: string;
      readonly auditorPublicKey: string;
      readonly screenerPublicKey: string;
      readonly proofValidityBlocks: string;
    };
    readonly constructorCalldata: readonly [string, string, string, string];
  };
  readonly deployment: {
    readonly deployer: string;
    readonly salt: string;
    readonly unique: true;
    readonly accountPayload: {
      readonly classHash: typeof STARKNET_PRIVACY_POOL_CLASS_HASH;
      readonly salt: string;
      readonly unique: true;
      readonly constructorCalldata: readonly [string, string, string, string];
    };
    readonly udcCall: {
      readonly contractAddress: typeof STARKNET_UDC_ADDRESS;
      readonly entrypoint: "deploy_contract";
      readonly calldata: readonly string[];
    };
  };
  readonly compatibility: {
    readonly starknetJsVersion: typeof TESTNET_STARKNET_JS_VERSION;
    readonly udcClassHash: typeof STARKNET_UDC_CLASS_HASH;
  };
  readonly verification: {
    readonly pinnedReleaseSelected: true;
    readonly constructorMatchesPinnedAbi: true;
    readonly publicKeysCurveValid: true;
    readonly settlementRoleSeparated: true;
    readonly udcCallMatchesPinnedStarknetJs: true;
    readonly addressDerived: true;
    readonly signerMaterialAccepted: false;
    readonly transactionSubmitted: false;
    readonly classDeclarationVerified: false;
    readonly saltFreshnessVerified: false;
    readonly authorityControlVerified: false;
    readonly privacyServicesBound: false;
    readonly deploymentApproved: false;
  };
  readonly blockers: readonly [
    "class_declaration_unverified",
    "salt_freshness_unverified",
    "authority_control_unverified",
    "privacy_services_unbound",
    "transaction_unsigned",
    "deployment_unsubmitted",
    "deployment_approval_required",
  ];
}

export type TestnetPoolDeploymentPlanErrorCode = "input_invalid" | "udc_compatibility_mismatch";

export class TestnetPoolDeploymentPlanError extends Error {
  readonly code: TestnetPoolDeploymentPlanErrorCode;

  constructor(code: TestnetPoolDeploymentPlanErrorCode, message: string) {
    super(message);
    this.name = "TestnetPoolDeploymentPlanError";
    this.code = code;
  }
}

export function createTestnetPoolDeploymentPlan(
  input: TestnetPoolDeploymentPlanInput,
): TestnetPoolDeploymentPlan {
  try {
    const values = validatedInput(input);
    const constructorCalldata: [string, string, string, string] = [
      values.governanceAdmin,
      values.auditorPublicKey,
      values.screenerPublicKey,
      `0x${BigInt(values.proofValidityBlocks).toString(16)}`,
    ];
    const predictedAddress = calculateStarknetUdcAddress({
      classHash: STARKNET_PRIVACY_POOL_CLASS_HASH,
      deployer: values.deployer,
      salt: values.salt,
      unique: true,
      constructorCalldata,
    });
    const udcCall = pinnedUdcCall({
      deployer: values.deployer,
      salt: values.salt,
      constructorCalldata,
      predictedAddress,
    });

    return {
      schemaVersion: TESTNET_POOL_DEPLOYMENT_PLAN_SCHEMA_VERSION,
      plannerVersion: TESTNET_POOL_DEPLOYMENT_PLANNER_VERSION,
      createdAt: values.createdAt,
      network: "SN_SEPOLIA",
      chainId: STARKNET_SEPOLIA_CHAIN_ID,
      source: {
        repository: STARKNET_PRIVACY_SOURCE_REPOSITORY,
        commit: STARKNET_PRIVACY_SDK_COMMIT,
        contractPath: STARKNET_PRIVACY_CONTRACT_PATH,
      },
      contract: {
        predictedAddress,
        classHash: STARKNET_PRIVACY_POOL_CLASS_HASH,
        version: STARKNET_PRIVACY_POOL_VERSION,
        configuration: {
          governanceAdmin: values.governanceAdmin,
          auditorPublicKey: values.auditorPublicKey,
          screenerPublicKey: values.screenerPublicKey,
          proofValidityBlocks: values.proofValidityBlocks,
        },
        constructorCalldata,
      },
      deployment: {
        deployer: values.deployer,
        salt: values.salt,
        unique: true,
        accountPayload: {
          classHash: STARKNET_PRIVACY_POOL_CLASS_HASH,
          salt: values.salt,
          unique: true,
          constructorCalldata,
        },
        udcCall,
      },
      compatibility: {
        starknetJsVersion: TESTNET_STARKNET_JS_VERSION,
        udcClassHash: STARKNET_UDC_CLASS_HASH,
      },
      verification: {
        pinnedReleaseSelected: true,
        constructorMatchesPinnedAbi: true,
        publicKeysCurveValid: true,
        settlementRoleSeparated: true,
        udcCallMatchesPinnedStarknetJs: true,
        addressDerived: true,
        signerMaterialAccepted: false,
        transactionSubmitted: false,
        classDeclarationVerified: false,
        saltFreshnessVerified: false,
        authorityControlVerified: false,
        privacyServicesBound: false,
        deploymentApproved: false,
      },
      blockers: [
        "class_declaration_unverified",
        "salt_freshness_unverified",
        "authority_control_unverified",
        "privacy_services_unbound",
        "transaction_unsigned",
        "deployment_unsubmitted",
        "deployment_approval_required",
      ],
    };
  } catch (error) {
    if (error instanceof TestnetPoolDeploymentPlanError) throw error;
    throw inputInvalid();
  }
}

function validatedInput(input: TestnetPoolDeploymentPlanInput): ValidatedInput {
  if (
    typeof input !== "object" ||
    input === null ||
    input.network !== "SN_SEPOLIA" ||
    canonicalNonzeroFelt(input.chainId) !== STARKNET_SEPOLIA_CHAIN_ID ||
    canonicalNonzeroFelt(input.poolClassHash) !== STARKNET_PRIVACY_POOL_CLASS_HASH ||
    input.poolVersion !== STARKNET_PRIVACY_POOL_VERSION ||
    input.unique !== true
  ) {
    throw inputInvalid();
  }
  const deployer = canonicalAddress(input.deployer);
  const governanceAdmin = canonicalAddress(input.governanceAdmin);
  const auditorPublicKey = canonicalCurvePublicKey(input.auditorPublicKey);
  const screenerPublicKey = canonicalCurvePublicKey(input.screenerPublicKey);
  const settlementAccount = canonicalAddress(input.settlementAccount);
  const salt = canonicalNonzeroFelt(input.salt);
  const proofValidityBlocks = positiveU64(input.proofValidityBlocks);
  if (
    auditorPublicKey === screenerPublicKey ||
    [deployer, governanceAdmin, auditorPublicKey, screenerPublicKey].includes(settlementAccount)
  ) {
    throw inputInvalid();
  }
  return {
    createdAt: canonicalTimestamp(input.createdAt),
    deployer,
    governanceAdmin,
    auditorPublicKey,
    screenerPublicKey,
    proofValidityBlocks,
    salt,
  };
}

function pinnedUdcCall(input: {
  readonly deployer: string;
  readonly salt: string;
  readonly constructorCalldata: readonly string[];
  readonly predictedAddress: string;
}): TestnetPoolDeploymentPlan["deployment"]["udcCall"] {
  try {
    const result = defaultDeployer.buildDeployerCall(
      {
        classHash: STARKNET_PRIVACY_POOL_CLASS_HASH,
        salt: input.salt,
        unique: true,
        constructorCalldata: [...input.constructorCalldata],
      },
      input.deployer,
    );
    const call = result.calls[0];
    const address = result.addresses[0];
    if (
      result.calls.length !== 1 ||
      result.addresses.length !== 1 ||
      call === undefined ||
      address === undefined ||
      canonicalAddress(call.contractAddress) !== STARKNET_UDC_ADDRESS ||
      call.entrypoint !== "deploy_contract" ||
      !Array.isArray(call.calldata) ||
      canonicalAddress(address) !== input.predictedAddress
    ) {
      throw udcCompatibilityMismatch();
    }
    const calldata = Array.from(call.calldata, libraryFelt);
    const expected = [
      STARKNET_PRIVACY_POOL_CLASS_HASH,
      input.salt,
      "0x1",
      `0x${input.constructorCalldata.length.toString(16)}`,
      ...input.constructorCalldata,
    ];
    if (
      calldata.length !== expected.length ||
      calldata.some((value, index) => value !== expected[index])
    ) {
      throw udcCompatibilityMismatch();
    }
    return {
      contractAddress: STARKNET_UDC_ADDRESS,
      entrypoint: "deploy_contract",
      calldata,
    };
  } catch (error) {
    if (
      error instanceof TestnetPoolDeploymentPlanError &&
      error.code === "udc_compatibility_mismatch"
    ) {
      throw error;
    }
    throw udcCompatibilityMismatch();
  }
}

function canonicalCurvePublicKey(value: unknown): string {
  const key = canonicalNonzeroFelt(value);
  try {
    const encoded = `02${BigInt(key).toString(16).padStart(64, "0")}`;
    ec.starkCurve.ProjectivePoint.fromHex(encoded);
  } catch {
    throw inputInvalid();
  }
  return key;
}

function canonicalAddress(value: unknown): string {
  const address = canonicalNonzeroFelt(value);
  if (BigInt(address) >= STARKNET_ADDRESS_BOUND) throw inputInvalid();
  return address;
}

function canonicalNonzeroFelt(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > MAXIMUM_FELT_TEXT_LENGTH ||
    !FELT_PATTERN.test(value)
  ) {
    throw inputInvalid();
  }
  const felt = BigInt(value);
  if (felt === 0n || felt >= STARK_FIELD_PRIME) throw inputInvalid();
  return `0x${felt.toString(16)}`;
}

function libraryFelt(value: unknown): string {
  try {
    const felt =
      typeof value === "bigint"
        ? value
        : typeof value === "number" && Number.isSafeInteger(value)
          ? BigInt(value)
          : typeof value === "string" && LIBRARY_FELT_PATTERN.test(value)
            ? BigInt(value)
            : -1n;
    if (felt < 0n || felt >= STARK_FIELD_PRIME) throw new Error("invalid felt");
    return `0x${felt.toString(16)}`;
  } catch {
    throw udcCompatibilityMismatch();
  }
}

function positiveU64(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > MAXIMUM_U64_TEXT_LENGTH ||
    !UNSIGNED_DECIMAL_PATTERN.test(value)
  ) {
    throw inputInvalid();
  }
  const parsed = BigInt(value);
  if (parsed === 0n || parsed > U64_MAX) throw inputInvalid();
  return value;
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > MAXIMUM_TIMESTAMP_LENGTH) throw inputInvalid();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw inputInvalid();
  }
  return value;
}

function inputInvalid(): TestnetPoolDeploymentPlanError {
  return new TestnetPoolDeploymentPlanError(
    "input_invalid",
    "Testnet pool deployment plan inputs are invalid",
  );
}

function udcCompatibilityMismatch(): TestnetPoolDeploymentPlanError {
  return new TestnetPoolDeploymentPlanError(
    "udc_compatibility_mismatch",
    "Pinned Starknet.js produced an incompatible UDC deployment call",
  );
}

interface ValidatedInput {
  readonly createdAt: string;
  readonly deployer: string;
  readonly governanceAdmin: string;
  readonly auditorPublicKey: string;
  readonly screenerPublicKey: string;
  readonly proofValidityBlocks: string;
  readonly salt: string;
}

const MAXIMUM_FELT_TEXT_LENGTH = 66;
const MAXIMUM_U64_TEXT_LENGTH = 20;
const MAXIMUM_TIMESTAMP_LENGTH = 32;
const STARKNET_ADDRESS_BOUND = (1n << 251n) - 256n;
const STARK_FIELD_PRIME = (1n << 251n) + (17n << 192n) + 1n;
const U64_MAX = (1n << 64n) - 1n;
const FELT_PATTERN = /^0x[0-9a-fA-F]+$/u;
const LIBRARY_FELT_PATTERN = /^(?:0x[0-9a-fA-F]+|0|[1-9][0-9]*)$/u;
const UNSIGNED_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/u;
