import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import { STARKNET_PRIVACY_SDK_COMMIT, STARKNET_PRIVACY_SDK_VERSION } from "./privacy-evidence.js";
import { PrivacySdkArtifactError } from "./privacy-sdk-artifact.js";
import {
  type LoadedPrivacySdkArtifact,
  loadPrivacySdkArtifact,
  PrivacySdkArtifactCommandError,
  type PrivacySdkArtifactEnvironment,
  privacySdkPackageToken,
} from "./privacy-sdk-artifact-command.js";
import {
  createPrivacySdkSourceBuildEvidence,
  PrivacySdkSourceBuildError,
  STARKNET_PRIVACY_SDK_REVIEWED_SOURCE_ARCHIVE_SHA256,
  STARKNET_PRIVACY_SDK_SOURCE_BUILD_IMAGE,
  STARKNET_PRIVACY_SDK_SOURCE_BUILD_NODE_VERSION,
  STARKNET_PRIVACY_SDK_SOURCE_BUILD_NPM_VERSION,
  STARKNET_PRIVACY_SDK_SOURCE_BUILD_PLATFORM,
  STARKNET_PRIVACY_SDK_SOURCE_REPOSITORY,
} from "./privacy-sdk-source-build.js";

export interface PrivacySdkSourceBuildCommandInput {
  readonly environment: PrivacySdkArtifactEnvironment;
  readonly loadArtifact?: (token: string) => Promise<LoadedPrivacySdkArtifact>;
  readonly rebuildSourceArtifact?: () => Promise<Uint8Array>;
  readonly now?: () => Date;
  readonly writeOutput: (value: string) => void;
  readonly writeError: (value: string) => void;
}

export interface PrivacySdkSourceBuildProcessOptions {
  readonly encoding: "utf8";
  readonly env: Readonly<Record<string, string>>;
  readonly maxBuffer: number;
  readonly timeout: number;
}

export interface PrivacySdkSourceBuildDependencies {
  readonly expectedArchiveSha256: string;
  readonly executeDocker: (
    executable: "docker",
    arguments_: readonly string[],
    options: PrivacySdkSourceBuildProcessOptions,
  ) => Promise<{ readonly stdout: string }>;
}

export type PrivacySdkSourceBuildCommandErrorCode =
  | "source_build_drift"
  | "source_build_failed"
  | "source_build_output_invalid";

export class PrivacySdkSourceBuildCommandError extends Error {
  readonly code: PrivacySdkSourceBuildCommandErrorCode;

  constructor(code: PrivacySdkSourceBuildCommandErrorCode, message: string) {
    super(message);
    this.name = "PrivacySdkSourceBuildCommandError";
    this.code = code;
  }
}

export async function runPrivacySdkSourceBuildVerificationCommand(
  input: PrivacySdkSourceBuildCommandInput,
): Promise<0 | 1> {
  try {
    const verifiedAt = timestamp((input.now ?? (() => new Date()))());
    const token = privacySdkPackageToken(input.environment);
    const loaded = await (input.loadArtifact ?? loadPrivacySdkArtifact)(token);
    const sourceBuildTarball = await (
      input.rebuildSourceArtifact ??
      (() => rebuildPrivacySdkSourceArtifact({ environment: input.environment }))
    )();
    const evidence = createPrivacySdkSourceBuildEvidence({
      registryMetadata: loaded.registryMetadata,
      publishedTarball: loaded.tarball,
      publishedInspection: loaded.inspection,
      sourceBuildTarball,
      verifiedAt,
    });
    input.writeOutput(`${JSON.stringify(evidence, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = knownError(error)
      ? error.message
      : "Privacy SDK source build verification failed unexpectedly";
    input.writeError(`${message}\n`);
    return 1;
  }
}

export async function rebuildPrivacySdkSourceArtifact(input: {
  readonly environment: PrivacySdkArtifactEnvironment;
  readonly dependencies?: PrivacySdkSourceBuildDependencies;
}): Promise<Uint8Array> {
  const dependencies = input.dependencies ?? DEFAULT_SOURCE_BUILD_DEPENDENCIES;
  let result: { readonly stdout: string };
  try {
    result = await dependencies.executeDocker("docker", dockerArguments(), {
      encoding: "utf8",
      env: dockerClientEnvironment(input.environment),
      maxBuffer: SOURCE_BUILD_MAX_BUFFER_BYTES,
      timeout: SOURCE_BUILD_PROCESS_TIMEOUT_MILLISECONDS,
    });
  } catch {
    throw sourceBuildFailed();
  }
  let stdout: unknown;
  try {
    stdout = Reflect.get(result, "stdout");
  } catch {
    throw sourceBuildOutputInvalid();
  }
  const archive = decodeSourceArchive(stdout);
  let expectedArchiveSha256: unknown;
  try {
    expectedArchiveSha256 = Reflect.get(dependencies, "expectedArchiveSha256");
  } catch {
    throw sourceBuildDrift();
  }
  if (
    typeof expectedArchiveSha256 !== "string" ||
    !SHA256.test(expectedArchiveSha256) ||
    createHash("sha256").update(archive).digest("hex") !== expectedArchiveSha256
  ) {
    throw sourceBuildDrift();
  }
  return archive;
}

function dockerArguments(): readonly string[] {
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
    "/work:rw,exec,size=8589934592,mode=1777",
    "--tmpfs",
    "/tmp:rw,noexec,size=1073741824,mode=1777",
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
    SOURCE_BUILD_SCRIPT,
  ];
}

function dockerClientEnvironment(
  environment: PrivacySdkArtifactEnvironment,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {
    LANG: "C",
    PATH: "/usr/local/bin:/usr/bin:/bin",
  };
  for (const key of DOCKER_CLIENT_ENVIRONMENT_KEYS) {
    let value: unknown;
    try {
      value = Reflect.get(environment, key);
    } catch {
      throw sourceBuildFailed();
    }
    if (value === undefined) {
      continue;
    }
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > MAX_DOCKER_ENVIRONMENT_VALUE_LENGTH ||
      containsControlCharacter(value)
    ) {
      throw sourceBuildFailed();
    }
    result[key] = value;
  }
  return result;
}

function decodeSourceArchive(value: unknown): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_SOURCE_ARCHIVE_BASE64_LENGTH ||
    value.length % 4 !== 0 ||
    !BASE64.test(value)
  ) {
    throw sourceBuildOutputInvalid();
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.byteLength < 1 ||
    decoded.byteLength > MAX_REBUILT_SOURCE_ARCHIVE_BYTES ||
    decoded.toString("base64") !== value
  ) {
    throw sourceBuildOutputInvalid();
  }
  return Uint8Array.from(decoded);
}

function timestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Invalid source build verification clock");
  }
  return value.toISOString();
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

function sourceBuildFailed(): PrivacySdkSourceBuildCommandError {
  return new PrivacySdkSourceBuildCommandError(
    "source_build_failed",
    "Privacy SDK isolated source build failed",
  );
}

function sourceBuildDrift(): PrivacySdkSourceBuildCommandError {
  return new PrivacySdkSourceBuildCommandError(
    "source_build_drift",
    "Privacy SDK isolated source build changed from the reviewed candidate",
  );
}

function sourceBuildOutputInvalid(): PrivacySdkSourceBuildCommandError {
  return new PrivacySdkSourceBuildCommandError(
    "source_build_output_invalid",
    "Privacy SDK isolated source build returned an invalid artifact",
  );
}

function knownError(
  error: unknown,
): error is
  | PrivacySdkArtifactCommandError
  | PrivacySdkArtifactError
  | PrivacySdkSourceBuildCommandError
  | PrivacySdkSourceBuildError {
  return (
    error instanceof PrivacySdkArtifactError ||
    error instanceof PrivacySdkArtifactCommandError ||
    error instanceof PrivacySdkSourceBuildCommandError ||
    error instanceof PrivacySdkSourceBuildError
  );
}

const execFile = promisify(execFileCallback);
const DEFAULT_SOURCE_BUILD_DEPENDENCIES: PrivacySdkSourceBuildDependencies = {
  expectedArchiveSha256: STARKNET_PRIVACY_SDK_REVIEWED_SOURCE_ARCHIVE_SHA256,
  executeDocker: async (executable, arguments_, options) => {
    const result = await execFile(executable, arguments_, options);
    return { stdout: result.stdout };
  },
};
const SOURCE_ARCHIVE_NAME = `starkware-libs-starknet-privacy-sdk-${STARKNET_PRIVACY_SDK_VERSION}.tgz`;
const SOURCE_BUILD_SCRIPT = [
  'mkdir -p "$HOME"',
  "git init -q -b source /work/source",
  `git -C /work/source remote add origin ${STARKNET_PRIVACY_SDK_SOURCE_REPOSITORY}`,
  `git -C /work/source fetch --depth=1 origin ${STARKNET_PRIVACY_SDK_COMMIT} 1>&2`,
  "git -C /work/source checkout --detach FETCH_HEAD 1>&2",
  `test "$(git -C /work/source rev-parse HEAD)" = ${STARKNET_PRIVACY_SDK_COMMIT}`,
  "cd /work/source/sdk",
  `test "$(node --version)" = v${STARKNET_PRIVACY_SDK_SOURCE_BUILD_NODE_VERSION}`,
  `test "$(npm --version)" = ${STARKNET_PRIVACY_SDK_SOURCE_BUILD_NPM_VERSION}`,
  "npm ci --ignore-scripts 1>&2",
  "npm run build 1>&2",
  "./node_modules/.bin/tsc scripts/build-browser.ts --module NodeNext --moduleResolution NodeNext --target ES2022 --skipLibCheck --esModuleInterop --noEmit false 1>&2",
  "node scripts/build-browser.js 1>&2",
  "git -C /work/source diff --exit-code 1>&2",
  "git -C /work/source diff --cached --exit-code 1>&2",
  "npm pack --ignore-scripts --silent 1>&2",
  `test -f ${SOURCE_ARCHIVE_NAME}`,
  "git -C /work/source diff --exit-code 1>&2",
  "git -C /work/source diff --cached --exit-code 1>&2",
  `test "$(git -C /work/source status --porcelain --untracked-files=all | tr '\\n' '|')" = "?? sdk/scripts/build-browser.js|?? sdk/${SOURCE_ARCHIVE_NAME}|"`,
  `base64 --wrap=0 ${SOURCE_ARCHIVE_NAME}`,
].join("\n");
const DOCKER_CLIENT_ENVIRONMENT_KEYS = ["DOCKER_CONFIG", "HOME"] as const;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_REBUILT_SOURCE_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_ARCHIVE_BASE64_LENGTH = Math.ceil(MAX_REBUILT_SOURCE_ARCHIVE_BYTES / 3) * 4;
const SOURCE_BUILD_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const SOURCE_BUILD_PROCESS_TIMEOUT_MILLISECONDS = 600_000;
const MAX_DOCKER_ENVIRONMENT_VALUE_LENGTH = 4096;
