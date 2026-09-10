import { STARKNET_PRIVACY_SDK_COMMIT, STARKNET_PRIVACY_SDK_VERSION } from "./privacy-evidence.js";
import {
  STARKNET_PRIVACY_SDK_PACKAGE_NAME,
  STARKNET_PRIVACY_SDK_RELEASE_TAG,
} from "./privacy-sdk-artifact.js";
import {
  STARKNET_PRIVACY_SDK_SOURCE_BUILD_IMAGE,
  STARKNET_PRIVACY_SDK_SOURCE_BUILD_NODE_VERSION,
  STARKNET_PRIVACY_SDK_SOURCE_BUILD_NPM_VERSION,
  STARKNET_PRIVACY_SDK_SOURCE_BUILD_PLATFORM,
  STARKNET_PRIVACY_SDK_SOURCE_REPOSITORY,
} from "./privacy-sdk-source-build.js";

export const STARKNET_PRIVACY_SDK_SOURCE_PORT_COMPATIBILITY_SCHEMA_VERSION =
  "cashu-strk20-privacy-sdk-source-port-compatibility-v1";
export const STARKNET_PRIVACY_SDK_SOURCE_PORT_COMPATIBILITY_RECIPE =
  "npm-ci-no-scripts-public-declarations-strict-tsc-v1";

export interface PrivacySdkSourcePortCompatibilityEvidence {
  readonly schemaVersion: typeof STARKNET_PRIVACY_SDK_SOURCE_PORT_COMPATIBILITY_SCHEMA_VERSION;
  readonly verifiedAt: string;
  readonly package: {
    readonly name: typeof STARKNET_PRIVACY_SDK_PACKAGE_NAME;
    readonly version: typeof STARKNET_PRIVACY_SDK_VERSION;
    readonly sourceTag: typeof STARKNET_PRIVACY_SDK_RELEASE_TAG;
    readonly sourceCommit: typeof STARKNET_PRIVACY_SDK_COMMIT;
  };
  readonly sourceCheck: {
    readonly repository: typeof STARKNET_PRIVACY_SDK_SOURCE_REPOSITORY;
    readonly containerImage: typeof STARKNET_PRIVACY_SDK_SOURCE_BUILD_IMAGE;
    readonly platform: typeof STARKNET_PRIVACY_SDK_SOURCE_BUILD_PLATFORM;
    readonly nodeVersion: typeof STARKNET_PRIVACY_SDK_SOURCE_BUILD_NODE_VERSION;
    readonly npmVersion: typeof STARKNET_PRIVACY_SDK_SOURCE_BUILD_NPM_VERSION;
    readonly recipe: typeof STARKNET_PRIVACY_SDK_SOURCE_PORT_COMPATIBILITY_RECIPE;
    readonly portDeclarationSha256: string;
    readonly compatibilityFixtureSha256: string;
    readonly installLifecycleScriptsRun: false;
    readonly packageCredentialForwarded: false;
    readonly hostWorkspaceMounted: false;
    readonly compatibilityInputsMountedReadOnly: true;
    readonly buildNetworkIsolated: false;
  };
  readonly compatibility: {
    readonly publicDeclarationsBuilt: true;
    readonly channelSnapshotAssignable: true;
    readonly discoveryProviderAssignable: true;
    readonly viewingKeyProviderAssignable: true;
    readonly privateTransfersAssignable: true;
    readonly sdkRuntimeExecuted: false;
    readonly authenticatedPackageDeclarationsVerified: false;
    readonly productionInstallApproved: false;
  };
  readonly blockers: readonly [
    "authenticated_package_declarations_unverified",
    "starknet_devnet_production_dependency",
  ];
}

export class PrivacySdkSourcePortCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivacySdkSourcePortCompatibilityError";
  }
}

export function createPrivacySdkSourcePortCompatibilityEvidence(input: {
  readonly verifiedAt: string;
  readonly portDeclarationSha256: string;
  readonly compatibilityFixtureSha256: string;
}): PrivacySdkSourcePortCompatibilityEvidence {
  if (typeof input !== "object" || input === null) throw invalidEvidence();
  let verifiedAtValue: unknown;
  let portDeclarationSha256Value: unknown;
  let compatibilityFixtureSha256Value: unknown;
  try {
    verifiedAtValue = Reflect.get(input, "verifiedAt");
    portDeclarationSha256Value = Reflect.get(input, "portDeclarationSha256");
    compatibilityFixtureSha256Value = Reflect.get(input, "compatibilityFixtureSha256");
  } catch {
    throw invalidEvidence();
  }
  const verifiedAt = canonicalTimestamp(verifiedAtValue);
  const portDeclarationSha256 = sha256(portDeclarationSha256Value);
  const compatibilityFixtureSha256 = sha256(compatibilityFixtureSha256Value);
  return {
    schemaVersion: STARKNET_PRIVACY_SDK_SOURCE_PORT_COMPATIBILITY_SCHEMA_VERSION,
    verifiedAt,
    package: {
      name: STARKNET_PRIVACY_SDK_PACKAGE_NAME,
      version: STARKNET_PRIVACY_SDK_VERSION,
      sourceTag: STARKNET_PRIVACY_SDK_RELEASE_TAG,
      sourceCommit: STARKNET_PRIVACY_SDK_COMMIT,
    },
    sourceCheck: {
      repository: STARKNET_PRIVACY_SDK_SOURCE_REPOSITORY,
      containerImage: STARKNET_PRIVACY_SDK_SOURCE_BUILD_IMAGE,
      platform: STARKNET_PRIVACY_SDK_SOURCE_BUILD_PLATFORM,
      nodeVersion: STARKNET_PRIVACY_SDK_SOURCE_BUILD_NODE_VERSION,
      npmVersion: STARKNET_PRIVACY_SDK_SOURCE_BUILD_NPM_VERSION,
      recipe: STARKNET_PRIVACY_SDK_SOURCE_PORT_COMPATIBILITY_RECIPE,
      portDeclarationSha256,
      compatibilityFixtureSha256,
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
  };
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== "string") throw invalidEvidence();
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw invalidEvidence();
  }
  return value;
}

function sha256(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw invalidEvidence();
  return value;
}

function invalidEvidence(): PrivacySdkSourcePortCompatibilityError {
  return new PrivacySdkSourcePortCompatibilityError(
    "Privacy SDK source-port compatibility evidence is invalid",
  );
}
