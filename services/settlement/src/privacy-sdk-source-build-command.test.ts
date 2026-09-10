import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { STARKNET_PRIVACY_SDK_COMMIT, STARKNET_PRIVACY_SDK_VERSION } from "./privacy-evidence.js";
import {
  STARKNET_PRIVACY_SDK_PACKAGE_NAME,
  STARKNET_PRIVACY_SDK_REGISTRY_ORIGIN,
} from "./privacy-sdk-artifact.js";
import {
  type LoadedPrivacySdkArtifact,
  PrivacySdkArtifactCommandError,
} from "./privacy-sdk-artifact-command.js";
import {
  STARKNET_PRIVACY_SDK_SOURCE_BUILD_IMAGE,
  STARKNET_PRIVACY_SDK_SOURCE_BUILD_PLATFORM,
} from "./privacy-sdk-source-build.js";
import {
  rebuildPrivacySdkSourceArtifact,
  runPrivacySdkSourceBuildVerificationCommand,
} from "./privacy-sdk-source-build-command.js";

const TOKEN = "github-package-token-fixture";
const TARBALL = new TextEncoder().encode("authenticated source build fixture");

describe("Privacy SDK source build verification command", () => {
  it("fetches the authenticated artifact before rebuilding and emits sanitized match evidence", async () => {
    const operations: string[] = [];
    const output: string[] = [];
    const errors: string[] = [];

    const exitCode = await runPrivacySdkSourceBuildVerificationCommand({
      environment: { NODE_AUTH_TOKEN: TOKEN },
      loadArtifact: async (token) => {
        expect(token).toBe(TOKEN);
        operations.push("load");
        return loadedArtifact();
      },
      rebuildSourceArtifact: async () => {
        operations.push("build");
        return Uint8Array.from(TARBALL);
      },
      now: () => new Date("2026-09-02T00:00:00.000Z"),
      writeOutput: (value) => output.push(value),
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(0);
    expect(operations).toEqual(["load", "build"]);
    expect(errors).toEqual([]);
    expect(JSON.parse(output.join(""))).toMatchObject({
      artifact: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      comparison: { exactArchiveBytesMatch: true, publisherBuildRecipeKnown: false },
      supplyChain: {
        sourceBuildMatchVerified: true,
        productionInstallApproved: false,
        blockers: ["starknet_devnet_production_dependency"],
      },
    });
    expect(output.join("")).not.toContain(TOKEN);
    expect(output.join("")).not.toContain("download/");
  });

  it("fails before registry or Docker access without a scoped package token", async () => {
    const errors: string[] = [];
    let loadCalls = 0;
    let buildCalls = 0;

    const exitCode = await runPrivacySdkSourceBuildVerificationCommand({
      environment: {},
      loadArtifact: async () => {
        loadCalls += 1;
        return loadedArtifact();
      },
      rebuildSourceArtifact: async () => {
        buildCalls += 1;
        return TARBALL;
      },
      writeOutput: () => undefined,
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(loadCalls).toBe(0);
    expect(buildCalls).toBe(0);
    expect(errors.join("")).toBe(
      "NODE_AUTH_TOKEN must contain a scoped GitHub Packages read token\n",
    );
  });

  it("rejects an invalid clock before reading the token, registry, or Docker", async () => {
    let environmentReads = 0;
    let loadCalls = 0;
    let buildCalls = 0;
    const errors: string[] = [];
    const exitCode = await runPrivacySdkSourceBuildVerificationCommand({
      environment: new Proxy(
        {},
        {
          get() {
            environmentReads += 1;
            return TOKEN;
          },
        },
      ),
      loadArtifact: async () => {
        loadCalls += 1;
        return loadedArtifact();
      },
      rebuildSourceArtifact: async () => {
        buildCalls += 1;
        return TARBALL;
      },
      now: () => new Date(Number.NaN),
      writeOutput: () => undefined,
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(environmentReads).toBe(0);
    expect(loadCalls).toBe(0);
    expect(buildCalls).toBe(0);
    expect(errors.join("")).toBe("Privacy SDK source build verification failed unexpectedly\n");
  });

  it("does not rebuild when authenticated package access fails", async () => {
    const errors: string[] = [];
    let buildCalls = 0;

    const exitCode = await runPrivacySdkSourceBuildVerificationCommand({
      environment: { NODE_AUTH_TOKEN: TOKEN },
      loadArtifact: async () => {
        throw new PrivacySdkArtifactCommandError(
          "package_access_denied",
          "Privacy SDK package access requires a scoped read token",
        );
      },
      rebuildSourceArtifact: async () => {
        buildCalls += 1;
        return TARBALL;
      },
      writeOutput: () => undefined,
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(buildCalls).toBe(0);
    expect(errors.join("")).toBe("Privacy SDK package access requires a scoped read token\n");
  });

  it("fails closed when the controlled build differs from the registry artifact", async () => {
    const errors: string[] = [];

    const exitCode = await runPrivacySdkSourceBuildVerificationCommand({
      environment: { NODE_AUTH_TOKEN: TOKEN },
      loadArtifact: async () => loadedArtifact(),
      rebuildSourceArtifact: async () =>
        new TextEncoder().encode("authenticated source build fixturf"),
      writeOutput: () => undefined,
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(errors.join("")).toBe(
      "Privacy SDK source build does not match the authenticated package\n",
    );
  });

  it("runs Docker with a fixed recipe and without forwarding credentials or host mounts", async () => {
    const calls: Array<{
      readonly arguments_: readonly string[];
      readonly env: Readonly<Record<string, string>>;
      readonly executable: string;
    }> = [];

    const rebuilt = await rebuildPrivacySdkSourceArtifact({
      environment: {
        DOCKER_CONFIG: "/Users/operator/.docker",
        HOME: "/Users/operator",
        NODE_AUTH_TOKEN: TOKEN,
        RPC_URL: "https://private-rpc.example",
      },
      dependencies: {
        expectedArchiveSha256: createHash("sha256").update(TARBALL).digest("hex"),
        executeDocker: async (executable, arguments_, options) => {
          calls.push({ executable, arguments_, env: options.env });
          return { stdout: Buffer.from(TARBALL).toString("base64") };
        },
      },
    });

    expect(rebuilt).toEqual(TARBALL);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.executable).toBe("docker");
    expect(call?.arguments_).toContain(STARKNET_PRIVACY_SDK_SOURCE_BUILD_IMAGE);
    expect(call?.arguments_).toContain(STARKNET_PRIVACY_SDK_SOURCE_BUILD_PLATFORM);
    expect(call?.arguments_).not.toContain("--mount");
    expect(call?.arguments_.join("\n")).toContain("npm ci --ignore-scripts");
    expect(call?.arguments_.join("\n")).toContain(STARKNET_PRIVACY_SDK_COMMIT);
    expect(call?.arguments_.join("\n")).not.toContain(TOKEN);
    expect(call?.arguments_.join("\n")).not.toContain("private-rpc");
    expect(call?.env).toEqual({
      DOCKER_CONFIG: "/Users/operator/.docker",
      HOME: "/Users/operator",
      LANG: "C",
      PATH: "/usr/local/bin:/usr/bin:/bin",
    });
  });

  it("maps Docker failures, hostile environment values, and malformed output to fixed errors", async () => {
    const throwingDependencies = {
      expectedArchiveSha256: createHash("sha256").update(TARBALL).digest("hex"),
      executeDocker: async () => {
        throw new Error(`Docker exposed ${TOKEN}`);
      },
    };
    await expect(
      rebuildPrivacySdkSourceArtifact({
        environment: {},
        dependencies: throwingDependencies,
      }),
    ).rejects.toMatchObject({
      code: "source_build_failed",
      message: "Privacy SDK isolated source build failed",
    });

    const hostileEnvironment = new Proxy(
      { NODE_AUTH_TOKEN: TOKEN },
      {
        get(_target, property) {
          if (property === "HOME") {
            throw new Error(`hostile home ${TOKEN}`);
          }
          return undefined;
        },
      },
    );
    await expect(
      rebuildPrivacySdkSourceArtifact({
        environment: hostileEnvironment,
        dependencies: {
          expectedArchiveSha256: createHash("sha256").update(TARBALL).digest("hex"),
          executeDocker: async () => ({ stdout: Buffer.from(TARBALL).toString("base64") }),
        },
      }),
    ).rejects.toMatchObject({ code: "source_build_failed" });

    await expect(
      rebuildPrivacySdkSourceArtifact({
        environment: {},
        dependencies: {
          expectedArchiveSha256: createHash("sha256").update(TARBALL).digest("hex"),
          executeDocker: async () => ({ stdout: `not-base64-${TOKEN}` }),
        },
      }),
    ).rejects.toMatchObject({
      code: "source_build_output_invalid",
      message: "Privacy SDK isolated source build returned an invalid artifact",
    });

    await expect(
      rebuildPrivacySdkSourceArtifact({
        environment: {},
        dependencies: {
          expectedArchiveSha256: "0".repeat(64),
          executeDocker: async () => ({ stdout: Buffer.from(TARBALL).toString("base64") }),
        },
      }),
    ).rejects.toMatchObject({
      code: "source_build_drift",
      message: "Privacy SDK isolated source build changed from the reviewed candidate",
    });
  });
});

function loadedArtifact(): LoadedPrivacySdkArtifact {
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
