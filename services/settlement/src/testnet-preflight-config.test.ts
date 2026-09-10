import { describe, expect, it } from "vitest";

import {
  STARKNET_PRIVACY_POOL_CLASS_HASH,
  STARKNET_PRIVACY_POOL_VERSION,
} from "./privacy-evidence.js";
import { STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION } from "./privacy-service-compatibility.js";
import { STARKNET_TRANSACTION_FINALITY_POLICIES } from "./starknet-transaction-observer.js";
import {
  STARKNET_SEPOLIA_CHAIN_ID,
  TESTNET_EVIDENCE_SCHEMA_VERSION,
  TESTNET_SCREENING_POLICY,
} from "./testnet-evidence.js";
import {
  createTestnetDeploymentConfigFromEnvironment,
  createTestnetPreflightConfigFromEnvironment,
  runTestnetPreflightCommand,
  type TestnetEnvironment,
  TestnetPreflightEnvironmentError,
} from "./testnet-preflight-config.js";

const RECORDED_AT = "2026-09-01T20:00:00.000Z";
const SIGNER_PRIVATE_KEY = "0x1234";
const VIEWING_KEY = "0x5678";
const ACCOUNT_ADDRESS = "0x789";
const PRIMARY_RPC_URL = "https://rpc-one.example/path?token=private-primary";
const SECONDARY_RPC_URL = "https://rpc-two.example/path?token=private-secondary";
const PROOF_INTERCEPTOR_URL = "https://interceptor.example";
const SCREENING_PROVIDER_URL = "https://screening.example/private-screening";
const SCREENING_PARTNER_SECRET = "c2NyZWVuaW5nLXNlY3JldA==";
const REQUIRED_VARIABLES = Object.keys(environmentFixture());

describe("testnet preflight environment", () => {
  it("builds the exact internal preflight config from named variables", () => {
    const config = createTestnetPreflightConfigFromEnvironment(environmentFixture(), RECORDED_AT);

    expect(config).toMatchObject({
      network: "SN_SEPOLIA",
      chainId: STARKNET_SEPOLIA_CHAIN_ID,
      recordedAt: RECORDED_AT,
      pool: {
        address: "0x123",
        classHash: STARKNET_PRIVACY_POOL_CLASS_HASH,
        version: STARKNET_PRIVACY_POOL_VERSION,
        deployment: {
          transactionReference: "0xaaa",
          manifestUrl: "https://deployments.example/immutable/sepolia-pool.json",
          manifestSha256: "a".repeat(64),
        },
      },
      token: {
        address: "0x456",
        classHash: "0x222",
        version: "usdc-test-v1",
        symbol: "USDC",
        decimals: 6,
        deployment: {
          transactionReference: "0xbbb",
          manifestUrl: "https://deployments.example/immutable/sepolia-usdc.json",
          manifestSha256: "b".repeat(64),
        },
      },
      account: {
        address: ACCOUNT_ADDRESS,
        classHash: "0xabc",
        version: "oz-account-v1",
      },
      rpcProviders: [
        { id: "rpc-primary", operator: "provider-one", url: PRIMARY_RPC_URL },
        { id: "rpc-secondary", operator: "provider-two", url: SECONDARY_RPC_URL },
      ],
      screening: {
        interceptor: {
          operator: "interceptor-one",
          url: PROOF_INTERCEPTOR_URL,
          version: STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION,
        },
        provider: { operator: "screener-one", url: SCREENING_PROVIDER_URL },
        rpcProviderId: "rpc-primary",
        poolAddress: "0x123",
        policy: TESTNET_SCREENING_POLICY,
        blockNonPoolTransactions: true,
        interceptorFailOpen: false,
        proverFailOpen: false,
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
      signerPrivateKey: SIGNER_PRIVATE_KEY,
      viewingKey: VIEWING_KEY,
      screeningCredentials: {
        partnerName: "partner-one",
        partnerSecret: SCREENING_PARTNER_SECRET,
      },
      safety: { testOnlyAccount: true, cappedFunds: true },
    });
  });

  it("builds read-only deployment config without accessing secret variables", () => {
    const environment = environmentFixture();
    Object.defineProperties(environment, {
      SETTLEMENT_SIGNER_PRIVATE_KEY: {
        get: () => {
          throw new Error("signer variable was read");
        },
      },
      SETTLEMENT_VIEWING_KEY: {
        get: () => {
          throw new Error("viewing variable was read");
        },
      },
      STRK20_SCREENING_PARTNER_NAME: {
        get: () => {
          throw new Error("screening partner name was read");
        },
      },
      STRK20_SCREENING_PARTNER_SECRET: {
        get: () => {
          throw new Error("screening partner secret was read");
        },
      },
    });

    const config = createTestnetDeploymentConfigFromEnvironment(environment, RECORDED_AT);

    expect(config).not.toHaveProperty("signerPrivateKey");
    expect(config).not.toHaveProperty("viewingKey");
    expect(config).not.toHaveProperty("screeningCredentials");
    expect(config).toMatchObject({
      network: "SN_SEPOLIA",
      account: { address: ACCOUNT_ADDRESS, classHash: "0xabc" },
    });
  });

  it("prints only sanitized deployment evidence", () => {
    const output: string[] = [];
    const errors: string[] = [];
    const environment = {
      ...environmentFixture(),
      CASHU_QUOTE_ID: "cashu-quote-secret",
      PRIVATE_NOTE: "private-note-plaintext",
    };

    expect(
      runTestnetPreflightCommand({
        environment,
        recordedAt: RECORDED_AT,
        writeOutput: (value) => output.push(value),
        writeError: (value) => errors.push(value),
      }),
    ).toBe(0);
    expect(errors).toEqual([]);
    expect(output).toHaveLength(1);

    const serialized = requiredValue(output[0]);
    expect(JSON.parse(serialized)).toMatchObject({
      schemaVersion: TESTNET_EVIDENCE_SCHEMA_VERSION,
      network: "SN_SEPOLIA",
      chainId: STARKNET_SEPOLIA_CHAIN_ID,
      account: { classHash: "0xabc", version: "oz-account-v1" },
    });
    for (const privateValue of [
      SIGNER_PRIVATE_KEY,
      VIEWING_KEY,
      ACCOUNT_ADDRESS,
      PRIMARY_RPC_URL,
      SECONDARY_RPC_URL,
      PROOF_INTERCEPTOR_URL,
      SCREENING_PROVIDER_URL,
      SCREENING_PARTNER_SECRET,
      "partner-one",
      "cashu-quote-secret",
      "private-note-plaintext",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it.each(REQUIRED_VARIABLES)("fails closed when %s is missing", (name) => {
    const environment: Record<string, string | undefined> = { ...environmentFixture() };
    delete environment[name];
    const result = captureCommand(environment);

    expect(result.exitCode).toBe(1);
    expect(result.output).toBe("");
    expect(result.error).toContain(name);
    expect(result.error).not.toContain(SIGNER_PRIVATE_KEY);
    expect(result.error).not.toContain(VIEWING_KEY);
  });

  it.each([
    { name: "zero positive value", variable: "STARKNET_PROVING_BLOCKS_BEHIND", value: "0" },
    { name: "negative value", variable: "STARKNET_MAXIMUM_HEAD_LAG_BLOCKS", value: "-1" },
    { name: "fractional value", variable: "STARKNET_MAXIMUM_BLOCK_AGE_SECONDS", value: "1.5" },
    { name: "leading zero", variable: "STARKNET_MAXIMUM_FUTURE_BLOCK_TIME_SECONDS", value: "01" },
    {
      name: "unsafe integer",
      variable: "STARKNET_MINIMUM_REMAINING_VALIDITY_BLOCKS",
      value: "9007199254740992",
    },
  ])("rejects a $name without echoing it", ({ variable, value }) => {
    const result = captureCommand({ ...environmentFixture(), [variable]: value });

    expect(result.exitCode).toBe(1);
    expect(result.output).toBe("");
    expect(result.error).toContain(variable);
    expect(result.error).not.toContain(value);
  });

  it.each([
    { variable: "STARKNET_NETWORK", value: "mainnet" },
    { variable: "STARKNET_FINALITY_POLICY", value: "latest" },
    { variable: "TESTNET_ACCOUNT_CONFIRMED", value: "TRUE" },
    { variable: "TESTNET_FUNDS_CAPPED", value: "false" },
    { variable: "STRK20_SCREENING_POLICY", value: "best_effort" },
    { variable: "STRK20_SCREENING_BLOCK_NON_POOL_TRANSACTIONS", value: "false" },
    { variable: "STRK20_SCREENING_FAIL_OPEN", value: "true" },
    { variable: "STRK20_PROVER_SCREENING_FAIL_OPEN", value: "true" },
    { variable: "STRK20_POOL_VERSION", value: ` ${STARKNET_PRIVACY_POOL_VERSION}` },
    { variable: "STRK20_WALLET_API_VERSION", value: "x".repeat(4_097) },
  ])("rejects invalid $variable syntax without echoing its value", ({ variable, value }) => {
    const result = captureCommand({ ...environmentFixture(), [variable]: value });

    expect(result.exitCode).toBe(1);
    expect(result.output).toBe("");
    expect(result.error).toContain(variable);
    expect(result.error).not.toContain(value);
  });

  it("redacts a malformed secret rejected by structured preflight", () => {
    const secret = "signer-secret-that-is-not-hex";
    const result = captureCommand({
      ...environmentFixture(),
      SETTLEMENT_SIGNER_PRIVATE_KEY: secret,
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toBe("");
    expect(result.error).not.toContain(secret);
    expect(result.error).toContain("signer private key");
  });

  it("redacts malformed screening credentials rejected by structured preflight", () => {
    const secret = "not-base64-secret";
    const result = captureCommand({
      ...environmentFixture(),
      STRK20_SCREENING_PARTNER_SECRET: secret,
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toBe("");
    expect(result.error).toBe("Testnet screening credentials are missing or invalid\n");
    expect(result.error).not.toContain(secret);
  });

  it("does not expose an exception thrown while reading the environment", () => {
    const secret = "secret-from-environment-provider";
    const environment = new Proxy(environmentFixture(), {
      get(target, property, receiver) {
        if (property === "STARKNET_CHAIN_ID") {
          throw new Error(secret);
        }
        return Reflect.get(target, property, receiver) as string | undefined;
      },
    });

    const result = captureCommand(environment);

    expect(result.exitCode).toBe(1);
    expect(result.output).toBe("");
    expect(result.error).not.toContain(secret);
    expect(result.error).toContain("STARKNET_CHAIN_ID");
  });

  it("rejects a non-string injected environment value through the typed error boundary", () => {
    const environment = {
      ...environmentFixture(),
      STARKNET_CHAIN_ID: 123 as unknown as string,
    };

    const result = captureCommand(environment);

    expect(result.exitCode).toBe(1);
    expect(result.output).toBe("");
    expect(result.error).toContain("STARKNET_CHAIN_ID");
  });

  it("uses a value-free error for unexpected failures", () => {
    const secret = "writer-secret";
    const errors: string[] = [];

    const exitCode = runTestnetPreflightCommand({
      environment: environmentFixture(),
      recordedAt: RECORDED_AT,
      writeOutput: () => {
        throw new Error(secret);
      },
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(errors.join("")).toBe("Testnet preflight failed unexpectedly\n");
    expect(errors.join("")).not.toContain(secret);
  });

  it("exposes typed environment failures to callers without including values", () => {
    try {
      createTestnetPreflightConfigFromEnvironment(
        { ...environmentFixture(), STARKNET_NETWORK: "private-mainnet-endpoint" },
        RECORDED_AT,
      );
      expect.unreachable("Invalid network was accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(TestnetPreflightEnvironmentError);
      expect(error).toMatchObject({ code: "invalid_variable" });
      expect((error as Error).message).not.toContain("private-mainnet-endpoint");
    }
  });
});

function environmentFixture(): Record<string, string> {
  return {
    STARKNET_NETWORK: "sepolia",
    STARKNET_CHAIN_ID: STARKNET_SEPOLIA_CHAIN_ID,
    STARKNET_RPC_PRIMARY_URL: PRIMARY_RPC_URL,
    STARKNET_RPC_PRIMARY_OPERATOR: "provider-one",
    STARKNET_RPC_SECONDARY_URL: SECONDARY_RPC_URL,
    STARKNET_RPC_SECONDARY_OPERATOR: "provider-two",
    STRK20_POOL_ADDRESS: "0x123",
    STRK20_POOL_CLASS_HASH: STARKNET_PRIVACY_POOL_CLASS_HASH,
    STRK20_POOL_VERSION: STARKNET_PRIVACY_POOL_VERSION,
    STRK20_POOL_DEPLOYMENT_TRANSACTION_REFERENCE: "0xaaa",
    STRK20_POOL_DEPLOYMENT_MANIFEST_URL: "https://deployments.example/immutable/sepolia-pool.json",
    STRK20_POOL_DEPLOYMENT_MANIFEST_SHA256: "a".repeat(64),
    STRK20_USDC_TOKEN_ADDRESS: "0x456",
    STRK20_USDC_TOKEN_CLASS_HASH: "0x222",
    STRK20_USDC_TOKEN_VERSION: "usdc-test-v1",
    STRK20_USDC_TOKEN_DEPLOYMENT_TRANSACTION_REFERENCE: "0xbbb",
    STRK20_USDC_TOKEN_DEPLOYMENT_MANIFEST_URL:
      "https://deployments.example/immutable/sepolia-usdc.json",
    STRK20_USDC_TOKEN_DEPLOYMENT_MANIFEST_SHA256: "b".repeat(64),
    STRK20_DISCOVERY_URL: "https://discovery.example/private-discovery",
    STRK20_DISCOVERY_OPERATOR: "indexer-one",
    STRK20_DISCOVERY_VERSION: "indexer-rc.2",
    STRK20_PROVING_URL: "https://prover.example/path?token=private-prover",
    STRK20_PROVING_OPERATOR: "prover-one",
    STRK20_PROVING_VERSION: "prover-rc.2",
    STRK20_PROOF_INTERCEPTOR_URL: PROOF_INTERCEPTOR_URL,
    STRK20_PROOF_INTERCEPTOR_OPERATOR: "interceptor-one",
    STRK20_PROOF_INTERCEPTOR_VERSION: STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION,
    STRK20_SCREENING_PROVIDER_URL: SCREENING_PROVIDER_URL,
    STRK20_SCREENING_PROVIDER_OPERATOR: "screener-one",
    STRK20_SCREENING_RPC_PROVIDER_ID: "rpc-primary",
    STRK20_SCREENING_POOL_ADDRESS: "0x123",
    STRK20_SCREENING_POLICY: TESTNET_SCREENING_POLICY,
    STRK20_SCREENING_BLOCK_NON_POOL_TRANSACTIONS: "true",
    STRK20_SCREENING_FAIL_OPEN: "false",
    STRK20_PROVER_SCREENING_FAIL_OPEN: "false",
    STRK20_WALLET_API_VERSION: "wallet-api-v1",
    STARKNET_FINALITY_POLICY: STARKNET_TRANSACTION_FINALITY_POLICIES.L1,
    STARKNET_PROVING_BLOCKS_BEHIND: "8",
    STARKNET_MINIMUM_REMAINING_VALIDITY_BLOCKS: "16",
    STARKNET_MAXIMUM_HEAD_LAG_BLOCKS: "3",
    STARKNET_MAXIMUM_BLOCK_AGE_SECONDS: "300",
    STARKNET_MAXIMUM_FUTURE_BLOCK_TIME_SECONDS: "30",
    STARKNET_RPC_REQUEST_TIMEOUT_MILLISECONDS: "10000",
    SETTLEMENT_ACCOUNT_ADDRESS: ACCOUNT_ADDRESS,
    SETTLEMENT_ACCOUNT_CLASS_HASH: "0xabc",
    SETTLEMENT_ACCOUNT_VERSION: "oz-account-v1",
    SETTLEMENT_SIGNER_PRIVATE_KEY: SIGNER_PRIVATE_KEY,
    SETTLEMENT_VIEWING_KEY: VIEWING_KEY,
    STRK20_SCREENING_PARTNER_NAME: "partner-one",
    STRK20_SCREENING_PARTNER_SECRET: SCREENING_PARTNER_SECRET,
    TESTNET_ACCOUNT_CONFIRMED: "true",
    TESTNET_FUNDS_CAPPED: "true",
  };
}

function captureCommand(environment: TestnetEnvironment): {
  readonly exitCode: 0 | 1;
  readonly output: string;
  readonly error: string;
} {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    exitCode: runTestnetPreflightCommand({
      environment,
      recordedAt: RECORDED_AT,
      writeOutput: (value) => output.push(value),
      writeError: (value) => errors.push(value),
    }),
    output: output.join(""),
    error: errors.join(""),
  };
}

function requiredValue<Value>(value: Value | undefined): Value {
  if (value === undefined) {
    throw new Error("Test fixture is incomplete");
  }
  return value;
}
