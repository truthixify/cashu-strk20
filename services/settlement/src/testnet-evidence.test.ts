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
import {
  STARKNET_DEPLOYMENT_VERIFIER_VERSION,
  type StarknetDeploymentVerification,
} from "./starknet-deployment-verifier.js";
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
  assertTestnetPreflightSecrets,
  createTestnetDeploymentEvidence,
  createTestnetRunEvidence,
  createTestnetVerifiedContextEvidence,
  createTestnetVerifiedDeploymentEvidence,
  createTestnetVerifiedRunEvidence,
  reconstructTestnetVerifiedRunEvidence,
  STARKNET_SEPOLIA_CHAIN_ID,
  serializeTestnetVerifiedRunEvidence,
  TESTNET_CDK_VERSION,
  TESTNET_EVIDENCE_SCHEMA_VERSION,
  TESTNET_SCENARIO_EXPECTED_STATES,
  TESTNET_SCENARIOS,
  TESTNET_SCREENING_POLICY,
  TESTNET_STARKNET_JS_VERSION,
  TESTNET_VERIFIED_CONTEXT_SCHEMA_VERSION,
  TESTNET_VERIFIED_RUN_SCHEMA_VERSION,
  type TestnetDeploymentEvidence,
  type TestnetPreflightConfig,
  type TestnetResultCode,
  type TestnetRunEvidence,
  type TestnetRunEvidenceInput,
  type TestnetVerifiedContextEvidence,
  type TestnetVerifiedDeploymentEvidence,
  validateTestnetVerifiedContextForRun,
} from "./testnet-evidence.js";
import {
  MAXIMUM_TESTNET_EVIDENCE_INPUT_BYTES,
  runTestnetEvidenceValidationCommand,
} from "./testnet-evidence-command.js";
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
const SIGNER_PRIVATE_KEY = "0xdeadbeef";
const VIEWING_KEY = "0xcafebabe";
const ACCOUNT_ADDRESS = "0x789";
const POOL_ADDRESS = "0x52a6aa9d50631626d80b8e6acc9a9918ed8879cc24e793832dcb562e22255dd";
const TOKEN_ADDRESS = "0x6a8d4f1ed931cf91bf5a81d0d1f4101f6fe8584d9d857f1226a128cc6529cb6";
const PRIMARY_RPC_URL = "https://rpc-one.example/v1/private-path?api_key=secret-one";
const SECONDARY_RPC_URL = "https://rpc-two.example/v1/private-path?api_key=secret-two";
const SCREENING_PARTNER_SECRET = "c2NyZWVuaW5nLXNlY3JldA==";
const PROOF_INTERCEPTOR_URL = "https://interceptor.example";
const SCREENING_PROVIDER_URL = "https://screening.example/private-screening";
const POOL_DEPLOYMENT = {
  transactionReference: "0xaaa",
  manifestUrl: "https://deployments.example/immutable/sepolia-pool.json",
  manifestSha256: "a".repeat(64),
} as const;
const TOKEN_DEPLOYMENT = {
  transactionReference: "0xbbb",
  manifestUrl: "https://deployments.example/immutable/sepolia-usdc.json",
  manifestSha256: "b".repeat(64),
} as const;

describe("testnet evidence", () => {
  it("validates the pinned Sepolia profile and returns only public fields", () => {
    const evidence = createTestnetDeploymentEvidence(preflightConfig());

    expect(evidence).toEqual({
      schemaVersion: TESTNET_EVIDENCE_SCHEMA_VERSION,
      recordedAt: RECORDED_AT,
      network: "SN_SEPOLIA",
      chainId: STARKNET_SEPOLIA_CHAIN_ID,
      attributionProfile: "signed_payer",
      pool: {
        address: POOL_ADDRESS,
        classHash: STARKNET_PRIVACY_POOL_CLASS_HASH,
        version: STARKNET_PRIVACY_POOL_VERSION,
        deployment: POOL_DEPLOYMENT,
      },
      token: {
        address: TOKEN_ADDRESS,
        classHash: "0x222",
        version: "usdc-test-v1",
        symbol: "USDC",
        decimals: 6,
        deployment: TOKEN_DEPLOYMENT,
      },
      account: { classHash: "0xabc", version: "oz-account-v1" },
      rpcProviders: [
        { id: "rpc-primary", operator: "provider-one" },
        { id: "rpc-secondary", operator: "provider-two" },
      ],
      services: {
        prover: {
          operator: "prover-one",
          version: STARKNET_TRANSACTION_PROVER_COMPONENT_VERSION,
        },
        discovery: {
          operator: "indexer-one",
          version: STARKNET_DISCOVERY_SERVICE_COMPONENT_VERSION,
        },
        screening: {
          interceptor: {
            operator: "interceptor-one",
            version: STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION,
          },
          provider: { operator: "screener-one" },
          rpcProviderId: "rpc-primary",
          configuredPolicy: TESTNET_SCREENING_POLICY,
          configuredPoolMatchesDeployment: true,
          configuredBlockNonPoolTransactions: true,
          configuredInterceptorFailOpen: false,
          configuredProverFailOpen: false,
        },
        walletApiVersion: "wallet-api-v1",
      },
      components: {
        nodeVersion: process.versions.node,
        privacySdkVersion: STARKNET_PRIVACY_SDK_VERSION,
        privacySdkCommit: STARKNET_PRIVACY_SDK_COMMIT,
        starknetJsVersion: TESTNET_STARKNET_JS_VERSION,
        cdkVersion: TESTNET_CDK_VERSION,
      },
      finalityPolicy: STARKNET_TRANSACTION_FINALITY_POLICIES.L1,
      provingPolicy: {
        blocksBehind: 8,
        minimumRemainingValidityBlocks: 16,
        maximumHeadLagBlocks: 3,
        maximumBlockAgeSeconds: 300,
        maximumFutureBlockTimeSeconds: 30,
        requestTimeoutMilliseconds: 10_000,
      },
      safety: { testOnlyAccount: true, cappedFunds: true },
    });

    const serialized = JSON.stringify(evidence);
    for (const hidden of [
      SIGNER_PRIVATE_KEY,
      VIEWING_KEY,
      ACCOUNT_ADDRESS,
      PRIMARY_RPC_URL,
      SECONDARY_RPC_URL,
      "secret-one",
      "secret-two",
      "prover.example",
      "discovery.example",
      PROOF_INTERCEPTOR_URL,
      SCREENING_PROVIDER_URL,
      SCREENING_PARTNER_SECRET,
    ]) {
      expect(serialized).not.toContain(hidden);
    }
  });

  it.each([
    {
      name: "Privacy SDK release",
      mutate: (config: TestnetPreflightConfig) => ({ ...config, privacySdkVersion: "0.14.4" }),
    },
    {
      name: "Privacy SDK commit",
      mutate: (config: TestnetPreflightConfig) => ({ ...config, privacySdkCommit: "f".repeat(40) }),
    },
    {
      name: "privacy pool class",
      mutate: (config: TestnetPreflightConfig) => ({
        ...config,
        pool: { ...config.pool, classHash: "0x111" },
      }),
    },
    {
      name: "privacy pool version",
      mutate: (config: TestnetPreflightConfig) => ({
        ...config,
        pool: { ...config.pool, version: "PRIVACY-0.14.3-RC.0" },
      }),
    },
    {
      name: "Starknet.js release",
      mutate: (config: TestnetPreflightConfig) => ({ ...config, starknetJsVersion: "10.6.0" }),
    },
    {
      name: "CDK release",
      mutate: (config: TestnetPreflightConfig) => ({ ...config, cdkVersion: "0.18.0-rc.2" }),
    },
    {
      name: "proof interceptor release",
      mutate: (config: TestnetPreflightConfig) => ({
        ...config,
        screening: {
          ...config.screening,
          interceptor: { ...config.screening.interceptor, version: "PRIVACY-0.14.3-RC.7" },
        },
      }),
    },
  ])("rejects a mismatched $name pin", ({ mutate }) => {
    expect(() => createTestnetDeploymentEvidence(mutate(preflightConfig()))).toThrow(
      expect.objectContaining({ code: "version_mismatch" }),
    );
  });

  it.each([
    {
      name: "mainnet network",
      mutate: (config: TestnetPreflightConfig) => ({ ...config, network: "SN_MAIN" as const }),
    },
    {
      name: "mainnet chain ID",
      mutate: (config: TestnetPreflightConfig) => ({ ...config, chainId: "0x534e5f4d41494e" }),
    },
    {
      name: "wrong token symbol",
      mutate: (config: TestnetPreflightConfig) => ({
        ...config,
        token: { ...config.token, symbol: "USDT" },
      }),
    },
    {
      name: "wrong token decimals",
      mutate: (config: TestnetPreflightConfig) => ({
        ...config,
        token: { ...config.token, decimals: 18 },
      }),
    },
    {
      name: "uncapped funds",
      mutate: (config: TestnetPreflightConfig) => ({
        ...config,
        safety: { ...config.safety, cappedFunds: false },
      }),
    },
    {
      name: "screening pool substitution",
      mutate: (config: TestnetPreflightConfig) => ({
        ...config,
        screening: { ...config.screening, poolAddress: "0x999" },
      }),
    },
    {
      name: "unknown screening RPC provider",
      mutate: (config: TestnetPreflightConfig) => ({
        ...config,
        screening: { ...config.screening, rpcProviderId: "rpc-unknown" },
      }),
    },
    {
      name: "non-pool transaction pass-through",
      mutate: (config: TestnetPreflightConfig) => ({
        ...config,
        screening: { ...config.screening, blockNonPoolTransactions: false },
      }),
    },
    {
      name: "fail-open proof interceptor",
      mutate: (config: TestnetPreflightConfig) => ({
        ...config,
        screening: { ...config.screening, interceptorFailOpen: true },
      }),
    },
    {
      name: "fail-open prover screening",
      mutate: (config: TestnetPreflightConfig) => ({
        ...config,
        screening: { ...config.screening, proverFailOpen: true },
      }),
    },
  ])("fails closed for $name", ({ mutate }) => {
    expect(() => createTestnetDeploymentEvidence(mutate(preflightConfig()))).toThrow(
      expect.objectContaining({ code: "unsafe_configuration" }),
    );
  });

  it("requires a deployment declaration for both value-bearing contracts", () => {
    const config = preflightConfig();
    const withoutPoolDeclaration = {
      ...config,
      pool: { ...config.pool, deployment: undefined },
    } as unknown as TestnetPreflightConfig;
    const withoutTokenDeclaration = {
      ...config,
      token: { ...config.token, deployment: undefined },
    } as unknown as TestnetPreflightConfig;

    expect(() => createTestnetDeploymentEvidence(withoutPoolDeclaration)).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
    expect(() => createTestnetDeploymentEvidence(withoutTokenDeclaration)).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });

  it.each(["0x0", "not-a-transaction-reference", `0x${"f".repeat(66)}`])(
    "rejects the invalid deployment transaction reference %s without echoing it",
    (transactionReference) => {
      const config = preflightConfig();
      const invalid = {
        ...config,
        pool: {
          ...config.pool,
          deployment: { ...config.pool.deployment, transactionReference },
        },
      };

      try {
        createTestnetDeploymentEvidence(invalid);
        expect.unreachable("Invalid deployment transaction reference was accepted");
      } catch (error) {
        expect(error).toEqual(expect.objectContaining({ code: "invalid_input" }));
        expect((error as Error).message).not.toContain(transactionReference);
      }
    },
  );

  it.each([
    "http://deployments.example/sepolia-pool.json",
    "https://user:secret@deployments.example/sepolia-pool.json",
    "https://deployments.example/sepolia-pool.json?token=secret",
    "https://deployments.example/sepolia-pool.json#private",
    " https://deployments.example/sepolia-pool.json",
    "https://localhost/sepolia-pool.json",
  ])("rejects the non-public deployment manifest URL %s without echoing it", (manifestUrl) => {
    const config = preflightConfig();
    const invalid = {
      ...config,
      pool: {
        ...config.pool,
        deployment: { ...config.pool.deployment, manifestUrl },
      },
    };

    try {
      createTestnetDeploymentEvidence(invalid);
      expect.unreachable("Non-public deployment manifest URL was accepted");
    } catch (error) {
      expect(error).toEqual(expect.objectContaining({ code: "evidence_not_public" }));
      expect((error as Error).message).not.toContain(manifestUrl);
    }
  });

  it.each(["A".repeat(64), "a".repeat(63), `0x${"a".repeat(64)}`])(
    "rejects the noncanonical deployment manifest hash %s without echoing it",
    (manifestSha256) => {
      const config = preflightConfig();
      const invalid = {
        ...config,
        token: {
          ...config.token,
          deployment: { ...config.token.deployment, manifestSha256 },
        },
      };

      try {
        createTestnetDeploymentEvidence(invalid);
        expect.unreachable("Noncanonical deployment manifest hash was accepted");
      } catch (error) {
        expect(error).toEqual(expect.objectContaining({ code: "invalid_input" }));
        expect((error as Error).message).not.toContain(manifestSha256);
      }
    },
  );

  it.each([
    "http://remote.example/rpc",
    "https://username:password@rpc.example/",
    "https://rpc.example/#credential",
  ])("rejects the unsafe endpoint %s without echoing it", (url) => {
    const config = preflightConfig();
    config.rpcProviders[0] = { ...requiredFixtureValue(config.rpcProviders[0]), url };

    try {
      createTestnetDeploymentEvidence(config);
      expect.unreachable("Unsafe endpoint was accepted");
    } catch (error) {
      expect(error).toEqual(expect.objectContaining({ code: "unsafe_configuration" }));
      expect((error as Error).message).not.toContain(url);
    }
  });

  it.each([
    {
      name: "discovery query",
      url: "https://discovery.example/index?token=private",
      mutate: (config: TestnetPreflightConfig, url: string) => ({
        ...config,
        discovery: { ...config.discovery, url },
      }),
    },
    {
      name: "proof interceptor trailing slash",
      url: "https://interceptor.example/",
      mutate: (config: TestnetPreflightConfig, url: string) => ({
        ...config,
        screening: {
          ...config.screening,
          interceptor: { ...config.screening.interceptor, url },
        },
      }),
    },
    {
      name: "screening provider query",
      url: "https://screening.example/api?token=private",
      mutate: (config: TestnetPreflightConfig, url: string) => ({
        ...config,
        screening: {
          ...config.screening,
          provider: { ...config.screening.provider, url },
        },
      }),
    },
  ])("rejects an incompatible $name base URL without echoing it", ({ mutate, url }) => {
    try {
      createTestnetDeploymentEvidence(mutate(preflightConfig(), url));
      expect.unreachable("Incompatible service base URL was accepted");
    } catch (error) {
      expect(error).toEqual(expect.objectContaining({ code: "unsafe_configuration" }));
      expect((error as Error).message).not.toContain(url);
    }
  });

  it("allows loopback HTTP endpoints for a local testnet proxy", () => {
    const config = preflightConfig();
    config.rpcProviders[0] = {
      ...requiredFixtureValue(config.rpcProviders[0]),
      url: "http://127.0.0.1:5050/rpc",
    };

    expect(createTestnetDeploymentEvidence(config).rpcProviders).toHaveLength(2);
  });

  it.each(["id", "operator", "url"] as const)(
    "rejects duplicate RPC provider $name values",
    (field) => {
      const config = preflightConfig();
      config.rpcProviders[1] = {
        ...requiredFixtureValue(config.rpcProviders[1]),
        [field]: requiredFixtureValue(config.rpcProviders[0])[field],
      };

      expect(() => createTestnetDeploymentEvidence(config)).toThrow(
        expect.objectContaining({ code: "unsafe_configuration" }),
      );
    },
  );

  it("rejects different RPC paths on the same endpoint origin", () => {
    const config = preflightConfig();
    config.rpcProviders[1] = {
      ...requiredFixtureValue(config.rpcProviders[1]),
      url: "https://rpc-one.example/another-path?api_key=another-secret",
    };

    expect(() => createTestnetDeploymentEvidence(config)).toThrow(
      expect.objectContaining({ code: "unsafe_configuration" }),
    );
  });

  it("rejects a sparse RPC provider configuration", () => {
    const config = preflightConfig();
    delete config.rpcProviders[1];

    expect(() => createTestnetDeploymentEvidence(config)).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });

  it.each([
    { field: "signerPrivateKey", secret: "signer-secret-not-hex" },
    { field: "viewingKey", secret: "0x0" },
  ] as const)("redacts an invalid $field", ({ field, secret }) => {
    const config = { ...preflightConfig(), [field]: secret };

    try {
      assertTestnetPreflightSecrets(config);
      expect.unreachable("Invalid secret was accepted");
    } catch (error) {
      expect(error).toEqual(expect.objectContaining({ code: "unsafe_configuration" }));
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it.each([
    {
      name: "partner name",
      secret: "partner name with spaces",
      mutate: (config: TestnetPreflightConfig, secret: string) => ({
        ...config,
        screeningCredentials: { ...config.screeningCredentials, partnerName: secret },
      }),
    },
    {
      name: "partner secret",
      secret: "not-a-base64-secret",
      mutate: (config: TestnetPreflightConfig, secret: string) => ({
        ...config,
        screeningCredentials: { ...config.screeningCredentials, partnerSecret: secret },
      }),
    },
  ])("redacts an invalid screening $name", ({ mutate, secret }) => {
    try {
      assertTestnetPreflightSecrets(mutate(preflightConfig(), secret));
      expect.unreachable("Invalid screening credential was accepted");
    } catch (error) {
      expect(error).toEqual(expect.objectContaining({ code: "unsafe_configuration" }));
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it("accepts a bounded visible-ASCII screening partner identifier", () => {
    const config = preflightConfig();

    expect(() =>
      assertTestnetPreflightSecrets({
        ...config,
        screeningCredentials: {
          ...config.screeningCredentials,
          partnerName: "Partner_ABC:123",
        },
      }),
    ).not.toThrow();
  });

  it("reconstructs block-pinned verification evidence from public fields", () => {
    const deployment = createTestnetDeploymentEvidence(preflightConfig());
    const verification = {
      ...deploymentVerification(),
      leakedSecret: "must-not-be-public",
    } as StarknetDeploymentVerification;
    const evidence = verifiedDeploymentFrom({
      deployment,
      verification,
      verifiedAt: VERIFIED_AT,
    });

    expect(evidence).toMatchObject({
      schemaVersion: TESTNET_EVIDENCE_SCHEMA_VERSION,
      deployment: {
        pool: { address: POOL_ADDRESS, classHash: STARKNET_PRIVACY_POOL_CLASS_HASH },
        token: { address: TOKEN_ADDRESS, classHash: "0x222" },
        account: { classHash: "0xabc" },
      },
      originVerification: {
        verifierVersion: STARKNET_DEPLOYMENT_ORIGIN_VERIFIER_VERSION,
        udcAddress: STARKNET_UDC_ADDRESS,
        udcClassHash: STARKNET_UDC_CLASS_HASH,
        deploymentEventSelector: STARKNET_UDC_CONTRACT_DEPLOYED_SELECTOR,
        providerIds: ["rpc-primary", "rpc-secondary"],
        verification: {
          addressesDerived: true,
          successfulReceiptsVerified: true,
          canonicalInclusionsVerified: true,
          udcDeploymentEventsVerified: true,
          classesAtDeploymentBlocksVerified: true,
          udcClassAtDeploymentBlocksVerified: true,
        },
      },
      verification: {
        verifiedAt: VERIFIED_AT,
        blockHash: "0xbeef",
        blockNumber: "100",
        poolClassHash: STARKNET_PRIVACY_POOL_CLASS_HASH,
        tokenClassHash: "0x222",
        accountClassHash: "0xabc",
        providerIds: ["rpc-primary", "rpc-secondary"],
        verifierVersion: STARKNET_DEPLOYMENT_VERIFIER_VERSION,
        deploymentOriginVerified: true,
        deploymentApproved: false,
      },
      blockers: ["manifest_publishers_unauthenticated", "deployment_approval_required"],
    });
    expect(JSON.stringify(evidence)).not.toContain("must-not-be-public");
    expect(JSON.stringify(evidence)).not.toContain(PRIMARY_RPC_URL);
    expect(JSON.stringify(evidence)).not.toContain(ACCOUNT_ADDRESS);
  });

  it.each([
    {
      name: "different provider order",
      verification: () => ({
        ...deploymentVerification(),
        providerIds: ["rpc-secondary", "rpc-primary"],
      }),
      verifiedAt: VERIFIED_AT,
    },
    {
      name: "wrong pool class",
      verification: () => ({ ...deploymentVerification(), poolClassHash: "0x999" }),
      verifiedAt: VERIFIED_AT,
    },
    {
      name: "wrong verifier version",
      verification: () => ({ ...deploymentVerification(), verifierVersion: "unreviewed" }),
      verifiedAt: VERIFIED_AT,
    },
    {
      name: "zero block hash",
      verification: () => ({ ...deploymentVerification(), blockHash: "0x0" }),
      verifiedAt: VERIFIED_AT,
    },
    {
      name: "stale block",
      verification: () => ({
        ...deploymentVerification(),
        blockTimestamp: Math.floor(Date.parse(VERIFIED_AT) / 1_000) - 301,
      }),
      verifiedAt: VERIFIED_AT,
    },
    {
      name: "future block",
      verification: () => ({
        ...deploymentVerification(),
        blockTimestamp: Math.floor(Date.parse(VERIFIED_AT) / 1_000) + 31,
      }),
      verifiedAt: VERIFIED_AT,
    },
    {
      name: "verification before profile",
      verification: deploymentVerification,
      verifiedAt: "2026-09-01T17:59:59.000Z",
    },
  ])("rejects deployment verification with $name", ({ verification, verifiedAt }) => {
    expect(() =>
      verifiedDeploymentFrom({
        deployment: createTestnetDeploymentEvidence(preflightConfig()),
        verification: verification() as StarknetDeploymentVerification,
        verifiedAt,
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it("rejects a sparse deployment-verification provider set", () => {
    const providerIds = new Array<string>(2);
    providerIds[0] = "rpc-primary";

    expect(() =>
      verifiedDeploymentFrom({
        deployment: createTestnetDeploymentEvidence(preflightConfig()),
        verification: { ...deploymentVerification(), providerIds },
        verifiedAt: VERIFIED_AT,
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it("rejects an internally consistent manifest and origin record with a non-UDC address", () => {
    const config = preflightConfig();
    const deployment = createTestnetDeploymentEvidence({
      ...config,
      pool: { ...config.pool, address: "0x123" },
      screening: { ...config.screening, poolAddress: "0x123" },
    });
    const manifestVerification = deploymentManifestVerification(deployment);

    expect(() =>
      createTestnetVerifiedDeploymentEvidence({
        deployment,
        manifestVerification,
        originVerification: deploymentOriginVerification(deployment, manifestVerification),
        verification: { ...deploymentVerification(), poolClassHash: deployment.pool.classHash },
        verifiedAt: VERIFIED_AT,
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it.each([
    {
      name: "provider substitution",
      mutate: (value: StarknetDeploymentOriginVerification) => ({
        ...value,
        providerIds: ["rpc-secondary", "rpc-primary"],
      }),
    },
    {
      name: "changed deployment salt",
      mutate: (value: StarknetDeploymentOriginVerification) => ({
        ...value,
        contracts: [{ ...value.contracts[0], salt: "0x2" }, value.contracts[1]],
      }),
    },
    {
      name: "changed canonical block",
      mutate: (value: StarknetDeploymentOriginVerification) => ({
        ...value,
        contracts: [{ ...value.contracts[0], blockHash: "0x999" }, value.contracts[1]],
      }),
    },
  ])("rejects deployment-origin evidence with $name", ({ mutate }) => {
    const deployment = createTestnetDeploymentEvidence(preflightConfig());
    const manifestVerification = deploymentManifestVerification(deployment);
    const originVerification = deploymentOriginVerification(deployment, manifestVerification);

    expect(() =>
      createTestnetVerifiedDeploymentEvidence({
        deployment,
        manifestVerification,
        originVerification: mutate(originVerification) as StarknetDeploymentOriginVerification,
        verification: deploymentVerification(),
        verifiedAt: VERIFIED_AT,
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it.each([
    {
      name: "approval upgrade",
      mutate: (value: TestnetVerifiedDeploymentEvidence) => ({
        ...value,
        verification: { ...value.verification, deploymentApproved: true },
      }),
    },
    {
      name: "origin downgrade",
      mutate: (value: TestnetVerifiedDeploymentEvidence) => ({
        ...value,
        verification: { ...value.verification, deploymentOriginVerified: false },
      }),
    },
    {
      name: "missing approval blocker",
      mutate: (value: TestnetVerifiedDeploymentEvidence) => ({
        ...value,
        blockers: value.blockers.slice(0, -1),
      }),
    },
  ])("rejects persisted deployment evidence with $name", ({ mutate }) => {
    expect(() =>
      createTestnetVerifiedContextEvidence({
        verifiedDeployment: mutate(
          verifiedDeploymentEvidence(),
        ) as TestnetVerifiedDeploymentEvidence,
        serviceVerification: serviceVerificationEvidence(),
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it("rejects manifest evidence with invalid chronology or a future deployment block", () => {
    const deployment = createTestnetDeploymentEvidence(preflightConfig());
    const manifestVerification = deploymentManifestVerification(deployment);
    const variants = [
      { ...manifestVerification, verifiedAt: "2026-09-01T17:59:59.000Z" },
      { ...manifestVerification, verifiedAt: "2026-09-01T18:00:11.000Z" },
      {
        ...manifestVerification,
        contracts: [
          manifestVerification.contracts[0],
          {
            ...manifestVerification.contracts[1],
            deployment: {
              ...manifestVerification.contracts[1].deployment,
              acceptedBlockNumber: "101",
            },
          },
        ],
      },
    ] as const satisfies readonly TestnetDeploymentManifestVerificationEvidence[];

    for (const variant of variants) {
      expect(() =>
        createTestnetVerifiedDeploymentEvidence({
          deployment,
          manifestVerification: variant,
          originVerification: deploymentOriginVerification(deployment, variant),
          verification: deploymentVerification(),
          verifiedAt: VERIFIED_AT,
        }),
      ).toThrow(expect.objectContaining({ code: "invalid_input" }));
    }
  });

  it("builds JSON-safe run evidence and omits transactions without disclosure approval", () => {
    const evidence = createTestnetRunEvidence(runEvidenceInput());

    expect(evidence).toMatchObject({
      schemaVersion: TESTNET_EVIDENCE_SCHEMA_VERSION,
      run: {
        command: ["pnpm", "--filter", "@cashu-strk20/settlement", "test:testnet"],
        startedAt: STARTED_AT,
        completedAt: COMPLETED_AT,
        observedBlockRange: { first: "101", last: "110" },
      },
      scenarios: [
        {
          scenario: "payout_response_loss",
          result: "PASSED",
          expectedState: "PAID",
          observedState: "PAID",
          durationMilliseconds: 2_500,
          provingMilliseconds: 1_000,
          finalityMilliseconds: 1_200,
          retryCount: 1,
          feeFri: "123",
          publicTransactions: [
            { transactionReference: "0x111", blockHash: "0xaaa", blockNumber: "105" },
          ],
        },
      ],
    });
    expect(() => JSON.stringify(evidence)).not.toThrow();
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("0x999999");
    expect(serialized).not.toContain("0x888888");
    expect(serialized).not.toContain("cashu-quote-secret");
    expect(serialized).not.toContain("private-recipient");
    expect(serialized).not.toContain("raw-provider-error");
  });

  it("reconstructs a deployment record so undeclared properties cannot enter public evidence", () => {
    const deployment = {
      ...createTestnetDeploymentEvidence(preflightConfig()),
      leakedSecret: "must-not-be-public",
      services: {
        ...createTestnetDeploymentEvidence(preflightConfig()).services,
        hiddenUrl: "https://private.example/?token=secret",
        screening: {
          ...createTestnetDeploymentEvidence(preflightConfig()).services.screening,
          endpoint: "https://screening-private.example/?token=secret",
          partnerSecret: "must-not-be-public-screening-secret",
        },
      },
    } as TestnetDeploymentEvidence;
    const input = runEvidenceInput();
    const evidence = createTestnetRunEvidence({ ...input, deployment });

    expect(JSON.stringify(evidence)).not.toContain("must-not-be-public");
    expect(JSON.stringify(evidence)).not.toContain("private.example");
    expect(JSON.stringify(evidence)).not.toContain("screening-private.example");
    expect(JSON.stringify(evidence)).not.toContain("must-not-be-public-screening-secret");
  });

  it("rejects sparse arrays at each run-evidence boundary", () => {
    const input = runEvidenceInput();
    const sparseProviders = [...input.deployment.rpcProviders];
    delete sparseProviders[1];
    const sparseCommand = new Array<string>(2);
    sparseCommand[0] = "pnpm";
    const sparseScenarios = new Array<TestnetRunEvidenceInput["scenarios"][number]>(1);

    expect(() =>
      createTestnetRunEvidence({
        ...input,
        deployment: { ...input.deployment, rpcProviders: sparseProviders },
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
    expect(() => createTestnetRunEvidence({ ...input, command: sparseCommand })).toThrow(
      expect.objectContaining({ code: "evidence_not_public" }),
    );
    expect(() => createTestnetRunEvidence({ ...input, scenarios: sparseScenarios })).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });

  it("binds a run to its verified deployment and reports incomplete scenario coverage", () => {
    const evidence = createTestnetVerifiedRunEvidence({
      verifiedContext: verifiedContextEvidence(),
      run: createTestnetRunEvidence(runEvidenceInput()),
    });

    expect(evidence).toMatchObject({
      schemaVersion: TESTNET_VERIFIED_RUN_SCHEMA_VERSION,
      verifiedContext: {
        schemaVersion: TESTNET_VERIFIED_CONTEXT_SCHEMA_VERSION,
        verification: { publicServiceProfileMatchesDeployment: true },
      },
      verification: {
        runProfileMatchesVerifiedContext: true,
        deploymentVerifiedBeforeRun: true,
        servicesVerifiedBeforeRun: true,
        deploymentVerificationFreshAtRun: true,
        serviceVerificationFreshAtRun: true,
        deploymentBlockNotAfterRunStart: true,
        discoveryBlockNotAfterRunStart: true,
        executionAttested: false,
        artifactAuthenticated: false,
        fundedExecutionApproved: false,
      },
      scenarioCoverage: {
        required: TESTNET_SCENARIOS.length,
        present: 1,
        passed: 1,
        missing: TESTNET_SCENARIOS.filter((scenario) => scenario !== "payout_response_loss"),
        notPassed: [],
      },
    });
    expect(() => JSON.stringify(evidence)).not.toThrow();
  });

  it("reports failed and skipped scenarios without treating them as passed", () => {
    const runInput = runEvidenceInput();
    const run = createTestnetRunEvidence({
      ...runInput,
      scenarios: [
        requiredFixtureValue(runInput.scenarios[0]),
        {
          scenario: "incoming_restart",
          result: "FAILED",
          expectedState: "PAID",
          observedState: "PENDING",
          durationMilliseconds: 500,
          retryCount: 1,
          resultCode: "assertion_failed",
        },
        {
          scenario: "payout_reorg",
          result: "SKIPPED",
          expectedState: "REORGED",
          observedState: "NOT_RUN",
          durationMilliseconds: 0,
          retryCount: 0,
          resultCode: "credentials_unavailable",
        },
      ],
    });

    expect(
      createTestnetVerifiedRunEvidence({
        verifiedContext: verifiedContextEvidence(),
        run,
      }).scenarioCoverage,
    ).toMatchObject({
      required: TESTNET_SCENARIOS.length,
      present: 3,
      passed: 1,
      notPassed: ["incoming_restart", "payout_reorg"],
    });
  });

  it("reconstructs nested records so undeclared properties cannot enter the verified envelope", () => {
    const contextFixture = verifiedContextEvidence();
    const verifiedContext = {
      ...contextFixture,
      leakedSecret: "verified-deployment-secret",
      verifiedDeployment: {
        ...contextFixture.verifiedDeployment,
        verification: {
          ...contextFixture.verifiedDeployment.verification,
          endpoint: "https://private-rpc.example/?token=secret",
        },
      },
      serviceVerification: {
        ...contextFixture.serviceVerification,
        rawResponse: "private-service-response",
      },
    } as TestnetVerifiedContextEvidence;
    const run = {
      ...createTestnetRunEvidence(runEvidenceInput()),
      leakedSecret: "run-secret",
      run: {
        ...createTestnetRunEvidence(runEvidenceInput()).run,
        signerPrivateKey: "0xprivate",
      },
      scenarios: createTestnetRunEvidence(runEvidenceInput()).scenarios.map((scenario) => ({
        ...scenario,
        privateRecipient: "private-recipient",
        publicTransactions: scenario.publicTransactions.map((transaction) => ({
          ...transaction,
          rawProviderResponse: "raw-provider-secret",
        })),
      })),
    } as TestnetRunEvidence;

    const serialized = JSON.stringify(createTestnetVerifiedRunEvidence({ verifiedContext, run }));
    for (const hidden of [
      "verified-deployment-secret",
      "private-rpc.example",
      "private-service-response",
      "run-secret",
      "0xprivate",
      "private-recipient",
      "raw-provider-secret",
    ]) {
      expect(serialized).not.toContain(hidden);
    }
  });

  it("rejects a run from a different deployment profile", () => {
    const config = preflightConfig();
    const runInput = runEvidenceInput();
    const run = createTestnetRunEvidence({
      ...runInput,
      deployment: createTestnetDeploymentEvidence({
        ...config,
        token: { ...config.token, version: "usdc-test-v2" },
      }),
    });

    expect(() =>
      createTestnetVerifiedRunEvidence({
        verifiedContext: verifiedContextEvidence(),
        run,
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it("rejects deployment verification performed after the run started", () => {
    const verifiedAt = "2026-09-01T18:10:01.000Z";
    const verifiedDeployment = verifiedDeploymentFrom({
      deployment: createTestnetDeploymentEvidence(preflightConfig()),
      verification: {
        ...deploymentVerification(),
        blockTimestamp: Math.floor(Date.parse(verifiedAt) / 1_000),
      },
      verifiedAt,
    });

    expect(() =>
      createTestnetVerifiedRunEvidence({
        verifiedContext: verifiedContextEvidence(verifiedDeployment),
        run: createTestnetRunEvidence(runEvidenceInput()),
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it("rejects a deployment verification block after the observed run start", () => {
    const verifiedDeployment = verifiedDeploymentFrom({
      deployment: createTestnetDeploymentEvidence(preflightConfig()),
      verification: { ...deploymentVerification(), blockNumber: 111n },
      verifiedAt: VERIFIED_AT,
    });

    expect(() =>
      createTestnetVerifiedRunEvidence({
        verifiedContext: verifiedContextEvidence(verifiedDeployment),
        run: createTestnetRunEvidence(runEvidenceInput()),
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it("rejects service verification from a different deployment profile", () => {
    const config = preflightConfig();
    const mismatchedProfile = createTestnetDeploymentEvidence({
      ...config,
      token: { ...config.token, version: "usdc-test-v2" },
    });

    expect(() =>
      createTestnetVerifiedContextEvidence({
        verifiedDeployment: verifiedDeploymentEvidence(),
        serviceVerification: serviceVerificationEvidence(mismatchedProfile),
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it("rejects a run whose deployment declaration differs from its verified context", () => {
    const input = runEvidenceInput();
    const run = createTestnetRunEvidence({
      ...input,
      deployment: {
        ...input.deployment,
        pool: {
          ...input.deployment.pool,
          deployment: {
            ...input.deployment.pool.deployment,
            manifestSha256: "c".repeat(64),
          },
        },
      },
    });

    expect(() =>
      createTestnetVerifiedRunEvidence({ verifiedContext: verifiedContextEvidence(), run }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it("matches separately recorded public profiles without requiring equal observation times", () => {
    const config = preflightConfig();
    const serviceProfile = createTestnetDeploymentEvidence({
      ...config,
      recordedAt: "2026-09-01T18:00:01.000Z",
    });

    expect(
      createTestnetVerifiedContextEvidence({
        verifiedDeployment: verifiedDeploymentEvidence(),
        serviceVerification: serviceVerificationEvidence(serviceProfile),
      }).verification,
    ).toEqual({ publicServiceProfileMatchesDeployment: true });
  });

  it("rejects service verification performed after the run started", () => {
    const verifiedAt = "2026-09-01T18:10:01.000Z";
    const blockTimestamp = Math.floor(Date.parse(verifiedAt) / 1_000);
    const service = serviceVerificationEvidence();
    const lateService = {
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
    };
    const verifiedContext = verifiedContextEvidence(verifiedDeploymentEvidence(), lateService);

    expect(() =>
      createTestnetVerifiedRunEvidence({
        verifiedContext,
        run: createTestnetRunEvidence(runEvidenceInput()),
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it("rejects context verification that is stale at run start", () => {
    const input = runEvidenceInput();
    const staleRun = createTestnetRunEvidence({
      ...input,
      startedAt: "2026-09-01T18:05:11.000Z",
      completedAt: "2026-09-01T18:05:12.000Z",
    });

    expect(() =>
      createTestnetVerifiedRunEvidence({
        verifiedContext: verifiedContextEvidence(),
        run: staleRun,
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it("accepts the exact context-age boundary and rejects one millisecond beyond it", () => {
    const verifiedContext = verifiedContextEvidence();

    expect(() =>
      validateTestnetVerifiedContextForRun({
        verifiedContext,
        startedAt: "2026-09-01T18:05:10.000Z",
      }),
    ).not.toThrow();
    expect(() =>
      validateTestnetVerifiedContextForRun({
        verifiedContext,
        startedAt: "2026-09-01T18:05:10.001Z",
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it("rejects a verified discovery block after the observed run start", () => {
    const service = serviceVerificationEvidence();
    const futureHead = {
      ...service,
      services: {
        ...service.services,
        discovery: {
          ...service.services.discovery,
          indexedHead: { ...service.services.discovery.indexedHead, blockNumber: 111 },
        },
      },
      chainVerification: { ...service.chainVerification, blockNumber: 111 },
    };
    const verifiedContext = verifiedContextEvidence(verifiedDeploymentEvidence(), futureHead);

    expect(() =>
      createTestnetVerifiedRunEvidence({
        verifiedContext,
        run: createTestnetRunEvidence(runEvidenceInput()),
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it.each([
    {
      name: "discovery and chain mismatch",
      mutate: (value: TestnetPrivacyServiceVerificationEvidence) => ({
        ...value,
        chainVerification: { ...value.chainVerification, blockHash: "0xdef" },
      }),
    },
    {
      name: "upgraded runtime attestation claim",
      mutate: (value: TestnetPrivacyServiceVerificationEvidence) => ({
        ...value,
        verification: { ...value.verification, remoteRuntimeImageVerified: true },
      }),
    },
    {
      name: "missing blocker",
      mutate: (value: TestnetPrivacyServiceVerificationEvidence) => ({
        ...value,
        blockers: value.blockers.slice(0, -1),
      }),
    },
    {
      name: "provider substitution",
      mutate: (value: TestnetPrivacyServiceVerificationEvidence) => ({
        ...value,
        chainVerification: {
          ...value.chainVerification,
          providerIds: ["rpc-secondary", "rpc-primary"],
        },
      }),
    },
  ])("rejects service evidence with $name", ({ mutate }) => {
    expect(() =>
      createTestnetVerifiedContextEvidence({
        verifiedDeployment: verifiedDeploymentEvidence(),
        serviceVerification: mutate(
          serviceVerificationEvidence(),
        ) as TestnetPrivacyServiceVerificationEvidence,
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it.each([
    null,
    {},
    { verifiedContext: {}, run: {} },
    {
      verifiedContext: verifiedContextEvidence(),
      run: { ...createTestnetRunEvidence(runEvidenceInput()), scenarios: [{}] },
    },
  ])("rejects malformed verified-run evidence with a stable public error", (input) => {
    expect(() =>
      createTestnetVerifiedRunEvidence(
        input as Parameters<typeof createTestnetVerifiedRunEvidence>[0],
      ),
    ).toThrow(
      expect.objectContaining({
        code: "invalid_input",
        message: expect.not.stringContaining("private"),
      }),
    );
  });

  it.each([
    { command: ["SIGNER_PRIVATE_KEY=0x123"] },
    { command: ["https://rpc.example/?token=secret"] },
    { command: [`0x${"a".repeat(64)}`] },
    { command: ["pnpm", "test:testnet;printenv"] },
  ])("rejects an unsafe public command without echoing it", ({ command }) => {
    const input = { ...runEvidenceInput(), command };

    try {
      createTestnetRunEvidence(input);
      expect.unreachable("Unsafe command was accepted");
    } catch (error) {
      expect(error).toEqual(expect.objectContaining({ code: "evidence_not_public" }));
      expect((error as Error).message).not.toContain(command.join(" "));
    }
  });

  it.each([
    {
      name: "a reversed timestamp range",
      mutate: (input: TestnetRunEvidenceInput) => ({
        ...input,
        completedAt: "2026-09-01T18:03:00.000Z",
      }),
    },
    {
      name: "a deployment profile recorded after the run starts",
      mutate: (input: TestnetRunEvidenceInput) => ({
        ...input,
        deployment: {
          ...input.deployment,
          recordedAt: "2026-09-01T18:10:01.000Z",
        },
      }),
    },
    {
      name: "a deployment profile from a different Node runtime",
      mutate: (input: TestnetRunEvidenceInput) => ({
        ...input,
        deployment: {
          ...input.deployment,
          components: { ...input.deployment.components, nodeVersion: "24.0.0" },
        },
      }),
    },
    {
      name: "a reversed block range",
      mutate: (input: TestnetRunEvidenceInput) => ({
        ...input,
        observedBlockRange: { first: 111n, last: 110n },
      }),
    },
    {
      name: "an oversized block number",
      mutate: (input: TestnetRunEvidenceInput) => ({
        ...input,
        observedBlockRange: { first: "9".repeat(1_000), last: 110n },
      }),
    },
    {
      name: "duplicate scenarios",
      mutate: (input: TestnetRunEvidenceInput) => ({
        ...input,
        scenarios: [...input.scenarios, requiredFixtureValue(input.scenarios[0])],
      }),
    },
    {
      name: "a false passed result",
      mutate: (input: TestnetRunEvidenceInput) => ({
        ...input,
        scenarios: [
          { ...requiredFixtureValue(input.scenarios[0]), observedState: "UNKNOWN" as const },
        ],
      }),
    },
    {
      name: "a caller-selected success criterion",
      mutate: (input: TestnetRunEvidenceInput) => ({
        ...input,
        scenarios: [
          {
            ...requiredFixtureValue(input.scenarios[0]),
            expectedState: "UNKNOWN" as const,
            observedState: "UNKNOWN" as const,
          },
        ],
      }),
    },
    {
      name: "a skipped scenario with an observed state",
      mutate: (input: TestnetRunEvidenceInput) => ({
        ...input,
        scenarios: [
          {
            ...requiredFixtureValue(input.scenarios[0]),
            result: "SKIPPED" as const,
            resultCode: "credentials_unavailable" as const,
          },
        ],
      }),
    },
    {
      name: "a failed scenario without a stable code",
      mutate: (input: TestnetRunEvidenceInput) => ({
        ...input,
        scenarios: [{ ...requiredFixtureValue(input.scenarios[0]), result: "FAILED" as const }],
      }),
    },
    {
      name: "a disclosed transaction outside the block range",
      mutate: (input: TestnetRunEvidenceInput) => ({
        ...input,
        scenarios: [
          {
            ...requiredFixtureValue(input.scenarios[0]),
            publicTransactions: [
              {
                transactionReference: "0x111",
                blockHash: "0xaaa",
                blockNumber: 111n,
                disclosureApproved: true,
              },
            ],
          },
        ],
      }),
    },
    {
      name: "a non-canonical fee",
      mutate: (input: TestnetRunEvidenceInput) => ({
        ...input,
        scenarios: [{ ...requiredFixtureValue(input.scenarios[0]), feeFri: "0123" }],
      }),
    },
    {
      name: "a fee above uint256",
      mutate: (input: TestnetRunEvidenceInput) => ({
        ...input,
        scenarios: [
          { ...requiredFixtureValue(input.scenarios[0]), feeFri: (1n << 256n).toString() },
        ],
      }),
    },
    {
      name: "an arbitrary failure message as a result code",
      mutate: (input: TestnetRunEvidenceInput) => ({
        ...input,
        scenarios: [
          {
            ...requiredFixtureValue(input.scenarios[0]),
            result: "FAILED" as const,
            resultCode: "signer-secret-not-hex" as TestnetResultCode,
          },
        ],
      }),
    },
  ])("rejects run evidence with $name", ({ mutate }) => {
    expect(() => createTestnetRunEvidence(mutate(runEvidenceInput()))).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });

  it("reconstructs a verified run without carrying undeclared fields", () => {
    const evidence = createTestnetVerifiedRunEvidence({
      verifiedContext: verifiedContextEvidence(),
      run: createTestnetRunEvidence(runEvidenceInput()),
    });
    const injected = {
      ...evidence,
      privateDetail: "cashu-quote-secret",
      scenarioCoverage: { ...evidence.scenarioCoverage, reviewerNote: "private-note" },
    };

    const reconstructed = reconstructTestnetVerifiedRunEvidence(injected);

    expect(reconstructed).toEqual(evidence);
    expect(JSON.stringify(reconstructed)).not.toContain("cashu-quote-secret");
    expect(JSON.stringify(reconstructed)).not.toContain("private-note");
  });

  it("rejects a verified run containing a pre-declaration deployment schema", () => {
    const evidence = verifiedRunEvidence();
    const legacy = {
      ...evidence,
      run: {
        ...evidence.run,
        deployment: {
          ...evidence.run.deployment,
          schemaVersion: "cashu-strk20-testnet-evidence-v2",
        },
      },
    };

    expect(() => reconstructTestnetVerifiedRunEvidence(legacy)).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });

  it("rejects the prior verified-run schema instead of upgrading missing limitation claims", () => {
    const evidence = verifiedRunEvidence();
    const legacy = {
      ...evidence,
      schemaVersion: "cashu-strk20-verified-run-evidence-v4",
      verification: {
        runProfileMatchesVerifiedContext: true,
        deploymentVerifiedBeforeRun: true,
        servicesVerifiedBeforeRun: true,
        deploymentVerificationFreshAtRun: true,
        serviceVerificationFreshAtRun: true,
        deploymentBlockNotAfterRunStart: true,
        discoveryBlockNotAfterRunStart: true,
      },
    };

    expect(() => reconstructTestnetVerifiedRunEvidence(legacy)).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });

  it("rejects the prior service schema before binding a verified context", () => {
    const verifiedDeployment = verifiedDeploymentEvidence();
    const serviceVerification = serviceVerificationEvidence(verifiedDeployment.deployment);
    const legacyServiceVerification = {
      ...serviceVerification,
      schemaVersion: "cashu-strk20-testnet-service-verification-v2",
      blockers: [...serviceVerification.blockers.slice(0, -1), "deployment_contracts_unverified"],
    } as unknown as TestnetPrivacyServiceVerificationEvidence;

    expect(() =>
      createTestnetVerifiedContextEvidence({
        verifiedDeployment,
        serviceVerification: legacyServiceVerification,
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it("accepts and reproduces the exact canonical verified-run artifact", () => {
    const evidence = verifiedRunEvidence();
    const encodedEvidence = serializeTestnetVerifiedRunEvidence(evidence);
    const output: string[] = [];
    const errors: string[] = [];

    const exitCode = runTestnetEvidenceValidationCommand({
      encodedEvidence,
      writeOutput: (value) => output.push(value),
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(output.join("")).toBe(encodedEvidence);
  });

  it.each([
    {
      name: "reordered object keys",
      encode: (evidence: ReturnType<typeof verifiedRunEvidence>) =>
        JSON.stringify({
          scenarioCoverage: evidence.scenarioCoverage,
          verification: evidence.verification,
          run: evidence.run,
          verifiedContext: evidence.verifiedContext,
          schemaVersion: evidence.schemaVersion,
        }),
    },
    {
      name: "duplicate object keys with equal values",
      encode: (evidence: ReturnType<typeof verifiedRunEvidence>) =>
        serializeTestnetVerifiedRunEvidence(evidence).replace(
          "{\n",
          `{\n  "schemaVersion": ${JSON.stringify(evidence.schemaVersion)},\n`,
        ),
    },
    {
      name: "a missing trailing newline",
      encode: (evidence: ReturnType<typeof verifiedRunEvidence>) =>
        serializeTestnetVerifiedRunEvidence(evidence).slice(0, -1),
    },
  ])("rejects a valid record encoded with $name", ({ encode }) => {
    const output: string[] = [];
    const errors: string[] = [];

    const exitCode = runTestnetEvidenceValidationCommand({
      encodedEvidence: encode(verifiedRunEvidence()),
      writeOutput: (value) => output.push(value),
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(output).toEqual([]);
    expect(errors).toEqual(["Verified testnet run artifact is not canonical\n"]);
  });

  it.each([
    {
      name: "an undeclared private field",
      mutate: (value: ReturnType<typeof verifiedRunEvidence>) => ({
        ...value,
        privateDetail: "cashu-quote-secret",
      }),
    },
    {
      name: "altered scenario coverage",
      mutate: (value: ReturnType<typeof verifiedRunEvidence>) => ({
        ...value,
        scenarioCoverage: { ...value.scenarioCoverage, passed: 8 },
      }),
    },
    {
      name: "an altered derived verification claim",
      mutate: (value: ReturnType<typeof verifiedRunEvidence>) => ({
        ...value,
        verification: { ...value.verification, servicesVerifiedBeforeRun: false },
      }),
    },
    {
      name: "an execution attestation upgrade",
      mutate: (value: ReturnType<typeof verifiedRunEvidence>) => ({
        ...value,
        verification: { ...value.verification, executionAttested: true },
      }),
    },
    {
      name: "an artifact authentication upgrade",
      mutate: (value: ReturnType<typeof verifiedRunEvidence>) => ({
        ...value,
        verification: { ...value.verification, artifactAuthenticated: true },
      }),
    },
    {
      name: "a funded-execution approval upgrade",
      mutate: (value: ReturnType<typeof verifiedRunEvidence>) => ({
        ...value,
        verification: { ...value.verification, fundedExecutionApproved: true },
      }),
    },
    {
      name: "an unapproved service attestation",
      mutate: (value: ReturnType<typeof verifiedRunEvidence>) => ({
        ...value,
        verifiedContext: {
          ...value.verifiedContext,
          serviceVerification: {
            ...value.verifiedContext.serviceVerification,
            verification: {
              ...value.verifiedContext.serviceVerification.verification,
              remoteRuntimeImageVerified: true,
            },
          },
        },
      }),
    },
  ])("rejects $name without echoing artifact content", ({ mutate }) => {
    const secret = "cashu-quote-secret";
    const output: string[] = [];
    const errors: string[] = [];

    const exitCode = runTestnetEvidenceValidationCommand({
      encodedEvidence: JSON.stringify(mutate(verifiedRunEvidence())),
      writeOutput: (value) => output.push(value),
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(output).toEqual([]);
    expect(errors.join("")).not.toContain(secret);
  });

  it("rejects malformed, empty, and oversized encoded artifacts with fixed errors", () => {
    for (const encodedEvidence of [
      "",
      "{not-json}",
      " ".repeat(MAXIMUM_TESTNET_EVIDENCE_INPUT_BYTES + 1),
    ]) {
      const errors: string[] = [];
      expect(
        runTestnetEvidenceValidationCommand({
          encodedEvidence,
          writeOutput: () => undefined,
          writeError: (value) => errors.push(value),
        }),
      ).toBe(1);
      expect(errors.join("")).toBe("Verified testnet run artifact is invalid\n");
    }
  });

  it("redacts output-writer failures", () => {
    const errors: string[] = [];

    const exitCode = runTestnetEvidenceValidationCommand({
      encodedEvidence: serializeTestnetVerifiedRunEvidence(verifiedRunEvidence()),
      writeOutput() {
        throw new Error("private-output-failure");
      },
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(errors.join("")).toBe("Testnet evidence validation failed unexpectedly\n");
    expect(errors.join("")).not.toContain("private-output-failure");
  });
});

function preflightConfig(): TestnetPreflightConfig & {
  rpcProviders: TestnetPreflightConfig["rpcProviders"][number][];
} {
  return {
    network: "SN_SEPOLIA",
    chainId: STARKNET_SEPOLIA_CHAIN_ID,
    recordedAt: RECORDED_AT,
    pool: {
      address: POOL_ADDRESS,
      classHash: STARKNET_PRIVACY_POOL_CLASS_HASH,
      version: STARKNET_PRIVACY_POOL_VERSION,
      deployment: POOL_DEPLOYMENT,
    },
    token: {
      address: TOKEN_ADDRESS,
      classHash: "0x0222",
      version: "usdc-test-v1",
      symbol: "USDC",
      decimals: 6,
      deployment: TOKEN_DEPLOYMENT,
    },
    account: { address: ACCOUNT_ADDRESS, classHash: "0x0abc", version: "oz-account-v1" },
    rpcProviders: [
      { id: "rpc-primary", operator: "provider-one", url: PRIMARY_RPC_URL },
      { id: "rpc-secondary", operator: "provider-two", url: SECONDARY_RPC_URL },
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
        url: PROOF_INTERCEPTOR_URL,
        version: STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION,
      },
      provider: {
        operator: "screener-one",
        url: SCREENING_PROVIDER_URL,
      },
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
    signerPrivateKey: SIGNER_PRIVATE_KEY,
    viewingKey: VIEWING_KEY,
    screeningCredentials: {
      partnerName: "partner-one",
      partnerSecret: SCREENING_PARTNER_SECRET,
    },
    safety: { testOnlyAccount: true, cappedFunds: true },
  };
}

function deploymentVerification(): StarknetDeploymentVerification {
  return {
    blockHash: "0xbeef",
    blockNumber: 100n,
    blockTimestamp: Math.floor(Date.parse(RECORDED_AT) / 1_000),
    poolClassHash: STARKNET_PRIVACY_POOL_CLASS_HASH,
    tokenClassHash: "0x222",
    accountClassHash: "0xabc",
    providerIds: ["rpc-primary", "rpc-secondary"],
    verifierVersion: STARKNET_DEPLOYMENT_VERIFIER_VERSION,
  };
}

function verifiedDeploymentEvidence(): TestnetVerifiedDeploymentEvidence {
  const deployment = createTestnetDeploymentEvidence(preflightConfig());
  return verifiedDeploymentFrom({
    deployment,
    verification: deploymentVerification(),
    verifiedAt: VERIFIED_AT,
  });
}

function verifiedDeploymentFrom(input: {
  readonly deployment: TestnetDeploymentEvidence;
  readonly verification: StarknetDeploymentVerification;
  readonly verifiedAt: string;
}): TestnetVerifiedDeploymentEvidence {
  const manifestVerification = deploymentManifestVerification(input.deployment);
  return createTestnetVerifiedDeploymentEvidence({
    ...input,
    manifestVerification,
    originVerification: deploymentOriginVerification(input.deployment, manifestVerification),
  });
}

function deploymentOriginVerification(
  deployment: TestnetDeploymentEvidence,
  manifestVerification: TestnetDeploymentManifestVerificationEvidence = deploymentManifestVerification(
    deployment,
  ),
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

function verifiedContextEvidence(
  verifiedDeployment: TestnetVerifiedDeploymentEvidence = verifiedDeploymentEvidence(),
  serviceVerification: TestnetPrivacyServiceVerificationEvidence = serviceVerificationEvidence(
    verifiedDeployment.deployment,
  ),
): TestnetVerifiedContextEvidence {
  return createTestnetVerifiedContextEvidence({ verifiedDeployment, serviceVerification });
}

function serviceVerificationEvidence(
  profile: TestnetDeploymentEvidence = createTestnetDeploymentEvidence(preflightConfig()),
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

function verifiedRunEvidence() {
  return createTestnetVerifiedRunEvidence({
    verifiedContext: verifiedContextEvidence(),
    run: createTestnetRunEvidence(runEvidenceInput()),
  });
}

function runEvidenceInput(): TestnetRunEvidenceInput {
  const scenario = {
    scenario: "payout_response_loss",
    result: "PASSED",
    expectedState: TESTNET_SCENARIO_EXPECTED_STATES.payout_response_loss,
    observedState: TESTNET_SCENARIO_EXPECTED_STATES.payout_response_loss,
    durationMilliseconds: 2_500,
    provingMilliseconds: 1_000,
    finalityMilliseconds: 1_200,
    retryCount: 1,
    feeFri: "123",
    cashuQuoteId: "cashu-quote-secret",
    privateRecipient: "private-recipient",
    rawError: "raw-provider-error",
    publicTransactions: [
      {
        transactionReference: "0x0111",
        blockHash: "0x0aaa",
        blockNumber: 105n,
        disclosureApproved: true,
        privateRecipient: "private-recipient",
      },
      {
        transactionReference: "0x999999",
        blockHash: "0x888888",
        blockNumber: 106n,
        disclosureApproved: false,
      },
    ],
  } as TestnetRunEvidenceInput["scenarios"][number];
  return {
    deployment: createTestnetDeploymentEvidence(preflightConfig()),
    command: ["pnpm", "--filter", "@cashu-strk20/settlement", "test:testnet"],
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    observedBlockRange: { first: 101n, last: "110" },
    scenarios: [scenario],
  };
}

function requiredFixtureValue<Value>(value: Value | undefined): Value {
  if (value === undefined) {
    throw new Error("Test fixture is incomplete");
  }
  return value;
}
