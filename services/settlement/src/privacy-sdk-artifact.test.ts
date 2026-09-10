import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { STARKNET_PRIVACY_SDK_COMMIT, STARKNET_PRIVACY_SDK_VERSION } from "./privacy-evidence.js";
import {
  createPrivacySdkArtifactEvidence,
  PrivacySdkArtifactError,
  privacySdkArtifactDistribution,
  STARKNET_PRIVACY_SDK_ARTIFACT_SCHEMA_VERSION,
  STARKNET_PRIVACY_SDK_PACKAGE_NAME,
  STARKNET_PRIVACY_SDK_REGISTRY_ORIGIN,
  STARKNET_PRIVACY_SDK_RELEASE_TAG,
} from "./privacy-sdk-artifact.js";

const VERIFIED_AT = "2026-09-02T00:00:00.000Z";
const TARBALL = new TextEncoder().encode("authenticated privacy sdk artifact fixture");

describe("Privacy SDK package artifact evidence", () => {
  it("binds authenticated registry metadata, source provenance, manifest, and archive bytes", () => {
    const evidence = createPrivacySdkArtifactEvidence(validInput());

    expect(evidence).toEqual({
      schemaVersion: STARKNET_PRIVACY_SDK_ARTIFACT_SCHEMA_VERSION,
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
        bytes: TARBALL.byteLength,
        manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        fileSetSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      runtimeDependencies: expectedDependencies(),
      supplyChain: {
        registryIntegrityVerified: true,
        declaredSourceCommitMatches: true,
        sourceBuildMatchVerified: false,
        productionInstallApproved: false,
        blockers: ["source_build_match_unverified", "starknet_devnet_production_dependency"],
      },
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("download/");
    expect(serialized).not.toContain("NODE_AUTH_TOKEN");
  });

  it.each([
    {
      name: "a different source commit",
      mutate: (metadata: ReturnType<typeof registryMetadata>) => {
        metadata.versions[STARKNET_PRIVACY_SDK_VERSION].gitHead = "f".repeat(40);
      },
      code: "manifest_mismatch",
    },
    {
      name: "a changed runtime dependency",
      mutate: (metadata: ReturnType<typeof registryMetadata>) => {
        metadata.versions[STARKNET_PRIVACY_SDK_VERSION].dependencies.starknet = "10.6.0";
      },
      code: "manifest_mismatch",
    },
    {
      name: "an install lifecycle script",
      mutate: (metadata: ReturnType<typeof registryMetadata>) => {
        Object.assign(metadata.versions[STARKNET_PRIVACY_SDK_VERSION].scripts, {
          postinstall: "print-private-environment",
        });
      },
      code: "manifest_mismatch",
    },
    {
      name: "an unrelated tarball host",
      mutate: (metadata: ReturnType<typeof registryMetadata>) => {
        metadata.versions[STARKNET_PRIVACY_SDK_VERSION].dist.tarball =
          "https://packages.example/private.tgz";
      },
      code: "metadata_invalid",
    },
  ])("rejects registry metadata with $name", ({ mutate, code }) => {
    const metadata = registryMetadata();
    mutate(metadata);

    expect(() => privacySdkArtifactDistribution(metadata)).toThrow(
      expect.objectContaining({ code }),
    );
  });

  it("rejects archive bytes that do not match both registry digests", () => {
    const input = validInput();

    expect(() =>
      createPrivacySdkArtifactEvidence({
        ...input,
        tarball: new TextEncoder().encode("substituted artifact"),
      }),
    ).toThrow(expect.objectContaining({ code: "integrity_mismatch" }));
  });

  it.each([
    {
      name: "an omitted export target",
      entries: artifactEntries().filter((entry) => entry !== "package/dist/internal/abi.d.ts"),
    },
    { name: "a parent traversal", entries: [...artifactEntries(), "package/dist/../../secret"] },
    { name: "an unexpected source file", entries: [...artifactEntries(), "package/src/index.ts"] },
    { name: "a duplicate entry", entries: [...artifactEntries(), "package/package.json"] },
  ])("rejects an archive with $name", ({ entries }) => {
    const input = validInput();

    expect(() =>
      createPrivacySdkArtifactEvidence({
        ...input,
        inspection: { ...input.inspection, entries },
      }),
    ).toThrow(expect.objectContaining({ code: "archive_invalid" }));
  });

  it("maps hostile registry objects to a fixed metadata error", () => {
    const metadata = new Proxy(registryMetadata(), {
      get() {
        throw new Error("registry token and private package value");
      },
    });

    expect(() => privacySdkArtifactDistribution(metadata)).toThrow(
      new PrivacySdkArtifactError("metadata_invalid", "Privacy SDK registry metadata is invalid"),
    );
  });
});

function validInput(): Parameters<typeof createPrivacySdkArtifactEvidence>[0] {
  return {
    registryMetadata: registryMetadata(),
    tarball: TARBALL,
    inspection: { manifest: packageManifest(), entries: artifactEntries() },
    verifiedAt: VERIFIED_AT,
  };
}

function registryMetadata() {
  const manifest = packageManifest();
  return {
    versions: {
      [STARKNET_PRIVACY_SDK_VERSION]: {
        ...manifest,
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
    scripts: { build: "tsc -p tsconfig.build.json", test: "vitest run" },
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
    "package/README.md",
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

function digest(algorithm: "sha1", value: Uint8Array): string {
  return createHash(algorithm).update(value).digest("hex");
}
