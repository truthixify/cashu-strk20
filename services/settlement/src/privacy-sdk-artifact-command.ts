import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  createPrivacySdkArtifactEvidence,
  PrivacySdkArtifactError,
  type PrivacySdkArtifactInspection,
  privacySdkArtifactDistribution,
  STARKNET_PRIVACY_SDK_PACKAGE_NAME,
  STARKNET_PRIVACY_SDK_REGISTRY_ORIGIN,
} from "./privacy-sdk-artifact.js";

export type PrivacySdkArtifactEnvironment = Readonly<Record<string, string | undefined>>;

export interface PrivacySdkArtifactCommandInput {
  readonly environment: PrivacySdkArtifactEnvironment;
  readonly loadArtifact?: (token: string) => Promise<LoadedPrivacySdkArtifact>;
  readonly now?: () => Date;
  readonly writeOutput: (value: string) => void;
  readonly writeError: (value: string) => void;
}

export interface LoadedPrivacySdkArtifact {
  readonly registryMetadata: unknown;
  readonly tarball: Uint8Array;
  readonly inspection: PrivacySdkArtifactInspection;
}

export interface PrivacySdkArtifactLoaderDependencies {
  readonly fetch: typeof fetch;
  readonly inspectTarball: typeof inspectPrivacySdkTarball;
}

export type PrivacySdkArtifactCommandErrorCode =
  | "archive_unavailable"
  | "package_access_denied"
  | "registry_unavailable"
  | "token_missing";

export class PrivacySdkArtifactCommandError extends Error {
  readonly code: PrivacySdkArtifactCommandErrorCode;

  constructor(code: PrivacySdkArtifactCommandErrorCode, message: string) {
    super(message);
    this.name = "PrivacySdkArtifactCommandError";
    this.code = code;
  }
}

export async function runPrivacySdkArtifactVerificationCommand(
  input: PrivacySdkArtifactCommandInput,
): Promise<0 | 1> {
  try {
    const verifiedAt = timestamp((input.now ?? (() => new Date()))());
    const token = privacySdkPackageToken(input.environment);
    const loaded = await (input.loadArtifact ?? loadPrivacySdkArtifact)(token);
    const evidence = createPrivacySdkArtifactEvidence({
      ...loaded,
      verifiedAt,
    });
    input.writeOutput(`${JSON.stringify(evidence, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = knownError(error)
      ? error.message
      : "Privacy SDK artifact verification failed unexpectedly";
    input.writeError(`${message}\n`);
    return 1;
  }
}

export async function loadPrivacySdkArtifact(
  token: string,
  dependencies: PrivacySdkArtifactLoaderDependencies = DEFAULT_LOADER_DEPENDENCIES,
): Promise<LoadedPrivacySdkArtifact> {
  assertPackageToken(token);
  const metadataResponse = await registryFetch(REGISTRY_METADATA_URL, token, dependencies.fetch, {
    accept: "application/json",
    resource: "metadata",
  });
  const registryMetadata = parseRegistryMetadata(
    await boundedResponseBody(metadataResponse, MAX_METADATA_BYTES, "registry_unavailable"),
  );
  const distribution = privacySdkArtifactDistribution(registryMetadata);
  const tarballResponse = await registryFetch(distribution.tarballUrl, token, dependencies.fetch, {
    accept: "application/octet-stream",
    resource: "artifact",
  });
  const tarball = await boundedResponseBody(
    tarballResponse,
    MAX_TARBALL_BYTES,
    "archive_unavailable",
  );
  const inspection = await dependencies.inspectTarball(tarball);
  return { registryMetadata, tarball, inspection };
}

export async function inspectPrivacySdkTarball(
  tarball: Uint8Array,
): Promise<PrivacySdkArtifactInspection> {
  if (
    !(tarball instanceof Uint8Array) ||
    tarball.byteLength < 1 ||
    tarball.byteLength > MAX_TARBALL_BYTES
  ) {
    throw archiveUnavailable();
  }
  const directory = await mkdtemp(join(tmpdir(), "cashu-strk20-privacy-sdk-"));
  const archivePath = join(directory, "artifact.tgz");
  try {
    await writeFile(archivePath, tarball, { flag: "wx", mode: 0o600 });
    const entriesResult = await executeTar(["-tzf", archivePath], MAX_TAR_LIST_BYTES);
    const typesResult = await executeTar(["-tvzf", archivePath], MAX_TAR_LIST_BYTES);
    const entries = entriesResult.stdout.split("\n").filter((entry) => entry.length > 0);
    const types = typesResult.stdout.split("\n").filter((entry) => entry.length > 0);
    if (
      entries.length !== types.length ||
      entries.some((entry, index) => {
        const type = types[index]?.at(0);
        return entry.endsWith("/") ? type !== "d" : type !== "-";
      })
    ) {
      throw archiveUnavailable();
    }
    const manifestResult = await executeTar(
      ["-xOzf", archivePath, "package/package.json"],
      MAX_MANIFEST_BYTES,
    );
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestResult.stdout);
    } catch {
      throw archiveUnavailable();
    }
    return { manifest, entries };
  } catch (error) {
    if (error instanceof PrivacySdkArtifactCommandError) {
      throw error;
    }
    throw archiveUnavailable();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function registryFetch(
  url: string,
  token: string,
  fetchImplementation: typeof fetch,
  options: {
    readonly accept: string;
    readonly resource: "artifact" | "metadata";
  },
): Promise<Response> {
  let current = requestUrl(url, options.resource);
  let authorizationAllowed = true;
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const headers: Record<string, string> =
      authorizationAllowed && isRegistryUrl(current)
        ? {
            Accept: options.accept,
            Authorization: `Bearer ${token}`,
            "User-Agent": "cashu-strk20-artifact-verifier/1",
          }
        : {
            Accept: options.accept,
            "User-Agent": "cashu-strk20-artifact-verifier/1",
          };
    let response: Response;
    try {
      response = await fetchImplementation(current, {
        method: "GET",
        headers,
        redirect: "manual",
        signal,
      });
    } catch {
      throw requestUnavailable(options.resource);
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      if (redirects === MAX_REDIRECTS) {
        throw requestUnavailable(options.resource);
      }
      const next = redirectUrl(response.headers.get("location"), current, options.resource);
      if (options.resource === "metadata" && !isRegistryUrl(next)) {
        throw requestUnavailable(options.resource);
      }
      if (options.resource === "artifact" && !isArtifactRequestUrl(next)) {
        throw requestUnavailable(options.resource);
      }
      if (!isRegistryUrl(next)) {
        authorizationAllowed = false;
      }
      try {
        await response.body?.cancel();
      } catch {
        throw requestUnavailable(options.resource);
      }
      current = next;
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      throw new PrivacySdkArtifactCommandError(
        "package_access_denied",
        "Privacy SDK package access requires a scoped read token",
      );
    }
    if (!response.ok) {
      throw requestUnavailable(options.resource);
    }
    return response;
  }
  throw requestUnavailable(options.resource);
}

async function boundedResponseBody(
  response: Response,
  maximumBytes: number,
  errorCode: "archive_unavailable" | "registry_unavailable",
): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(length) || Number(length) > maximumBytes)) {
    throw responseBodyError(errorCode);
  }
  if (response.body === null) {
    throw responseBodyError(errorCode);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      if (!(result.value instanceof Uint8Array)) {
        throw responseBodyError(errorCode);
      }
      total += result.value.byteLength;
      if (!Number.isSafeInteger(total) || total > maximumBytes) {
        throw responseBodyError(errorCode);
      }
      chunks.push(Uint8Array.from(result.value));
    }
  } catch (error) {
    if (error instanceof PrivacySdkArtifactCommandError) {
      throw error;
    }
    throw responseBodyError(errorCode);
  } finally {
    reader.releaseLock();
  }
  if (total < 1) {
    throw responseBodyError(errorCode);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function parseRegistryMetadata(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new PrivacySdkArtifactCommandError(
      "registry_unavailable",
      "Privacy SDK registry returned invalid metadata",
    );
  }
}

function requestUrl(value: string, resource: "artifact" | "metadata"): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw requestUnavailable(resource);
  }
  if (resource === "metadata" ? !isRegistryUrl(url) : !isArtifactRequestUrl(url)) {
    throw requestUnavailable(resource);
  }
  return url;
}

function redirectUrl(
  location: string | null,
  current: URL,
  resource: "artifact" | "metadata",
): URL {
  if (location === null || location.length < 1 || location.length > MAX_REDIRECT_URL_LENGTH) {
    throw requestUnavailable(resource);
  }
  try {
    return new URL(location, current);
  } catch {
    throw requestUnavailable(resource);
  }
}

function isRegistryUrl(url: URL): boolean {
  return (
    url.origin === STARKNET_PRIVACY_SDK_REGISTRY_ORIGIN &&
    url.username === "" &&
    url.password === "" &&
    url.hash === ""
  );
}

function isArtifactRequestUrl(url: URL): boolean {
  const contentHost =
    url.hostname === "pkg-containers.githubusercontent.com" ||
    url.hostname.endsWith(".pkg-containers.githubusercontent.com");
  return (
    (isRegistryUrl(url) ||
      (url.protocol === "https:" && url.port === "" && contentHost && url.hash === "")) &&
    url.username === "" &&
    url.password === ""
  );
}

async function executeTar(
  arguments_: readonly string[],
  maxBuffer: number,
): Promise<{ readonly stdout: string }> {
  try {
    const result = await execFile("/usr/bin/tar", arguments_, {
      encoding: "utf8",
      env: {
        LANG: "C",
        PATH: "/usr/bin:/bin",
      },
      maxBuffer,
      timeout: TAR_TIMEOUT_MILLISECONDS,
    });
    return { stdout: result.stdout };
  } catch {
    throw archiveUnavailable();
  }
}

export function privacySdkPackageToken(environment: PrivacySdkArtifactEnvironment): string {
  let token: unknown;
  try {
    token = Reflect.get(environment, "NODE_AUTH_TOKEN");
  } catch {
    throw tokenMissing();
  }
  assertPackageToken(token);
  return token;
}

function assertPackageToken(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_TOKEN_LENGTH ||
    value.trim() !== value ||
    containsControlCharacter(value)
  ) {
    throw tokenMissing();
  }
}

function timestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Invalid artifact verification clock");
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

function responseBodyError(
  code: "archive_unavailable" | "registry_unavailable",
): PrivacySdkArtifactCommandError {
  return code === "archive_unavailable"
    ? archiveUnavailable()
    : new PrivacySdkArtifactCommandError(
        "registry_unavailable",
        "Privacy SDK registry returned invalid metadata",
      );
}

function requestUnavailable(resource: "artifact" | "metadata"): PrivacySdkArtifactCommandError {
  return resource === "artifact"
    ? archiveUnavailable()
    : new PrivacySdkArtifactCommandError(
        "registry_unavailable",
        "Privacy SDK registry request failed",
      );
}

function archiveUnavailable(): PrivacySdkArtifactCommandError {
  return new PrivacySdkArtifactCommandError(
    "archive_unavailable",
    "Privacy SDK package archive could not be inspected",
  );
}

function tokenMissing(): PrivacySdkArtifactCommandError {
  return new PrivacySdkArtifactCommandError(
    "token_missing",
    "NODE_AUTH_TOKEN must contain a scoped GitHub Packages read token",
  );
}

function knownError(
  error: unknown,
): error is PrivacySdkArtifactCommandError | PrivacySdkArtifactError {
  return (
    error instanceof PrivacySdkArtifactCommandError || error instanceof PrivacySdkArtifactError
  );
}

const execFile = promisify(execFileCallback);
const DEFAULT_LOADER_DEPENDENCIES: PrivacySdkArtifactLoaderDependencies = {
  fetch,
  inspectTarball: inspectPrivacySdkTarball,
};
const REGISTRY_METADATA_URL = `${STARKNET_PRIVACY_SDK_REGISTRY_ORIGIN}/${encodeURIComponent(
  STARKNET_PRIVACY_SDK_PACKAGE_NAME,
)}`;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const REQUEST_TIMEOUT_MILLISECONDS = 30_000;
const MAX_REDIRECTS = 3;
const MAX_REDIRECT_URL_LENGTH = 4096;
const TAR_TIMEOUT_MILLISECONDS = 10_000;
const MAX_METADATA_BYTES = 5 * 1024 * 1024;
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
const MAX_TAR_LIST_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_TOKEN_LENGTH = 1024;
