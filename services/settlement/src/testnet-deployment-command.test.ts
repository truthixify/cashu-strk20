import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { BlockIdentifier } from "starknet";
import { describe, expect, it } from "vitest";
import {
  STARKNET_PRIVACY_POOL_CLASS_HASH,
  STARKNET_PRIVACY_POOL_VERSION,
  STARKNET_PRIVACY_SDK_COMMIT,
} from "./privacy-evidence.js";
import { STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION } from "./privacy-service-compatibility.js";
import {
  STARKNET_UDC_ADDRESS,
  STARKNET_UDC_CLASS_HASH,
  STARKNET_UDC_CONTRACT_DEPLOYED_SELECTOR,
} from "./starknet-deployment-origin-verifier.js";
import {
  runTestnetDeploymentVerificationCommand,
  type TestnetDeploymentVerificationRpc,
} from "./testnet-deployment-command.js";
import {
  STARKNET_PRIVACY_CONTRACT_PATH,
  STARKNET_PRIVACY_SOURCE_REPOSITORY,
  serializeTestnetDeploymentManifest,
  TESTNET_DEPLOYMENT_MANIFEST_SCHEMA_VERSION,
  type TestnetDeploymentManifestDocument,
} from "./testnet-deployment-manifest.js";
import { STARKNET_SEPOLIA_CHAIN_ID } from "./testnet-evidence.js";

const NOW_SECONDS = 2_000_000_000;
const HEAD_BLOCK_NUMBER = 1_234;
const ACCOUNT_ADDRESS = "0x789";
const POOL_ADDRESS = "0x52a6aa9d50631626d80b8e6acc9a9918ed8879cc24e793832dcb562e22255dd";
const TOKEN_ADDRESS = "0x6a8d4f1ed931cf91bf5a81d0d1f4101f6fe8584d9d857f1226a128cc6529cb6";
const POOL_BLOCK_HASH = "0xabc";
const TOKEN_BLOCK_HASH = "0xdef";
const PRIMARY_RPC_URL = "https://rpc-one.example/path?token=private-primary";
const SECONDARY_RPC_URL = "https://rpc-two.example/path?token=private-secondary";
const POOL_MANIFEST_URL = "https://deployments.example/immutable/sepolia-pool.json";
const TOKEN_MANIFEST_URL = "https://deployments.example/immutable/sepolia-usdc.json";
const POOL_MANIFEST = serializeTestnetDeploymentManifest(poolManifest());
const TOKEN_MANIFEST = serializeTestnetDeploymentManifest(tokenManifest());

describe("testnet deployment verification command", () => {
  it("emits sanitized evidence without reading signer or viewing configuration", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const urls: string[] = [];
    const providers = [new FakeDeploymentRpc(), new FakeDeploymentRpc()];

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

    const exitCode = await runTestnetDeploymentVerificationCommand({
      environment,
      createProvider: (url) => {
        urls.push(url);
        const provider = providers.shift();
        if (provider === undefined) {
          throw new Error("Unexpected provider request");
        }
        return provider;
      },
      fetchImplementation: manifestFetch(),
      now: fixedClock(),
      writeOutput: (value) => output.push(value),
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(urls).toEqual([PRIMARY_RPC_URL, SECONDARY_RPC_URL]);
    const serialized = output.join("");
    expect(JSON.parse(serialized)).toMatchObject({
      deployment: {
        network: "SN_SEPOLIA",
        pool: { address: POOL_ADDRESS, classHash: STARKNET_PRIVACY_POOL_CLASS_HASH },
        token: { address: TOKEN_ADDRESS, classHash: "0x222" },
        account: { classHash: "0xabc" },
      },
      verification: {
        blockHash: "0xbeef",
        blockNumber: String(HEAD_BLOCK_NUMBER),
        poolClassHash: STARKNET_PRIVACY_POOL_CLASS_HASH,
        tokenClassHash: "0x222",
        accountClassHash: "0xabc",
        providerIds: ["rpc-primary", "rpc-secondary"],
      },
    });
    for (const privateValue of [ACCOUNT_ADDRESS, PRIMARY_RPC_URL, SECONDARY_RPC_URL]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("uses the pinned Starknet.js provider through deterministic loopback RPCs", async () => {
    const methods: string[] = [];
    const servers = await Promise.all([startRpcServer(methods), startRpcServer(methods)]);
    const output: string[] = [];
    const errors: string[] = [];
    try {
      const environment = environmentFixture();
      Object.assign(environment, {
        STARKNET_RPC_PRIMARY_URL: servers[0]?.url ?? "",
        STARKNET_RPC_SECONDARY_URL: servers[1]?.url ?? "",
      });

      const exitCode = await runTestnetDeploymentVerificationCommand({
        environment,
        fetchImplementation: manifestFetch(),
        now: fixedClock(),
        writeOutput: (value) => output.push(value),
        writeError: (value) => errors.push(value),
      });

      expect(exitCode).toBe(0);
      expect(errors).toEqual([]);
      expect(JSON.parse(output.join(""))).toMatchObject({
        verification: {
          blockHash: "0xbeef",
          poolClassHash: STARKNET_PRIVACY_POOL_CLASS_HASH,
          tokenClassHash: "0x222",
          accountClassHash: "0xabc",
        },
      });
      expect(new Set(methods)).toEqual(
        new Set([
          "starknet_chainId",
          "starknet_getTransactionReceipt",
          "starknet_getBlockWithTxHashes",
          "starknet_getClassHashAt",
        ]),
      );
      for (const server of servers) {
        expect(output.join("")).not.toContain(server.url);
      }
    } finally {
      await Promise.all(servers.map(({ server }) => closeServer(server)));
    }
  });

  it("returns a redacted provider failure without partial stdout", async () => {
    const secret = "credential-bearing-provider-failure";
    const output: string[] = [];
    const errors: string[] = [];
    const first = new FakeDeploymentRpc();
    const second = new FakeDeploymentRpc();
    second.error = new Error(secret);
    const providers = [first, second];

    const exitCode = await runTestnetDeploymentVerificationCommand({
      environment: environmentFixture(),
      createProvider: () => requiredProvider(providers.shift()),
      fetchImplementation: manifestFetch(),
      now: fixedClock(),
      writeOutput: (value) => output.push(value),
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(output).toEqual([]);
    expect(errors.join("")).toContain("rpc-secondary");
    expect(errors.join("")).not.toContain(secret);
    expect(errors.join("")).not.toContain(SECONDARY_RPC_URL);
  });

  it("redacts an unexpected provider-construction failure", async () => {
    const secret = "credential-bearing-constructor-failure";
    const errors: string[] = [];

    const exitCode = await runTestnetDeploymentVerificationCommand({
      environment: environmentFixture(),
      createProvider: () => {
        throw new Error(secret);
      },
      fetchImplementation: manifestFetch(),
      now: fixedClock(),
      writeOutput: () => undefined,
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(errors.join("")).toBe("Testnet deployment verification failed unexpectedly\n");
    expect(errors.join("")).not.toContain(secret);
  });

  it("fails before provider construction when the profile is incomplete", async () => {
    const environment = environmentFixture();
    Reflect.deleteProperty(environment, "STRK20_POOL_CLASS_HASH");
    const errors: string[] = [];
    let providerCalls = 0;

    const exitCode = await runTestnetDeploymentVerificationCommand({
      environment,
      createProvider: () => {
        providerCalls += 1;
        return new FakeDeploymentRpc();
      },
      now: fixedClock(),
      writeOutput: () => undefined,
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(providerCalls).toBe(0);
    expect(errors.join("")).toContain("STRK20_POOL_CLASS_HASH");
  });

  it("uses a value-free error when stdout fails", async () => {
    const secret = "writer-secret";
    const errors: string[] = [];
    const providers = [new FakeDeploymentRpc(), new FakeDeploymentRpc()];

    const exitCode = await runTestnetDeploymentVerificationCommand({
      environment: environmentFixture(),
      createProvider: () => requiredProvider(providers.shift()),
      fetchImplementation: manifestFetch(),
      now: fixedClock(),
      writeOutput: () => {
        throw new Error(secret);
      },
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(errors.join("")).toBe("Testnet deployment verification failed unexpectedly\n");
    expect(errors.join("")).not.toContain(secret);
  });

  it("stops before provider construction when a manifest is unavailable", async () => {
    const secret = "private-manifest-failure";
    const errors: string[] = [];
    let providerCalls = 0;

    const exitCode = await runTestnetDeploymentVerificationCommand({
      environment: environmentFixture(),
      createProvider: () => {
        providerCalls += 1;
        return new FakeDeploymentRpc();
      },
      fetchImplementation: (async () => {
        throw new Error(secret);
      }) as typeof fetch,
      now: fixedClock(),
      writeOutput: () => undefined,
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(providerCalls).toBe(0);
    expect(errors.join("")).toBe("Testnet deployment manifest is unavailable\n");
    expect(errors.join("")).not.toContain(secret);
  });
});

class FakeDeploymentRpc implements TestnetDeploymentVerificationRpc {
  error?: Error;

  async getChainId(): Promise<string> {
    if (this.error !== undefined) {
      throw this.error;
    }
    return STARKNET_SEPOLIA_CHAIN_ID;
  }

  async getBlockWithTxHashes(blockIdentifier: BlockIdentifier = "latest"): Promise<unknown> {
    if (this.error !== undefined) {
      throw this.error;
    }
    if (String(blockIdentifier) === "99") {
      return deploymentBlock("0xaaa", POOL_BLOCK_HASH, 99);
    }
    if (String(blockIdentifier) === "100") {
      return deploymentBlock("0xbbb", TOKEN_BLOCK_HASH, 100);
    }
    return {
      status: "ACCEPTED_ON_L1",
      block_hash: "0xbeef",
      block_number: HEAD_BLOCK_NUMBER,
      timestamp: NOW_SECONDS - 10,
      transactions: [],
      requestedBlock: blockIdentifier,
    };
  }

  async getTransactionReceipt(transactionHash: string): Promise<unknown> {
    if (this.error !== undefined) {
      throw this.error;
    }
    return deploymentReceipt(transactionHash);
  }

  async getClassHashAt(contractAddress: string): Promise<string> {
    if (this.error !== undefined) {
      throw this.error;
    }
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

function manifestFetch(): typeof fetch {
  return (async (input) => {
    const body = new Map([
      [POOL_MANIFEST_URL, POOL_MANIFEST],
      [TOKEN_MANIFEST_URL, TOKEN_MANIFEST],
    ]).get(String(input));
    if (body === undefined) {
      throw new Error("Unexpected manifest URL");
    }
    return new Response(body, { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
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
    STRK20_DISCOVERY_URL: "https://discovery.example/private-discovery",
    STRK20_DISCOVERY_OPERATOR: "indexer-one",
    STRK20_DISCOVERY_VERSION: "indexer-rc.2",
    STRK20_PROVING_URL: "https://prover.example/path?token=private-prover",
    STRK20_PROVING_OPERATOR: "prover-one",
    STRK20_PROVING_VERSION: "prover-rc.2",
    STRK20_PROOF_INTERCEPTOR_URL: "https://interceptor.example",
    STRK20_PROOF_INTERCEPTOR_OPERATOR: "interceptor-one",
    STRK20_PROOF_INTERCEPTOR_VERSION: STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION,
    STRK20_SCREENING_PROVIDER_URL: "https://screening.example/private-screening",
    STRK20_SCREENING_PROVIDER_OPERATOR: "screener-one",
    STRK20_SCREENING_RPC_PROVIDER_ID: "rpc-primary",
    STRK20_SCREENING_POOL_ADDRESS: POOL_ADDRESS,
    STRK20_SCREENING_POLICY: "fail_closed_v1",
    STRK20_SCREENING_BLOCK_NON_POOL_TRANSACTIONS: "true",
    STRK20_SCREENING_FAIL_OPEN: "false",
    STRK20_PROVER_SCREENING_FAIL_OPEN: "false",
    STRK20_WALLET_API_VERSION: "wallet-api-v1",
    STARKNET_FINALITY_POLICY: "starknet_l1_final_v1",
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

function fixedClock(): () => Date {
  return () => new Date(NOW_SECONDS * 1_000);
}

function requiredProvider(provider: FakeDeploymentRpc | undefined): FakeDeploymentRpc {
  if (provider === undefined) {
    throw new Error("Test provider is missing");
  }
  return provider;
}

async function startRpcServer(
  methods: string[],
): Promise<{ readonly server: Server; readonly url: string }> {
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const payload = JSON.parse(body) as RpcRequest;
      methods.push(payload.method);
      const result = rpcResult(payload);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function rpcResult(request: RpcRequest): unknown {
  if (request.method === "starknet_chainId") {
    return STARKNET_SEPOLIA_CHAIN_ID;
  }
  if (request.method === "starknet_getBlockWithTxHashes") {
    const blockNumber = requestedBlockNumber(request.params?.block_id);
    if (blockNumber === 99) {
      return deploymentBlock("0xaaa", POOL_BLOCK_HASH, blockNumber);
    }
    if (blockNumber === 100) {
      return deploymentBlock("0xbbb", TOKEN_BLOCK_HASH, blockNumber);
    }
    return {
      status: "ACCEPTED_ON_L1",
      block_hash: "0xbeef",
      parent_hash: "0xaaa",
      block_number: HEAD_BLOCK_NUMBER,
      new_root: "0xbbb",
      timestamp: NOW_SECONDS - 10,
      sequencer_address: "0x1",
      l1_gas_price: { price_in_fri: "0x1", price_in_wei: "0x1" },
      l1_data_gas_price: { price_in_fri: "0x1", price_in_wei: "0x1" },
      l2_gas_price: { price_in_fri: "0x1", price_in_wei: "0x1" },
      l1_da_mode: "BLOB",
      starknet_version: "0.14.0",
      transactions: [],
    };
  }
  if (request.method === "starknet_getTransactionReceipt") {
    return deploymentReceipt(request.params?.transaction_hash ?? "");
  }
  if (request.method === "starknet_getClassHashAt") {
    const value = new Map([
      [POOL_ADDRESS, STARKNET_PRIVACY_POOL_CLASS_HASH],
      [TOKEN_ADDRESS, "0x222"],
      [STARKNET_UDC_ADDRESS, STARKNET_UDC_CLASS_HASH],
      [ACCOUNT_ADDRESS, "0xabc"],
    ]).get(request.params?.contract_address ?? "");
    if (value !== undefined) {
      return value;
    }
  }
  throw new Error(`Unexpected test RPC method ${request.method}`);
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

function requestedBlockNumber(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || !("block_number" in value)) {
    return undefined;
  }
  const blockNumber = (value as { readonly block_number?: unknown }).block_number;
  return typeof blockNumber === "number" ? blockNumber : undefined;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

interface RpcRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params?: {
    readonly block_id?: unknown;
    readonly contract_address?: string;
    readonly transaction_hash?: string;
  };
}
