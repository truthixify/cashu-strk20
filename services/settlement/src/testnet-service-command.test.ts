import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { BlockIdentifier } from "starknet";
import { describe, expect, it } from "vitest";

import {
  STARKNET_PRIVACY_POOL_CLASS_HASH,
  STARKNET_PRIVACY_POOL_VERSION,
} from "./privacy-evidence.js";
import type { StarknetDiscoveryHeadRpc } from "./starknet-discovery-head-verifier.js";
import { STARKNET_TRANSACTION_FINALITY_POLICIES } from "./starknet-transaction-observer.js";
import { runTestnetPrivacyServiceVerificationCommand } from "./testnet-service-command.js";
import {
  STARKNET_DISCOVERY_SERVICE_COMPONENT_VERSION,
  STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION,
  STARKNET_TRANSACTION_PROVER_API_VERSION,
  STARKNET_TRANSACTION_PROVER_COMPONENT_VERSION,
} from "./testnet-service-verifier.js";

const NOW = new Date("2026-09-02T02:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
const SECRET = "private-service-token";
const PRIMARY_RPC_URL = "https://rpc-one.example";
const SECONDARY_RPC_URL = "https://rpc-two.example";

describe("testnet privacy service verification command", () => {
  it("loads only the read-only profile and prints sanitized service evidence", async () => {
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
    const output: string[] = [];
    const errors: string[] = [];
    const providerUrls: string[] = [];
    const exitCode = await runTestnetPrivacyServiceVerificationCommand({
      environment,
      createProvider: providerFactory(providerUrls),
      fetchImplementation: serviceFetch(),
      now: () => NOW,
      writeOutput: (value) => output.push(value),
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(JSON.parse(output.join(""))).toMatchObject({
      verifiedAt: NOW.toISOString(),
      services: {
        prover: { operator: "prover-one", apiVersion: STARKNET_TRANSACTION_PROVER_API_VERSION },
        discovery: { operator: "indexer-one", status: "OK" },
        screening: {
          interceptorOperator: "interceptor-one",
          screeningProviderOperator: "screener-one",
          healthStatus: "ok",
        },
      },
      chainVerification: {
        blockHash: "0xabc",
        blockNumber: 1_234,
        minimumAcceptedStatus: "ACCEPTED_ON_L2",
        providerIds: ["rpc-primary", "rpc-secondary"],
      },
    });
    expect(providerUrls).toEqual([PRIMARY_RPC_URL, SECONDARY_RPC_URL]);
    expect(output.join("")).not.toContain(SECRET);
    expect(output.join("")).not.toContain("prover.example");
    expect(output.join("")).not.toContain("discovery.example");
    expect(output.join("")).not.toContain("interceptor.example");
    expect(output.join("")).not.toContain("screening.example");
    expect(output.join("")).not.toContain("0x789");
  });

  it("fails before network access when the component pin is wrong", async () => {
    let calls = 0;
    const errors: string[] = [];
    const exitCode = await runTestnetPrivacyServiceVerificationCommand({
      environment: {
        ...environmentFixture(),
        STRK20_PROVING_VERSION: "PRIVACY-0.14.3-RC.3",
      },
      fetchImplementation: async () => {
        calls += 1;
        return jsonResponse({});
      },
      now: () => NOW,
      writeOutput: () => undefined,
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(calls).toBe(0);
    expect(errors.join("")).toBe("Testnet privacy service configuration is invalid\n");
  });

  it("uses value-free failures for upstream and output-writer errors", async () => {
    const upstreamErrors: string[] = [];
    const upstreamExitCode = await runTestnetPrivacyServiceVerificationCommand({
      environment: environmentFixture(),
      fetchImplementation: async () => {
        throw new Error(SECRET);
      },
      now: () => NOW,
      writeOutput: () => undefined,
      writeError: (value) => upstreamErrors.push(value),
    });
    expect(upstreamExitCode).toBe(1);
    expect(upstreamErrors.join("")).toBe("Testnet prover service is unavailable\n");
    expect(upstreamErrors.join("")).not.toContain(SECRET);

    const writerErrors: string[] = [];
    const writerExitCode = await runTestnetPrivacyServiceVerificationCommand({
      environment: environmentFixture(),
      createProvider: providerFactory(),
      fetchImplementation: serviceFetch(),
      now: () => NOW,
      writeOutput: () => {
        throw new Error(SECRET);
      },
      writeError: (value) => writerErrors.push(value),
    });
    expect(writerExitCode).toBe(1);
    expect(writerErrors.join("")).toBe(
      "Testnet privacy service verification failed unexpectedly\n",
    );
    expect(writerErrors.join("")).not.toContain(SECRET);
  });

  it("uses a provider-only error for discovery chain verification failure", async () => {
    const errors: string[] = [];
    const providers = [new FakeDiscoveryHeadRpc(), new FakeDiscoveryHeadRpc(new Error(SECRET))];
    const exitCode = await runTestnetPrivacyServiceVerificationCommand({
      environment: environmentFixture(),
      createProvider: () => requiredProvider(providers.shift()),
      fetchImplementation: serviceFetch(),
      now: () => NOW,
      writeOutput: () => undefined,
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(errors.join("")).toBe(
      "Starknet provider rpc-secondary could not verify the discovery head\n",
    );
    expect(errors.join("")).not.toContain(SECRET);
  });

  it("uses the pinned Starknet.js provider for the discovery-head cross-check", async () => {
    const requests: RpcRequest[] = [];
    const servers = await Promise.all([startRpcServer(requests), startRpcServer(requests)]);
    const output: string[] = [];
    const errors: string[] = [];
    try {
      const environment = {
        ...environmentFixture(),
        STARKNET_RPC_PRIMARY_URL: requiredServer(servers, 0).url,
        STARKNET_RPC_SECONDARY_URL: requiredServer(servers, 1).url,
      };
      const exitCode = await runTestnetPrivacyServiceVerificationCommand({
        environment,
        fetchImplementation: serviceFetch(),
        now: () => NOW,
        writeOutput: (value) => output.push(value),
        writeError: (value) => errors.push(value),
      });

      expect(exitCode).toBe(0);
      expect(errors).toEqual([]);
      expect(requests.map(({ method }) => method).sort()).toEqual([
        "starknet_chainId",
        "starknet_chainId",
        "starknet_getBlockWithTxHashes",
        "starknet_getBlockWithTxHashes",
      ]);
      expect(
        requests
          .filter(({ method }) => method === "starknet_getBlockWithTxHashes")
          .map(({ params }) => params?.block_id),
      ).toEqual([{ block_number: 1_234 }, { block_number: 1_234 }]);
      for (const { url } of servers) {
        expect(output.join("")).not.toContain(url);
      }
    } finally {
      await Promise.all(servers.map(({ server }) => closeServer(server)));
    }
  });

  it("redacts invalid environment values", async () => {
    const errors: string[] = [];
    const exitCode = await runTestnetPrivacyServiceVerificationCommand({
      environment: { ...environmentFixture(), STARKNET_NETWORK: SECRET },
      fetchImplementation: serviceFetch(),
      now: () => NOW,
      writeOutput: () => undefined,
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(errors.join("")).toContain("STARKNET_NETWORK");
    expect(errors.join("")).not.toContain(SECRET);
  });
});

function serviceFetch(): typeof fetch {
  return (async (input) => {
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
        block_number: 1_234,
        block_hash: "0xabc",
        timestamp: NOW_SECONDS - 10,
      },
      lag_secs: 10,
    });
  }) as typeof fetch;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

class FakeDiscoveryHeadRpc implements StarknetDiscoveryHeadRpc {
  readonly #error: Error | undefined;

  constructor(error?: Error) {
    this.#error = error;
  }

  async getChainId(): Promise<string> {
    if (this.#error) {
      throw this.#error;
    }
    return "0x534e5f5345504f4c4941";
  }

  async getBlockWithTxHashes(_blockIdentifier?: BlockIdentifier): Promise<unknown> {
    if (this.#error) {
      throw this.#error;
    }
    return {
      status: "ACCEPTED_ON_L2",
      block_hash: "0xabc",
      block_number: 1_234,
      timestamp: NOW_SECONDS - 10,
      transactions: [],
    };
  }
}

function providerFactory(urls: string[] = []): (url: string) => StarknetDiscoveryHeadRpc {
  const providers = [new FakeDiscoveryHeadRpc(), new FakeDiscoveryHeadRpc()];
  return (url) => {
    urls.push(url);
    return requiredProvider(providers.shift());
  };
}

function requiredProvider(
  provider: StarknetDiscoveryHeadRpc | undefined,
): StarknetDiscoveryHeadRpc {
  if (!provider) {
    throw new Error("Test discovery-head provider is missing");
  }
  return provider;
}

async function startRpcServer(
  requests: RpcRequest[],
): Promise<{ readonly server: Server; readonly url: string }> {
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const payload = JSON.parse(body) as RpcRequest;
      requests.push(payload);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: rpcResult(payload) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function rpcResult(request: RpcRequest): unknown {
  if (request.method === "starknet_chainId") {
    return "0x534e5f5345504f4c4941";
  }
  if (request.method === "starknet_getBlockWithTxHashes") {
    return {
      status: "ACCEPTED_ON_L2",
      block_hash: "0xabc",
      parent_hash: "0xaaa",
      block_number: 1_234,
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
  throw new Error(`Unexpected test RPC method ${request.method}`);
}

function requiredServer(
  servers: readonly { readonly server: Server; readonly url: string }[],
  index: number,
): { readonly server: Server; readonly url: string } {
  const server = servers[index];
  if (!server) {
    throw new Error("Test RPC server is missing");
  }
  return server;
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

function environmentFixture(): Record<string, string> {
  return {
    STARKNET_NETWORK: "sepolia",
    STARKNET_CHAIN_ID: "0x534e5f5345504f4c4941",
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
    STRK20_DISCOVERY_URL: "https://discovery.example/indexer",
    STRK20_DISCOVERY_OPERATOR: "indexer-one",
    STRK20_DISCOVERY_VERSION: STARKNET_DISCOVERY_SERVICE_COMPONENT_VERSION,
    STRK20_PROVING_URL: `https://prover.example/rpc?token=${SECRET}`,
    STRK20_PROVING_OPERATOR: "prover-one",
    STRK20_PROVING_VERSION: STARKNET_TRANSACTION_PROVER_COMPONENT_VERSION,
    STRK20_PROOF_INTERCEPTOR_URL: "https://interceptor.example",
    STRK20_PROOF_INTERCEPTOR_OPERATOR: "interceptor-one",
    STRK20_PROOF_INTERCEPTOR_VERSION: STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION,
    STRK20_SCREENING_PROVIDER_URL: "https://screening.example/api",
    STRK20_SCREENING_PROVIDER_OPERATOR: "screener-one",
    STRK20_SCREENING_RPC_PROVIDER_ID: "rpc-primary",
    STRK20_SCREENING_POOL_ADDRESS: "0x123",
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
    SETTLEMENT_ACCOUNT_ADDRESS: "0x789",
    SETTLEMENT_ACCOUNT_CLASS_HASH: "0xabc",
    SETTLEMENT_ACCOUNT_VERSION: "oz-account-v1",
    TESTNET_ACCOUNT_CONFIRMED: "true",
    TESTNET_FUNDS_CAPPED: "true",
  };
}

interface RpcRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params?: {
    readonly block_id?: { readonly block_number?: number };
  };
}
