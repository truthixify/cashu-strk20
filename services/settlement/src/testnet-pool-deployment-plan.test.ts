import { defaultDeployer, ec } from "starknet";
import { describe, expect, it, vi } from "vitest";

import {
  STARKNET_PRIVACY_POOL_CLASS_HASH,
  STARKNET_PRIVACY_POOL_VERSION,
  STARKNET_PRIVACY_SDK_COMMIT,
} from "./privacy-evidence.js";
import {
  STARKNET_UDC_ADDRESS,
  STARKNET_UDC_CLASS_HASH,
} from "./starknet-deployment-origin-verifier.js";
import { STARKNET_SEPOLIA_CHAIN_ID, TESTNET_STARKNET_JS_VERSION } from "./testnet-evidence.js";
import {
  createTestnetPoolDeploymentPlan,
  TESTNET_POOL_DEPLOYMENT_PLAN_SCHEMA_VERSION,
  TESTNET_POOL_DEPLOYMENT_PLANNER_VERSION,
  type TestnetPoolDeploymentPlanInput,
} from "./testnet-pool-deployment-plan.js";
import {
  createTestnetPoolDeploymentPlanInputFromEnvironment,
  runTestnetPoolDeploymentPlanCommand,
} from "./testnet-pool-deployment-plan-command.js";

const CREATED_AT = "2026-09-10T02:00:00.000Z";
const DEPLOYER = "0x1234";
const GOVERNANCE_ADMIN = "0x2345";
const SETTLEMENT_ACCOUNT = "0x3456";
const SALT = "0x4567";
const AUDITOR_PUBLIC_KEY = ec.starkCurve.getStarkKey("0x1");
const SCREENER_PUBLIC_KEY = ec.starkCurve.getStarkKey("0x2");
const PREDICTED_ADDRESS = "0x1fa4f65296c0db9b73355dd251d059853e25234ab9bfcc3f5fb2f64a44a9a0c";

describe("testnet pool deployment plan", () => {
  it("builds the exact four-field RC.6 constructor and unique UDC call", () => {
    const plan = createTestnetPoolDeploymentPlan(planInput());

    expect(plan).toEqual({
      schemaVersion: TESTNET_POOL_DEPLOYMENT_PLAN_SCHEMA_VERSION,
      plannerVersion: TESTNET_POOL_DEPLOYMENT_PLANNER_VERSION,
      createdAt: CREATED_AT,
      network: "SN_SEPOLIA",
      chainId: STARKNET_SEPOLIA_CHAIN_ID,
      source: {
        repository: "https://github.com/starkware-libs/starknet-privacy",
        commit: STARKNET_PRIVACY_SDK_COMMIT,
        contractPath: "packages/privacy/src/privacy.cairo",
      },
      contract: {
        predictedAddress: PREDICTED_ADDRESS,
        classHash: STARKNET_PRIVACY_POOL_CLASS_HASH,
        version: STARKNET_PRIVACY_POOL_VERSION,
        configuration: {
          governanceAdmin: GOVERNANCE_ADMIN,
          auditorPublicKey: AUDITOR_PUBLIC_KEY,
          screenerPublicKey: SCREENER_PUBLIC_KEY,
          proofValidityBlocks: "450",
        },
        constructorCalldata: [GOVERNANCE_ADMIN, AUDITOR_PUBLIC_KEY, SCREENER_PUBLIC_KEY, "0x1c2"],
      },
      deployment: {
        deployer: DEPLOYER,
        salt: SALT,
        unique: true,
        accountPayload: {
          classHash: STARKNET_PRIVACY_POOL_CLASS_HASH,
          salt: SALT,
          unique: true,
          constructorCalldata: [GOVERNANCE_ADMIN, AUDITOR_PUBLIC_KEY, SCREENER_PUBLIC_KEY, "0x1c2"],
        },
        udcCall: {
          contractAddress: STARKNET_UDC_ADDRESS,
          entrypoint: "deploy_contract",
          calldata: [
            STARKNET_PRIVACY_POOL_CLASS_HASH,
            SALT,
            "0x1",
            "0x4",
            GOVERNANCE_ADMIN,
            AUDITOR_PUBLIC_KEY,
            SCREENER_PUBLIC_KEY,
            "0x1c2",
          ],
        },
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
    });
  });

  it("rejects stale releases, mainnet, non-unique deployment, and malformed validity", () => {
    for (const input of [
      { ...planInput(), chainId: "0x534e5f4d41494e" },
      {
        ...planInput(),
        poolClassHash: "0x715b22abfb60815623f4127ba64bd2f93613d8a5c1e519841eaab444659d2af",
      },
      { ...planInput(), poolVersion: "PRIVACY-0.14.3-RC.5" },
      { ...planInput(), unique: false } as unknown as TestnetPoolDeploymentPlanInput,
      { ...planInput(), proofValidityBlocks: "0" },
      { ...planInput(), proofValidityBlocks: "018" },
      { ...planInput(), proofValidityBlocks: (1n << 64n).toString(10) },
    ]) {
      expect(() => createTestnetPoolDeploymentPlan(input)).toThrow(
        "Testnet pool deployment plan inputs are invalid",
      );
    }
  });

  it("rejects invalid or reused authority values and settlement-role reuse", () => {
    for (const input of [
      { ...planInput(), auditorPublicKey: "0x5" },
      { ...planInput(), screenerPublicKey: AUDITOR_PUBLIC_KEY },
      { ...planInput(), settlementAccount: DEPLOYER },
      { ...planInput(), settlementAccount: GOVERNANCE_ADMIN },
      { ...planInput(), settlementAccount: AUDITOR_PUBLIC_KEY },
      { ...planInput(), settlementAccount: SCREENER_PUBLIC_KEY },
      { ...planInput(), salt: "0x0" },
    ]) {
      expect(() => createTestnetPoolDeploymentPlan(input)).toThrow(
        "Testnet pool deployment plan inputs are invalid",
      );
    }
  });

  it("classifies malformed Starknet.js deployment output as a compatibility mismatch", () => {
    const build = vi.spyOn(defaultDeployer, "buildDeployerCall").mockReturnValue({
      calls: [{ contractAddress: "0x1", entrypoint: "deploy_contract", calldata: [] }],
      addresses: ["0x1"],
    });
    try {
      expect(() => createTestnetPoolDeploymentPlan(planInput())).toThrow(
        expect.objectContaining({
          code: "udc_compatibility_mismatch",
          message: "Pinned Starknet.js produced an incompatible UDC deployment call",
        }),
      );
    } finally {
      build.mockRestore();
    }
  });

  it("emits a deterministic unsigned plan without reading secret variables", () => {
    const output: string[] = [];
    const errors: string[] = [];
    const environment = environmentFixture();
    Object.defineProperties(environment, {
      SETTLEMENT_SIGNER_PRIVATE_KEY: {
        get: () => {
          throw new Error("signer secret was read");
        },
      },
      SETTLEMENT_VIEWING_KEY: {
        get: () => {
          throw new Error("viewing secret was read");
        },
      },
      STRK20_SCREENING_PARTNER_SECRET: {
        get: () => {
          throw new Error("screening secret was read");
        },
      },
    });

    const exitCode = runTestnetPoolDeploymentPlanCommand({
      environment,
      now: () => new Date(CREATED_AT),
      writeOutput: (value) => output.push(value),
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(JSON.parse(output.join(""))).toMatchObject({
      contract: {
        predictedAddress: PREDICTED_ADDRESS,
        constructorCalldata: [GOVERNANCE_ADMIN, AUDITOR_PUBLIC_KEY, SCREENER_PUBLIC_KEY, "0x1c2"],
      },
      verification: {
        signerMaterialAccepted: false,
        transactionSubmitted: false,
        deploymentApproved: false,
      },
    });
    expect(output.join("")).not.toContain(SETTLEMENT_ACCOUNT);
  });

  it("validates the clock before reading deployment environment values", () => {
    let environmentReads = 0;
    const environment = new Proxy(
      {},
      {
        get() {
          environmentReads += 1;
          throw new Error("environment was read");
        },
      },
    );
    const errors: string[] = [];

    const exitCode = runTestnetPoolDeploymentPlanCommand({
      environment,
      now: () => new Date(Number.NaN),
      writeOutput: () => undefined,
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(environmentReads).toBe(0);
    expect(errors).toEqual(["Testnet pool deployment plan clock is invalid\n"]);
  });

  it("fails closed on incomplete, hostile, or incorrectly scoped environment values", () => {
    const missing = environmentFixture();
    Reflect.deleteProperty(missing, "STRK20_POOL_SCREENER_PUBLIC_KEY");
    expect(() => createTestnetPoolDeploymentPlanInputFromEnvironment(missing, CREATED_AT)).toThrow(
      "Required testnet pool deployment variable STRK20_POOL_SCREENER_PUBLIC_KEY is missing",
    );

    const nonUnique = environmentFixture();
    Reflect.set(nonUnique, "STRK20_POOL_DEPLOYMENT_UNIQUE", "false");
    expect(() =>
      createTestnetPoolDeploymentPlanInputFromEnvironment(nonUnique, CREATED_AT),
    ).toThrow("Testnet pool deployment variable STRK20_POOL_DEPLOYMENT_UNIQUE is invalid");

    const hostile = new Proxy(environmentFixture(), {
      get(target, property, receiver) {
        if (property === "STRK20_POOL_DEPLOYER_ADDRESS") throw new Error("private value");
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => createTestnetPoolDeploymentPlanInputFromEnvironment(hostile, CREATED_AT)).toThrow(
      "Testnet pool deployment variable STRK20_POOL_DEPLOYER_ADDRESS is invalid",
    );
  });

  it("does not turn output callback failures into a successful plan", () => {
    const secret = "writer-secret";
    const errors: string[] = [];

    const exitCode = runTestnetPoolDeploymentPlanCommand({
      environment: environmentFixture(),
      now: () => new Date(CREATED_AT),
      writeOutput: () => {
        throw new Error(secret);
      },
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(errors).toEqual(["Testnet pool deployment planning failed unexpectedly\n"]);
    expect(errors.join("")).not.toContain(secret);
  });
});

function planInput(): TestnetPoolDeploymentPlanInput {
  return {
    createdAt: CREATED_AT,
    network: "SN_SEPOLIA",
    chainId: STARKNET_SEPOLIA_CHAIN_ID,
    poolClassHash: STARKNET_PRIVACY_POOL_CLASS_HASH,
    poolVersion: STARKNET_PRIVACY_POOL_VERSION,
    deployer: DEPLOYER,
    governanceAdmin: GOVERNANCE_ADMIN,
    auditorPublicKey: AUDITOR_PUBLIC_KEY,
    screenerPublicKey: SCREENER_PUBLIC_KEY,
    proofValidityBlocks: "450",
    salt: SALT,
    unique: true,
    settlementAccount: SETTLEMENT_ACCOUNT,
  };
}

function environmentFixture(): Record<string, string> {
  return {
    STARKNET_NETWORK: "sepolia",
    STARKNET_CHAIN_ID: STARKNET_SEPOLIA_CHAIN_ID,
    STRK20_POOL_CLASS_HASH: STARKNET_PRIVACY_POOL_CLASS_HASH,
    STRK20_POOL_VERSION: STARKNET_PRIVACY_POOL_VERSION,
    STRK20_POOL_DEPLOYER_ADDRESS: DEPLOYER,
    STRK20_POOL_GOVERNANCE_ADMIN: GOVERNANCE_ADMIN,
    STRK20_POOL_AUDITOR_PUBLIC_KEY: AUDITOR_PUBLIC_KEY,
    STRK20_POOL_SCREENER_PUBLIC_KEY: SCREENER_PUBLIC_KEY,
    STRK20_POOL_PROOF_VALIDITY_BLOCKS: "450",
    STRK20_POOL_DEPLOYMENT_SALT: SALT,
    STRK20_POOL_DEPLOYMENT_UNIQUE: "true",
    SETTLEMENT_ACCOUNT_ADDRESS: SETTLEMENT_ACCOUNT,
  };
}
