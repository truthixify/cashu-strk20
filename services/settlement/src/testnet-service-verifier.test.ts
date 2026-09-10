import type { BlockIdentifier } from "starknet";
import { describe, expect, it } from "vitest";

import {
  STARKNET_PRIVACY_POOL_CLASS_HASH,
  STARKNET_PRIVACY_POOL_VERSION,
  STARKNET_PRIVACY_SDK_COMMIT,
  STARKNET_PRIVACY_SDK_VERSION,
} from "./privacy-evidence.js";
import type {
  NamedStarknetDiscoveryHeadProvider,
  StarknetDiscoveryHeadRpc,
} from "./starknet-discovery-head-verifier.js";
import { STARKNET_TRANSACTION_FINALITY_POLICIES } from "./starknet-transaction-observer.js";
import {
  TESTNET_CDK_VERSION,
  TESTNET_STARKNET_JS_VERSION,
  type TestnetDeploymentConfig,
} from "./testnet-evidence.js";
import {
  STARKNET_DISCOVERY_SERVICE_COMPONENT_VERSION,
  STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION,
  STARKNET_TRANSACTION_PROVER_API_VERSION,
  STARKNET_TRANSACTION_PROVER_COMPONENT_VERSION,
  verifyTestnetPrivacyServices,
} from "./testnet-service-verifier.js";

const NOW = new Date("2026-09-02T02:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
const PROVER_URL = "https://prover.example/rpc?token=private-prover";
const DISCOVERY_URL = "https://discovery.example/indexer";
const PROOF_INTERCEPTOR_URL = "https://interceptor.example";
const PROOF_INTERCEPTOR_HEALTH_URL = `${PROOF_INTERCEPTOR_URL}/health`;
const PRIVATE_PROVER_TOKEN = "private-prover";

describe("testnet privacy service verifier", () => {
  it("sends only fixed health requests and emits sanitized compatibility evidence", async () => {
    const requests: CapturedRequest[] = [];
    const providers = discoveryProviders();
    const evidence = await verifyServices({
      config: deploymentConfig(),
      fetchImplementation: successfulFetch(requests),
      now: () => NOW,
      providers,
    });

    expect(requests).toHaveLength(3);
    const prover = requestFor(requests, PROVER_URL);
    expect(prover.init).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect(JSON.parse(String(prover.init.body))).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "starknet_specVersion",
      params: [],
    });
    const discovery = requestFor(requests, `${DISCOVERY_URL}/health`);
    expect(discovery.init).toMatchObject({
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect(discovery.init.body).toBeUndefined();
    const proofInterceptor = requestFor(requests, PROOF_INTERCEPTOR_HEALTH_URL);
    expect(proofInterceptor.init).toMatchObject({
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect(proofInterceptor.init.headers).toEqual({
      Accept: "application/json",
      "User-Agent": "cashu-strk20-service-verifier/1",
    });
    expect(proofInterceptor.init.body).toBeUndefined();
    expect(prover.init.signal).toBeInstanceOf(AbortSignal);
    expect(discovery.init.signal).toBeInstanceOf(AbortSignal);
    expect(proofInterceptor.init.signal).toBeInstanceOf(AbortSignal);

    expect(evidence).toMatchObject({
      schemaVersion: "cashu-strk20-testnet-service-verification-v3",
      verifiedAt: NOW.toISOString(),
      network: "SN_SEPOLIA",
      profile: {
        recordedAt: "2026-09-02T01:59:00.000Z",
        pool: { address: "0x123", classHash: STARKNET_PRIVACY_POOL_CLASS_HASH },
        token: { address: "0x456", decimals: 6, symbol: "USDC" },
        provingPolicy: {
          maximumBlockAgeSeconds: 300,
          maximumFutureBlockTimeSeconds: 30,
        },
      },
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
            blockNumber: 1_234,
            blockHash: "0xabc",
            blockTimestamp: NOW_SECONDS - 10,
            reportedLagSeconds: 10,
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
        blockNumber: 1_234,
        blockHash: "0xabc",
        blockTimestamp: NOW_SECONDS - 10,
        minimumAcceptedStatus: "ACCEPTED_ON_L2",
        providerIds: ["rpc-primary", "rpc-secondary"],
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
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(PROVER_URL);
    expect(serialized).not.toContain(DISCOVERY_URL);
    expect(serialized).not.toContain(PROOF_INTERCEPTOR_URL);
    expect(serialized).not.toContain("screening.example");
    expect(serialized).not.toContain(PRIVATE_PROVER_TOKEN);
    expect(serialized).not.toContain("0x789");
    expect(providers.map(({ provider }) => provider.blockIdentifiers)).toEqual([[1_234], [1_234]]);
  });

  it.each([
    {
      name: "a moved prover component pin",
      config: () => ({
        ...deploymentConfig(),
        prover: { ...deploymentConfig().prover, version: "PRIVACY-0.14.3-RC.3" },
      }),
    },
    {
      name: "a moved discovery component pin",
      config: () => ({
        ...deploymentConfig(),
        discovery: { ...deploymentConfig().discovery, version: "PRIVACY-0.14.3-RC.3" },
      }),
    },
    {
      name: "a moved proof interceptor component pin",
      config: () => ({
        ...deploymentConfig(),
        screening: {
          ...deploymentConfig().screening,
          interceptor: {
            ...deploymentConfig().screening.interceptor,
            version: "PRIVACY-0.14.3-RC.7",
          },
        },
      }),
    },
    {
      name: "a fail-open proof interceptor declaration",
      config: () => ({
        ...deploymentConfig(),
        screening: { ...deploymentConfig().screening, interceptorFailOpen: true },
      }),
    },
    {
      name: "a secret-shaped operator label",
      config: () => ({
        ...deploymentConfig(),
        prover: { ...deploymentConfig().prover, operator: "private operator token" },
      }),
    },
    {
      name: "a non-HTTPS remote prover",
      config: () => ({
        ...deploymentConfig(),
        prover: { ...deploymentConfig().prover, url: "http://prover.example/rpc" },
      }),
    },
  ])("rejects $name before network access", async ({ config }) => {
    let calls = 0;
    await expect(
      verifyServices({
        config: config(),
        fetchImplementation: async () => {
          calls += 1;
          return jsonResponse({});
        },
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "service_configuration_invalid" });
    expect(calls).toBe(0);
  });

  it.each([
    {
      name: "substituted",
      providers: [
        { id: "rpc-attacker", provider: new FakeDiscoveryHeadRpc() },
        { id: "rpc-secondary", provider: new FakeDiscoveryHeadRpc() },
      ],
    },
    {
      name: "reordered",
      providers: discoveryProviders().toReversed(),
    },
  ])("rejects a $name RPC provider set before network access", async ({ providers }) => {
    let calls = 0;
    await expect(
      verifyTestnetPrivacyServices({
        config: deploymentConfig(),
        providers,
        fetchImplementation: async () => {
          calls += 1;
          return jsonResponse({});
        },
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "service_configuration_invalid" });
    expect(calls).toBe(0);
  });

  it("rejects a sparse RPC provider set before network access", async () => {
    const providers = new Array<NamedStarknetDiscoveryHeadProvider>(2);
    const provider = new FakeDiscoveryHeadRpc();
    providers[0] = { id: "rpc-primary", provider };
    let calls = 0;

    await expect(
      verifyTestnetPrivacyServices({
        config: deploymentConfig(),
        providers,
        fetchImplementation: async () => {
          calls += 1;
          return jsonResponse({});
        },
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "service_configuration_invalid" });
    expect(calls).toBe(0);
    expect(provider.blockIdentifiers).toEqual([]);
  });

  it.each([
    `${DISCOVERY_URL}/`,
    `${DISCOVERY_URL}?`,
    `${DISCOVERY_URL}?token=private-discovery`,
    `${DISCOVERY_URL}#fragment`,
  ])("rejects SDK-incompatible discovery URL %s before network access", async (url) => {
    let calls = 0;
    const config = deploymentConfig();
    await expect(
      verifyServices({
        config: { ...config, discovery: { ...config.discovery, url } },
        fetchImplementation: async () => {
          calls += 1;
          return jsonResponse({});
        },
        now: () => NOW,
      }),
    ).rejects.toMatchObject({
      code: "discovery_endpoint_incompatible",
      message: "Testnet discovery endpoint is incompatible with the pinned SDK",
    });
    expect(calls).toBe(0);
  });

  it.each([
    `${PROOF_INTERCEPTOR_URL}/`,
    `${PROOF_INTERCEPTOR_URL}?`,
    `${PROOF_INTERCEPTOR_URL}?token=private-interceptor`,
    `${PROOF_INTERCEPTOR_URL}#fragment`,
  ])("rejects incompatible proof interceptor URL %s before network access", async (url) => {
    let calls = 0;
    const config = deploymentConfig();
    await expect(
      verifyServices({
        config: {
          ...config,
          screening: {
            ...config.screening,
            interceptor: { ...config.screening.interceptor, url },
          },
        },
        fetchImplementation: async () => {
          calls += 1;
          return jsonResponse({});
        },
        now: () => NOW,
      }),
    ).rejects.toMatchObject({
      code: "proof_interceptor_endpoint_incompatible",
      message: "Testnet proof interceptor endpoint is incompatible with the pinned release",
    });
    expect(calls).toBe(0);
  });

  it("rejects a different prover API version", async () => {
    await expect(
      verifyServices({
        config: deploymentConfig(),
        fetchImplementation: serviceFetch({ proverVersion: "0.10.3-rc.3" }),
        now: () => NOW,
      }),
    ).rejects.toMatchObject({
      code: "prover_version_mismatch",
      message: "Testnet prover API version does not match the reviewed release",
    });
  });

  it.each([
    {
      name: "missing JSON-RPC result",
      options: { proverBody: { jsonrpc: "2.0", id: 1 } },
      code: "prover_response_invalid",
    },
    {
      name: "JSON-RPC error",
      options: {
        proverBody: {
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32_603, message: PRIVATE_PROVER_TOKEN },
        },
      },
      code: "prover_response_invalid",
    },
    {
      name: "unhealthy discovery status",
      options: { discoveryStatus: "UNHEALTHY" },
      code: "discovery_response_invalid",
    },
    {
      name: "noncanonical discovery hash",
      options: { discoveryBlockHash: "0x0abc" },
      code: "discovery_response_invalid",
    },
    {
      name: "unsafe discovery block",
      options: { discoveryBlockNumber: Number.MAX_SAFE_INTEGER + 1 },
      code: "discovery_response_invalid",
    },
    {
      name: "unhealthy proof interceptor",
      options: { proofInterceptorBody: { status: "unhealthy" } },
      code: "proof_interceptor_response_invalid",
    },
    {
      name: "ambiguous proof interceptor health",
      options: { proofInterceptorBody: { status: "ok", screening: "active" } },
      code: "proof_interceptor_response_invalid",
    },
  ])("rejects $name without echoing a response", async ({ options, code }) => {
    try {
      await verifyServices({
        config: deploymentConfig(),
        fetchImplementation: serviceFetch(options),
        now: () => NOW,
      });
      expect.unreachable("Invalid service response was accepted");
    } catch (error) {
      expect(error).toMatchObject({ code });
      expect((error as Error).message).not.toContain(PRIVATE_PROVER_TOKEN);
    }
  });

  it.each([
    {
      name: "stale timestamp",
      timestamp: NOW_SECONDS - 301,
      lag: 301,
    },
    {
      name: "future timestamp",
      timestamp: NOW_SECONDS + 31,
      lag: 0,
    },
    {
      name: "excessive reported lag",
      timestamp: NOW_SECONDS - 10,
      lag: 301,
    },
  ])("rejects a $name", async ({ timestamp, lag }) => {
    await expect(
      verifyServices({
        config: deploymentConfig(),
        fetchImplementation: serviceFetch({
          discoveryTimestamp: timestamp,
          discoveryLag: lag,
        }),
        now: () => NOW,
      }),
    ).rejects.toMatchObject({
      code: "discovery_stale",
      message: "Testnet discovery service head is outside the configured freshness policy",
    });
  });

  it.each([
    {
      name: "a prover fetch failure",
      fetchImplementation: (async (input) => {
        if (String(input) === PROVER_URL) {
          throw new Error(PRIVATE_PROVER_TOKEN);
        }
        return serviceResponse(String(input));
      }) as typeof fetch,
      code: "prover_unavailable",
    },
    {
      name: "a discovery redirect",
      fetchImplementation: (async (input) =>
        String(input) === PROVER_URL
          ? proverResponse()
          : String(input) === `${DISCOVERY_URL}/health`
            ? new Response(null, {
                status: 302,
                headers: { location: `https://attacker.example/${PRIVATE_PROVER_TOKEN}` },
              })
            : proofInterceptorResponse()) as typeof fetch,
      code: "discovery_unavailable",
    },
    {
      name: "an oversized discovery response",
      fetchImplementation: (async (input) =>
        String(input) === PROVER_URL
          ? proverResponse()
          : String(input) === `${DISCOVERY_URL}/health`
            ? new Response("{}", {
                status: 200,
                headers: {
                  "content-type": "application/json",
                  "content-length": String(64 * 1024 + 1),
                },
              })
            : proofInterceptorResponse()) as typeof fetch,
      code: "discovery_response_invalid",
    },
    {
      name: "a non-JSON prover response",
      fetchImplementation: (async (input) =>
        String(input) === PROVER_URL
          ? new Response(`not-json-${PRIVATE_PROVER_TOKEN}`, {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : serviceResponse(String(input))) as typeof fetch,
      code: "prover_response_invalid",
    },
    {
      name: "a proof interceptor fetch failure",
      fetchImplementation: (async (input) => {
        if (String(input) === PROOF_INTERCEPTOR_HEALTH_URL) {
          throw new Error(PRIVATE_PROVER_TOKEN);
        }
        return serviceResponse(String(input));
      }) as typeof fetch,
      code: "proof_interceptor_unavailable",
    },
    {
      name: "an oversized proof interceptor response",
      fetchImplementation: (async (input) =>
        String(input) === PROOF_INTERCEPTOR_HEALTH_URL
          ? new Response("{}", {
              status: 200,
              headers: {
                "content-type": "application/json",
                "content-length": String(64 * 1024 + 1),
              },
            })
          : serviceResponse(String(input))) as typeof fetch,
      code: "proof_interceptor_response_invalid",
    },
    {
      name: "a JSONP prover media type",
      fetchImplementation: (async (input) =>
        String(input) === PROVER_URL
          ? new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                result: STARKNET_TRANSACTION_PROVER_API_VERSION,
              }),
              {
                status: 200,
                headers: { "content-type": "application/jsonp" },
              },
            )
          : serviceResponse(String(input))) as typeof fetch,
      code: "prover_response_invalid",
    },
  ])("redacts $name", async ({ fetchImplementation, code }) => {
    try {
      await verifyServices({
        config: deploymentConfig(),
        fetchImplementation,
        now: () => NOW,
      });
      expect.unreachable("Invalid service transport was accepted");
    } catch (error) {
      expect(error).toMatchObject({ code });
      expect((error as Error).message).not.toContain(PRIVATE_PROVER_TOKEN);
    }
  });

  it("maps hostile response accessors to a value-free response error", async () => {
    const hostileResponse = {
      get ok() {
        throw new Error(PRIVATE_PROVER_TOKEN);
      },
    } as unknown as Response;

    try {
      await verifyServices({
        config: deploymentConfig(),
        fetchImplementation: (async (input) =>
          String(input) === PROVER_URL
            ? hostileResponse
            : serviceResponse(String(input))) as typeof fetch,
        now: () => NOW,
      });
      expect.unreachable("Hostile response accessor was accepted");
    } catch (error) {
      expect(error).toMatchObject({ code: "prover_response_invalid" });
      expect((error as Error).message).not.toContain(PRIVATE_PROVER_TOKEN);
    }
  });

  it("waits for every probe and applies deterministic error priority", async () => {
    const requests: string[] = [];
    const fetchImplementation = (async (input) => {
      const url = String(input);
      requests.push(url);
      if (url === PROVER_URL) {
        await Promise.resolve();
      }
      throw new Error(PRIVATE_PROVER_TOKEN);
    }) as typeof fetch;

    await expect(
      verifyServices({
        config: deploymentConfig(),
        fetchImplementation,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "prover_unavailable" });
    expect(requests).toEqual([PROVER_URL, `${DISCOVERY_URL}/health`, PROOF_INTERCEPTOR_HEALTH_URL]);
  });

  it("maps a failing clock to a value-free configuration error", async () => {
    try {
      await verifyServices({
        config: deploymentConfig(),
        fetchImplementation: serviceFetch(),
        now: () => {
          throw new Error(PRIVATE_PROVER_TOKEN);
        },
      });
      expect.unreachable("Failing verification clock was accepted");
    } catch (error) {
      expect(error).toMatchObject({ code: "service_configuration_invalid" });
      expect((error as Error).message).not.toContain(PRIVATE_PROVER_TOKEN);
    }
  });

  it("rejects verification that predates its sanitized profile", async () => {
    await expect(
      verifyServices({
        config: { ...deploymentConfig(), recordedAt: "2026-09-02T02:00:01.000Z" },
        fetchImplementation: serviceFetch(),
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "service_configuration_invalid" });
  });

  it("rejects a discovery head that becomes stale while RPC verification runs", async () => {
    let clockReads = 0;
    await expect(
      verifyServices({
        config: deploymentConfig(),
        fetchImplementation: serviceFetch(),
        now: () => {
          clockReads += 1;
          return clockReads === 1 ? NOW : new Date(NOW.getTime() + 291_000);
        },
      }),
    ).rejects.toMatchObject({ code: "discovery_stale" });
    expect(clockReads).toBe(2);
  });

  it("rejects clock rollback after RPC verification", async () => {
    let clockReads = 0;
    await expect(
      verifyServices({
        config: deploymentConfig(),
        fetchImplementation: serviceFetch(),
        now: () => {
          clockReads += 1;
          return clockReads === 1 ? NOW : new Date(NOW.getTime() - 1_000);
        },
      }),
    ).rejects.toMatchObject({ code: "service_configuration_invalid" });
  });
});

interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit;
}

interface CapturedDiscoveryProvider extends NamedStarknetDiscoveryHeadProvider {
  readonly provider: FakeDiscoveryHeadRpc;
}

type ServiceVerificationInput = Parameters<typeof verifyTestnetPrivacyServices>[0];
type TestServiceVerificationInput = Omit<ServiceVerificationInput, "providers"> & {
  readonly providers?: ServiceVerificationInput["providers"];
};

interface ServiceFetchOptions {
  readonly proverVersion?: string;
  readonly proverBody?: unknown;
  readonly discoveryStatus?: string;
  readonly discoveryBlockHash?: string;
  readonly discoveryBlockNumber?: number;
  readonly discoveryTimestamp?: number;
  readonly discoveryLag?: number;
  readonly proofInterceptorBody?: unknown;
}

class FakeDiscoveryHeadRpc implements StarknetDiscoveryHeadRpc {
  readonly blockIdentifiers: BlockIdentifier[] = [];

  async getChainId(): Promise<string> {
    return "0x534e5f5345504f4c4941";
  }

  async getBlockWithTxHashes(blockIdentifier: BlockIdentifier = "latest"): Promise<unknown> {
    this.blockIdentifiers.push(blockIdentifier);
    return {
      status: "ACCEPTED_ON_L2",
      block_hash: "0xabc",
      block_number: 1_234,
      timestamp: NOW_SECONDS - 10,
      transactions: [],
    };
  }
}

function verifyServices(
  input: TestServiceVerificationInput,
): ReturnType<typeof verifyTestnetPrivacyServices> {
  const { providers = discoveryProviders(), ...request } = input;
  return verifyTestnetPrivacyServices({ ...request, providers });
}

function discoveryProviders(): readonly CapturedDiscoveryProvider[] {
  return [
    { id: "rpc-primary", provider: new FakeDiscoveryHeadRpc() },
    { id: "rpc-secondary", provider: new FakeDiscoveryHeadRpc() },
  ];
}

function successfulFetch(requests: CapturedRequest[]): typeof fetch {
  return (async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });
    return serviceResponse(url);
  }) as typeof fetch;
}

function serviceFetch(options: ServiceFetchOptions = {}): typeof fetch {
  return (async (input) => serviceResponse(String(input), options)) as typeof fetch;
}

function serviceResponse(url: string, options: ServiceFetchOptions = {}): Response {
  if (url === PROVER_URL) {
    return proverResponse(options.proverVersion, options.proverBody);
  }
  if (url === PROOF_INTERCEPTOR_HEALTH_URL) {
    return proofInterceptorResponse(options.proofInterceptorBody);
  }
  return discoveryResponse(options);
}

function proverResponse(
  version = STARKNET_TRANSACTION_PROVER_API_VERSION,
  body?: unknown,
): Response {
  return jsonResponse(body ?? { jsonrpc: "2.0", id: 1, result: version });
}

function discoveryResponse(options: ServiceFetchOptions = {}): Response {
  return jsonResponse({
    status: options.discoveryStatus ?? "OK",
    chain_head: {
      block_number: options.discoveryBlockNumber ?? 1_234,
      block_hash: options.discoveryBlockHash ?? "0xabc",
      timestamp: options.discoveryTimestamp ?? NOW_SECONDS - 10,
    },
    lag_secs: options.discoveryLag ?? 10,
  });
}

function proofInterceptorResponse(body: unknown = { status: "ok" }): Response {
  return jsonResponse(body);
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function requestFor(requests: readonly CapturedRequest[], url: string): CapturedRequest {
  const request = requests.find((candidate) => candidate.url === url);
  if (!request) {
    throw new Error("missing captured request");
  }
  return request;
}

function deploymentConfig(): TestnetDeploymentConfig {
  return {
    network: "SN_SEPOLIA",
    chainId: "0x534e5f5345504f4c4941",
    recordedAt: "2026-09-02T01:59:00.000Z",
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
    account: { address: "0x789", classHash: "0xabc", version: "oz-account-v1" },
    rpcProviders: [
      { id: "rpc-primary", operator: "provider-one", url: "https://rpc-one.example" },
      { id: "rpc-secondary", operator: "provider-two", url: "https://rpc-two.example" },
    ],
    prover: {
      operator: "prover-one",
      url: PROVER_URL,
      version: STARKNET_TRANSACTION_PROVER_COMPONENT_VERSION,
    },
    discovery: {
      operator: "indexer-one",
      url: DISCOVERY_URL,
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
        url: "https://screening.example/api",
      },
      rpcProviderId: "rpc-primary",
      poolAddress: "0x123",
      policy: "fail_closed_v1",
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
    safety: { testOnlyAccount: true, cappedFunds: true },
  };
}
