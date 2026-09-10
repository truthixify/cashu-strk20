import { createHash } from "node:crypto";

import {
  STARKNET_PRIVACY_SDK_COMMIT,
  type STARKNET_PRIVACY_SDK_VERSION,
} from "./privacy-evidence.js";
import {
  createPrivacySdkArtifactEvidence,
  PrivacySdkArtifactError,
  type PrivacySdkArtifactInspection,
  type STARKNET_PRIVACY_SDK_PACKAGE_NAME,
  type STARKNET_PRIVACY_SDK_REGISTRY_ORIGIN,
  type STARKNET_PRIVACY_SDK_RELEASE_TAG,
} from "./privacy-sdk-artifact.js";
import {
  STARKNET_PRIVACY_SDK_SOURCE_BUILD_IMAGE,
  STARKNET_PRIVACY_SDK_SOURCE_BUILD_NODE_VERSION,
  STARKNET_PRIVACY_SDK_SOURCE_BUILD_NPM_VERSION,
  STARKNET_PRIVACY_SDK_SOURCE_BUILD_PLATFORM,
  STARKNET_PRIVACY_SDK_SOURCE_REPOSITORY,
} from "./privacy-sdk-source-build.js";

export const STARKNET_PRIVACY_SDK_ARTIFACT_PORT_COMPATIBILITY_SCHEMA_VERSION =
  "cashu-strk20-privacy-sdk-artifact-port-compatibility-v1";
export const STARKNET_PRIVACY_SDK_ARTIFACT_PORT_COMPATIBILITY_RECIPE =
  "authenticated-tarball-no-scripts-strict-tsc-v1";

export interface PrivacySdkArtifactPortCompatibilityEvidence {
  readonly schemaVersion: typeof STARKNET_PRIVACY_SDK_ARTIFACT_PORT_COMPATIBILITY_SCHEMA_VERSION;
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
  readonly declarationCheck: {
    readonly compilerSourceRepository: typeof STARKNET_PRIVACY_SDK_SOURCE_REPOSITORY;
    readonly compilerSourceCommit: typeof STARKNET_PRIVACY_SDK_COMMIT;
    readonly containerImage: typeof STARKNET_PRIVACY_SDK_SOURCE_BUILD_IMAGE;
    readonly platform: typeof STARKNET_PRIVACY_SDK_SOURCE_BUILD_PLATFORM;
    readonly nodeVersion: typeof STARKNET_PRIVACY_SDK_SOURCE_BUILD_NODE_VERSION;
    readonly npmVersion: typeof STARKNET_PRIVACY_SDK_SOURCE_BUILD_NPM_VERSION;
    readonly recipe: typeof STARKNET_PRIVACY_SDK_ARTIFACT_PORT_COMPATIBILITY_RECIPE;
    readonly portDeclarationSha256: string;
    readonly compatibilityFixtureSha256: string;
    readonly installLifecycleScriptsRun: false;
    readonly packageCredentialForwarded: false;
    readonly hostWorkspaceMounted: false;
    readonly compatibilityInputsMountedReadOnly: true;
    readonly authenticatedArtifactMountedReadOnly: true;
    readonly buildNetworkIsolated: false;
  };
  readonly compatibility: {
    readonly registryIntegrityVerified: true;
    readonly declaredSourceCommitMatches: true;
    readonly authenticatedPackageDeclarationsVerified: true;
    readonly channelSnapshotAssignable: true;
    readonly discoveryProviderAssignable: true;
    readonly viewingKeyProviderAssignable: true;
    readonly privateTransfersAssignable: true;
    readonly sdkRuntimeExecuted: false;
    readonly sourceBuildMatchVerified: false;
    readonly productionInstallApproved: false;
  };
  readonly runtimeDependencies: Readonly<Record<string, string>>;
  readonly blockers: readonly [
    "source_build_match_unverified",
    "starknet_devnet_production_dependency",
  ];
}

export class PrivacySdkArtifactPortCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivacySdkArtifactPortCompatibilityError";
  }
}

export function createPrivacySdkArtifactPortCompatibilityEvidence(input: {
  readonly registryMetadata: unknown;
  readonly tarball: Uint8Array;
  readonly inspection: PrivacySdkArtifactInspection;
  readonly verifiedAt: string;
  readonly portDeclarationSha256: string;
  readonly compatibilityFixtureSha256: string;
}): PrivacySdkArtifactPortCompatibilityEvidence {
  try {
    const registryMetadata = input.registryMetadata;
    const tarball = ownedTarball(input.tarball);
    const inspection = input.inspection;
    const verifiedAt = input.verifiedAt;
    const portDeclarationSha256 = sha256(input.portDeclarationSha256);
    const compatibilityFixtureSha256 = sha256(input.compatibilityFixtureSha256);
    const artifactEvidence = createPrivacySdkArtifactEvidence({
      registryMetadata,
      tarball,
      inspection,
      verifiedAt,
    });
    const tarballSha256 = createHash("sha256").update(tarball).digest("hex");
    return {
      schemaVersion: STARKNET_PRIVACY_SDK_ARTIFACT_PORT_COMPATIBILITY_SCHEMA_VERSION,
      verifiedAt: artifactEvidence.verifiedAt,
      package: artifactEvidence.package,
      artifact: {
        integrity: artifactEvidence.artifact.integrity,
        shasum: artifactEvidence.artifact.shasum,
        sha256: tarballSha256,
        bytes: artifactEvidence.artifact.bytes,
        manifestSha256: artifactEvidence.artifact.manifestSha256,
        fileSetSha256: artifactEvidence.artifact.fileSetSha256,
      },
      declarationCheck: {
        compilerSourceRepository: STARKNET_PRIVACY_SDK_SOURCE_REPOSITORY,
        compilerSourceCommit: STARKNET_PRIVACY_SDK_COMMIT,
        containerImage: STARKNET_PRIVACY_SDK_SOURCE_BUILD_IMAGE,
        platform: STARKNET_PRIVACY_SDK_SOURCE_BUILD_PLATFORM,
        nodeVersion: STARKNET_PRIVACY_SDK_SOURCE_BUILD_NODE_VERSION,
        npmVersion: STARKNET_PRIVACY_SDK_SOURCE_BUILD_NPM_VERSION,
        recipe: STARKNET_PRIVACY_SDK_ARTIFACT_PORT_COMPATIBILITY_RECIPE,
        portDeclarationSha256,
        compatibilityFixtureSha256,
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
      runtimeDependencies: artifactEvidence.runtimeDependencies,
      blockers: ["source_build_match_unverified", "starknet_devnet_production_dependency"],
    };
  } catch (error) {
    if (
      error instanceof PrivacySdkArtifactError ||
      error instanceof PrivacySdkArtifactPortCompatibilityError
    ) {
      throw error;
    }
    throw invalidCompatibilityEvidence();
  }
}

function ownedTarball(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < 1 ||
    value.byteLength > MAXIMUM_ARTIFACT_BYTES
  ) {
    throw invalidCompatibilityEvidence();
  }
  return Uint8Array.from(value);
}

function sha256(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw invalidCompatibilityEvidence();
  }
  return value;
}

function invalidCompatibilityEvidence(): PrivacySdkArtifactPortCompatibilityError {
  return new PrivacySdkArtifactPortCompatibilityError(
    "Privacy SDK authenticated-artifact port compatibility evidence is invalid",
  );
}

const MAXIMUM_ARTIFACT_BYTES = 64 * 1024 * 1024;
