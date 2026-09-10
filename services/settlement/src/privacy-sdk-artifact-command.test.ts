import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import { STARKNET_PRIVACY_SDK_COMMIT, STARKNET_PRIVACY_SDK_VERSION } from "./privacy-evidence.js";
import {
  STARKNET_PRIVACY_SDK_ARTIFACT_SCHEMA_VERSION,
  STARKNET_PRIVACY_SDK_PACKAGE_NAME,
  STARKNET_PRIVACY_SDK_REGISTRY_ORIGIN,
} from "./privacy-sdk-artifact.js";
import {
  inspectPrivacySdkTarball,
  type LoadedPrivacySdkArtifact,
  loadPrivacySdkArtifact,
  runPrivacySdkArtifactVerificationCommand,
} from "./privacy-sdk-artifact-command.js";

const TOKEN = "github-package-token-fixture";
const TARBALL = new TextEncoder().encode("authenticated privacy sdk artifact fixture");

describe("Privacy SDK artifact verification command", () => {
  it("emits sanitized evidence after using the process-only package token", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const tokens: string[] = [];

    const exitCode = await runPrivacySdkArtifactVerificationCommand({
      environment: { NODE_AUTH_TOKEN: TOKEN },
      loadArtifact: async (token) => {
        tokens.push(token);
        return loadedArtifact();
      },
      now: () => new Date("2026-09-02T00:00:00.000Z"),
      writeOutput: (value) => output.push(value),
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(0);
    expect(tokens).toEqual([TOKEN]);
    expect(errors).toEqual([]);
    expect(JSON.parse(output.join(""))).toMatchObject({
      schemaVersion: STARKNET_PRIVACY_SDK_ARTIFACT_SCHEMA_VERSION,
      package: {
        name: STARKNET_PRIVACY_SDK_PACKAGE_NAME,
        version: STARKNET_PRIVACY_SDK_VERSION,
        sourceCommit: STARKNET_PRIVACY_SDK_COMMIT,
      },
      supplyChain: { productionInstallApproved: false },
    });
    expect(output.join("")).not.toContain(TOKEN);
    expect(output.join("")).not.toContain("download/");
  });

  it("fails before package access when no scoped token is present", async () => {
    const errors: string[] = [];
    let loadCalls = 0;

    const exitCode = await runPrivacySdkArtifactVerificationCommand({
      environment: {},
      loadArtifact: async () => {
        loadCalls += 1;
        return loadedArtifact();
      },
      writeOutput: () => undefined,
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(loadCalls).toBe(0);
    expect(errors.join("")).toBe(
      "NODE_AUTH_TOKEN must contain a scoped GitHub Packages read token\n",
    );
  });

  it("rejects an invalid clock before reading the token or accessing the package", async () => {
    let environmentReads = 0;
    let loadCalls = 0;
    const environment = new Proxy(
      {},
      {
        get() {
          environmentReads += 1;
          return TOKEN;
        },
      },
    );
    const errors: string[] = [];
    const exitCode = await runPrivacySdkArtifactVerificationCommand({
      environment,
      loadArtifact: async () => {
        loadCalls += 1;
        return loadedArtifact();
      },
      now: () => new Date(Number.NaN),
      writeOutput: () => undefined,
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(environmentReads).toBe(0);
    expect(loadCalls).toBe(0);
    expect(errors.join("")).toBe("Privacy SDK artifact verification failed unexpectedly\n");
  });

  it("maps package and output failures to value-free messages", async () => {
    const packageErrors: string[] = [];
    const packageExit = await runPrivacySdkArtifactVerificationCommand({
      environment: { NODE_AUTH_TOKEN: TOKEN },
      loadArtifact: async () => {
        throw new Error(`private package failure for ${TOKEN}`);
      },
      writeOutput: () => undefined,
      writeError: (value) => packageErrors.push(value),
    });
    expect(packageExit).toBe(1);
    expect(packageErrors.join("")).toBe("Privacy SDK artifact verification failed unexpectedly\n");
    expect(packageErrors.join("")).not.toContain(TOKEN);

    const outputErrors: string[] = [];
    const outputExit = await runPrivacySdkArtifactVerificationCommand({
      environment: { NODE_AUTH_TOKEN: TOKEN },
      loadArtifact: async () => loadedArtifact(),
      writeOutput: () => {
        throw new Error(`private output failure for ${TOKEN}`);
      },
      writeError: (value) => outputErrors.push(value),
    });
    expect(outputExit).toBe(1);
    expect(outputErrors.join("")).toBe("Privacy SDK artifact verification failed unexpectedly\n");
    expect(outputErrors.join("")).not.toContain(TOKEN);
  });

  it("does not reveal hostile environment or metadata values", async () => {
    const environment = new Proxy(
      {},
      {
        get() {
          throw new Error(`hostile environment ${TOKEN}`);
        },
      },
    );
    const environmentErrors: string[] = [];
    await runPrivacySdkArtifactVerificationCommand({
      environment,
      writeOutput: () => undefined,
      writeError: (value) => environmentErrors.push(value),
    });
    expect(environmentErrors.join("")).toBe(
      "NODE_AUTH_TOKEN must contain a scoped GitHub Packages read token\n",
    );

    const loaded: LoadedPrivacySdkArtifact = {
      ...loadedArtifact(),
      registryMetadata: new Proxy(
        {},
        {
          get() {
            throw new Error(`hostile metadata ${TOKEN}`);
          },
        },
      ),
    };
    const metadataErrors: string[] = [];
    await runPrivacySdkArtifactVerificationCommand({
      environment: { NODE_AUTH_TOKEN: TOKEN },
      loadArtifact: async () => loaded,
      writeOutput: () => undefined,
      writeError: (value) => metadataErrors.push(value),
    });
    expect(metadataErrors.join("")).toBe("Privacy SDK registry metadata is invalid\n");
    expect(metadataErrors.join("")).not.toContain(TOKEN);
  });

  it("never forwards or reintroduces package authorization after leaving the registry", async () => {
    const contentUrl =
      "https://pkg-containers.githubusercontent.com/fixture/artifact.tgz?download=private";
    const returnedRegistryUrl = `${STARKNET_PRIVACY_SDK_REGISTRY_ORIGIN}/download/returned-artifact`;
    const requests: Array<{ readonly authorization: string | null; readonly url: string }> = [];
    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = fetchInputUrl(input);
      requests.push({
        authorization: new Headers(init?.headers).get("authorization"),
        url,
      });
      switch (requests.length) {
        case 1:
          return jsonResponse(registryMetadata());
        case 2:
          return redirectResponse(contentUrl);
        case 3:
          return redirectResponse(returnedRegistryUrl);
        case 4:
          return byteResponse(TARBALL);
        default:
          throw new Error("unexpected fetch");
      }
    };

    const loaded = await loadPrivacySdkArtifact(TOKEN, {
      fetch: fetchImplementation,
      inspectTarball: async () => ({ manifest: packageManifest(), entries: artifactEntries() }),
    });

    expect(loaded.tarball).toEqual(TARBALL);
    expect(requests.map(({ authorization }) => authorization)).toEqual([
      `Bearer ${TOKEN}`,
      `Bearer ${TOKEN}`,
      null,
      null,
    ]);
    expect(requests.map(({ url }) => url)).toEqual([
      `${STARKNET_PRIVACY_SDK_REGISTRY_ORIGIN}/${encodeURIComponent(
        STARKNET_PRIVACY_SDK_PACKAGE_NAME,
      )}`,
      registryMetadata().versions[STARKNET_PRIVACY_SDK_VERSION].dist.tarball,
      contentUrl,
      returnedRegistryUrl,
    ]);
  });

  it("rejects an artifact redirect before contacting an unapproved host", async () => {
    const requests: string[] = [];
    const fetchImplementation: typeof fetch = async (input) => {
      requests.push(fetchInputUrl(input));
      return requests.length === 1
        ? jsonResponse(registryMetadata())
        : redirectResponse("https://packages.example/private-artifact.tgz");
    };

    await expect(
      loadPrivacySdkArtifact(TOKEN, {
        fetch: fetchImplementation,
        inspectTarball: async () => {
          throw new Error("archive inspection must not run");
        },
      }),
    ).rejects.toMatchObject({ code: "archive_unavailable" });
    expect(requests).toHaveLength(2);
    expect(requests).not.toContain("https://packages.example/private-artifact.tgz");
  });

  it("rejects metadata redirects that leave the exact package registry", async () => {
    const requests: string[] = [];
    const fetchImplementation: typeof fetch = async (input) => {
      requests.push(fetchInputUrl(input));
      return redirectResponse("https://pkg-containers.githubusercontent.com/metadata.json");
    };

    await expect(
      loadPrivacySdkArtifact(TOKEN, {
        fetch: fetchImplementation,
        inspectTarball: async () => {
          throw new Error("archive inspection must not run");
        },
      }),
    ).rejects.toMatchObject({ code: "registry_unavailable" });
    expect(requests).toHaveLength(1);
  });

  it("bounds same-origin redirect chains and metadata response size", async () => {
    const redirectRequests: string[] = [];
    const redirectingFetch: typeof fetch = async (input) => {
      const url = fetchInputUrl(input);
      redirectRequests.push(url);
      return redirectResponse(
        `${STARKNET_PRIVACY_SDK_REGISTRY_ORIGIN}/redirect/${redirectRequests.length}`,
      );
    };
    const inspectTarball = async () => {
      throw new Error("archive inspection must not run");
    };

    await expect(
      loadPrivacySdkArtifact(TOKEN, { fetch: redirectingFetch, inspectTarball }),
    ).rejects.toMatchObject({ code: "registry_unavailable" });
    expect(redirectRequests).toHaveLength(4);

    const oversizedFetch: typeof fetch = async () =>
      new Response("x", { headers: { "Content-Length": String(5 * 1024 * 1024 + 1) } });
    await expect(
      loadPrivacySdkArtifact(TOKEN, { fetch: oversizedFetch, inspectTarball }),
    ).rejects.toMatchObject({ code: "registry_unavailable" });
  });

  it("inspects an npm tarball without extracting its files", async () => {
    const root = await mkdtemp(join(tmpdir(), "cashu-strk20-artifact-test-"));
    const packageRoot = join(root, "package");
    const archive = join(root, "fixture.tgz");
    try {
      await mkdir(join(packageRoot, "dist", "browser"), { recursive: true });
      await mkdir(join(packageRoot, "dist", "internal"), { recursive: true });
      await mkdir(join(packageRoot, "dist", "testing"), { recursive: true });
      await writeFile(join(packageRoot, "package.json"), JSON.stringify(packageManifest()));
      for (const entry of artifactEntries().filter((value) => value !== "package/package.json")) {
        const path = join(root, entry);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, "fixture");
      }
      await execFile("/usr/bin/tar", ["-czf", archive, "-C", root, "package"], {
        env: { LANG: "C", PATH: "/usr/bin:/bin" },
      });

      const inspection = await inspectPrivacySdkTarball(await readFile(archive));

      expect(inspection.manifest).toEqual(packageManifest());
      expect(inspection.entries).toEqual(expect.arrayContaining(artifactEntries()));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects linked members in an untrusted package archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "cashu-strk20-artifact-link-test-"));
    const packageRoot = join(root, "package");
    const archive = join(root, "fixture.tgz");
    try {
      await mkdir(join(packageRoot, "dist"), { recursive: true });
      await writeFile(join(packageRoot, "package.json"), JSON.stringify(packageManifest()));
      await symlink("../package.json", join(packageRoot, "dist", "index.js"));
      await execFile("/usr/bin/tar", ["-czf", archive, "-C", root, "package"], {
        env: { LANG: "C", PATH: "/usr/bin:/bin" },
      });

      await expect(inspectPrivacySdkTarball(await readFile(archive))).rejects.toMatchObject({
        code: "archive_unavailable",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function loadedArtifact(): {
  registryMetadata: ReturnType<typeof registryMetadata>;
  tarball: Uint8Array;
  inspection: LoadedPrivacySdkArtifact["inspection"];
} {
  return {
    registryMetadata: registryMetadata(),
    tarball: TARBALL,
    inspection: { manifest: packageManifest(), entries: artifactEntries() },
  };
}

function registryMetadata() {
  return {
    versions: {
      [STARKNET_PRIVACY_SDK_VERSION]: {
        ...packageManifest(),
        gitHead: STARKNET_PRIVACY_SDK_COMMIT,
        dist: {
          integrity: `sha512-${createHash("sha512").update(TARBALL).digest("base64")}`,
          shasum: createHash("sha1").update(TARBALL).digest("hex"),
          tarball: `${STARKNET_PRIVACY_SDK_REGISTRY_ORIGIN}/download/@starkware-libs/starknet-privacy-sdk/${STARKNET_PRIVACY_SDK_VERSION}/fixture-sha`,
        },
      },
    },
  };
}

function packageManifest() {
  return {
    name: STARKNET_PRIVACY_SDK_PACKAGE_NAME,
    version: STARKNET_PRIVACY_SDK_VERSION,
    repository: {
      type: "git",
      url: "git+https://github.com/starkware-libs/starknet-privacy.git",
      directory: "sdk",
    },
    type: "module",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: {
      ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
      "./testing": {
        import: "./dist/testing/index.js",
        types: "./dist/testing/index.d.ts",
      },
      "./browser": {
        import: "./dist/browser/starknet-sdk.js",
        default: "./dist/browser/starknet-sdk.min.js",
      },
      "./browser/testing": {
        import: "./dist/browser/starknet-sdk-testing.js",
        default: "./dist/browser/starknet-sdk-testing.min.js",
      },
      "./abi": {
        import: "./dist/internal/abi.js",
        types: "./dist/internal/abi.d.ts",
      },
    },
    publishConfig: { registry: STARKNET_PRIVACY_SDK_REGISTRY_ORIGIN },
    files: ["dist"],
    scripts: { build: "tsc -p tsconfig.build.json" },
    dependencies: {
      "@starknet-io/starknet-types-0101": "npm:@starknet-io/types-js@~0.10.2",
      "ohttp-ts": "^0.3.0",
      starknet: "10.5.0",
      "starknet-devnet": "^0.7.2",
      zod: "^3.24.0",
    },
  };
}

function artifactEntries(): string[] {
  return [
    "package/package.json",
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/testing/index.js",
    "package/dist/testing/index.d.ts",
    "package/dist/browser/starknet-sdk.js",
    "package/dist/browser/starknet-sdk.min.js",
    "package/dist/browser/starknet-sdk-testing.js",
    "package/dist/browser/starknet-sdk-testing.min.js",
    "package/dist/internal/abi.js",
    "package/dist/internal/abi.d.ts",
  ];
}

function fetchInputUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
}

function byteResponse(value: Uint8Array): Response {
  return new Response(Uint8Array.from(value));
}

function redirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

const execFile = promisify(execFileCallback);
