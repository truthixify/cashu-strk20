import { describe, expect, it } from "vitest";

import {
  createPrivacyServiceImageEvidence,
  type PrivacyServiceImageObservation,
  STARKNET_PRIVACY_SERVICE_BUILD_TYPE,
  STARKNET_PRIVACY_SERVICE_IMAGE_PINS,
} from "./privacy-service-images.js";

describe("privacy service image evidence", () => {
  it("keeps the reviewed digest table immutable at runtime", () => {
    expect(Object.isFrozen(STARKNET_PRIVACY_SERVICE_IMAGE_PINS)).toBe(true);
    for (const pin of STARKNET_PRIVACY_SERVICE_IMAGE_PINS) {
      expect(Object.isFrozen(pin)).toBe(true);
      expect(Object.isFrozen(pin.platforms)).toBe(true);
      expect(Object.isFrozen(pin.sourceDeclaration)).toBe(true);
      expect(Object.isFrozen(pin.sourceDeclaration.completeness)).toBe(true);
    }
  });

  it("records exact release indexes and platform manifests without approving deployment", () => {
    const evidence = createPrivacyServiceImageEvidence({
      observations: observations().reverse(),
      verifiedAt: "2026-09-02T01:00:00.000Z",
    });

    expect(evidence).toMatchObject({
      schemaVersion: "cashu-strk20-privacy-service-images-v2",
      verifiedAt: "2026-09-02T01:00:00.000Z",
      compatibilityRelease: {
        tag: "PRIVACY-0.14.3-RC.6",
        commit: "4db755b9512f00b540126737b605472ea2275e15",
      },
      verification: {
        releaseTagsResolveToReviewedIndexes: true,
        platformManifestsMatch: true,
        publisherAttachedSourceDeclarationsMatch: true,
        imagesPulled: false,
        containersStarted: false,
        provenanceAttestationsVerified: false,
        sourceReproducibilityVerified: false,
        deploymentApproved: false,
      },
      blockers: [
        "image_provenance_unverified",
        "image_source_reproducibility_unverified",
        "sepolia_deployment_profile_unresolved",
      ],
    });
    expect(evidence.images.map((image) => image.role)).toEqual([
      "transaction_prover",
      "discovery_service",
      "proof_interceptor",
    ]);
    expect(evidence.images.map((image) => image.requirement)).toEqual([
      "required",
      "required",
      "required",
    ]);
    for (const [index, image] of evidence.images.entries()) {
      const pin = pinAt(index);
      expect(image).toMatchObject({
        tagReference: pin.tagReference,
        indexDigest: pin.indexDigest,
        platforms: pin.platforms,
        sourceDeclaration: {
          ...pin.sourceDeclaration,
          buildType: STARKNET_PRIVACY_SERVICE_BUILD_TYPE,
        },
      });
      expect(image.pinnedReference).toBe(
        `${pin.tagReference.slice(0, pin.tagReference.lastIndexOf(":"))}@${pin.indexDigest}`,
      );
    }
  });

  it.each([
    {
      name: "a missing component",
      mutate: (value: PrivacyServiceImageObservation[]) => value.slice(1),
      code: "image_set_invalid",
    },
    {
      name: "a duplicate component",
      mutate: (value: PrivacyServiceImageObservation[]) => [value[0], value[0], value[2]],
      code: "image_set_invalid",
    },
    {
      name: "a substituted tag",
      mutate: (value: PrivacyServiceImageObservation[]) => [
        {
          ...observationAt(value, 0),
          tagReference: `${observationAt(value, 0).tagReference}-moved`,
        },
        ...value.slice(1),
      ],
      code: "image_set_invalid",
    },
    {
      name: "a substituted provenance reference",
      mutate: (value: PrivacyServiceImageObservation[]) => [
        {
          ...observationAt(value, 0),
          provenanceReference: `${observationAt(value, 0).provenanceReference}-moved`,
        },
        ...value.slice(1),
      ],
      code: "image_set_invalid",
    },
    {
      name: "an index digest change",
      mutate: (value: PrivacyServiceImageObservation[]) => [
        {
          ...observationAt(value, 0),
          manifest: imageManifest(firstPin(), {
            indexDigest: `sha256:${"0".repeat(64)}`,
          }),
        },
        ...value.slice(1),
      ],
      code: "image_digest_mismatch",
    },
    {
      name: "a platform digest change",
      mutate: (value: PrivacyServiceImageObservation[]) => [
        {
          ...observationAt(value, 0),
          manifest: imageManifest(firstPin(), {
            amd64Digest: `sha256:${"0".repeat(64)}`,
          }),
        },
        ...value.slice(1),
      ],
      code: "image_digest_mismatch",
    },
  ])("rejects $name", ({ mutate, code }) => {
    expect(() =>
      createPrivacyServiceImageEvidence({
        observations: mutate(observations()) as PrivacyServiceImageObservation[],
        verifiedAt: "2026-09-02T01:00:00.000Z",
      }),
    ).toThrow(expect.objectContaining({ code }));
  });

  it.each([
    { name: "non-JSON", manifest: "not-json" },
    {
      name: "an OCI image instead of an index",
      manifest: JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: STARKNET_PRIVACY_SERVICE_IMAGE_PINS[0]?.indexDigest,
        manifests: [],
      }),
    },
    {
      name: "a duplicate platform",
      manifest: (() => {
        const parsed = JSON.parse(imageManifest(firstPin()));
        parsed.manifests[1].platform = { architecture: "amd64", os: "linux" };
        return JSON.stringify(parsed);
      })(),
    },
    {
      name: "a missing provenance descriptor",
      manifest: (() => {
        const parsed = JSON.parse(imageManifest(firstPin()));
        parsed.manifests = parsed.manifests.slice(0, 2);
        return JSON.stringify(parsed);
      })(),
    },
    {
      name: "an unrelated unknown platform",
      manifest: (() => {
        const parsed = JSON.parse(imageManifest(firstPin()));
        parsed.manifests[2].annotations["vnd.docker.reference.type"] = "other";
        return JSON.stringify(parsed);
      })(),
    },
    { name: "oversized output", manifest: `{${" ".repeat(128 * 1024)}}` },
  ])("rejects $name", ({ manifest }) => {
    const value = observations();
    value[0] = { ...observationAt(value, 0), manifest };
    expect(() =>
      createPrivacyServiceImageEvidence({
        observations: value,
        verifiedAt: "2026-09-02T01:00:00.000Z",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "image_manifest_invalid",
        message: "Privacy service image manifest is invalid",
      }),
    );
  });

  it.each([
    {
      name: "non-JSON source metadata",
      provenance: "not-json",
      code: "image_source_declaration_invalid",
    },
    {
      name: "a missing source platform",
      provenance: (() => {
        const parsed = JSON.parse(imageProvenance(firstPin()));
        delete parsed["linux/arm64"];
        return JSON.stringify(parsed);
      })(),
      code: "image_source_declaration_invalid",
    },
    {
      name: "an extra source platform",
      provenance: (() => {
        const parsed = JSON.parse(imageProvenance(firstPin()));
        parsed["linux/s390x"] = parsed["linux/amd64"];
        return JSON.stringify(parsed);
      })(),
      code: "image_source_declaration_invalid",
    },
    {
      name: "a changed source revision",
      provenance: changedProvenance((statement) => {
        statement.runDetails.metadata.buildkit_metadata.vcs.revision = "0".repeat(40);
      }),
      code: "image_source_declaration_mismatch",
    },
    {
      name: "a changed source repository",
      provenance: changedProvenance((statement) => {
        statement.runDetails.metadata.buildkit_metadata.vcs.source =
          "https://github.com/example/substitute";
      }),
      code: "image_source_declaration_mismatch",
    },
    {
      name: "a changed Dockerfile path",
      provenance: changedProvenance((statement) => {
        statement.runDetails.metadata.buildkit_metadata.vcs["localdir:dockerfile"] = "Dockerfile";
      }),
      code: "image_source_declaration_mismatch",
    },
    {
      name: "a changed builder identity",
      provenance: changedProvenance((statement) => {
        statement.runDetails.builder.id = "https://github.com/example/actions/runs/1";
      }),
      code: "image_source_declaration_mismatch",
    },
    {
      name: "a cross-platform declaration",
      provenance: changedProvenance((statement) => {
        statement.buildDefinition.internalParameters.builderPlatform = "linux/arm64";
      }),
      code: "image_source_declaration_mismatch",
    },
    {
      name: "inflated completeness",
      provenance: changedProvenance((statement) => {
        statement.runDetails.metadata.buildkit_completeness.resolvedDependencies = true;
      }),
      code: "image_source_declaration_mismatch",
    },
    {
      name: "oversized source metadata",
      provenance: `{${" ".repeat(256 * 1024)}}`,
      code: "image_source_declaration_invalid",
    },
  ])("rejects $name", ({ provenance, code }) => {
    const value = observations();
    value[0] = { ...observationAt(value, 0), provenance };
    expect(() =>
      createPrivacyServiceImageEvidence({
        observations: value,
        verifiedAt: "2026-09-02T01:00:00.000Z",
      }),
    ).toThrow(expect.objectContaining({ code }));
  });

  it("requires a canonical verification timestamp", () => {
    expect(() =>
      createPrivacyServiceImageEvidence({
        observations: observations(),
        verifiedAt: "2026-09-02T01:00:00Z",
      }),
    ).toThrow(expect.objectContaining({ code: "image_manifest_invalid" }));
  });
});

function observations(): PrivacyServiceImageObservation[] {
  return STARKNET_PRIVACY_SERVICE_IMAGE_PINS.map((pin) => ({
    role: pin.role,
    tagReference: pin.tagReference,
    manifest: imageManifest(pin),
    provenanceReference: immutableImageReference(pin),
    provenance: imageProvenance(pin),
  }));
}

function firstPin() {
  return pinAt(0);
}

function immutableImageReference(pin: (typeof STARKNET_PRIVACY_SERVICE_IMAGE_PINS)[number]) {
  return `${pin.tagReference.slice(0, pin.tagReference.lastIndexOf(":"))}@${pin.indexDigest}`;
}

function pinAt(index: number) {
  const pin = STARKNET_PRIVACY_SERVICE_IMAGE_PINS[index];
  if (!pin) {
    throw new Error("missing fixture image pin");
  }
  return pin;
}

function observationAt(
  values: readonly PrivacyServiceImageObservation[],
  index: number,
): PrivacyServiceImageObservation {
  const value = values[index];
  if (!value) {
    throw new Error("missing fixture image observation");
  }
  return value;
}

function imageManifest(
  pin: (typeof STARKNET_PRIVACY_SERVICE_IMAGE_PINS)[number],
  overrides: { readonly indexDigest?: string; readonly amd64Digest?: string } = {},
): string {
  const amd64 = overrides.amd64Digest ?? pin.platforms["linux/amd64"];
  const arm64 = pin.platforms["linux/arm64"];
  return JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    digest: overrides.indexDigest ?? pin.indexDigest,
    manifests: [
      descriptor(amd64, "amd64"),
      descriptor(arm64, "arm64"),
      attestation(`sha256:${"a".repeat(64)}`, amd64),
      attestation(`sha256:${"b".repeat(64)}`, arm64),
    ],
  });
}

function descriptor(digest: string, architecture: "amd64" | "arm64") {
  return {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest,
    platform: { architecture, os: "linux" },
  };
}

function attestation(digest: string, subjectDigest: string) {
  return {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest,
    annotations: {
      "vnd.docker.reference.digest": subjectDigest,
      "vnd.docker.reference.type": "attestation-manifest",
    },
    platform: { architecture: "unknown", os: "unknown" },
  };
}

function imageProvenance(pin: (typeof STARKNET_PRIVACY_SERVICE_IMAGE_PINS)[number]): string {
  return JSON.stringify({
    "linux/amd64": { SLSA: provenanceStatement(pin, "linux/amd64") },
    "linux/arm64": { SLSA: provenanceStatement(pin, "linux/arm64") },
  });
}

function changedProvenance(mutate: (statement: ProvenanceStatementFixture) => void): string {
  const pin = firstPin();
  const amd64 = provenanceStatement(pin, "linux/amd64");
  const arm64 = provenanceStatement(pin, "linux/arm64");
  mutate(amd64);
  return JSON.stringify({
    "linux/amd64": { SLSA: amd64 },
    "linux/arm64": { SLSA: arm64 },
  });
}

function provenanceStatement(
  pin: (typeof STARKNET_PRIVACY_SERVICE_IMAGE_PINS)[number],
  platform: "linux/amd64" | "linux/arm64",
) {
  return {
    buildDefinition: {
      buildType: STARKNET_PRIVACY_SERVICE_BUILD_TYPE,
      internalParameters: { builderPlatform: platform },
    },
    runDetails: {
      builder: { id: pin.sourceDeclaration.builderId ?? "" },
      metadata: {
        buildkit_metadata: {
          vcs: {
            source: pin.sourceDeclaration.repository,
            revision: pin.sourceDeclaration.revision,
            "localdir:dockerfile": pin.sourceDeclaration.dockerfilePath,
          },
        },
        buildkit_completeness: { ...pin.sourceDeclaration.completeness },
      },
    },
  };
}

type ProvenanceStatementFixture = ReturnType<typeof provenanceStatement>;
