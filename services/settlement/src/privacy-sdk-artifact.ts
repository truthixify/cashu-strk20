import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { STARKNET_PRIVACY_SDK_COMMIT, STARKNET_PRIVACY_SDK_VERSION } from "./privacy-evidence.js";

export const STARKNET_PRIVACY_SDK_PACKAGE_NAME = "@starkware-libs/starknet-privacy-sdk";
export const STARKNET_PRIVACY_SDK_RELEASE_TAG = "PRIVACY-0.14.3-RC.6";
export const STARKNET_PRIVACY_SDK_REGISTRY_ORIGIN = "https://npm.pkg.github.com";
export const STARKNET_PRIVACY_SDK_ARTIFACT_SCHEMA_VERSION = "cashu-strk20-privacy-sdk-artifact-v1";

export interface PrivacySdkArtifactDistribution {
  readonly integrity: string;
  readonly shasum: string;
  readonly tarballUrl: string;
}

export interface PrivacySdkArtifactInspection {
  readonly manifest: unknown;
  readonly entries: readonly string[];
}

export interface PrivacySdkArtifactEvidence {
  readonly schemaVersion: typeof STARKNET_PRIVACY_SDK_ARTIFACT_SCHEMA_VERSION;
  readonly verifiedAt: string;
  readonly package: {
    readonly name: typeof STARKNET_PRIVACY_SDK_PACKAGE_NAME;
    readonly version: typeof STARKNET_PRIVACY_SDK_VERSION;
    readonly sourceTag: typeof STARKNET_PRIVACY_SDK_RELEASE_TAG;
    readonly sourceCommit: typeof STARKNET_PRIVACY_SDK_COMMIT;
    readonly registry: typeof STARKNET_PRIVACY_SDK_REGISTRY_ORIGIN;
  };
  readonly artifact: {
    readonly integrity: string;
    readonly shasum: string;
    readonly bytes: number;
    readonly manifestSha256: string;
    readonly fileSetSha256: string;
  };
  readonly runtimeDependencies: Readonly<Record<string, string>>;
  readonly supplyChain: {
    readonly registryIntegrityVerified: true;
    readonly declaredSourceCommitMatches: true;
    readonly sourceBuildMatchVerified: false;
    readonly productionInstallApproved: false;
    readonly blockers: readonly [
      "source_build_match_unverified",
      "starknet_devnet_production_dependency",
    ];
  };
}

export type PrivacySdkArtifactErrorCode =
  | "archive_invalid"
  | "integrity_mismatch"
  | "manifest_mismatch"
  | "metadata_invalid";

export class PrivacySdkArtifactError extends Error {
  readonly code: PrivacySdkArtifactErrorCode;

  constructor(code: PrivacySdkArtifactErrorCode, message: string) {
    super(message);
    this.name = "PrivacySdkArtifactError";
    this.code = code;
  }
}

export function privacySdkArtifactDistribution(
  registryMetadata: unknown,
): PrivacySdkArtifactDistribution {
  try {
    const version = registryVersion(registryMetadata);
    assertExpectedManifest(version);
    if (readString(version, "gitHead") !== STARKNET_PRIVACY_SDK_COMMIT) {
      throw manifestMismatch();
    }
    const dist = readRecord(version, "dist");
    const integrity = readString(dist, "integrity");
    const shasum = readString(dist, "shasum");
    const tarballUrl = readString(dist, "tarball");
    assertDistribution(integrity, shasum, tarballUrl);
    return { integrity, shasum, tarballUrl };
  } catch (error) {
    throw knownOrMetadataInvalid(error);
  }
}

export function createPrivacySdkArtifactEvidence(input: {
  readonly registryMetadata: unknown;
  readonly tarball: Uint8Array;
  readonly inspection: PrivacySdkArtifactInspection;
  readonly verifiedAt: string;
}): PrivacySdkArtifactEvidence {
  try {
    const distribution = privacySdkArtifactDistribution(input.registryMetadata);
    const manifest = expectedManifestProjection(input.inspection.manifest);
    const versionManifest = expectedManifestProjection(registryVersion(input.registryMetadata));
    if (!isDeepStrictEqual(manifest, versionManifest)) {
      throw manifestMismatch();
    }
    const tarball = ownedTarball(input.tarball);
    assertArtifactIntegrity(tarball, distribution);
    const entries = validatedArtifactEntries(input.inspection.entries, manifest.exports);
    const verifiedAt = canonicalTimestamp(input.verifiedAt);
    return {
      schemaVersion: STARKNET_PRIVACY_SDK_ARTIFACT_SCHEMA_VERSION,
      verifiedAt,
      package: {
        name: STARKNET_PRIVACY_SDK_PACKAGE_NAME,
        version: STARKNET_PRIVACY_SDK_VERSION,
        sourceTag: STARKNET_PRIVACY_SDK_RELEASE_TAG,
        sourceCommit: STARKNET_PRIVACY_SDK_COMMIT,
        registry: STARKNET_PRIVACY_SDK_REGISTRY_ORIGIN,
      },
      artifact: {
        integrity: distribution.integrity,
        shasum: distribution.shasum,
        bytes: tarball.byteLength,
        manifestSha256: sha256(JSON.stringify(manifest)),
        fileSetSha256: sha256(entries.join("\n")),
      },
      runtimeDependencies: { ...EXPECTED_RUNTIME_DEPENDENCIES },
      supplyChain: {
        registryIntegrityVerified: true,
        declaredSourceCommitMatches: true,
        sourceBuildMatchVerified: false,
        productionInstallApproved: false,
        blockers: ["source_build_match_unverified", "starknet_devnet_production_dependency"],
      },
    };
  } catch (error) {
    if (error instanceof PrivacySdkArtifactError) {
      throw error;
    }
    throw metadataInvalid();
  }
}

function registryVersion(value: unknown): Record<string, unknown> {
  const metadata = plainRecord(value);
  const versions = readRecord(metadata, "versions");
  return readRecord(versions, STARKNET_PRIVACY_SDK_VERSION);
}

function assertExpectedManifest(value: unknown): void {
  expectedManifestProjection(value);
}

function expectedManifestProjection(value: unknown): ExpectedManifestProjection {
  const manifest = plainRecord(value);
  const repository = readRecord(manifest, "repository");
  const publishConfig = readRecord(manifest, "publishConfig");
  const dependencies = stringRecord(readRecord(manifest, "dependencies"));
  const files = stringArray(readValue(manifest, "files"));
  const exports = ownedJson(readValue(manifest, "exports"));
  const scripts = readRecord(manifest, "scripts");
  for (const lifecycle of FORBIDDEN_LIFECYCLE_SCRIPTS) {
    if (Object.hasOwn(scripts, lifecycle)) {
      throw manifestMismatch();
    }
  }
  const projection: ExpectedManifestProjection = {
    name: readString(manifest, "name"),
    version: readString(manifest, "version"),
    repository: {
      type: readString(repository, "type"),
      url: readString(repository, "url"),
      directory: readString(repository, "directory"),
    },
    type: readString(manifest, "type"),
    main: readString(manifest, "main"),
    types: readString(manifest, "types"),
    exports,
    publishConfig: { registry: readString(publishConfig, "registry") },
    files,
    dependencies,
  };
  if (!isDeepStrictEqual(projection, EXPECTED_MANIFEST)) {
    throw manifestMismatch();
  }
  return projection;
}

function assertDistribution(integrity: string, shasum: string, tarballUrl: string): void {
  if (!SHA512_INTEGRITY.test(integrity) || !SHA1_HEX.test(shasum)) {
    throw metadataInvalid();
  }
  let url: URL;
  try {
    url = new URL(tarballUrl);
  } catch {
    throw metadataInvalid();
  }
  const expectedPrefix = `/download/@starkware-libs/starknet-privacy-sdk/${STARKNET_PRIVACY_SDK_VERSION}/`;
  if (
    url.origin !== STARKNET_PRIVACY_SDK_REGISTRY_ORIGIN ||
    !url.pathname.startsWith(expectedPrefix) ||
    url.pathname.length <= expectedPrefix.length ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw metadataInvalid();
  }
}

function ownedTarball(value: Uint8Array): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < 1 ||
    value.byteLength > MAX_TARBALL_BYTES
  ) {
    throw new PrivacySdkArtifactError("archive_invalid", "Privacy SDK package archive is invalid");
  }
  return Uint8Array.from(value);
}

function assertArtifactIntegrity(
  tarball: Uint8Array,
  distribution: PrivacySdkArtifactDistribution,
): void {
  const bytes = Buffer.from(tarball.buffer, tarball.byteOffset, tarball.byteLength);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const shasum = createHash("sha1").update(bytes).digest("hex");
  if (integrity !== distribution.integrity || shasum !== distribution.shasum) {
    throw new PrivacySdkArtifactError(
      "integrity_mismatch",
      "Privacy SDK package integrity does not match registry metadata",
    );
  }
}

function validatedArtifactEntries(value: readonly string[], exports: JsonValue): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ARCHIVE_ENTRIES) {
    throw archiveInvalid();
  }
  const entries = new Set<string>();
  for (const candidate of Array.from(value)) {
    if (
      typeof candidate !== "string" ||
      candidate.length < 1 ||
      candidate.length > MAX_ARCHIVE_PATH_LENGTH ||
      candidate.includes("\\") ||
      containsControlCharacter(candidate)
    ) {
      throw archiveInvalid();
    }
    const entry = candidate.endsWith("/") ? candidate.slice(0, -1) : candidate;
    const segments = entry.split("/");
    if (
      entry.length < 1 ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
      !allowedArtifactEntry(entry) ||
      entries.has(entry)
    ) {
      throw archiveInvalid();
    }
    entries.add(entry);
  }
  if (!entries.has("package/package.json")) {
    throw archiveInvalid();
  }
  for (const target of exportTargets(exports)) {
    const entry = `package/${target.replace(/^\.\//u, "")}`;
    if (!entries.has(entry)) {
      throw archiveInvalid();
    }
  }
  return [...entries].sort();
}

function allowedArtifactEntry(entry: string): boolean {
  return (
    entry === "package" ||
    entry === "package/dist" ||
    entry === "package/package.json" ||
    entry === "package/README" ||
    entry === "package/README.md" ||
    entry === "package/LICENSE" ||
    entry === "package/LICENSE.md" ||
    entry === "package/CHANGELOG.md" ||
    entry.startsWith("package/dist/")
  );
}

function exportTargets(value: JsonValue): readonly string[] {
  if (!isJsonRecord(value)) {
    throw manifestMismatch();
  }
  const targets: string[] = [];
  for (const conditions of Object.values(value)) {
    if (!isJsonRecord(conditions)) {
      throw manifestMismatch();
    }
    for (const target of Object.values(conditions)) {
      if (typeof target !== "string" || !target.startsWith("./dist/")) {
        throw manifestMismatch();
      }
      targets.push(target);
    }
  }
  return [...new Set(targets)].sort();
}

function canonicalTimestamp(value: string): string {
  if (typeof value !== "string" || value.length > 64) {
    throw metadataInvalid();
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw metadataInvalid();
  }
  return value;
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw metadataInvalid();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw metadataInvalid();
  }
  return value as Record<string, unknown>;
}

function readValue(record: Record<string, unknown>, key: string): unknown {
  if (!Object.hasOwn(record, key)) {
    throw metadataInvalid();
  }
  return record[key];
}

function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return plainRecord(readValue(record, key));
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = readValue(record, key);
  if (typeof value !== "string") {
    throw metadataInvalid();
  }
  return value;
}

function stringRecord(value: Record<string, unknown>): Record<string, string> {
  const entries = Object.entries(value);
  if (entries.length > MAX_MANIFEST_ENTRIES) {
    throw metadataInvalid();
  }
  const result: Record<string, string> = {};
  for (const [key, candidate] of entries) {
    if (typeof candidate !== "string") {
      throw metadataInvalid();
    }
    result[key] = candidate;
  }
  return result;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_MANIFEST_ENTRIES) {
    throw metadataInvalid();
  }
  const result = Array.from(value);
  if (result.some((entry) => typeof entry !== "string")) {
    throw metadataInvalid();
  }
  return result as string[];
}

function ownedJson(value: unknown): JsonValue {
  if (!isJsonValue(value, new Set(), 0)) {
    throw metadataInvalid();
  }
  return structuredClone(value);
}

function isJsonValue(value: unknown, ancestors: Set<object>, depth: number): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value);
  }
  if (
    depth > MAX_JSON_DEPTH ||
    typeof value !== "object" ||
    value === null ||
    ancestors.has(value)
  ) {
    return false;
  }
  ancestors.add(value);
  let valid: boolean;
  if (Array.isArray(value)) {
    valid =
      value.length <= MAX_MANIFEST_ENTRIES &&
      Array.from(value).every((entry) => isJsonValue(entry, ancestors, depth + 1));
  } else if (isJsonRecord(value)) {
    const entries = Object.entries(value);
    valid =
      entries.length <= MAX_MANIFEST_ENTRIES &&
      entries.every(([, entry]) => isJsonValue(entry, ancestors, depth + 1));
  } else {
    valid = false;
  }
  ancestors.delete(value);
  return valid;
}

function isJsonRecord(value: unknown): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function archiveInvalid(): PrivacySdkArtifactError {
  return new PrivacySdkArtifactError("archive_invalid", "Privacy SDK package archive is invalid");
}

function manifestMismatch(): PrivacySdkArtifactError {
  return new PrivacySdkArtifactError(
    "manifest_mismatch",
    "Privacy SDK package manifest does not match the approved source release",
  );
}

function metadataInvalid(): PrivacySdkArtifactError {
  return new PrivacySdkArtifactError(
    "metadata_invalid",
    "Privacy SDK registry metadata is invalid",
  );
}

function knownOrMetadataInvalid(error: unknown): PrivacySdkArtifactError {
  return error instanceof PrivacySdkArtifactError ? error : metadataInvalid();
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

interface ExpectedManifestProjection {
  readonly name: string;
  readonly version: string;
  readonly repository: {
    readonly type: string;
    readonly url: string;
    readonly directory: string;
  };
  readonly type: string;
  readonly main: string;
  readonly types: string;
  readonly exports: JsonValue;
  readonly publishConfig: { readonly registry: string };
  readonly files: readonly string[];
  readonly dependencies: Readonly<Record<string, string>>;
}

const EXPECTED_RUNTIME_DEPENDENCIES = {
  "@starknet-io/starknet-types-0101": "npm:@starknet-io/types-js@~0.10.2",
  "ohttp-ts": "^0.3.0",
  starknet: "10.5.0",
  "starknet-devnet": "^0.7.2",
  zod: "^3.24.0",
} as const;

const EXPECTED_EXPORTS = {
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
} as const;

const EXPECTED_MANIFEST: ExpectedManifestProjection = {
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
  exports: EXPECTED_EXPORTS,
  publishConfig: { registry: STARKNET_PRIVACY_SDK_REGISTRY_ORIGIN },
  files: ["dist"],
  dependencies: EXPECTED_RUNTIME_DEPENDENCIES,
};

const FORBIDDEN_LIFECYCLE_SCRIPTS = [
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "prepublishOnly",
  "prepare",
] as const;
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const SHA1_HEX = /^[0-9a-f]{40}$/;
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 20_000;
const MAX_ARCHIVE_PATH_LENGTH = 512;
const MAX_MANIFEST_ENTRIES = 256;
const MAX_JSON_DEPTH = 8;
