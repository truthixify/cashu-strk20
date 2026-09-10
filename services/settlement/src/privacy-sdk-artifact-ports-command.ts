import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { STARKNET_PRIVACY_SDK_COMMIT, STARKNET_PRIVACY_SDK_VERSION } from "./privacy-evidence.js";
import {
  createPrivacySdkArtifactEvidence,
  PrivacySdkArtifactError,
  type PrivacySdkArtifactInspection,
} from "./privacy-sdk-artifact.js";
import {
  type LoadedPrivacySdkArtifact,
  loadPrivacySdkArtifact,
  PrivacySdkArtifactCommandError,
  type PrivacySdkArtifactEnvironment,
  privacySdkPackageToken,
} from "./privacy-sdk-artifact-command.js";
import {
  createPrivacySdkArtifactPortCompatibilityEvidence,
  PrivacySdkArtifactPortCompatibilityError,
} from "./privacy-sdk-artifact-ports.js";
import {
  STARKNET_PRIVACY_SDK_SOURCE_BUILD_IMAGE,
  STARKNET_PRIVACY_SDK_SOURCE_BUILD_NODE_VERSION,
  STARKNET_PRIVACY_SDK_SOURCE_BUILD_NPM_VERSION,
  STARKNET_PRIVACY_SDK_SOURCE_BUILD_PLATFORM,
  STARKNET_PRIVACY_SDK_SOURCE_REPOSITORY,
} from "./privacy-sdk-source-build.js";

export interface PrivacySdkArtifactPortCompatibilityCommandInput {
  readonly environment: PrivacySdkArtifactEnvironment;
  readonly loadArtifact?: (token: string) => Promise<LoadedPrivacySdkArtifact>;
  readonly typecheckArtifactPorts?: (
    input: PrivacySdkArtifactPortTypecheckInput,
  ) => Promise<PrivacySdkArtifactPortTypecheckResult>;
  readonly now?: () => Date;
  readonly writeOutput: (value: string) => void;
  readonly writeError: (value: string) => void;
}

export interface PrivacySdkArtifactPortTypecheckInput {
  readonly environment: PrivacySdkArtifactEnvironment;
  readonly tarball: Uint8Array;
}

export interface PrivacySdkArtifactPortTypecheckResult {
  readonly portDeclarationSha256: string;
  readonly compatibilityFixtureSha256: string;
}

export interface PrivacySdkArtifactPortProcessOptions {
  readonly encoding: "utf8";
  readonly env: Readonly<Record<string, string>>;
  readonly maxBuffer: number;
  readonly timeout: number;
}

export interface PrivacySdkArtifactPortTypecheckDependencies {
  readonly loadPortDeclaration: () => Promise<string>;
  readonly loadCompatibilityFixture: () => Promise<string>;
  readonly executeDocker: (
    executable: "docker",
    arguments_: readonly string[],
    options: PrivacySdkArtifactPortProcessOptions,
  ) => Promise<{ readonly stdout: string }>;
}

export type PrivacySdkArtifactPortCompatibilityCommandErrorCode =
  | "artifact_port_check_failed"
  | "artifact_port_check_input_invalid"
  | "artifact_port_check_output_invalid";

export class PrivacySdkArtifactPortCompatibilityCommandError extends Error {
  readonly code: PrivacySdkArtifactPortCompatibilityCommandErrorCode;

  constructor(code: PrivacySdkArtifactPortCompatibilityCommandErrorCode, message: string) {
    super(message);
    this.name = "PrivacySdkArtifactPortCompatibilityCommandError";
    this.code = code;
  }
}

export async function runPrivacySdkArtifactPortCompatibilityCommand(
  input: PrivacySdkArtifactPortCompatibilityCommandInput,
): Promise<0 | 1> {
  try {
    const verifiedAt = timestamp((input.now ?? (() => new Date()))());
    const token = privacySdkPackageToken(input.environment);
    const typecheckEnvironment = dockerClientEnvironment(input.environment);
    const loaded = snapshotLoadedArtifact(
      await (input.loadArtifact ?? loadPrivacySdkArtifact)(token),
    );
    createPrivacySdkArtifactEvidence({ ...loaded, verifiedAt });
    const compatibility = await (input.typecheckArtifactPorts ?? typecheckPrivacySdkArtifactPorts)({
      environment: typecheckEnvironment,
      tarball: Uint8Array.from(loaded.tarball),
    });
    const evidence = createPrivacySdkArtifactPortCompatibilityEvidence({
      ...loaded,
      verifiedAt,
      ...compatibility,
    });
    input.writeOutput(`${JSON.stringify(evidence, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = knownError(error)
      ? error.message
      : "Privacy SDK authenticated-artifact port compatibility verification failed unexpectedly";
    input.writeError(`${message}\n`);
    return 1;
  }
}

export async function typecheckPrivacySdkArtifactPorts(
  input: PrivacySdkArtifactPortTypecheckInput & {
    readonly dependencies?: PrivacySdkArtifactPortTypecheckDependencies;
  },
): Promise<PrivacySdkArtifactPortTypecheckResult> {
  const dependencies = typecheckDependencies(input.dependencies);
  const tarball = ownedTarball(input.tarball);
  const artifactSha256 = createHash("sha256").update(tarball).digest("hex");
  const [portDeclaration, compatibilityFixture] = await Promise.all([
    loadInput(dependencies.loadPortDeclaration),
    loadInput(dependencies.loadCompatibilityFixture),
  ]);
  const directory = await mkdtemp(join(tmpdir(), "cashu-strk20-sdk-artifact-ports-"));
  if (directory.includes(",") || containsControlCharacter(directory)) {
    await rm(directory, { recursive: true, force: true });
    throw inputInvalid();
  }
  try {
    await chmod(directory, 0o755);
    await Promise.all([
      writeFile(join(directory, ARTIFACT_NAME), tarball, { flag: "wx", mode: 0o444 }),
      writeFile(join(directory, PORT_DECLARATION_NAME), portDeclaration, {
        flag: "wx",
        mode: 0o444,
      }),
      writeFile(join(directory, COMPATIBILITY_FIXTURE_NAME), compatibilityFixture, {
        flag: "wx",
        mode: 0o444,
      }),
    ]);
    const options = processOptions(input.environment);
    let result: { readonly stdout: string };
    try {
      result = await dependencies.executeDocker(
        "docker",
        dockerArguments(directory, artifactSha256),
        options,
      );
    } catch {
      throw checkFailed();
    }
    if (dockerStdout(result) !== `${SUCCESS_MARKER}\n`) throw outputInvalid();
    return {
      portDeclarationSha256: createHash("sha256").update(portDeclaration).digest("hex"),
      compatibilityFixtureSha256: createHash("sha256").update(compatibilityFixture).digest("hex"),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function dockerArguments(inputDirectory: string, artifactSha256: string): readonly string[] {
  return [
    "run",
    "--rm",
    "--pull=missing",
    "--platform",
    STARKNET_PRIVACY_SDK_SOURCE_BUILD_PLATFORM,
    "--network",
    "bridge",
    "--read-only",
    "--user",
    "1000:1000",
    "--cap-drop=ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "512",
    "--memory",
    "4g",
    "--cpus",
    "2",
    "--ulimit",
    "nofile=1024:1024",
    "--tmpfs",
    "/work:rw,exec,size=4294967296,mode=1777",
    "--tmpfs",
    "/tmp:rw,noexec,size=1073741824,mode=1777",
    "--mount",
    `type=bind,source=${inputDirectory},target=/input,readonly`,
    "--env",
    "HOME=/work/home",
    "--env",
    "NPM_CONFIG_AUDIT=false",
    "--env",
    "NPM_CONFIG_CACHE=/work/npm-cache",
    "--env",
    "NPM_CONFIG_FUND=false",
    "--env",
    "NPM_CONFIG_UPDATE_NOTIFIER=false",
    "--env",
    "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1",
    STARKNET_PRIVACY_SDK_SOURCE_BUILD_IMAGE,
    "/usr/bin/timeout",
    "--signal=TERM",
    "--kill-after=10s",
    "540s",
    "/bin/bash",
    "-euc",
    artifactPortCheckScript(artifactSha256),
  ];
}

function artifactPortCheckScript(artifactSha256: string): string {
  if (!SHA256.test(artifactSha256)) throw inputInvalid();
  return [
    'mkdir -p "$HOME" /work/authenticated',
    "git init -q -b source /work/source",
    `git -C /work/source remote add origin ${STARKNET_PRIVACY_SDK_SOURCE_REPOSITORY}`,
    `git -C /work/source fetch --depth=1 origin ${STARKNET_PRIVACY_SDK_COMMIT} 1>&2`,
    "git -C /work/source checkout --detach FETCH_HEAD 1>&2",
    `test "$(git -C /work/source rev-parse HEAD)" = ${STARKNET_PRIVACY_SDK_COMMIT}`,
    "cd /work/source/sdk",
    `test "$(node --version)" = v${STARKNET_PRIVACY_SDK_SOURCE_BUILD_NODE_VERSION}`,
    `test "$(npm --version)" = ${STARKNET_PRIVACY_SDK_SOURCE_BUILD_NPM_VERSION}`,
    `test "$(node -p 'require("./package.json").version')" = ${STARKNET_PRIVACY_SDK_VERSION}`,
    "npm ci --ignore-scripts --no-audit --no-fund 1>&2",
    `test "$(sha256sum /input/${ARTIFACT_NAME} | cut -d ' ' -f 1)" = ${artifactSha256}`,
    `tar --extract --gzip --file=/input/${ARTIFACT_NAME} --directory=/work/authenticated --no-same-owner --no-same-permissions`,
    "test -f /work/authenticated/package/dist/index.d.ts",
    `cp /input/${PORT_DECLARATION_NAME} /work/authenticated/package/${PORT_DECLARATION_NAME}`,
    `cp /input/${COMPATIBILITY_FIXTURE_NAME} /work/authenticated/package/${COMPATIBILITY_FIXTURE_NAME}`,
    "ln -s /work/source/sdk/node_modules /work/authenticated/package/node_modules",
    "cd /work/authenticated/package",
    `/work/source/sdk/node_modules/.bin/tsc --pretty false --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --exactOptionalPropertyTypes true --noUncheckedIndexedAccess true ${COMPATIBILITY_FIXTURE_NAME} 1>&2`,
    `printf '${SUCCESS_MARKER}\\n'`,
  ].join("\n");
}

function processOptions(
  environment: PrivacySdkArtifactEnvironment,
): PrivacySdkArtifactPortProcessOptions {
  const env: Record<string, string> = {
    LANG: "C",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    ...dockerClientEnvironment(environment),
  };
  return {
    encoding: "utf8",
    env,
    maxBuffer: PROCESS_MAX_BUFFER_BYTES,
    timeout: PROCESS_TIMEOUT_MILLISECONDS,
  };
}

function dockerClientEnvironment(
  environment: PrivacySdkArtifactEnvironment,
): PrivacySdkArtifactEnvironment {
  const result: Record<string, string> = {};
  for (const key of DOCKER_CLIENT_ENVIRONMENT_KEYS) {
    let value: unknown;
    try {
      value = Reflect.get(environment, key);
    } catch {
      throw inputInvalid();
    }
    if (value === undefined) continue;
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > MAXIMUM_ENVIRONMENT_VALUE_LENGTH ||
      containsControlCharacter(value)
    ) {
      throw inputInvalid();
    }
    result[key] = value;
  }
  return result;
}

function snapshotLoadedArtifact(value: unknown): LoadedPrivacySdkArtifact {
  if (typeof value !== "object" || value === null) throw inputInvalid();
  let registryMetadata: unknown;
  let tarball: unknown;
  let inspection: unknown;
  try {
    registryMetadata = structuredClone(Reflect.get(value, "registryMetadata"));
    tarball = Reflect.get(value, "tarball");
    inspection = structuredClone(Reflect.get(value, "inspection"));
  } catch {
    throw inputInvalid();
  }
  return {
    registryMetadata,
    tarball: ownedTarball(tarball),
    inspection: inspection as PrivacySdkArtifactInspection,
  };
}

function typecheckDependencies(
  value: PrivacySdkArtifactPortTypecheckDependencies | undefined,
): PrivacySdkArtifactPortTypecheckDependencies {
  if (value === undefined) return DEFAULT_DEPENDENCIES;
  if (typeof value !== "object" || value === null) throw inputInvalid();
  let loadPortDeclaration: unknown;
  let loadCompatibilityFixture: unknown;
  let executeDocker: unknown;
  try {
    loadPortDeclaration = Reflect.get(value, "loadPortDeclaration");
    loadCompatibilityFixture = Reflect.get(value, "loadCompatibilityFixture");
    executeDocker = Reflect.get(value, "executeDocker");
  } catch {
    throw inputInvalid();
  }
  if (
    typeof loadPortDeclaration !== "function" ||
    typeof loadCompatibilityFixture !== "function" ||
    typeof executeDocker !== "function"
  ) {
    throw inputInvalid();
  }
  return {
    loadPortDeclaration:
      loadPortDeclaration as PrivacySdkArtifactPortTypecheckDependencies["loadPortDeclaration"],
    loadCompatibilityFixture:
      loadCompatibilityFixture as PrivacySdkArtifactPortTypecheckDependencies["loadCompatibilityFixture"],
    executeDocker: executeDocker as PrivacySdkArtifactPortTypecheckDependencies["executeDocker"],
  };
}

async function loadInput(loader: () => Promise<string>): Promise<string> {
  let value: unknown;
  try {
    value = await loader();
  } catch {
    throw inputInvalid();
  }
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > MAXIMUM_INPUT_BYTES ||
    value.includes("\0")
  ) {
    throw inputInvalid();
  }
  return value;
}

function ownedTarball(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < 1 ||
    value.byteLength > MAXIMUM_ARTIFACT_BYTES
  ) {
    throw inputInvalid();
  }
  return Uint8Array.from(value);
}

function dockerStdout(value: unknown): string {
  if (typeof value !== "object" || value === null) throw outputInvalid();
  let stdout: unknown;
  try {
    stdout = Reflect.get(value, "stdout");
  } catch {
    throw outputInvalid();
  }
  if (typeof stdout !== "string") throw outputInvalid();
  return stdout;
}

function timestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw inputInvalid();
  return value.toISOString();
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function inputInvalid(): PrivacySdkArtifactPortCompatibilityCommandError {
  return new PrivacySdkArtifactPortCompatibilityCommandError(
    "artifact_port_check_input_invalid",
    "Privacy SDK authenticated-artifact port compatibility inputs are invalid",
  );
}

function checkFailed(): PrivacySdkArtifactPortCompatibilityCommandError {
  return new PrivacySdkArtifactPortCompatibilityCommandError(
    "artifact_port_check_failed",
    "Privacy SDK authenticated-artifact port compatibility check failed",
  );
}

function outputInvalid(): PrivacySdkArtifactPortCompatibilityCommandError {
  return new PrivacySdkArtifactPortCompatibilityCommandError(
    "artifact_port_check_output_invalid",
    "Privacy SDK authenticated-artifact port compatibility check returned invalid output",
  );
}

function knownError(
  error: unknown,
): error is
  | PrivacySdkArtifactCommandError
  | PrivacySdkArtifactError
  | PrivacySdkArtifactPortCompatibilityCommandError
  | PrivacySdkArtifactPortCompatibilityError {
  return (
    error instanceof PrivacySdkArtifactCommandError ||
    error instanceof PrivacySdkArtifactError ||
    error instanceof PrivacySdkArtifactPortCompatibilityCommandError ||
    error instanceof PrivacySdkArtifactPortCompatibilityError
  );
}

const execFile = promisify(execFileCallback);
const DEFAULT_DEPENDENCIES: PrivacySdkArtifactPortTypecheckDependencies = {
  loadPortDeclaration: () =>
    readFile(new URL("./starknet-privacy-sdk-ports.d.ts", import.meta.url), "utf8"),
  loadCompatibilityFixture: () =>
    readFile(new URL("../compatibility/privacy-sdk-0.14.3-rc.6.ts", import.meta.url), "utf8"),
  executeDocker: async (executable, arguments_, options) => {
    const result = await execFile(executable, arguments_, options);
    return { stdout: result.stdout };
  },
};
const ARTIFACT_NAME = "starknet-privacy-sdk.tgz";
const PORT_DECLARATION_NAME = "starknet-privacy-sdk-ports.d.ts";
const COMPATIBILITY_FIXTURE_NAME = "privacy-sdk-0.14.3-rc.6.ts";
const SUCCESS_MARKER = "cashu-strk20-privacy-sdk-artifact-ports-ok";
const DOCKER_CLIENT_ENVIRONMENT_KEYS = ["DOCKER_CONFIG", "HOME"] as const;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAXIMUM_ENVIRONMENT_VALUE_LENGTH = 4_096;
const MAXIMUM_INPUT_BYTES = 256 * 1_024;
const MAXIMUM_ARTIFACT_BYTES = 64 * 1_024 * 1_024;
const PROCESS_MAX_BUFFER_BYTES = 8 * 1_024 * 1_024;
const PROCESS_TIMEOUT_MILLISECONDS = 600_000;
