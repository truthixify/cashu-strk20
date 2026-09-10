import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { STARKNET_PRIVACY_SDK_COMMIT, STARKNET_PRIVACY_SDK_VERSION } from "./privacy-evidence.js";
import {
  STARKNET_PRIVACY_SDK_PACKAGE_NAME,
  STARKNET_PRIVACY_SDK_REGISTRY_ORIGIN,
  STARKNET_PRIVACY_SDK_RELEASE_TAG,
} from "./privacy-sdk-artifact.js";
import {
  createPrivacySdkSourceBuildEvidence,
  STARKNET_PRIVACY_SDK_SOURCE_BUILD_IMAGE,
  STARKNET_PRIVACY_SDK_SOURCE_BUILD_NODE_VERSION,
  STARKNET_PRIVACY_SDK_SOURCE_BUILD_NPM_VERSION,
  STARKNET_PRIVACY_SDK_SOURCE_BUILD_PLATFORM,
  STARKNET_PRIVACY_SDK_SOURCE_BUILD_RECIPE,
  STARKNET_PRIVACY_SDK_SOURCE_BUILD_SCHEMA_VERSION,
  STARKNET_PRIVACY_SDK_SOURCE_REPOSITORY,
} from "./privacy-sdk-source-build.js";

const VERIFIED_AT = "2026-09-02T00:00:00.000Z";
const TARBALL = new TextEncoder().encode("independently rebuilt privacy sdk artifact fixture");

describe("Privacy SDK source build evidence", () => {
  it("marks a byte-identical independent source build while retaining the dependency blocker", () => {
    const evidence = createPrivacySdkSourceBuildEvidence({
      registryMetadata: registryMetadata(),
      publishedTarball: TARBALL,
      publishedInspection: { manifest: packageManifest(), entries: artifactEntries() },
      sourceBuildTarball: Uint8Array.from(TARBALL),
      verifiedAt: VERIFIED_AT,
    });

    expect(evidence).toEqual({
      schemaVersion: STARKNET_PRIVACY_SDK_SOURCE_BUILD_SCHEMA_VERSION,
      verifiedAt: VERIFIED_AT,
      package: {
        name: STARKNET_PRIVACY_SDK_PACKAGE_NAME,
        version: STARKNET_PRIVACY_SDK_VERSION,
        sourceTag: STARKNET_PRIVACY_SDK_RELEASE_TAG,
        sourceCommit: STARKNET_PRIVACY_SDK_COMMIT,
        registry: STARKNET_PRIVACY_SDK_REGISTRY_ORIGIN,
      },
      artifact: {
        integrity: sha512Integrity(TARBALL),
        shasum: digest("sha1", TARBALL),
        sha256: digest("sha256", TARBALL),
        bytes: TARBALL.byteLength,
        manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        fileSetSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
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
      runtimeDependencies: expectedDependencies(),
      supplyChain: {
        registryIntegrityVerified: true,
        declaredSourceCommitMatches: true,
        sourceBuildMatchVerified: true,
        productionInstallApproved: false,
        blockers: ["starknet_devnet_production_dependency"],
      },
    });
    expect(JSON.stringify(evidence)).not.toContain("download/");
    expect(JSON.stringify(evidence)).not.toContain("NODE_AUTH_TOKEN");
  });

  it("rejects a source build that differs by one byte", () => {
    expect(() =>
      createPrivacySdkSourceBuildEvidence({
        registryMetadata: registryMetadata(),
        publishedTarball: TARBALL,
        publishedInspection: { manifest: packageManifest(), entries: artifactEntries() },
        sourceBuildTarball: new TextEncoder().encode(
          "independently rebuilt privacy sdk artifact fixturf",
        ),
        verifiedAt: VERIFIED_AT,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "source_build_mismatch",
        message: "Privacy SDK source build does not match the authenticated package",
      }),
    );
  });

  it("rejects an empty or structurally invalid source archive", () => {
    expect(() =>
      createPrivacySdkSourceBuildEvidence({
        registryMetadata: registryMetadata(),
        publishedTarball: TARBALL,
        publishedInspection: { manifest: packageManifest(), entries: artifactEntries() },
        sourceBuildTarball: new Uint8Array(),
        verifiedAt: VERIFIED_AT,
      }),
    ).toThrow(expect.objectContaining({ code: "source_archive_invalid" }));
  });
});

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

function digest(algorithm: "sha1" | "sha256", value: Uint8Array): string {
  return createHash(algorithm).update(value).digest("hex");
}
