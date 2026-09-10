import { describe, expect, it } from "vitest";

import {
  STARKNET_PRIVACY_POOL_CLASS_HASH,
  STARKNET_PRIVACY_POOL_VERSION,
  STARKNET_PRIVACY_SDK_COMMIT,
  STARKNET_PRIVACY_SDK_VERSION,
} from "./privacy-evidence.js";
import {
  STARKNET_DISCOVERY_SERVICE_COMPONENT_VERSION,
  STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION,
  STARKNET_TRANSACTION_PROVER_API_VERSION,
  STARKNET_TRANSACTION_PROVER_COMPONENT_VERSION,
} from "./privacy-service-compatibility.js";
import {
  STARKNET_DEPLOYMENT_ORIGIN_VERIFIER_VERSION,
  STARKNET_UDC_ADDRESS,
  STARKNET_UDC_CLASS_HASH,
  STARKNET_UDC_CONTRACT_DEPLOYED_SELECTOR,
  type StarknetDeploymentOriginVerification,
} from "./starknet-deployment-origin-verifier.js";
import { STARKNET_DEPLOYMENT_VERIFIER_VERSION } from "./starknet-deployment-verifier.js";
import { STARKNET_DISCOVERY_HEAD_VERIFIER_VERSION } from "./starknet-discovery-head-verifier.js";
import { STARKNET_TRANSACTION_FINALITY_POLICIES } from "./starknet-transaction-observer.js";
import {
  STARKNET_PRIVACY_CONTRACT_PATH,
  STARKNET_PRIVACY_SOURCE_REPOSITORY,
  TESTNET_DEPLOYMENT_MANIFEST_VERIFICATION_SCHEMA_VERSION,
  TESTNET_DEPLOYMENT_MANIFEST_VERIFIER_VERSION,
  type TestnetDeploymentManifestVerificationEvidence,
} from "./testnet-deployment-manifest.js";
import {
  createTestnetDeploymentEvidence,
  createTestnetVerifiedContextEvidence,
  createTestnetVerifiedDeploymentEvidence,
  STARKNET_SEPOLIA_CHAIN_ID,
  TESTNET_CDK_VERSION,
  TESTNET_SCENARIO_EXPECTED_STATES,
  TESTNET_SCENARIOS,
  TESTNET_SCREENING_POLICY,
  TESTNET_STARKNET_JS_VERSION,
  type TestnetDeploymentEvidence,
  type TestnetPreflightConfig,
  type TestnetScenario,
  type TestnetVerifiedContextEvidence,
  type TestnetVerifiedDeploymentEvidence,
} from "./testnet-evidence.js";
import {
  type TestnetScenarioDefinition,
  type TestnetScenarioOutcome,
  TestnetScenarioRunner,
  type TestnetScenarioRunnerConfig,
  TestnetScenarioRunnerConfigurationError,
} from "./testnet-scenario-runner.js";
import {
  TESTNET_PRIVACY_SERVICE_VERIFICATION_SCHEMA_VERSION,
  TESTNET_PRIVACY_SERVICE_VERIFIER_VERSION,
  type TestnetPrivacyServiceVerificationEvidence,
} from "./testnet-service-verifier.js";

const RECORDED_AT = "2026-09-01T18:00:00.000Z";
const VERIFIED_AT = "2026-09-01T18:00:10.000Z";
const SERVICES_VERIFIED_AT = "2026-09-01T18:00:20.000Z";
const STARTED_AT = "2026-09-01T18:04:00.000Z";
const COMPLETED_AT = "2026-09-01T18:05:00.000Z";
const POOL_ADDRESS = "0x52a6aa9d50631626d80b8e6acc9a9918ed8879cc24e793832dcb562e22255dd";
const TOKEN_ADDRESS = "0x6a8d4f1ed931cf91bf5a81d0d1f4101f6fe8584d9d857f1226a128cc6529cb6";

describe("testnet scenario runner", () => {
  it("runs every canonical scenario sequentially and emits a profile-bound envelope", async () => {
    const executed: TestnetScenario[] = [];
    let inFlight = false;
    const runner = new TestnetScenarioRunner(
      runnerConfig({
        scenarios: scenarioDefinitions(async (scenario, index) => {
          expect(inFlight).toBe(false);
          inFlight = true;
          await Promise.resolve();
          executed.push(scenario);
          inFlight = false;
          return {
            kind: "OBSERVED",
            observedState: TESTNET_SCENARIO_EXPECTED_STATES[scenario],
            retryCount: index,
            ...(index === 0
              ? {
                  provingMilliseconds: 25,
                  finalityMilliseconds: 50,
                  feeFri: "123",
                  publicTransactions: [
                    {
                      transactionReference: "0x0111",
                      blockHash: "0x0aaa",
                      blockNumber: 105n,
                      disclosureApproved: true,
                    },
                    {
                      transactionReference: "private-transaction-reference",
                      blockHash: "private-block-hash",
                      blockNumber: 106n,
                      disclosureApproved: false,
                    },
                  ],
                }
              : {}),
          };
        }),
      }),
    );

    expect(runner.state).toBe("IDLE");
    const evidence = await runner.run();

    expect(runner.state).toBe("COMPLETED");
    expect(executed).toEqual(TESTNET_SCENARIOS);
    expect(evidence.run.run).toEqual({
      command: ["pnpm", "--filter", "@cashu-strk20/settlement", "test:testnet"],
      startedAt: STARTED_AT,
      completedAt: COMPLETED_AT,
      observedBlockRange: { first: "101", last: "110" },
    });
    expect(evidence.run.scenarios).toHaveLength(TESTNET_SCENARIOS.length);
    expect(evidence.run.scenarios.every(({ result }) => result === "PASSED")).toBe(true);
    expect(
      evidence.run.scenarios.every(({ durationMilliseconds }) => durationMilliseconds === 1),
    ).toBe(true);
    expect(evidence.run.scenarios[0]).toMatchObject({
      scenario: "incoming_attribution",
      expectedState: "PAID",
      observedState: "PAID",
      retryCount: 0,
      provingMilliseconds: 25,
      finalityMilliseconds: 50,
      feeFri: "123",
      publicTransactions: [
        { transactionReference: "0x111", blockHash: "0xaaa", blockNumber: "105" },
      ],
    });
    expect(evidence.scenarioCoverage).toEqual({
      required: TESTNET_SCENARIOS.length,
      present: TESTNET_SCENARIOS.length,
      passed: TESTNET_SCENARIOS.length,
      missing: [],
      notPassed: [],
    });
    expect(evidence.verification).toMatchObject({
      executionAttested: false,
      artifactAuthenticated: false,
      fundedExecutionApproved: false,
    });
    expect(JSON.stringify(evidence)).not.toContain("private-transaction-reference");
    expect(JSON.stringify(evidence)).not.toContain("private-block-hash");
  });

  it("stops after an observed-state mismatch and marks the remainder as operator-stopped", async () => {
    const executed: TestnetScenario[] = [];
    const runner = new TestnetScenarioRunner(
      runnerConfig({
        scenarios: scenarioDefinitions((scenario, index) => {
          executed.push(scenario);
          return {
            kind: "OBSERVED",
            observedState: index === 0 ? "REVERTED" : TESTNET_SCENARIO_EXPECTED_STATES[scenario],
            retryCount: 0,
          };
        }),
      }),
    );

    const evidence = await runner.run();

    expect(executed).toEqual(["incoming_attribution"]);
    expect(evidence.run.scenarios[0]).toMatchObject({
      result: "FAILED",
      expectedState: "PAID",
      observedState: "REVERTED",
      resultCode: "assertion_failed",
    });
    expect(evidence.run.scenarios.slice(1)).toHaveLength(TESTNET_SCENARIOS.length - 1);
    expect(
      evidence.run.scenarios
        .slice(1)
        .every(
          ({ result, observedState, resultCode, durationMilliseconds }) =>
            result === "SKIPPED" &&
            observedState === "NOT_RUN" &&
            resultCode === "operator_stopped" &&
            durationMilliseconds === 0,
        ),
    ).toBe(true);
    expect(evidence.scenarioCoverage.notPassed).toEqual(TESTNET_SCENARIOS);
  });

  it("redacts a thrown callback error and records an operator-required failure", async () => {
    const secret = "credential-bearing-scenario-failure";
    const runner = new TestnetScenarioRunner(
      runnerConfig({
        scenarios: scenarioDefinitions(() => {
          throw new Error(secret);
        }),
      }),
    );

    const evidence = await runner.run();
    const serialized = JSON.stringify(evidence);

    expect(evidence.run.scenarios[0]).toMatchObject({
      result: "FAILED",
      observedState: "OPERATOR_REQUIRED",
      resultCode: "assertion_failed",
    });
    expect(serialized).not.toContain(secret);
    expect(evidence.run.scenarios.slice(1).every(({ result }) => result === "SKIPPED")).toBe(true);
  });

  it("preserves an explicit skip reason and stops before later callbacks", async () => {
    let calls = 0;
    const runner = new TestnetScenarioRunner(
      runnerConfig({
        scenarios: scenarioDefinitions(() => {
          calls += 1;
          return { kind: "SKIPPED", resultCode: "credentials_unavailable" };
        }),
      }),
    );

    const evidence = await runner.run();

    expect(calls).toBe(1);
    expect(evidence.run.scenarios[0]).toMatchObject({
      result: "SKIPPED",
      observedState: "NOT_RUN",
      resultCode: "credentials_unavailable",
    });
    expect(evidence.run.scenarios[1]).toMatchObject({
      result: "SKIPPED",
      resultCode: "operator_stopped",
    });
  });

  it("rejects malformed configuration before reading blocks or executing scenarios", () => {
    let blockReads = 0;
    let scenarioCalls = 0;
    const callbacks = {
      readAcceptedBlockNumber: async () => {
        blockReads += 1;
        return 100n;
      },
      scenarios: scenarioDefinitions((scenario) => {
        scenarioCalls += 1;
        return observedFinal(scenario);
      }),
    };
    const reordered = [...callbacks.scenarios];
    const first = requiredValue(reordered[0]);
    reordered[0] = requiredValue(reordered[1]);
    reordered[1] = first;
    const sparse = [...callbacks.scenarios];
    delete sparse[1];
    const verifiedContext = verifiedContextEvidence();
    const sparseProviderIds = new Array<string>(2);
    sparseProviderIds[0] = "rpc-primary";
    const malformedContext = {
      ...verifiedContext,
      verifiedDeployment: {
        ...verifiedContext.verifiedDeployment,
        verification: {
          ...verifiedContext.verifiedDeployment.verification,
          providerIds: sparseProviderIds,
        },
      },
    } as TestnetVerifiedContextEvidence;

    for (const config of [
      runnerConfig({ ...callbacks, scenarios: reordered }),
      runnerConfig({ ...callbacks, scenarios: sparse }),
      runnerConfig({ ...callbacks, command: ["pnpm", "TOKEN=private-value"] }),
      runnerConfig({ ...callbacks, verifiedContext: malformedContext }),
    ]) {
      expect(() => new TestnetScenarioRunner(config)).toThrow(
        TestnetScenarioRunnerConfigurationError,
      );
    }
    expect(blockReads).toBe(0);
    expect(scenarioCalls).toBe(0);
  });

  it("rejects late context verification before reading blocks or executing scenarios", async () => {
    let blockReads = 0;
    let scenarioCalls = 0;
    const verifiedDeployment = verifiedDeploymentEvidence();
    const service = serviceVerificationEvidence(verifiedDeployment.deployment);
    const verifiedAt = "2026-09-01T18:04:01.000Z";
    const blockTimestamp = Math.floor(Date.parse(verifiedAt) / 1_000);
    const verifiedContext = createTestnetVerifiedContextEvidence({
      verifiedDeployment,
      serviceVerification: {
        ...service,
        verifiedAt,
        services: {
          ...service.services,
          discovery: {
            ...service.services.discovery,
            indexedHead: { ...service.services.discovery.indexedHead, blockTimestamp },
          },
        },
        chainVerification: { ...service.chainVerification, blockTimestamp },
      },
    });
    const runner = new TestnetScenarioRunner(
      runnerConfig({
        verifiedContext,
        readAcceptedBlockNumber: async () => {
          blockReads += 1;
          return 100n;
        },
        scenarios: scenarioDefinitions((scenario) => {
          scenarioCalls += 1;
          return observedFinal(scenario);
        }),
      }),
    );

    await expect(runner.run()).rejects.toMatchObject({ code: "evidence_invalid" });
    expect(runner.state).toBe("FAILED");
    expect(blockReads).toBe(0);
    expect(scenarioCalls).toBe(0);
  });

  it("rejects a context head after the first block before executing scenarios", async () => {
    let blockReads = 0;
    let scenarioCalls = 0;
    const verifiedDeployment = verifiedDeploymentEvidence();
    const service = serviceVerificationEvidence(verifiedDeployment.deployment);
    const verifiedContext = createTestnetVerifiedContextEvidence({
      verifiedDeployment,
      serviceVerification: {
        ...service,
        services: {
          ...service.services,
          discovery: {
            ...service.services.discovery,
            indexedHead: { ...service.services.discovery.indexedHead, blockNumber: 102 },
          },
        },
        chainVerification: { ...service.chainVerification, blockNumber: 102 },
      },
    });
    const runner = new TestnetScenarioRunner(
      runnerConfig({
        verifiedContext,
        readAcceptedBlockNumber: async () => {
          blockReads += 1;
          return 101n;
        },
        scenarios: scenarioDefinitions((scenario) => {
          scenarioCalls += 1;
          return observedFinal(scenario);
        }),
      }),
    );

    await expect(runner.run()).rejects.toMatchObject({ code: "evidence_invalid" });
    expect(runner.state).toBe("FAILED");
    expect(blockReads).toBe(1);
    expect(scenarioCalls).toBe(0);
  });

  it("returns value-free errors for unavailable, invalid, and reversed block boundaries", async () => {
    const secret = "private-provider-error";
    const unavailable = new TestnetScenarioRunner(
      runnerConfig({
        readAcceptedBlockNumber: async () => {
          throw new Error(secret);
        },
      }),
    );
    const invalid = new TestnetScenarioRunner(
      runnerConfig({ readAcceptedBlockNumber: blockNumbers((1n << 64n).toString()) }),
    );
    const oversized = new TestnetScenarioRunner(
      runnerConfig({ readAcceptedBlockNumber: blockNumbers("9".repeat(1_000)) }),
    );
    const reversed = new TestnetScenarioRunner(
      runnerConfig({ readAcceptedBlockNumber: blockNumbers(111n, 110n) }),
    );

    for (const runner of [unavailable, invalid, oversized, reversed]) {
      try {
        await runner.run();
        expect.unreachable("Invalid block boundary was accepted");
      } catch (error) {
        expect(error).toMatchObject({ code: "block_source_failure" });
        expect((error as Error).message).not.toContain(secret);
      }
      expect(runner.state).toBe("FAILED");
    }
  });

  it("permits only one run, including while the first invocation is active", async () => {
    let releaseFirstScenario: (() => void) | undefined;
    const firstScenarioGate = new Promise<void>((resolve) => {
      releaseFirstScenario = resolve;
    });
    const runner = new TestnetScenarioRunner(
      runnerConfig({
        scenarios: scenarioDefinitions(async (scenario, index) => {
          if (index === 0) {
            await firstScenarioGate;
          }
          return observedFinal(scenario);
        }),
      }),
    );

    const firstRun = runner.run();
    expect(runner.state).toBe("RUNNING");
    await expect(runner.run()).rejects.toMatchObject({ code: "already_run" });
    requiredValue(releaseFirstScenario)();
    await expect(firstRun).resolves.toMatchObject({
      scenarioCoverage: { passed: TESTNET_SCENARIOS.length },
    });
    expect(runner.state).toBe("COMPLETED");
    await expect(runner.run()).rejects.toMatchObject({ code: "already_run" });
    expect(runner.state).toBe("COMPLETED");
  });

  it("turns malformed callback output into redacted failure evidence", async () => {
    const secret = "private-callback-payload";
    const outcome = {
      kind: "OBSERVED",
      observedState: "FINAL",
      retryCount: 0,
      rawError: secret,
      publicTransactions: [
        {
          transactionReference: "0x111",
          blockHash: "0xaaa",
          blockNumber: "105",
          disclosureApproved: secret,
        },
      ],
    } as unknown as TestnetScenarioOutcome;
    const runner = new TestnetScenarioRunner(
      runnerConfig({ scenarios: scenarioDefinitions(() => outcome) }),
    );

    const evidence = await runner.run();

    expect(evidence.run.scenarios[0]).toMatchObject({
      result: "FAILED",
      observedState: "OPERATOR_REQUIRED",
      resultCode: "assertion_failed",
      publicTransactions: [],
    });
    expect(JSON.stringify(evidence)).not.toContain(secret);
  });

  it.each([
    {
      name: "an oversized fee",
      outcome: {
        kind: "OBSERVED",
        observedState: "FINAL",
        retryCount: 0,
        feeFri: "9".repeat(79),
      },
    },
    {
      name: "too many public transactions",
      outcome: {
        kind: "OBSERVED",
        observedState: "FINAL",
        retryCount: 0,
        publicTransactions: Array.from({ length: 9 }, (_, index) => ({
          transactionReference: `0x${index + 1}`,
          blockHash: `0x${index + 101}`,
          blockNumber: "105",
          disclosureApproved: true,
        })),
      },
    },
  ])("turns $name into bounded failure evidence", async ({ outcome }) => {
    const runner = new TestnetScenarioRunner(
      runnerConfig({
        scenarios: scenarioDefinitions(() => outcome as TestnetScenarioOutcome),
      }),
    );

    const evidence = await runner.run();

    expect(evidence.run.scenarios[0]).toMatchObject({
      result: "FAILED",
      observedState: "OPERATOR_REQUIRED",
      resultCode: "assertion_failed",
    });
    expect(evidence.run.scenarios.slice(1).every(({ result }) => result === "SKIPPED")).toBe(true);
  });

  it("fails with a fixed error when monotonic or wall-clock time moves backward", async () => {
    const monotonic = new TestnetScenarioRunner(
      runnerConfig({ monotonicNow: numberSequence(10, 9) }),
    );
    const wallClock = new TestnetScenarioRunner(
      runnerConfig({ now: dateSequence(COMPLETED_AT, STARTED_AT) }),
    );

    for (const runner of [monotonic, wallClock]) {
      await expect(runner.run()).rejects.toMatchObject({ code: "clock_invalid" });
      expect(runner.state).toBe("FAILED");
    }
  });
});

function runnerConfig(
  overrides: Partial<TestnetScenarioRunnerConfig> = {},
): TestnetScenarioRunnerConfig {
  return {
    verifiedContext: verifiedContextEvidence(),
    command: ["pnpm", "--filter", "@cashu-strk20/settlement", "test:testnet"],
    scenarios: scenarioDefinitions(),
    readAcceptedBlockNumber: blockNumbers(101n, 110n),
    now: dateSequence(STARTED_AT, COMPLETED_AT),
    monotonicNow: incrementingMonotonicClock(),
    ...overrides,
  };
}

function scenarioDefinitions(
  execute: (
    scenario: TestnetScenario,
    index: number,
  ) => Promise<TestnetScenarioOutcome> | TestnetScenarioOutcome = observedFinal,
): TestnetScenarioDefinition[] {
  return TESTNET_SCENARIOS.map((scenario, index) => ({
    scenario,
    execute: async () => execute(scenario, index),
  }));
}

function observedFinal(scenario: TestnetScenario): TestnetScenarioOutcome {
  return {
    kind: "OBSERVED",
    observedState: TESTNET_SCENARIO_EXPECTED_STATES[scenario],
    retryCount: 0,
  };
}

function blockNumbers(...values: readonly (bigint | string)[]): () => Promise<unknown> {
  let index = 0;
  return async () => requiredValue(values[index++]);
}

function dateSequence(...values: readonly string[]): () => Date {
  let index = 0;
  return () => new Date(requiredValue(values[index++]));
}

function numberSequence(...values: readonly number[]): () => number {
  let index = 0;
  return () => requiredValue(values[index++]);
}

function incrementingMonotonicClock(): () => number {
  let value = 0;
  return () => {
    const current = value;
    value += 0.25;
    return current;
  };
}

function verifiedDeploymentEvidence(): TestnetVerifiedDeploymentEvidence {
  const deployment = createTestnetDeploymentEvidence(preflightConfig());
  const manifestVerification = deploymentManifestVerification(deployment);
  return createTestnetVerifiedDeploymentEvidence({
    deployment,
    manifestVerification,
    originVerification: deploymentOriginVerification(deployment, manifestVerification),
    verification: {
      blockHash: "0xbeef",
      blockNumber: 100n,
      blockTimestamp: Math.floor(Date.parse(RECORDED_AT) / 1_000),
      poolClassHash: STARKNET_PRIVACY_POOL_CLASS_HASH,
      tokenClassHash: "0x222",
      accountClassHash: "0xabc",
      providerIds: ["rpc-primary", "rpc-secondary"],
      verifierVersion: STARKNET_DEPLOYMENT_VERIFIER_VERSION,
    },
    verifiedAt: VERIFIED_AT,
  });
}

function deploymentOriginVerification(
  deployment: TestnetDeploymentEvidence,
  manifestVerification: TestnetDeploymentManifestVerificationEvidence,
): StarknetDeploymentOriginVerification {
  const pool = manifestVerification.contracts[0];
  const token = manifestVerification.contracts[1];
  return {
    network: "SN_SEPOLIA",
    finalityPolicy: deployment.finalityPolicy,
    udcAddress: STARKNET_UDC_ADDRESS,
    udcClassHash: STARKNET_UDC_CLASS_HASH,
    deploymentEventSelector: STARKNET_UDC_CONTRACT_DEPLOYED_SELECTOR,
    contracts: [
      {
        role: "privacy_pool",
        address: pool.address,
        classHash: pool.classHash,
        transactionReference: pool.deployment.transactionReference,
        blockHash: pool.deployment.acceptedBlockHash,
        blockNumber: BigInt(pool.deployment.acceptedBlockNumber),
        deployer: pool.deployment.deployer,
        salt: pool.deployment.salt,
        unique: pool.deployment.unique,
        constructorCalldata: pool.deployment.constructorCalldata,
      },
      {
        role: "usdc_token",
        address: token.address,
        classHash: token.classHash,
        transactionReference: token.deployment.transactionReference,
        blockHash: token.deployment.acceptedBlockHash,
        blockNumber: BigInt(token.deployment.acceptedBlockNumber),
        deployer: token.deployment.deployer,
        salt: token.deployment.salt,
        unique: token.deployment.unique,
        constructorCalldata: token.deployment.constructorCalldata,
      },
    ],
    providerIds: ["rpc-primary", "rpc-secondary"],
    verifierVersion: STARKNET_DEPLOYMENT_ORIGIN_VERIFIER_VERSION,
  };
}

function deploymentManifestVerification(
  deployment: TestnetDeploymentEvidence,
): TestnetDeploymentManifestVerificationEvidence {
  return {
    schemaVersion: TESTNET_DEPLOYMENT_MANIFEST_VERIFICATION_SCHEMA_VERSION,
    verifierVersion: TESTNET_DEPLOYMENT_MANIFEST_VERIFIER_VERSION,
    verifiedAt: "2026-09-01T18:00:05.000Z",
    network: "SN_SEPOLIA",
    chainId: STARKNET_SEPOLIA_CHAIN_ID,
    contracts: [
      {
        role: "privacy_pool",
        address: deployment.pool.address,
        classHash: deployment.pool.classHash,
        version: deployment.pool.version,
        source: {
          repository: STARKNET_PRIVACY_SOURCE_REPOSITORY,
          commit: STARKNET_PRIVACY_SDK_COMMIT,
          contractPath: STARKNET_PRIVACY_CONTRACT_PATH,
        },
        deployment: {
          transactionReference: deployment.pool.deployment.transactionReference,
          acceptedBlockHash: "0xaaa",
          acceptedBlockNumber: "99",
          deployer: "0x777",
          salt: "0x1",
          unique: false,
          constructorCalldata: ["0x777", "0x111", "0x222", "0x1c2"],
        },
        configuration: {
          governanceAdmin: "0x777",
          auditorPublicKey: "0x111",
          screenerPublicKey: "0x222",
          proofValidityBlocks: "450",
        },
        manifestUrl: deployment.pool.deployment.manifestUrl,
        manifestSha256: deployment.pool.deployment.manifestSha256,
        manifestBytes: 1_024,
      },
      {
        role: "usdc_token",
        address: deployment.token.address,
        classHash: deployment.token.classHash,
        version: deployment.token.version,
        source: {
          repository: "https://github.com/example/test-usdc",
          commit: "c".repeat(40),
          contractPath: "src/TestUsdc.cairo",
        },
        deployment: {
          transactionReference: deployment.token.deployment.transactionReference,
          acceptedBlockHash: "0xbbb",
          acceptedBlockNumber: "100",
          deployer: "0x777",
          salt: "0x2",
          unique: true,
          constructorCalldata: [],
        },
        configuration: {
          symbol: "USDC",
          decimals: 6,
          mintAuthority: "0x778",
          supplyPolicy: "capped_test_supply_v1",
          maximumSupplyBaseUnits: "1000000000",
        },
        manifestUrl: deployment.token.deployment.manifestUrl,
        manifestSha256: deployment.token.deployment.manifestSha256,
        manifestBytes: 768,
      },
    ],
    verification: {
      manifestBytesRetrieved: true,
      manifestHashesMatch: true,
      canonicalJsonVerified: true,
      contractProfilesMatch: true,
      poolConstructorMatchesPinnedAbi: true,
      sourcePublishersAuthenticated: false,
      transactionReceiptsVerified: false,
      deploymentApproved: false,
    },
    blockers: [
      "manifest_publishers_unauthenticated",
      "deployment_transactions_unverified",
      "deployment_approval_required",
    ],
  };
}

function verifiedContextEvidence(): TestnetVerifiedContextEvidence {
  const verifiedDeployment = verifiedDeploymentEvidence();
  return createTestnetVerifiedContextEvidence({
    verifiedDeployment,
    serviceVerification: serviceVerificationEvidence(verifiedDeployment.deployment),
  });
}

function serviceVerificationEvidence(
  profile: TestnetVerifiedDeploymentEvidence["deployment"],
): TestnetPrivacyServiceVerificationEvidence {
  const blockTimestamp = Math.floor(Date.parse(RECORDED_AT) / 1_000);
  return {
    schemaVersion: TESTNET_PRIVACY_SERVICE_VERIFICATION_SCHEMA_VERSION,
    verifierVersion: TESTNET_PRIVACY_SERVICE_VERIFIER_VERSION,
    verifiedAt: SERVICES_VERIFIED_AT,
    network: "SN_SEPOLIA",
    profile,
    services: {
      prover: {
        operator: "prover-one",
        configuredComponentVersion: STARKNET_TRANSACTION_PROVER_COMPONENT_VERSION,
        apiVersion: STARKNET_TRANSACTION_PROVER_API_VERSION,
      },
      discovery: {
        operator: "indexer-one",
        configuredComponentVersion: STARKNET_DISCOVERY_SERVICE_COMPONENT_VERSION,
        status: "OK",
        indexedHead: {
          blockNumber: 101,
          blockHash: "0xabc",
          blockTimestamp,
          reportedLagSeconds: 1,
        },
      },
      screening: {
        interceptorOperator: "interceptor-one",
        screeningProviderOperator: "screener-one",
        configuredComponentVersion: STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION,
        healthStatus: "ok",
        rpcProviderId: "rpc-primary",
      },
    },
    chainVerification: {
      blockNumber: 101,
      blockHash: "0xabc",
      blockTimestamp,
      minimumAcceptedStatus: "ACCEPTED_ON_L2",
      providerIds: ["rpc-primary", "rpc-secondary"],
      verifierVersion: STARKNET_DISCOVERY_HEAD_VERIFIER_VERSION,
    },
    verification: {
      proverApiCompatible: true,
      discoveryHealthCompatible: true,
      discoveryHeadFresh: true,
      noTransactionSubmitted: true,
      noCashuOrTransactionDataSent: true,
      proverRuntimeVersionVerified: false,
      discoveryRuntimeVersionVerified: false,
      proofInterceptorRuntimeVersionVerified: false,
      discoveryChainStateVerified: true,
      proverChainIdentityVerified: false,
      proofInterceptorHealthCompatible: true,
      screeningRuntimeConfigurationVerified: false,
      screeningActivityVerified: false,
      remoteRuntimeImageVerified: false,
      deploymentApproved: false,
    },
    blockers: [
      "prover_runtime_version_unverifiable",
      "discovery_runtime_version_unverifiable",
      "proof_interceptor_runtime_version_unverifiable",
      "prover_chain_identity_unverified",
      "screening_runtime_configuration_unverified",
      "screening_activity_unverified",
      "remote_runtime_image_unverified",
      "service_contract_bindings_unverified",
    ],
  };
}

function preflightConfig(): TestnetPreflightConfig {
  return {
    network: "SN_SEPOLIA",
    chainId: STARKNET_SEPOLIA_CHAIN_ID,
    recordedAt: RECORDED_AT,
    pool: {
      address: POOL_ADDRESS,
      classHash: STARKNET_PRIVACY_POOL_CLASS_HASH,
      version: STARKNET_PRIVACY_POOL_VERSION,
      deployment: {
        transactionReference: "0xaaa",
        manifestUrl: "https://deployments.example/immutable/sepolia-pool.json",
        manifestSha256: "a".repeat(64),
      },
    },
    token: {
      address: TOKEN_ADDRESS,
      classHash: "0x0222",
      version: "usdc-test-v1",
      symbol: "USDC",
      decimals: 6,
      deployment: {
        transactionReference: "0xbbb",
        manifestUrl: "https://deployments.example/immutable/sepolia-usdc.json",
        manifestSha256: "b".repeat(64),
      },
    },
    account: { address: "0x0789", classHash: "0x0abc", version: "oz-account-v1" },
    rpcProviders: [
      {
        id: "rpc-primary",
        operator: "provider-one",
        url: "https://rpc-one.example/v1/private-path?api_key=secret-one",
      },
      {
        id: "rpc-secondary",
        operator: "provider-two",
        url: "https://rpc-two.example/v1/private-path?api_key=secret-two",
      },
    ],
    prover: {
      operator: "prover-one",
      url: "https://prover.example/prove?credential=private",
      version: STARKNET_TRANSACTION_PROVER_COMPONENT_VERSION,
    },
    discovery: {
      operator: "indexer-one",
      url: "https://discovery.example/private-discovery",
      version: STARKNET_DISCOVERY_SERVICE_COMPONENT_VERSION,
    },
    screening: {
      interceptor: {
        operator: "interceptor-one",
        url: "https://interceptor.example",
        version: STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION,
      },
      provider: { operator: "screener-one", url: "https://screening.example/private-screening" },
      rpcProviderId: "rpc-primary",
      poolAddress: POOL_ADDRESS,
      policy: TESTNET_SCREENING_POLICY,
      blockNonPoolTransactions: true,
      interceptorFailOpen: false,
      proverFailOpen: false,
    },
    walletApiVersion: "wallet-api-v1",
    privacySdkVersion: STARKNET_PRIVACY_SDK_VERSION,
    privacySdkCommit: STARKNET_PRIVACY_SDK_COMMIT,
    starknetJsVersion: TESTNET_STARKNET_JS_VERSION,
    cdkVersion: TESTNET_CDK_VERSION,
    finalityPolicy: STARKNET_TRANSACTION_FINALITY_POLICIES.L1,
    provingPolicy: {
      blocksBehind: 8,
      minimumRemainingValidityBlocks: 16,
      maximumHeadLagBlocks: 3,
      maximumBlockAgeSeconds: 300,
      maximumFutureBlockTimeSeconds: 30,
      requestTimeoutMilliseconds: 10_000,
    },
    signerPrivateKey: "0xdeadbeef",
    viewingKey: "0xcafebabe",
    screeningCredentials: {
      partnerName: "partner-one",
      partnerSecret: "c2NyZWVuaW5nLXNlY3JldA==",
    },
    safety: { testOnlyAccount: true, cappedFunds: true },
  };
}

function requiredValue<Value>(value: Value | undefined): Value {
  if (value === undefined) {
    throw new Error("Test fixture is incomplete");
  }
  return value;
}
