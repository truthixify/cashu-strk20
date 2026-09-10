import { createHash } from "node:crypto";

import type { BlockIdentifier } from "starknet";
import { describe, expect, it } from "vitest";

import {
  STARKNET_PRIVACY_POOL_CLASS_HASH,
  STARKNET_PRIVACY_POOL_VERSION,
  STARKNET_PRIVACY_SDK_COMMIT,
} from "./privacy-evidence.js";
import {
  STARKNET_DISCOVERY_SERVICE_COMPONENT_VERSION,
  STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION,
  STARKNET_TRANSACTION_PROVER_API_VERSION,
  STARKNET_TRANSACTION_PROVER_COMPONENT_VERSION,
} from "./privacy-service-compatibility.js";
import {
  STARKNET_UDC_ADDRESS,
  STARKNET_UDC_CLASS_HASH,
  STARKNET_UDC_CONTRACT_DEPLOYED_SELECTOR,
} from "./starknet-deployment-origin-verifier.js";
import { STARKNET_TRANSACTION_FINALITY_POLICIES } from "./starknet-transaction-observer.js";
import {
  runTestnetContextVerificationCommand,
  type TestnetContextRpc,
} from "./testnet-context-command.js";
import {
  STARKNET_PRIVACY_CONTRACT_PATH,
  STARKNET_PRIVACY_SOURCE_REPOSITORY,
  serializeTestnetDeploymentManifest,
  TESTNET_DEPLOYMENT_MANIFEST_SCHEMA_VERSION,
  type TestnetDeploymentManifestDocument,
} from "./testnet-deployment-manifest.js";
import {
  STARKNET_SEPOLIA_CHAIN_ID,
  TESTNET_VERIFIED_CONTEXT_SCHEMA_VERSION,
} from "./testnet-evidence.js";

const NOW_SECONDS = 2_000_000_000;
const NOW = new Date(NOW_SECONDS * 1_000);
const BLOCK_NUMBER = 1_234;
const BLOCK_HASH = "0xabc";
const ACCOUNT_ADDRESS = "0x789";
const POOL_ADDRESS = "0x52a6aa9d50631626d80b8e6acc9a9918ed8879cc24e793832dcb562e22255dd";
const TOKEN_ADDRESS = "0x6a8d4f1ed931cf91bf5a81d0d1f4101f6fe8584d9d857f1226a128cc6529cb6";
const POOL_BLOCK_HASH = "0xcafe";
const TOKEN_BLOCK_HASH = "0xdef";
const PRIMARY_RPC_URL = "https://rpc-one.example/private?token=primary-secret";
const SECONDARY_RPC_URL = "https://rpc-two.example/private?token=secondary-secret";
const SERVICE_SECRET = "private-service-token";
const POOL_MANIFEST_URL = "https://deployments.example/immutable/sepolia-pool.json";
const TOKEN_MANIFEST_URL = "https://deployments.example/immutable/sepolia-usdc.json";
const POOL_MANIFEST = serializeTestnetDeploymentManifest(poolManifest());
const TOKEN_MANIFEST = serializeTestnetDeploymentManifest(tokenManifest());

describe("testnet context verification command", () => {
  it("reuses one public profile and provider set to emit a sanitized verified context", async () => {
    const environment = environmentFixture();
    assertFundedVariablesUnread(environment);
    const output: string[] = [];
    const errors: string[] = [];
    const urls: string[] = [];
    const providers = [new FakeContextRpc(), new FakeContextRpc()];

    const exitCode = await runTestnetContextVerificationCommand({
      environment,
      createProvider(url) {
        urls.push(url);
        return requiredProvider(providers[urls.length - 1]);
      },
      fetchImplementation: serviceFetch(),
      now: () => NOW,
      writeOutput: (value) => output.push(value),
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(urls).toEqual([PRIMARY_RPC_URL, SECONDARY_RPC_URL]);
    expect(
      providers.every(({ classHashCalls, chainCalls }) => classHashCalls === 7 && chainCalls >= 2),
    ).toBe(true);
    const serialized = output.join("");
    expect(JSON.parse(serialized)).toMatchObject({
      schemaVersion: TESTNET_VERIFIED_CONTEXT_SCHEMA_VERSION,
      verifiedDeployment: {
        deployment: {
          network: "SN_SEPOLIA",
          pool: { address: POOL_ADDRESS, classHash: STARKNET_PRIVACY_POOL_CLASS_HASH },
          token: { address: TOKEN_ADDRESS, classHash: "0x222" },
          account: { classHash: "0xabc" },
        },
        manifestVerification: {
          verification: {
            manifestHashesMatch: true,
            poolConstructorMatchesPinnedAbi: true,
            transactionReceiptsVerified: false,
          },
        },
        verification: {
          blockHash: BLOCK_HASH,
          blockNumber: String(BLOCK_NUMBER),
          providerIds: ["rpc-primary", "rpc-secondary"],
          deploymentOriginVerified: true,
          deploymentApproved: false,
        },
      },
      serviceVerification: {
        services: {
          prover: { apiVersion: STARKNET_TRANSACTION_PROVER_API_VERSION },
          discovery: { status: "OK", indexedHead: { blockNumber: BLOCK_NUMBER } },
          screening: { healthStatus: "ok" },
        },
        chainVerification: {
          blockHash: BLOCK_HASH,
          blockNumber: BLOCK_NUMBER,
          providerIds: ["rpc-primary", "rpc-secondary"],
        },
        verification: {
          deploymentApproved: false,
          screeningActivityVerified: false,
          remoteRuntimeImageVerified: false,
        },
      },
      verification: { publicServiceProfileMatchesDeployment: true },
    });
    for (const privateValue of [
      ACCOUNT_ADDRESS,
      PRIMARY_RPC_URL,
      SECONDARY_RPC_URL,
      SERVICE_SECRET,
      "prover.example",
      "discovery.example",
      "interceptor.example",
      "screening.example",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("stops before service probes and emits no stdout when deployment verification fails", async () => {
    const secret = "private-deployment-failure";
    const providers = [new FakeContextRpc(), new FakeContextRpc(new Error(secret))];
    let providerIndex = 0;
    let serviceFetchCalls = 0;
    const output: string[] = [];
    const errors: string[] = [];

    const exitCode = await runTestnetContextVerificationCommand({
      environment: environmentFixture(),
      createProvider: () => requiredProvider(providers[providerIndex++]),
      fetchImplementation: manifestAndServiceFetch(() => {
        serviceFetchCalls += 1;
        return jsonResponse({});
      }),
      now: () => NOW,
      writeOutput: (value) => output.push(value),
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(serviceFetchCalls).toBe(0);
    expect(output).toEqual([]);
    expect(errors.join("")).toContain("rpc-secondary");
    expect(errors.join("")).not.toContain(secret);
    expect(errors.join("")).not.toContain(SECONDARY_RPC_URL);
  });

  it("does not construct RPC providers when a deployment manifest is unavailable", async () => {
    let providerCalls = 0;
    let fetchCalls = 0;
    const output: string[] = [];
    const errors: string[] = [];

    const exitCode = await runTestnetContextVerificationCommand({
      environment: environmentFixture(),
      createProvider: () => {
        providerCalls += 1;
        return new FakeContextRpc();
      },
      fetchImplementation: (async () => {
        fetchCalls += 1;
        return new Response(null, { status: 503 });
      }) as typeof fetch,
      now: () => NOW,
      writeOutput: (value) => output.push(value),
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(fetchCalls).toBe(2);
    expect(providerCalls).toBe(0);
    expect(output).toEqual([]);
    expect(errors.join("")).toBe("Testnet deployment manifest is unavailable\n");
  });

  it("emits no partial context when a privacy service is unavailable", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const providers = [new FakeContextRpc(), new FakeContextRpc()];
    let providerIndex = 0;

    const exitCode = await runTestnetContextVerificationCommand({
      environment: environmentFixture(),
      createProvider: () => requiredProvider(providers[providerIndex++]),
      fetchImplementation: manifestAndServiceFetch(() => {
        throw new Error(SERVICE_SECRET);
      }),
      now: () => NOW,
      writeOutput: (value) => output.push(value),
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(output).toEqual([]);
    expect(errors.join("")).toBe("Testnet prover service is unavailable\n");
    expect(errors.join("")).not.toContain(SERVICE_SECRET);
  });

  it("rejects invalid public configuration before providers or services are used", async () => {
    const environment = environmentFixture();
    Reflect.deleteProperty(environment, "STRK20_POOL_CLASS_HASH");
    let providerCalls = 0;
    let fetchCalls = 0;
    const errors: string[] = [];

    const exitCode = await runTestnetContextVerificationCommand({
      environment,
      createProvider: () => {
        providerCalls += 1;
        return new FakeContextRpc();
      },
      fetchImplementation: async () => {
        fetchCalls += 1;
        return jsonResponse({});
      },
      now: () => NOW,
      writeOutput: () => undefined,
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(providerCalls).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(errors.join("")).toContain("STRK20_POOL_CLASS_HASH");
  });

  it("uses fixed failures for provider construction, clocks, and output writers", async () => {
    const providerErrors: string[] = [];
    const providerExit = await runTestnetContextVerificationCommand({
      environment: environmentFixture(),
      createProvider() {
        throw new Error(SERVICE_SECRET);
      },
      fetchImplementation: serviceFetch(),
      now: () => NOW,
      writeOutput: () => undefined,
      writeError: (value) => providerErrors.push(value),
    });
    expect(providerExit).toBe(1);
    expect(providerErrors.join("")).toBe("Testnet context verification failed unexpectedly\n");

    const clockErrors: string[] = [];
    const clockExit = await runTestnetContextVerificationCommand({
      environment: environmentFixture(),
      now: () => new Date(Number.NaN),
      writeOutput: () => undefined,
      writeError: (value) => clockErrors.push(value),
    });
    expect(clockExit).toBe(1);
    expect(clockErrors.join("")).toBe("Testnet context verification failed unexpectedly\n");

    const providers = [new FakeContextRpc(), new FakeContextRpc()];
    let providerIndex = 0;
    const writerErrors: string[] = [];
    const writerExit = await runTestnetContextVerificationCommand({
      environment: environmentFixture(),
      createProvider: () => requiredProvider(providers[providerIndex++]),
      fetchImplementation: serviceFetch(),
      now: () => NOW,
      writeOutput() {
        throw new Error(SERVICE_SECRET);
      },
      writeError: (value) => writerErrors.push(value),
    });
    expect(writerExit).toBe(1);
    expect(writerErrors.join("")).toBe("Testnet context verification failed unexpectedly\n");
    expect(writerErrors.join("")).not.toContain(SERVICE_SECRET);
  });
});

class FakeContextRpc implements TestnetContextRpc {
  readonly #error: Error | undefined;
  classHashCalls = 0;
  chainCalls = 0;

  constructor(error?: Error) {
    this.#error = error;
  }

  async getChainId(): Promise<string> {
    this.chainCalls += 1;
    this.#throwIfFailed();
    return STARKNET_SEPOLIA_CHAIN_ID;
  }

  async getBlockWithTxHashes(blockIdentifier: BlockIdentifier = "latest"): Promise<unknown> {
    this.#throwIfFailed();
    if (String(blockIdentifier) === "99") {
      return deploymentBlock("0xaaa", POOL_BLOCK_HASH, 99);
    }
    if (String(blockIdentifier) === "100") {
      return deploymentBlock("0xbbb", TOKEN_BLOCK_HASH, 100);
    }
    return {
      status: "ACCEPTED_ON_L1",
      block_hash: BLOCK_HASH,
      block_number: BLOCK_NUMBER,
      timestamp: NOW_SECONDS - 10,
      transactions: [],
    };
  }

  async getTransactionReceipt(transactionHash: string): Promise<unknown> {
    this.#throwIfFailed();
    return deploymentReceipt(transactionHash);
  }

  async getClassHashAt(
    contractAddress: string,
    _blockIdentifier?: BlockIdentifier,
  ): Promise<string> {
    this.classHashCalls += 1;
    this.#throwIfFailed();
    const value = new Map([
      [POOL_ADDRESS, STARKNET_PRIVACY_POOL_CLASS_HASH],
      [TOKEN_ADDRESS, "0x222"],
      [STARKNET_UDC_ADDRESS, STARKNET_UDC_CLASS_HASH],
      [ACCOUNT_ADDRESS, "0xabc"],
    ]).get(contractAddress);
    if (value === undefined) {
      throw new Error("Unknown test contract");
    }
    return value;
  }

  #throwIfFailed(): void {
    if (this.#error !== undefined) {
      throw this.#error;
    }
  }
}

function deploymentReceipt(transactionHash: string): Record<string, unknown> {
  if (transactionHash === "0xaaa") {
    return acceptedDeploymentReceipt({
      transactionHash,
      blockHash: POOL_BLOCK_HASH,
      blockNumber: 99,
      address: POOL_ADDRESS,
      classHash: STARKNET_PRIVACY_POOL_CLASS_HASH,
      unique: false,
      constructorCalldata: ["0x777", "0x111", "0x222", "0x1c2"],
      salt: "0x1",
    });
  }
  if (transactionHash === "0xbbb") {
    return acceptedDeploymentReceipt({
      transactionHash,
      blockHash: TOKEN_BLOCK_HASH,
      blockNumber: 100,
      address: TOKEN_ADDRESS,
      classHash: "0x222",
      unique: true,
      constructorCalldata: [],
      salt: "0x2",
    });
  }
  throw new Error("Unknown deployment transaction");
}

function acceptedDeploymentReceipt(input: {
  readonly transactionHash: string;
  readonly blockHash: string;
  readonly blockNumber: number;
  readonly address: string;
  readonly classHash: string;
  readonly unique: boolean;
  readonly constructorCalldata: readonly string[];
  readonly salt: string;
}): Record<string, unknown> {
  return {
    type: "INVOKE",
    transaction_hash: input.transactionHash,
    block_hash: input.blockHash,
    block_number: input.blockNumber,
    finality_status: "ACCEPTED_ON_L1",
    execution_status: "SUCCEEDED",
    events: [
      {
        from_address: STARKNET_UDC_ADDRESS,
        keys: [STARKNET_UDC_CONTRACT_DEPLOYED_SELECTOR],
        data: [
          input.address,
          "0x777",
          input.unique ? "0x1" : "0x0",
          input.classHash,
          `0x${input.constructorCalldata.length.toString(16)}`,
          ...input.constructorCalldata,
          input.salt,
        ],
      },
    ],
  };
}

function deploymentBlock(
  transactionHash: string,
  blockHash: string,
  blockNumber: number,
): Record<string, unknown> {
  return {
    status: "ACCEPTED_ON_L1",
    block_hash: blockHash,
    block_number: blockNumber,
    transactions: [transactionHash],
  };
}

function serviceFetch(): typeof fetch {
  return manifestAndServiceFetch(async (input) => {
    const url = String(input);
    if (url.includes("prover.example")) {
      return jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: STARKNET_TRANSACTION_PROVER_API_VERSION,
      });
    }
    if (url.includes("interceptor.example")) {
      return jsonResponse({ status: "ok" });
    }
    return jsonResponse({
      status: "OK",
      chain_head: {
        block_number: BLOCK_NUMBER,
        block_hash: BLOCK_HASH,
        timestamp: NOW_SECONDS - 10,
      },
      lag_secs: 10,
    });
  });
}

function manifestAndServiceFetch(
  service: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => Promise<Response> | Response,
): typeof fetch {
  return (async (input, init) => {
    const manifestBody = new Map([
      [POOL_MANIFEST_URL, POOL_MANIFEST],
      [TOKEN_MANIFEST_URL, TOKEN_MANIFEST],
    ]).get(String(input));
    if (manifestBody !== undefined) {
      return new Response(manifestBody, { headers: { "content-type": "application/json" } });
    }
    return service(input, init);
  }) as typeof fetch;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function poolManifest(): TestnetDeploymentManifestDocument {
  return {
    schemaVersion: TESTNET_DEPLOYMENT_MANIFEST_SCHEMA_VERSION,
    network: "SN_SEPOLIA",
    chainId: STARKNET_SEPOLIA_CHAIN_ID,
    contracts: [
      {
        role: "privacy_pool",
        address: POOL_ADDRESS,
        classHash: STARKNET_PRIVACY_POOL_CLASS_HASH,
        version: STARKNET_PRIVACY_POOL_VERSION,
        source: {
          repository: STARKNET_PRIVACY_SOURCE_REPOSITORY,
          commit: STARKNET_PRIVACY_SDK_COMMIT,
          contractPath: STARKNET_PRIVACY_CONTRACT_PATH,
        },
        deployment: {
          transactionReference: "0xaaa",
          acceptedBlockHash: POOL_BLOCK_HASH,
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
      },
    ],
  };
}

function tokenManifest(): TestnetDeploymentManifestDocument {
  return {
    schemaVersion: TESTNET_DEPLOYMENT_MANIFEST_SCHEMA_VERSION,
    network: "SN_SEPOLIA",
    chainId: STARKNET_SEPOLIA_CHAIN_ID,
    contracts: [
      {
        role: "usdc_token",
        address: TOKEN_ADDRESS,
        classHash: "0x222",
        version: "usdc-test-v1",
        source: {
          repository: "https://github.com/example/test-usdc",
          commit: "c".repeat(40),
          contractPath: "src/TestUsdc.cairo",
        },
        deployment: {
          transactionReference: "0xbbb",
          acceptedBlockHash: TOKEN_BLOCK_HASH,
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
      },
    ],
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function environmentFixture(): Record<string, string> {
  return {
    STARKNET_NETWORK: "sepolia",
    STARKNET_CHAIN_ID: STARKNET_SEPOLIA_CHAIN_ID,
    STARKNET_RPC_PRIMARY_URL: PRIMARY_RPC_URL,
    STARKNET_RPC_PRIMARY_OPERATOR: "provider-one",
    STARKNET_RPC_SECONDARY_URL: SECONDARY_RPC_URL,
    STARKNET_RPC_SECONDARY_OPERATOR: "provider-two",
    STRK20_POOL_ADDRESS: POOL_ADDRESS,
    STRK20_POOL_CLASS_HASH: STARKNET_PRIVACY_POOL_CLASS_HASH,
    STRK20_POOL_VERSION: STARKNET_PRIVACY_POOL_VERSION,
    STRK20_POOL_DEPLOYMENT_TRANSACTION_REFERENCE: "0xaaa",
    STRK20_POOL_DEPLOYMENT_MANIFEST_URL: POOL_MANIFEST_URL,
    STRK20_POOL_DEPLOYMENT_MANIFEST_SHA256: sha256(POOL_MANIFEST),
    STRK20_USDC_TOKEN_ADDRESS: TOKEN_ADDRESS,
    STRK20_USDC_TOKEN_CLASS_HASH: "0x222",
    STRK20_USDC_TOKEN_VERSION: "usdc-test-v1",
    STRK20_USDC_TOKEN_DEPLOYMENT_TRANSACTION_REFERENCE: "0xbbb",
    STRK20_USDC_TOKEN_DEPLOYMENT_MANIFEST_URL: TOKEN_MANIFEST_URL,
    STRK20_USDC_TOKEN_DEPLOYMENT_MANIFEST_SHA256: sha256(TOKEN_MANIFEST),
    STRK20_DISCOVERY_URL: "https://discovery.example/indexer",
    STRK20_DISCOVERY_OPERATOR: "indexer-one",
    STRK20_DISCOVERY_VERSION: STARKNET_DISCOVERY_SERVICE_COMPONENT_VERSION,
    STRK20_PROVING_URL: `https://prover.example/rpc?token=${SERVICE_SECRET}`,
    STRK20_PROVING_OPERATOR: "prover-one",
    STRK20_PROVING_VERSION: STARKNET_TRANSACTION_PROVER_COMPONENT_VERSION,
    STRK20_PROOF_INTERCEPTOR_URL: "https://interceptor.example",
    STRK20_PROOF_INTERCEPTOR_OPERATOR: "interceptor-one",
    STRK20_PROOF_INTERCEPTOR_VERSION: STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION,
    STRK20_SCREENING_PROVIDER_URL: "https://screening.example/api",
    STRK20_SCREENING_PROVIDER_OPERATOR: "screener-one",
    STRK20_SCREENING_RPC_PROVIDER_ID: "rpc-primary",
    STRK20_SCREENING_POOL_ADDRESS: POOL_ADDRESS,
    STRK20_SCREENING_POLICY: "fail_closed_v1",
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
    TESTNET_ACCOUNT_CONFIRMED: "true",
    TESTNET_FUNDS_CAPPED: "true",
  };
}

function assertFundedVariablesUnread(environment: Record<string, string>): void {
  for (const name of [
    "SETTLEMENT_SIGNER_PRIVATE_KEY",
    "SETTLEMENT_VIEWING_KEY",
    "STRK20_SCREENING_PARTNER_NAME",
    "STRK20_SCREENING_PARTNER_SECRET",
  ]) {
    Object.defineProperty(environment, name, {
      get() {
        throw new Error(`${name} was read`);
      },
    });
  }
}

function requiredProvider(provider: TestnetContextRpc | undefined): TestnetContextRpc {
  if (provider === undefined) {
    throw new Error("Test context provider is missing");
  }
  return provider;
}
