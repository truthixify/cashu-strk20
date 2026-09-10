import { createHash } from "node:crypto";
import { access } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { STARKNET_PRIVACY_SDK_COMMIT, STARKNET_PRIVACY_SDK_VERSION } from "./privacy-evidence.js";
import { STARKNET_PRIVACY_SDK_PACKAGE_NAME } from "./privacy-sdk-artifact.js";
import {
  STARKNET_PRIVACY_SDK_SOURCE_PORT_COMPATIBILITY_RECIPE,
  STARKNET_PRIVACY_SDK_SOURCE_PORT_COMPATIBILITY_SCHEMA_VERSION,
} from "./privacy-sdk-source-ports.js";
import {
  type PrivacySdkSourcePortCompatibilityDependencies,
  runPrivacySdkSourcePortCompatibilityCommand,
  verifyPrivacySdkSourcePortCompatibility,
} from "./privacy-sdk-source-ports-command.js";

const TOKEN = "github-package-token-fixture";
const PRIVATE_RPC = "https://private-rpc.example";
const PORT_DECLARATION = "export interface Port { readonly value: unknown; }\n";
const COMPATIBILITY_FIXTURE = "import type { Port } from './starknet-privacy-sdk-ports.js';\n";
const SUCCESS_MARKER = "cashu-strk20-privacy-sdk-source-ports-ok\n";

describe("Privacy SDK source-port compatibility command", () => {
  it("emits hashed source compatibility evidence without forwarding project secrets", async () => {
    const calls: DockerCall[] = [];
    const output: string[] = [];
    const errors: string[] = [];
    const exitCode = await runPrivacySdkSourcePortCompatibilityCommand({
      environment: {
        DOCKER_CONFIG: "/Users/operator/.docker",
        HOME: "/Users/operator",
        NODE_AUTH_TOKEN: TOKEN,
        RPC_URL: PRIVATE_RPC,
      },
      dependencies: dependencies(async (executable, arguments_, options) => {
        calls.push({ executable, arguments_, options });
        return { stdout: SUCCESS_MARKER };
      }),
      now: () => new Date("2026-09-10T00:00:00.000Z"),
      writeOutput: (value) => output.push(value),
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(JSON.parse(output.join(""))).toEqual({
      schemaVersion: STARKNET_PRIVACY_SDK_SOURCE_PORT_COMPATIBILITY_SCHEMA_VERSION,
      verifiedAt: "2026-09-10T00:00:00.000Z",
      package: {
        name: STARKNET_PRIVACY_SDK_PACKAGE_NAME,
        version: STARKNET_PRIVACY_SDK_VERSION,
        sourceTag: "PRIVACY-0.14.3-RC.6",
        sourceCommit: STARKNET_PRIVACY_SDK_COMMIT,
      },
      sourceCheck: {
        repository: "https://github.com/starkware-libs/starknet-privacy.git",
        containerImage:
          "node:24.0.2-bookworm@sha256:7cd385e17f9d66b2c3ae40597359286073a33266db71b5f01ce2d87db81b52f7",
        platform: "linux/amd64",
        nodeVersion: "24.0.2",
        npmVersion: "11.3.0",
        recipe: STARKNET_PRIVACY_SDK_SOURCE_PORT_COMPATIBILITY_RECIPE,
        portDeclarationSha256: sha256(PORT_DECLARATION),
        compatibilityFixtureSha256: sha256(COMPATIBILITY_FIXTURE),
        installLifecycleScriptsRun: false,
        packageCredentialForwarded: false,
        hostWorkspaceMounted: false,
        compatibilityInputsMountedReadOnly: true,
        buildNetworkIsolated: false,
      },
      compatibility: {
        publicDeclarationsBuilt: true,
        channelSnapshotAssignable: true,
        discoveryProviderAssignable: true,
        viewingKeyProviderAssignable: true,
        privateTransfersAssignable: true,
        sdkRuntimeExecuted: false,
        authenticatedPackageDeclarationsVerified: false,
        productionInstallApproved: false,
      },
      blockers: [
        "authenticated_package_declarations_unverified",
        "starknet_devnet_production_dependency",
      ],
    });
    expect(output.join("")).not.toContain(TOKEN);
    expect(output.join("")).not.toContain(PRIVATE_RPC);
    expect(output.join("")).not.toContain("/Users/operator");

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.executable).toBe("docker");
    expect(call?.arguments_).toContain("--mount");
    const argumentsText = call?.arguments_.join("\n") ?? "";
    expect(argumentsText).toContain(STARKNET_PRIVACY_SDK_COMMIT);
    expect(argumentsText).toContain("npm ci --ignore-scripts --no-audit --no-fund");
    expect(argumentsText).toContain("npm run build");
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

  it("maps Docker failures and unexpected output to fixed value-free errors", async () => {
    const dockerErrors: string[] = [];
    const dockerExitCode = await runPrivacySdkSourcePortCompatibilityCommand({
      environment: {},
      dependencies: dependencies(async () => {
        throw new Error(`Docker exposed ${TOKEN}`);
      }),
      writeOutput: () => undefined,
      writeError: (value) => dockerErrors.push(value),
    });
    expect(dockerExitCode).toBe(1);
    expect(dockerErrors.join("")).toBe("Privacy SDK source-port compatibility check failed\n");
    expect(dockerErrors.join("")).not.toContain(TOKEN);

    const outputErrors: string[] = [];
    const outputExitCode = await runPrivacySdkSourcePortCompatibilityCommand({
      environment: {},
      dependencies: dependencies(async () => ({ stdout: `unexpected ${TOKEN}\n` })),
      writeOutput: () => undefined,
      writeError: (value) => outputErrors.push(value),
    });
    expect(outputExitCode).toBe(1);
    expect(outputErrors.join("")).toBe(
      "Privacy SDK source-port compatibility check returned invalid output\n",
    );
    expect(outputErrors.join("")).not.toContain(TOKEN);
  });

  it("rejects malformed inputs and hostile Docker environment values before execution", async () => {
    let dockerCalls = 0;
    await expect(
      verifyPrivacySdkSourcePortCompatibility({
        environment: {},
        dependencies: {
          ...dependencies(async () => {
            dockerCalls += 1;
            return { stdout: SUCCESS_MARKER };
          }),
          loadPortDeclaration: async () => "",
        },
      }),
    ).rejects.toMatchObject({ code: "source_port_check_input_invalid" });
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
      verifyPrivacySdkSourcePortCompatibility({
        environment: hostileEnvironment,
        dependencies: dependencies(async () => {
          dockerCalls += 1;
          return { stdout: SUCCESS_MARKER };
        }),
      }),
    ).rejects.toMatchObject({ code: "source_port_check_input_invalid" });
    expect(dockerCalls).toBe(0);
  });

  it("normalizes hostile dependency and Docker-result accessors", async () => {
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
      verifyPrivacySdkSourcePortCompatibility({
        environment: {},
        dependencies:
          hostileDependencies as unknown as PrivacySdkSourcePortCompatibilityDependencies,
      }),
    ).rejects.toMatchObject({
      code: "source_port_check_input_invalid",
      message: "Privacy SDK source-port compatibility inputs are invalid",
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
      verifyPrivacySdkSourcePortCompatibility({
        environment: {},
        dependencies: dependencies(
          async () => hostileResult as unknown as { readonly stdout: string },
        ),
      }),
    ).rejects.toMatchObject({
      code: "source_port_check_output_invalid",
      message: "Privacy SDK source-port compatibility check returned invalid output",
    });
  });

  it("rejects an invalid clock before loading inputs or starting Docker", async () => {
    let inputLoads = 0;
    let dockerCalls = 0;
    const errors: string[] = [];
    const exitCode = await runPrivacySdkSourcePortCompatibilityCommand({
      environment: {},
      dependencies: {
        loadPortDeclaration: async () => {
          inputLoads += 1;
          return PORT_DECLARATION;
        },
        loadCompatibilityFixture: async () => {
          inputLoads += 1;
          return COMPATIBILITY_FIXTURE;
        },
        executeDocker: async () => {
          dockerCalls += 1;
          return { stdout: SUCCESS_MARKER };
        },
      },
      now: () => new Date(Number.NaN),
      writeOutput: () => undefined,
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(inputLoads).toBe(0);
    expect(dockerCalls).toBe(0);
    expect(errors.join("")).toBe("Privacy SDK source-port compatibility inputs are invalid\n");
  });

  it("does not convert output callback failures into compatibility evidence", async () => {
    const errors: string[] = [];
    const exitCode = await runPrivacySdkSourcePortCompatibilityCommand({
      environment: {},
      dependencies: dependencies(async () => ({ stdout: SUCCESS_MARKER })),
      writeOutput: () => {
        throw new Error(`output exposed ${TOKEN}`);
      },
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(errors.join("")).toBe(
      "Privacy SDK source-port compatibility verification failed unexpectedly\n",
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

function dependencies(
  executeDocker: PrivacySdkSourcePortCompatibilityDependencies["executeDocker"],
): PrivacySdkSourcePortCompatibilityDependencies {
  return {
    loadPortDeclaration: async () => PORT_DECLARATION,
    loadCompatibilityFixture: async () => COMPATIBILITY_FIXTURE,
    executeDocker,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
