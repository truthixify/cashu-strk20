import { createHash, timingSafeEqual } from "node:crypto";

import type {
  STARKNET_PRIVACY_SDK_COMMIT,
  STARKNET_PRIVACY_SDK_VERSION,
} from "./privacy-evidence.js";
import {
  createPrivacySdkArtifactEvidence,
  PrivacySdkArtifactError,
  type PrivacySdkArtifactInspection,
  type STARKNET_PRIVACY_SDK_PACKAGE_NAME,
  type STARKNET_PRIVACY_SDK_REGISTRY_ORIGIN,
  type STARKNET_PRIVACY_SDK_RELEASE_TAG,
} from "./privacy-sdk-artifact.js";

export const STARKNET_PRIVACY_SDK_SOURCE_BUILD_SCHEMA_VERSION =
  "cashu-strk20-privacy-sdk-source-build-v1";
export const STARKNET_PRIVACY_SDK_SOURCE_REPOSITORY =
  "https://github.com/starkware-libs/starknet-privacy.git";
export const STARKNET_PRIVACY_SDK_SOURCE_BUILD_IMAGE =
  "node:24.0.2-bookworm@sha256:7cd385e17f9d66b2c3ae40597359286073a33266db71b5f01ce2d87db81b52f7";
export const STARKNET_PRIVACY_SDK_SOURCE_BUILD_PLATFORM = "linux/amd64";
export const STARKNET_PRIVACY_SDK_SOURCE_BUILD_NODE_VERSION = "24.0.2";
export const STARKNET_PRIVACY_SDK_SOURCE_BUILD_NPM_VERSION = "11.3.0";
export const STARKNET_PRIVACY_SDK_SOURCE_BUILD_RECIPE = "npm-ci-no-scripts-tsc-browser-pack-v1";
export const STARKNET_PRIVACY_SDK_REVIEWED_SOURCE_ARCHIVE_SHA256 =
  "38890093ad7c134414de666907a096427311aa1a2a6d2c2cc7febc2336a6b522";

export interface PrivacySdkSourceBuildEvidence {
  readonly schemaVersion: typeof STARKNET_PRIVACY_SDK_SOURCE_BUILD_SCHEMA_VERSION;
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
    readonly sha256: string;
    readonly bytes: number;
    readonly manifestSha256: string;
    readonly fileSetSha256: string;
  };
  readonly sourceBuild: {
    readonly repository: typeof STARKNET_PRIVACY_SDK_SOURCE_REPOSITORY;
    readonly containerImage: typeof STARKNET_PRIVACY_SDK_SOURCE_BUILD_IMAGE;
    readonly platform: typeof STARKNET_PRIVACY_SDK_SOURCE_BUILD_PLATFORM;
    readonly nodeVersion: typeof STARKNET_PRIVACY_SDK_SOURCE_BUILD_NODE_VERSION;
    readonly npmVersion: typeof STARKNET_PRIVACY_SDK_SOURCE_BUILD_NPM_VERSION;
    readonly recipe: typeof STARKNET_PRIVACY_SDK_SOURCE_BUILD_RECIPE;
    readonly installLifecycleScriptsRun: false;
    readonly hostWorkspaceMounted: false;
    readonly packageCredentialForwarded: false;
    readonly buildNetworkIsolated: false;
  };
  readonly comparison: {
    readonly exactArchiveBytesMatch: true;
    readonly publisherBuildRecipeKnown: false;
  };
  readonly runtimeDependencies: Readonly<Record<string, string>>;
  readonly supplyChain: {
    readonly registryIntegrityVerified: true;
    readonly declaredSourceCommitMatches: true;
    readonly sourceBuildMatchVerified: true;
    readonly productionInstallApproved: false;
    readonly blockers: readonly ["starknet_devnet_production_dependency"];
  };
}

export type PrivacySdkSourceBuildErrorCode = "source_archive_invalid" | "source_build_mismatch";

export class PrivacySdkSourceBuildError extends Error {
  readonly code: PrivacySdkSourceBuildErrorCode;

  constructor(code: PrivacySdkSourceBuildErrorCode, message: string) {
    super(message);
    this.name = "PrivacySdkSourceBuildError";
    this.code = code;
  }
}

export function createPrivacySdkSourceBuildEvidence(input: {
  readonly registryMetadata: unknown;
  readonly publishedTarball: Uint8Array;
  readonly publishedInspection: PrivacySdkArtifactInspection;
  readonly sourceBuildTarball: Uint8Array;
  readonly verifiedAt: string;
}): PrivacySdkSourceBuildEvidence {
  try {
    const artifactEvidence = createPrivacySdkArtifactEvidence({
      registryMetadata: input.registryMetadata,
      tarball: input.publishedTarball,
      inspection: input.publishedInspection,
      verifiedAt: input.verifiedAt,
    });
    const publishedTarball = ownedArchive(input.publishedTarball);
    const sourceBuildTarball = ownedArchive(input.sourceBuildTarball);
    if (
      publishedTarball.byteLength !== sourceBuildTarball.byteLength ||
      !timingSafeEqual(publishedTarball, sourceBuildTarball)
    ) {
      throw new PrivacySdkSourceBuildError(
        "source_build_mismatch",
        "Privacy SDK source build does not match the authenticated package",
      );
    }
    return {
      schemaVersion: STARKNET_PRIVACY_SDK_SOURCE_BUILD_SCHEMA_VERSION,
      verifiedAt: artifactEvidence.verifiedAt,
      package: artifactEvidence.package,
      artifact: {
        ...artifactEvidence.artifact,
        sha256: createHash("sha256").update(sourceBuildTarball).digest("hex"),
      },
      sourceBuild: {
        repository: STARKNET_PRIVACY_SDK_SOURCE_REPOSITORY,
        containerImage: STARKNET_PRIVACY_SDK_SOURCE_BUILD_IMAGE,
        platform: STARKNET_PRIVACY_SDK_SOURCE_BUILD_PLATFORM,
        nodeVersion: STARKNET_PRIVACY_SDK_SOURCE_BUILD_NODE_VERSION,
        npmVersion: STARKNET_PRIVACY_SDK_SOURCE_BUILD_NPM_VERSION,
        recipe: STARKNET_PRIVACY_SDK_SOURCE_BUILD_RECIPE,
        installLifecycleScriptsRun: false,
        hostWorkspaceMounted: false,
        packageCredentialForwarded: false,
        buildNetworkIsolated: false,
      },
      comparison: {
        exactArchiveBytesMatch: true,
        publisherBuildRecipeKnown: false,
      },
      runtimeDependencies: artifactEvidence.runtimeDependencies,
      supplyChain: {
        registryIntegrityVerified: true,
        declaredSourceCommitMatches: true,
        sourceBuildMatchVerified: true,
        productionInstallApproved: false,
        blockers: ["starknet_devnet_production_dependency"],
      },
    };
  } catch (error) {
    if (error instanceof PrivacySdkArtifactError || error instanceof PrivacySdkSourceBuildError) {
      throw error;
    }
    throw sourceArchiveInvalid();
  }
}

function ownedArchive(value: Uint8Array): Buffer {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < 1 ||
    value.byteLength > MAX_SOURCE_ARCHIVE_BYTES
  ) {
    throw sourceArchiveInvalid();
  }
  return Buffer.from(Uint8Array.from(value));
}

function sourceArchiveInvalid(): PrivacySdkSourceBuildError {
  return new PrivacySdkSourceBuildError(
    "source_archive_invalid",
    "Privacy SDK source build artifact is invalid",
  );
}

const MAX_SOURCE_ARCHIVE_BYTES = 64 * 1024 * 1024;
