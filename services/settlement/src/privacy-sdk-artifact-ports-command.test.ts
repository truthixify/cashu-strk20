import { createHash } from "node:crypto";
import { access } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { STARKNET_PRIVACY_SDK_COMMIT, STARKNET_PRIVACY_SDK_VERSION } from "./privacy-evidence.js";
import {
  STARKNET_PRIVACY_SDK_PACKAGE_NAME,
  STARKNET_PRIVACY_SDK_REGISTRY_ORIGIN,
} from "./privacy-sdk-artifact.js";
import type { LoadedPrivacySdkArtifact } from "./privacy-sdk-artifact-command.js";
import {
  STARKNET_PRIVACY_SDK_ARTIFACT_PORT_COMPATIBILITY_RECIPE,
  STARKNET_PRIVACY_SDK_ARTIFACT_PORT_COMPATIBILITY_SCHEMA_VERSION,
} from "./privacy-sdk-artifact-ports.js";
import {
  type PrivacySdkArtifactPortTypecheckDependencies,
  runPrivacySdkArtifactPortCompatibilityCommand,
  typecheckPrivacySdkArtifactPorts,
} from "./privacy-sdk-artifact-ports-command.js";
import {
  STARKNET_PRIVACY_SDK_SOURCE_BUILD_IMAGE,
  STARKNET_PRIVACY_SDK_SOURCE_BUILD_PLATFORM,
} from "./privacy-sdk-source-build.js";

const TOKEN = "github-package-token-fixture";
const PRIVATE_RPC = "https://private-rpc.example";
const TARBALL = new TextEncoder().encode("authenticated privacy sdk declarations fixture");
const PORT_DECLARATION = "export interface Port { readonly value: unknown; }\n";
const COMPATIBILITY_FIXTURE = "import type { Port } from './starknet-privacy-sdk-ports.js';\n";
const PORT_DECLARATION_SHA256 = sha256(PORT_DECLARATION);
const COMPATIBILITY_FIXTURE_SHA256 = sha256(COMPATIBILITY_FIXTURE);
const SUCCESS_MARKER = "cashu-strk20-privacy-sdk-artifact-ports-ok\n";

describe("Privacy SDK authenticated-artifact port compatibility command", () => {
  it("authenticates before type-checking and emits conservative sanitized evidence", async () => {
    const operations: string[] = [];
    const output: string[] = [];
    const errors: string[] = [];
    const exitCode = await runPrivacySdkArtifactPortCompatibilityCommand({
      environment: {
        DOCKER_CONFIG: "/Users/operator/.docker",
        HOME: "/Users/operator",
        NODE_AUTH_TOKEN: TOKEN,
        RPC_URL: PRIVATE_RPC,
      },
      loadArtifact: async (token) => {
        expect(token).toBe(TOKEN);
        operations.push("authenticate");
        return loadedArtifact();
      },
      typecheckArtifactPorts: async ({ environment, tarball }) => {
        operations.push("typecheck");
        expect(environment).toEqual({
          DOCKER_CONFIG: "/Users/operator/.docker",
          HOME: "/Users/operator",
        });
        expect(tarball).toEqual(TARBALL);
        return {
          portDeclarationSha256: PORT_DECLARATION_SHA256,
          compatibilityFixtureSha256: COMPATIBILITY_FIXTURE_SHA256,
        };
      },
      now: () => new Date("2026-09-10T00:00:00.000Z"),
      writeOutput: (value) => output.push(value),
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(0);
    expect(operations).toEqual(["authenticate", "typecheck"]);
    expect(errors).toEqual([]);
    expect(JSON.parse(output.join(""))).toEqual({
      schemaVersion: STARKNET_PRIVACY_SDK_ARTIFACT_PORT_COMPATIBILITY_SCHEMA_VERSION,
      verifiedAt: "2026-09-10T00:00:00.000Z",
      package: {
        name: STARKNET_PRIVACY_SDK_PACKAGE_NAME,
        version: STARKNET_PRIVACY_SDK_VERSION,
        sourceTag: "PRIVACY-0.14.3-RC.6",
        sourceCommit: STARKNET_PRIVACY_SDK_COMMIT,
        registry: STARKNET_PRIVACY_SDK_REGISTRY_ORIGIN,
      },
      artifact: {
        integrity: sha512Integrity(TARBALL),
        shasum: digest("sha1", TARBALL),
        sha256: digest("sha256", TARBALL),
        bytes: TARBALL.byteLength,
        manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        fileSetSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
      declarationCheck: {
        compilerSourceRepository: "https://github.com/starkware-libs/starknet-privacy.git",
        compilerSourceCommit: STARKNET_PRIVACY_SDK_COMMIT,
        containerImage: STARKNET_PRIVACY_SDK_SOURCE_BUILD_IMAGE,
        platform: STARKNET_PRIVACY_SDK_SOURCE_BUILD_PLATFORM,
        nodeVersion: "24.0.2",
        npmVersion: "11.3.0",
        recipe: STARKNET_PRIVACY_SDK_ARTIFACT_PORT_COMPATIBILITY_RECIPE,
        portDeclarationSha256: PORT_DECLARATION_SHA256,
        compatibilityFixtureSha256: COMPATIBILITY_FIXTURE_SHA256,
        installLifecycleScriptsRun: false,
        packageCredentialForwarded: false,
        hostWorkspaceMounted: false,
        compatibilityInputsMountedReadOnly: true,
        authenticatedArtifactMountedReadOnly: true,
        buildNetworkIsolated: false,
      },
      compatibility: {
        registryIntegrityVerified: true,
        declaredSourceCommitMatches: true,
        authenticatedPackageDeclarationsVerified: true,
        channelSnapshotAssignable: true,
        discoveryProviderAssignable: true,
        viewingKeyProviderAssignable: true,
        privateTransfersAssignable: true,
        sdkRuntimeExecuted: false,
        sourceBuildMatchVerified: false,
        productionInstallApproved: false,
      },
      runtimeDependencies: expectedDependencies(),
      blockers: ["source_build_match_unverified", "starknet_devnet_production_dependency"],
    });
    expect(output.join("")).not.toContain(TOKEN);
    expect(output.join("")).not.toContain(PRIVATE_RPC);
    expect(output.join("")).not.toContain("download/");
  });

  it("rejects an invalid clock or missing token before package or Docker access", async () => {
    let loadCalls = 0;
    let typecheckCalls = 0;
    const invalidClockErrors: string[] = [];
    const invalidClockExit = await runPrivacySdkArtifactPortCompatibilityCommand({
      environment: { NODE_AUTH_TOKEN: TOKEN },
      loadArtifact: async () => {
        loadCalls += 1;
        return loadedArtifact();
      },
      typecheckArtifactPorts: async () => {
        typecheckCalls += 1;
        return compatibilityResult();
      },
      now: () => new Date(Number.NaN),
      writeOutput: () => undefined,
      writeError: (value) => invalidClockErrors.push(value),
    });
    expect(invalidClockExit).toBe(1);
    expect(loadCalls).toBe(0);
    expect(typecheckCalls).toBe(0);
    expect(invalidClockErrors.join("")).toBe(
      "Privacy SDK authenticated-artifact port compatibility inputs are invalid\n",
    );

    const missingTokenErrors: string[] = [];
    const missingTokenExit = await runPrivacySdkArtifactPortCompatibilityCommand({
      environment: {},
      loadArtifact: async () => {
        loadCalls += 1;
        return loadedArtifact();
      },
      typecheckArtifactPorts: async () => {
        typecheckCalls += 1;
        return compatibilityResult();
      },
      writeOutput: () => undefined,
      writeError: (value) => missingTokenErrors.push(value),
    });
    expect(missingTokenExit).toBe(1);
    expect(loadCalls).toBe(0);
    expect(typecheckCalls).toBe(0);
    expect(missingTokenErrors.join("")).toBe(
      "NODE_AUTH_TOKEN must contain a scoped GitHub Packages read token\n",
    );
  });

  it("validates package integrity and structure before invoking the declaration checker", async () => {
    let typecheckCalls = 0;
    const errors: string[] = [];
    const exitCode = await runPrivacySdkArtifactPortCompatibilityCommand({
      environment: { NODE_AUTH_TOKEN: TOKEN },
      loadArtifact: async () => ({
        ...loadedArtifact(),
        registryMetadata: {},
      }),
      typecheckArtifactPorts: async () => {
        typecheckCalls += 1;
        return compatibilityResult();
      },
      writeOutput: () => undefined,
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(typecheckCalls).toBe(0);
    expect(errors.join("")).toBe("Privacy SDK registry metadata is invalid\n");
  });

  it("redacts checker failures and rejects malformed evidence hashes", async () => {
    const checkerErrors: string[] = [];
    const checkerExit = await runPrivacySdkArtifactPortCompatibilityCommand({
      environment: { NODE_AUTH_TOKEN: TOKEN },
      loadArtifact: async () => loadedArtifact(),
      typecheckArtifactPorts: async () => {
        throw new Error(`checker exposed ${TOKEN}`);
      },
      writeOutput: () => undefined,
      writeError: (value) => checkerErrors.push(value),
    });
    expect(checkerExit).toBe(1);
    expect(checkerErrors.join("")).toBe(
      "Privacy SDK authenticated-artifact port compatibility verification failed unexpectedly\n",
    );
    expect(checkerErrors.join("")).not.toContain(TOKEN);

    const hashErrors: string[] = [];
    const hashExit = await runPrivacySdkArtifactPortCompatibilityCommand({
      environment: { NODE_AUTH_TOKEN: TOKEN },
      loadArtifact: async () => loadedArtifact(),
      typecheckArtifactPorts: async () => ({
        ...compatibilityResult(),
        portDeclarationSha256: PORT_DECLARATION_SHA256.toUpperCase(),
      }),
      writeOutput: () => undefined,
      writeError: (value) => hashErrors.push(value),
    });
    expect(hashExit).toBe(1);
    expect(hashErrors.join("")).toBe(
      "Privacy SDK authenticated-artifact port compatibility evidence is invalid\n",
    );
  });

  it("runs the declaration check in a bounded container without forwarding secrets", async () => {
    const calls: DockerCall[] = [];
    const result = await typecheckPrivacySdkArtifactPorts({
      environment: {
        DOCKER_CONFIG: "/Users/operator/.docker",
        HOME: "/Users/operator",
        NODE_AUTH_TOKEN: TOKEN,
        RPC_URL: PRIVATE_RPC,
      },
      tarball: TARBALL,
      dependencies: dependencies(async (executable, arguments_, options) => {
        calls.push({ executable, arguments_, options });
        return { stdout: SUCCESS_MARKER };
      }),
    });

    expect(result).toEqual(compatibilityResult());
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.executable).toBe("docker");
    expect(call?.arguments_).toContain(STARKNET_PRIVACY_SDK_SOURCE_BUILD_IMAGE);
    expect(call?.arguments_).toContain(STARKNET_PRIVACY_SDK_SOURCE_BUILD_PLATFORM);
    const argumentsText = call?.arguments_.join("\n") ?? "";
    expect(argumentsText).toContain(STARKNET_PRIVACY_SDK_COMMIT);
    expect(argumentsText).toContain(digest("sha256", TARBALL));
    expect(argumentsText).toContain("npm ci --ignore-scripts --no-audit --no-fund");
    expect(argumentsText).toContain("--no-same-owner --no-same-permissions");
    expect(argumentsText).toContain("--exactOptionalPropertyTypes true");
    expect(argumentsText).not.toContain(TOKEN);
    expect(argumentsText).not.toContain(PRIVATE_RPC);
    expect(argumentsText).not.toContain("/Users/operator");
    expect(call?.options.env).toEqual({
      DOCKER_CONFIG: "/Users/operator/.docker",
      HOME: "/Users/operator",
      LANG: "C",
      PATH: "/usr/local/bin:/usr/bin:/bin",
    });
    const mount = call?.arguments_.find((value) => value.startsWith("type=bind,source="));
    expect(mount).toMatch(/,target=\/input,readonly$/u);
    const stagedDirectory = mount?.slice("type=bind,source=".length, mount.indexOf(",target="));
    await expect(access(stagedDirectory ?? "")).rejects.toThrow();
  });

  it("rejects malformed inputs and hostile accessors before Docker execution", async () => {
    let dockerCalls = 0;
    await expect(
      typecheckPrivacySdkArtifactPorts({
        environment: {},
        tarball: new Uint8Array(),
        dependencies: dependencies(async () => {
          dockerCalls += 1;
          return { stdout: SUCCESS_MARKER };
        }),
      }),
    ).rejects.toMatchObject({ code: "artifact_port_check_input_invalid" });
    expect(dockerCalls).toBe(0);

    const hostileDependencies = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "loadPortDeclaration") throw new Error(`hostile ${TOKEN}`);
          return undefined;
        },
      },
    );
    await expect(
      typecheckPrivacySdkArtifactPorts({
        environment: {},
        tarball: TARBALL,
        dependencies: hostileDependencies as unknown as PrivacySdkArtifactPortTypecheckDependencies,
      }),
    ).rejects.toMatchObject({ code: "artifact_port_check_input_invalid" });
    expect(dockerCalls).toBe(0);

    const hostileEnvironment = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "HOME") throw new Error(`hostile ${TOKEN}`);
          return undefined;
        },
      },
    );
    await expect(
      typecheckPrivacySdkArtifactPorts({
        environment: hostileEnvironment,
        tarball: TARBALL,
        dependencies: dependencies(async () => {
          dockerCalls += 1;
          return { stdout: SUCCESS_MARKER };
        }),
      }),
    ).rejects.toMatchObject({ code: "artifact_port_check_input_invalid" });
    expect(dockerCalls).toBe(0);
  });

  it("normalizes Docker failures and hostile or unexpected output", async () => {
    await expect(
      typecheckPrivacySdkArtifactPorts({
        environment: {},
        tarball: TARBALL,
        dependencies: dependencies(async () => {
          throw new Error(`Docker exposed ${TOKEN}`);
        }),
      }),
    ).rejects.toMatchObject({
      code: "artifact_port_check_failed",
      message: "Privacy SDK authenticated-artifact port compatibility check failed",
    });

    const hostileResult = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "stdout") throw new Error(`hostile ${TOKEN}`);
          return undefined;
        },
      },
    );
    await expect(
      typecheckPrivacySdkArtifactPorts({
        environment: {},
        tarball: TARBALL,
        dependencies: dependencies(
          async () => hostileResult as unknown as { readonly stdout: string },
        ),
      }),
    ).rejects.toMatchObject({ code: "artifact_port_check_output_invalid" });

    await expect(
      typecheckPrivacySdkArtifactPorts({
        environment: {},
        tarball: TARBALL,
        dependencies: dependencies(async () => ({ stdout: `unexpected ${TOKEN}\n` })),
      }),
    ).rejects.toMatchObject({
      code: "artifact_port_check_output_invalid",
      message:
        "Privacy SDK authenticated-artifact port compatibility check returned invalid output",
    });
  });

  it("does not convert output callback failures into compatibility evidence", async () => {
    const errors: string[] = [];
    const exitCode = await runPrivacySdkArtifactPortCompatibilityCommand({
      environment: { NODE_AUTH_TOKEN: TOKEN },
      loadArtifact: async () => loadedArtifact(),
      typecheckArtifactPorts: async () => compatibilityResult(),
      writeOutput: () => {
        throw new Error(`output exposed ${TOKEN}`);
      },
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(errors.join("")).toBe(
      "Privacy SDK authenticated-artifact port compatibility verification failed unexpectedly\n",
    );
    expect(errors.join("")).not.toContain(TOKEN);
  });
});

interface DockerCall {
  readonly executable: string;
  readonly arguments_: readonly string[];
  readonly options: {
    readonly env: Readonly<Record<string, string>>;
  };
}

function compatibilityResult() {
  return {
    portDeclarationSha256: PORT_DECLARATION_SHA256,
    compatibilityFixtureSha256: COMPATIBILITY_FIXTURE_SHA256,
  };
}

function dependencies(
  executeDocker: PrivacySdkArtifactPortTypecheckDependencies["executeDocker"],
): PrivacySdkArtifactPortTypecheckDependencies {
  return {
    loadPortDeclaration: async () => PORT_DECLARATION,
    loadCompatibilityFixture: async () => COMPATIBILITY_FIXTURE,
    executeDocker,
  };
}

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
          integrity: sha512Integrity(TARBALL),
          shasum: digest("sha1", TARBALL),
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
    dependencies: expectedDependencies(),
  };
}

function expectedDependencies() {
  return {
    "@starknet-io/starknet-types-0101": "npm:@starknet-io/types-js@~0.10.2",
    "ohttp-ts": "^0.3.0",
    starknet: "10.5.0",
    "starknet-devnet": "^0.7.2",
    zod: "^3.24.0",
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

function sha512Integrity(value: Uint8Array): string {
  return `sha512-${createHash("sha512").update(value).digest("base64")}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digest(algorithm: "sha1" | "sha256", value: Uint8Array): string {
  return createHash(algorithm).update(value).digest("hex");
}
