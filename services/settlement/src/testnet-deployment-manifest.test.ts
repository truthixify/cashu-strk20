import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  STARKNET_PRIVACY_POOL_CLASS_HASH,
  STARKNET_PRIVACY_POOL_VERSION,
  STARKNET_PRIVACY_SDK_COMMIT,
} from "./privacy-evidence.js";
import { calculateStarknetUdcDeploymentAddress } from "./starknet-deployment-origin-verifier.js";
import {
  assertTestnetDeploymentManifestsDoNotExposeAddresses,
  createTestnetDeploymentManifestVerificationEvidence,
  reconstructTestnetDeploymentManifestVerificationEvidence,
  STARKNET_PRIVACY_CONTRACT_PATH,
  STARKNET_PRIVACY_SOURCE_REPOSITORY,
  serializeTestnetDeploymentManifest,
  TESTNET_DEPLOYMENT_MANIFEST_SCHEMA_VERSION,
  TESTNET_DEPLOYMENT_MANIFEST_VERIFICATION_SCHEMA_VERSION,
  TESTNET_DEPLOYMENT_MANIFEST_VERIFIER_VERSION,
  type TestnetDeploymentManifestContract,
  type TestnetDeploymentManifestDocument,
  type TestnetDeploymentManifestDocumentInput,
  type TestnetDeploymentManifestProfile,
  type TestnetPrivacyPoolManifestContract,
  type TestnetUsdcTokenManifestContract,
  verifyTestnetDeploymentManifests,
} from "./testnet-deployment-manifest.js";
import { STARKNET_SEPOLIA_CHAIN_ID } from "./testnet-evidence.js";

const VERIFIED_AT = "2026-09-02T10:00:00.000Z";
const POOL_MANIFEST_URL = "https://deployments.example/immutable/sepolia-pool.json";
const TOKEN_MANIFEST_URL = "https://deployments.example/immutable/sepolia-usdc.json";
const SHARED_MANIFEST_URL = "https://deployments.example/immutable/sepolia-contracts.json";
const CANONICAL_VECTOR_SHA256 = "1888f8ebca6f35f5a6f6303eb32202b1bf2edd86596c1c77fabe7c32f9d90ce5";

const POOL_CONTRACT: TestnetPrivacyPoolManifestContract = {
  role: "privacy_pool",
  address: "0x123",
  classHash: STARKNET_PRIVACY_POOL_CLASS_HASH,
  version: STARKNET_PRIVACY_POOL_VERSION,
  source: {
    repository: STARKNET_PRIVACY_SOURCE_REPOSITORY,
    commit: STARKNET_PRIVACY_SDK_COMMIT,
    contractPath: STARKNET_PRIVACY_CONTRACT_PATH,
  },
  deployment: {
    transactionReference: "0xaaa",
    acceptedBlockHash: "0xabc",
    acceptedBlockNumber: "99",
    deployer: "0x789",
    salt: "0x1",
    unique: false,
    constructorCalldata: ["0x789", "0x111", "0x222", "0x1c2"],
  },
  configuration: {
    governanceAdmin: "0x789",
    auditorPublicKey: "0x111",
    screenerPublicKey: "0x222",
    proofValidityBlocks: "450",
  },
};

const TOKEN_CONTRACT: TestnetUsdcTokenManifestContract = {
  role: "usdc_token",
  address: "0x456",
  classHash: "0x333",
  version: "usdc-test-v1",
  source: {
    repository: "https://github.com/example/test-usdc",
    commit: "c".repeat(40),
    contractPath: "src/TestUsdc.cairo",
  },
  deployment: {
    transactionReference: "0xbbb",
    acceptedBlockHash: "0xdef",
    acceptedBlockNumber: "100",
    deployer: "0x789",
    salt: "0x2",
    unique: true,
    constructorCalldata: [],
  },
  configuration: {
    symbol: "USDC",
    decimals: 6,
    mintAuthority: "0x789",
    supplyPolicy: "capped_test_supply_v1",
    maximumSupplyBaseUnits: "1000000000",
  },
};

describe("testnet deployment manifests", () => {
  it("keeps the published canonical vector byte-for-byte stable", () => {
    const bytes = readFileSync(
      new URL("../../../docs/specs/vectors/testnet-deployment-manifest-v1.json", import.meta.url),
    );
    const encoded = bytes.toString("utf8");
    const document = JSON.parse(encoded) as TestnetDeploymentManifestDocument;

    expect(serializeTestnetDeploymentManifest(document)).toBe(encoded);
    expect(sha256(bytes)).toBe(CANONICAL_VECTOR_SHA256);
    expect(
      document.contracts.map((contract) => calculateStarknetUdcDeploymentAddress(contract)),
    ).toEqual(document.contracts.map(({ address }) => address));
  });

  it("verifies canonical manifest bytes and reconstructs only public fields", () => {
    const pool = observation(manifest([POOL_CONTRACT]), POOL_MANIFEST_URL);
    const token = observation(manifest([TOKEN_CONTRACT]), TOKEN_MANIFEST_URL);
    const profile = profileFor(pool, token);

    const evidence = createTestnetDeploymentManifestVerificationEvidence({
      profile,
      documents: [pool, token],
      verifiedAt: VERIFIED_AT,
    });

    expect(evidence).toMatchObject({
      schemaVersion: TESTNET_DEPLOYMENT_MANIFEST_VERIFICATION_SCHEMA_VERSION,
      verifierVersion: TESTNET_DEPLOYMENT_MANIFEST_VERIFIER_VERSION,
      verifiedAt: VERIFIED_AT,
      network: "SN_SEPOLIA",
      chainId: STARKNET_SEPOLIA_CHAIN_ID,
      contracts: [
        {
          ...POOL_CONTRACT,
          manifestUrl: POOL_MANIFEST_URL,
          manifestSha256: sha256(pool.bytes),
          manifestBytes: pool.bytes.byteLength,
        },
        {
          ...TOKEN_CONTRACT,
          manifestUrl: TOKEN_MANIFEST_URL,
          manifestSha256: sha256(token.bytes),
          manifestBytes: token.bytes.byteLength,
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
    });
    expect(reconstructTestnetDeploymentManifestVerificationEvidence(evidence, profile)).toEqual(
      evidence,
    );
    expect(JSON.stringify(evidence)).not.toContain(Buffer.from(pool.bytes).toString("base64"));
  });

  it("accepts one content-addressed manifest containing both contracts", () => {
    const shared = observation(manifest([POOL_CONTRACT, TOKEN_CONTRACT]), SHARED_MANIFEST_URL);
    const profile = profileFor(shared, shared);

    const evidence = createTestnetDeploymentManifestVerificationEvidence({
      profile,
      documents: [shared],
      verifiedAt: VERIFIED_AT,
    });

    expect(evidence.contracts.map(({ manifestUrl }) => manifestUrl)).toEqual([
      SHARED_MANIFEST_URL,
      SHARED_MANIFEST_URL,
    ]);
    expect(evidence.contracts[0].manifestSha256).toBe(evidence.contracts[1].manifestSha256);
  });

  it("rejects a private settlement address reused in public deployment fields", () => {
    const pool = observation(manifest([POOL_CONTRACT]), POOL_MANIFEST_URL);
    const token = observation(manifest([TOKEN_CONTRACT]), TOKEN_MANIFEST_URL);
    const evidence = createTestnetDeploymentManifestVerificationEvidence({
      profile: profileFor(pool, token),
      documents: [pool, token],
      verifiedAt: VERIFIED_AT,
    });

    expect(() =>
      assertTestnetDeploymentManifestsDoNotExposeAddresses(evidence, ["0x999"]),
    ).not.toThrow();
    expect(() => assertTestnetDeploymentManifestsDoNotExposeAddresses(evidence, ["0x789"])).toThrow(
      expect.objectContaining({ code: "configuration_invalid" }),
    );
  });

  it("rejects bytes that do not match the profile hash", () => {
    const pool = observation(manifest([POOL_CONTRACT]), POOL_MANIFEST_URL);
    const token = observation(manifest([TOKEN_CONTRACT]), TOKEN_MANIFEST_URL);
    const profile = profileFor(pool, token);
    const changed = Uint8Array.from(pool.bytes);
    const changedIndex = changed.length - 2;
    changed[changedIndex] = (changed[changedIndex] ?? 0) ^ 1;

    expect(() =>
      createTestnetDeploymentManifestVerificationEvidence({
        profile,
        documents: [{ url: pool.url, bytes: changed }, token],
        verifiedAt: VERIFIED_AT,
      }),
    ).toThrow(expect.objectContaining({ code: "manifest_hash_mismatch" }));
  });

  it.each([
    {
      name: "address",
      contract: { ...POOL_CONTRACT, address: "0x999" },
    },
    {
      name: "class hash",
      contract: { ...POOL_CONTRACT, classHash: "0x999" },
    },
    {
      name: "version",
      contract: { ...POOL_CONTRACT, version: "PRIVACY-0.14.3-RC.5" },
    },
    {
      name: "transaction reference",
      contract: {
        ...POOL_CONTRACT,
        deployment: { ...POOL_CONTRACT.deployment, transactionReference: "0x999" },
      },
    },
    {
      name: "source commit",
      contract: {
        ...POOL_CONTRACT,
        source: { ...POOL_CONTRACT.source, commit: "d".repeat(40) },
      },
    },
  ] as const)("rejects a pool manifest with a mismatched $name", ({ contract }) => {
    expectPoolManifestError(contract, "manifest_profile_mismatch");
  });

  it("rejects the stale three-field pool constructor described by upstream deployment examples", () => {
    const contract = {
      ...POOL_CONTRACT,
      deployment: {
        ...POOL_CONTRACT.deployment,
        constructorCalldata: ["0x789", "0x111", "0x1c2"],
      },
    };

    expectPoolManifestError(contract, "manifest_content_invalid");
  });

  it.each([
    {
      name: "constructor order",
      contract: {
        ...POOL_CONTRACT,
        deployment: {
          ...POOL_CONTRACT.deployment,
          constructorCalldata: ["0x789", "0x222", "0x111", "0x1c2"],
        },
      },
    },
    {
      name: "zero proof-validity window",
      contract: {
        ...POOL_CONTRACT,
        configuration: { ...POOL_CONTRACT.configuration, proofValidityBlocks: "0" },
      },
    },
    {
      name: "overflowing proof-validity window",
      contract: {
        ...POOL_CONTRACT,
        configuration: {
          ...POOL_CONTRACT.configuration,
          proofValidityBlocks: (1n << 64n).toString(),
        },
      },
    },
    {
      name: "source path traversal",
      contract: {
        ...POOL_CONTRACT,
        source: { ...POOL_CONTRACT.source, contractPath: "../privacy.cairo" },
      },
    },
  ] as const)("rejects a pool manifest with invalid $name", ({ contract }) => {
    expectPoolManifestError(contract, "manifest_content_invalid");
  });

  it.each([
    {
      name: "wrong symbol",
      configuration: { ...TOKEN_CONTRACT.configuration, symbol: "USDT" },
    },
    {
      name: "wrong decimals",
      configuration: { ...TOKEN_CONTRACT.configuration, decimals: 18 },
    },
    {
      name: "uncapped policy",
      configuration: { ...TOKEN_CONTRACT.configuration, supplyPolicy: "unlimited" },
    },
    {
      name: "zero maximum supply",
      configuration: { ...TOKEN_CONTRACT.configuration, maximumSupplyBaseUnits: "0" },
    },
    {
      name: "overflowing maximum supply",
      configuration: {
        ...TOKEN_CONTRACT.configuration,
        maximumSupplyBaseUnits: (1n << 256n).toString(),
      },
    },
  ])("rejects token configuration with $name", ({ configuration }) => {
    const token = rawObservation(
      manifest([
        {
          ...TOKEN_CONTRACT,
          configuration,
        } as TestnetUsdcTokenManifestContract,
      ]),
      TOKEN_MANIFEST_URL,
    );
    const pool = observation(manifest([POOL_CONTRACT]), POOL_MANIFEST_URL);

    expect(() =>
      createTestnetDeploymentManifestVerificationEvidence({
        profile: profileFor(pool, token),
        documents: [pool, token],
        verifiedAt: VERIFIED_AT,
      }),
    ).toThrow(expect.objectContaining({ code: "manifest_content_invalid" }));
  });

  it.each([
    {
      name: "minified JSON",
      encode: (document: TestnetDeploymentManifestDocument) => JSON.stringify(document),
    },
    {
      name: "an extra field",
      encode: (document: TestnetDeploymentManifestDocument) =>
        `${JSON.stringify({ ...document, privateOperatorNote: "not-allowed" }, null, 2)}\n`,
    },
    {
      name: "a duplicate key",
      encode: (document: TestnetDeploymentManifestDocument) =>
        serializeTestnetDeploymentManifest(document).replace(
          '  "network": "SN_SEPOLIA",',
          '  "network": "SN_MAIN",\n  "network": "SN_SEPOLIA",',
        ),
    },
  ])("rejects $name even when its declared hash matches", ({ encode }) => {
    const encoded = encode(manifest([POOL_CONTRACT]));
    const pool = encodedObservation(encoded, POOL_MANIFEST_URL);
    const token = observation(manifest([TOKEN_CONTRACT]), TOKEN_MANIFEST_URL);

    expect(() =>
      createTestnetDeploymentManifestVerificationEvidence({
        profile: profileFor(pool, token),
        documents: [pool, token],
        verifiedAt: VERIFIED_AT,
      }),
    ).toThrow(expect.objectContaining({ code: "manifest_content_invalid" }));
  });

  it("rejects an invalid UTF-8 manifest without exposing its bytes", () => {
    const pool = { url: POOL_MANIFEST_URL, bytes: Uint8Array.from([0xff, 0xfe]) };
    const token = observation(manifest([TOKEN_CONTRACT]), TOKEN_MANIFEST_URL);

    expect(() =>
      createTestnetDeploymentManifestVerificationEvidence({
        profile: profileFor(pool, token),
        documents: [pool, token],
        verifiedAt: VERIFIED_AT,
      }),
    ).toThrow(expect.objectContaining({ code: "manifest_content_invalid" }));
  });

  it("requires exactly one observation for every distinct manifest URL", () => {
    const pool = observation(manifest([POOL_CONTRACT]), POOL_MANIFEST_URL);
    const token = observation(manifest([TOKEN_CONTRACT]), TOKEN_MANIFEST_URL);
    const profile = profileFor(pool, token);

    for (const documents of [[pool], [pool, token, token]]) {
      expect(() =>
        createTestnetDeploymentManifestVerificationEvidence({
          profile,
          documents,
          verifiedAt: VERIFIED_AT,
        }),
      ).toThrow(expect.objectContaining({ code: "manifest_content_invalid" }));
    }
  });

  it("rejects a shared URL carrying conflicting hash declarations", async () => {
    const shared = observation(manifest([POOL_CONTRACT, TOKEN_CONTRACT]), SHARED_MANIFEST_URL);
    const profile = profileFor(shared, {
      ...shared,
      bytes: new TextEncoder().encode(`${new TextDecoder().decode(shared.bytes)} `),
    });
    let fetchCalls = 0;

    await expect(
      verifyTestnetDeploymentManifests({
        profile,
        fetchImplementation: async () => {
          fetchCalls += 1;
          return manifestResponse(new TextDecoder().decode(shared.bytes));
        },
      }),
    ).rejects.toMatchObject({ code: "configuration_invalid" });
    expect(fetchCalls).toBe(0);
  });

  it("fetches each distinct manifest once with credential-free bounded requests", async () => {
    const pool = observation(manifest([POOL_CONTRACT]), POOL_MANIFEST_URL);
    const token = observation(manifest([TOKEN_CONTRACT]), TOKEN_MANIFEST_URL);
    const profile = profileFor(pool, token);
    const requests: { readonly url: string; readonly init: RequestInit | undefined }[] = [];
    const bodies = new Map([
      [POOL_MANIFEST_URL, new TextDecoder().decode(pool.bytes)],
      [TOKEN_MANIFEST_URL, new TextDecoder().decode(token.bytes)],
    ]);

    const evidence = await verifyTestnetDeploymentManifests({
      profile,
      fetchImplementation: (async (input, init) => {
        const url = String(input);
        requests.push({ url, init });
        const body = bodies.get(url);
        if (body === undefined) {
          throw new Error("Unexpected URL");
        }
        return manifestResponse(body);
      }) as typeof fetch,
      now: () => new Date(VERIFIED_AT),
    });

    expect(evidence.verifiedAt).toBe(VERIFIED_AT);
    expect(requests.map(({ url }) => url).sort()).toEqual(
      [POOL_MANIFEST_URL, TOKEN_MANIFEST_URL].sort(),
    );
    for (const { init } of requests) {
      expect(init).toMatchObject({
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
      const headers = new Headers(init?.headers);
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.get("accept-encoding")).toBe("identity");
      expect(headers.has("authorization")).toBe(false);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("fetches a shared pool and token manifest only once", async () => {
    const shared = observation(manifest([POOL_CONTRACT, TOKEN_CONTRACT]), SHARED_MANIFEST_URL);
    let fetchCalls = 0;

    await verifyTestnetDeploymentManifests({
      profile: profileFor(shared, shared),
      fetchImplementation: (async () => {
        fetchCalls += 1;
        return manifestResponse(new TextDecoder().decode(shared.bytes));
      }) as typeof fetch,
      now: () => new Date(VERIFIED_AT),
    });

    expect(fetchCalls).toBe(1);
  });

  it.each([
    {
      name: "HTTP failure",
      response: () => new Response(null, { status: 503 }),
      code: "manifest_unavailable",
    },
    {
      name: "wrong content type",
      response: () => new Response("{}", { headers: { "content-type": "text/plain" } }),
      code: "manifest_response_invalid",
    },
    {
      name: "compressed content",
      response: () =>
        new Response("{}", {
          headers: { "content-encoding": "gzip", "content-type": "application/json" },
        }),
      code: "manifest_response_invalid",
    },
    {
      name: "oversized declared body",
      response: () =>
        new Response("{}", {
          headers: { "content-length": "65537", "content-type": "application/json" },
        }),
      code: "manifest_response_invalid",
    },
  ])("fails closed for $name", async ({ response, code }) => {
    const shared = observation(manifest([POOL_CONTRACT, TOKEN_CONTRACT]), SHARED_MANIFEST_URL);

    await expect(
      verifyTestnetDeploymentManifests({
        profile: profileFor(shared, shared),
        fetchImplementation: (async () => response()) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code });
  });

  it("redacts fetch exceptions and invalid clocks", async () => {
    const secret = "private-fetch-failure";
    const shared = observation(manifest([POOL_CONTRACT, TOKEN_CONTRACT]), SHARED_MANIFEST_URL);
    const profile = profileFor(shared, shared);

    try {
      await verifyTestnetDeploymentManifests({
        profile,
        fetchImplementation: (async () => {
          throw new Error(secret);
        }) as typeof fetch,
      });
      expect.unreachable("Fetch failure was accepted");
    } catch (error) {
      expect(error).toEqual(expect.objectContaining({ code: "manifest_unavailable" }));
      expect((error as Error).message).not.toContain(secret);
    }

    await expect(
      verifyTestnetDeploymentManifests({
        profile,
        fetchImplementation: (async () =>
          manifestResponse(new TextDecoder().decode(shared.bytes))) as typeof fetch,
        now: () => new Date(Number.NaN),
      }),
    ).rejects.toMatchObject({ code: "configuration_invalid" });
  });

  it("rejects altered verification claims and profile bindings during reconstruction", () => {
    const pool = observation(manifest([POOL_CONTRACT]), POOL_MANIFEST_URL);
    const token = observation(manifest([TOKEN_CONTRACT]), TOKEN_MANIFEST_URL);
    const profile = profileFor(pool, token);
    const evidence = createTestnetDeploymentManifestVerificationEvidence({
      profile,
      documents: [pool, token],
      verifiedAt: VERIFIED_AT,
    });

    const variants = [
      { ...evidence, network: "SN_MAIN" },
      { ...evidence, chainId: "0x1" },
      {
        ...evidence,
        verification: { ...evidence.verification, transactionReceiptsVerified: true },
      },
      { ...evidence, blockers: evidence.blockers.slice(0, -1) },
      {
        ...evidence,
        contracts: [
          { ...evidence.contracts[0], manifestSha256: "f".repeat(64) },
          evidence.contracts[1],
        ],
      },
    ];

    for (const variant of variants) {
      expect(() =>
        reconstructTestnetDeploymentManifestVerificationEvidence(variant, profile),
      ).toThrow(expect.objectContaining({ code: expect.stringMatching(/invalid|mismatch/u) }));
    }
  });
});

function manifest(
  contracts: readonly TestnetDeploymentManifestContract[],
): TestnetDeploymentManifestDocument {
  return {
    schemaVersion: TESTNET_DEPLOYMENT_MANIFEST_SCHEMA_VERSION,
    network: "SN_SEPOLIA",
    chainId: STARKNET_SEPOLIA_CHAIN_ID,
    contracts,
  };
}

function observation(
  document: TestnetDeploymentManifestDocument,
  url: string,
): TestnetDeploymentManifestDocumentInput {
  return encodedObservation(serializeTestnetDeploymentManifest(document), url);
}

function encodedObservation(encoded: string, url: string): TestnetDeploymentManifestDocumentInput {
  return { url, bytes: new TextEncoder().encode(encoded) };
}

function rawObservation(
  document: TestnetDeploymentManifestDocument,
  url: string,
): TestnetDeploymentManifestDocumentInput {
  return encodedObservation(`${JSON.stringify(document, null, 2)}\n`, url);
}

function profileFor(
  pool: TestnetDeploymentManifestDocumentInput,
  token: TestnetDeploymentManifestDocumentInput,
): TestnetDeploymentManifestProfile {
  return {
    network: "SN_SEPOLIA",
    chainId: STARKNET_SEPOLIA_CHAIN_ID,
    pool: {
      address: POOL_CONTRACT.address,
      classHash: POOL_CONTRACT.classHash,
      version: POOL_CONTRACT.version,
      deployment: {
        transactionReference: POOL_CONTRACT.deployment.transactionReference,
        manifestUrl: pool.url,
        manifestSha256: sha256(pool.bytes),
      },
    },
    token: {
      address: TOKEN_CONTRACT.address,
      classHash: TOKEN_CONTRACT.classHash,
      version: TOKEN_CONTRACT.version,
      symbol: "USDC",
      decimals: 6,
      deployment: {
        transactionReference: TOKEN_CONTRACT.deployment.transactionReference,
        manifestUrl: token.url,
        manifestSha256: sha256(token.bytes),
      },
    },
  };
}

function expectPoolManifestError(contract: TestnetDeploymentManifestContract, code: string): void {
  const pool = rawObservation(manifest([contract]), POOL_MANIFEST_URL);
  const token = observation(manifest([TOKEN_CONTRACT]), TOKEN_MANIFEST_URL);
  expect(() =>
    createTestnetDeploymentManifestVerificationEvidence({
      profile: profileFor(pool, token),
      documents: [pool, token],
      verifiedAt: VERIFIED_AT,
    }),
  ).toThrow(expect.objectContaining({ code }));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256")
    .update(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    .digest("hex");
}

function manifestResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
