import { STARKNET_PRIVACY_SDK_COMMIT } from "./privacy-evidence.js";
import { STARKNET_PRIVACY_SDK_RELEASE_TAG } from "./privacy-sdk-artifact.js";
import {
  STARKNET_DISCOVERY_SERVICE_COMPONENT_VERSION,
  STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION,
  STARKNET_TRANSACTION_PROVER_COMPONENT_VERSION,
} from "./privacy-service-compatibility.js";

export const STARKNET_PRIVACY_SERVICE_IMAGE_SCHEMA_VERSION =
  "cashu-strk20-privacy-service-images-v2";
export const STARKNET_PRIVACY_SERVICE_SOURCE_REPOSITORY =
  "https://github.com/starkware-libs/starknet-privacy";
export const STARKNET_PRIVACY_SERVICE_BUILD_TYPE =
  "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md";

export type PrivacyServiceImageRole =
  | "transaction_prover"
  | "discovery_service"
  | "proof_interceptor";

export interface PrivacyServiceImagePin {
  readonly role: PrivacyServiceImageRole;
  readonly componentVersion: string;
  readonly tagReference: string;
  readonly indexDigest: string;
  readonly platforms: {
    readonly "linux/amd64": string;
    readonly "linux/arm64": string;
  };
  readonly sourceDeclaration: PrivacyServiceSourceDeclaration;
  readonly requirement: "required";
}

export interface PrivacyServiceSourceDeclaration {
  readonly repository: string;
  readonly revision: string;
  readonly dockerfilePath: string;
  readonly builderId: string | null;
  readonly completeness: {
    readonly request: boolean;
    readonly resolvedDependencies: boolean;
  };
}

export const STARKNET_PRIVACY_SERVICE_IMAGE_PINS: readonly PrivacyServiceImagePin[] = Object.freeze(
  [
    Object.freeze({
      role: "transaction_prover",
      componentVersion: STARKNET_TRANSACTION_PROVER_COMPONENT_VERSION,
      tagReference:
        "ghcr.io/starkware-libs/starknet-privacy/transaction-prover:PRIVACY-0.14.3-RC.2",
      indexDigest: "sha256:a2f71d7139069fa566c4f44bdd66b79cac992c0cbc20ddf0af3a3558c6cabd64",
      platforms: Object.freeze({
        "linux/amd64": "sha256:a62e7764e034ea25d84d4a235f1f683f7c5f03f88f6646a744599171bf5ca58c",
        "linux/arm64": "sha256:9882d27692b420a9edae9b50bf8075103044230de0f83ee6bed3db19cace105f",
      }),
      sourceDeclaration: Object.freeze({
        repository: "https://github.com/starkware-libs/sequencer",
        revision: "e6b6fd2e9932909107833579e5b6efd6c75fa0af",
        dockerfilePath: "crates/starknet_transaction_prover",
        builderId: null,
        completeness: Object.freeze({ request: false, resolvedDependencies: false }),
      }),
      requirement: "required",
    }),
    Object.freeze({
      role: "discovery_service",
      componentVersion: STARKNET_DISCOVERY_SERVICE_COMPONENT_VERSION,
      tagReference: "ghcr.io/starkware-libs/starknet-privacy/discovery-service:PRIVACY-0.14.3-RC.2",
      indexDigest: "sha256:29c3be4422a0471039e87e3318173153c4e9484d6c185404390916fee7ce3bae",
      platforms: Object.freeze({
        "linux/amd64": "sha256:1ca73b16fcfbe7284d2b05b4c00dd40f645a010ae0539fdf9c6e16049bb19c15",
        "linux/arm64": "sha256:dff588c0797a57c24fb29efc1da5454a8060300bc1ef45b1a71870efeb44812b",
      }),
      sourceDeclaration: Object.freeze({
        repository: STARKNET_PRIVACY_SERVICE_SOURCE_REPOSITORY,
        revision: "9bfeb8dd35565a2915a0617dff3f649bd5bb891a",
        dockerfilePath: "deploy/discovery-service",
        builderId: "https://github.com/starkware-libs/starknet-privacy/actions/runs/28506731538",
        completeness: Object.freeze({ request: false, resolvedDependencies: false }),
      }),
      requirement: "required",
    }),
    Object.freeze({
      role: "proof_interceptor",
      componentVersion: STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION,
      tagReference: "ghcr.io/starkware-libs/starknet-privacy/proof-interceptor:PRIVACY-0.14.3-RC.6",
      indexDigest: "sha256:a9082f75b378b2f01f817dbfbb7c28333ca7210e8b2b95ca311e6f364f0c6456",
      platforms: Object.freeze({
        "linux/amd64": "sha256:0f6cce261c06bad1a3d9c72f298609d53606bb96f9c5ba800643142198c0eef2",
        "linux/arm64": "sha256:cf15b94074ced8929ba3038e9b8b27fb40b63e86529a8ac4bdfc45b75e77dddf",
      }),
      sourceDeclaration: Object.freeze({
        repository: STARKNET_PRIVACY_SERVICE_SOURCE_REPOSITORY,
        revision: STARKNET_PRIVACY_SDK_COMMIT,
        dockerfilePath: "deploy/proof-interceptor",
        builderId: "https://github.com/starkware-libs/starknet-privacy/actions/runs/33398719195",
        completeness: Object.freeze({ request: true, resolvedDependencies: false }),
      }),
      requirement: "required",
    }),
  ],
);

export interface PrivacyServiceImageObservation {
  readonly role: PrivacyServiceImageRole;
  readonly tagReference: string;
  readonly manifest: string;
  readonly provenanceReference: string;
  readonly provenance: string;
}

export interface PrivacyServiceImageEvidence {
  readonly schemaVersion: typeof STARKNET_PRIVACY_SERVICE_IMAGE_SCHEMA_VERSION;
  readonly verifiedAt: string;
  readonly compatibilityRelease: {
    readonly repository: typeof STARKNET_PRIVACY_SERVICE_SOURCE_REPOSITORY;
    readonly tag: typeof STARKNET_PRIVACY_SDK_RELEASE_TAG;
    readonly commit: typeof STARKNET_PRIVACY_SDK_COMMIT;
  };
  readonly images: readonly {
    readonly role: PrivacyServiceImageRole;
    readonly componentVersion: string;
    readonly requirement: "required";
    readonly tagReference: string;
    readonly pinnedReference: string;
    readonly indexDigest: string;
    readonly platforms: {
      readonly "linux/amd64": string;
      readonly "linux/arm64": string;
    };
    readonly sourceDeclaration: PrivacyServiceSourceDeclaration & {
      readonly buildType: typeof STARKNET_PRIVACY_SERVICE_BUILD_TYPE;
    };
  }[];
  readonly verification: {
    readonly releaseTagsResolveToReviewedIndexes: true;
    readonly platformManifestsMatch: true;
    readonly publisherAttachedSourceDeclarationsMatch: true;
    readonly imagesPulled: false;
    readonly containersStarted: false;
    readonly provenanceAttestationsVerified: false;
    readonly sourceReproducibilityVerified: false;
    readonly deploymentApproved: false;
  };
  readonly blockers: readonly [
    "image_provenance_unverified",
    "image_source_reproducibility_unverified",
    "sepolia_deployment_profile_unresolved",
  ];
}

export type PrivacyServiceImageErrorCode =
  | "image_digest_mismatch"
  | "image_manifest_invalid"
  | "image_source_declaration_invalid"
  | "image_source_declaration_mismatch"
  | "image_set_invalid";

export class PrivacyServiceImageError extends Error {
  readonly code: PrivacyServiceImageErrorCode;

  constructor(code: PrivacyServiceImageErrorCode, message: string) {
    super(message);
    this.name = "PrivacyServiceImageError";
    this.code = code;
  }
}

export function createPrivacyServiceImageEvidence(input: {
  readonly observations: readonly PrivacyServiceImageObservation[];
  readonly verifiedAt: string;
}): PrivacyServiceImageEvidence {
  try {
    if (
      !Array.isArray(input.observations) ||
      input.observations.length !== STARKNET_PRIVACY_SERVICE_IMAGE_PINS.length
    ) {
      throw imageSetInvalid();
    }
    const observations = new Map<PrivacyServiceImageRole, PrivacyServiceImageObservation>();
    for (const observation of input.observations) {
      if (!isImageRole(observation.role) || observations.has(observation.role)) {
        throw imageSetInvalid();
      }
      observations.set(observation.role, observation);
    }

    const images = STARKNET_PRIVACY_SERVICE_IMAGE_PINS.map((pin) => {
      const observation = observations.get(pin.role);
      const pinnedReference = immutableImageReference(pin);
      if (
        !observation ||
        observation.tagReference !== pin.tagReference ||
        observation.provenanceReference !== pinnedReference
      ) {
        throw imageSetInvalid();
      }
      const inspected = parseImageIndex(observation.manifest);
      if (
        inspected.indexDigest !== pin.indexDigest ||
        inspected.platforms["linux/amd64"] !== pin.platforms["linux/amd64"] ||
        inspected.platforms["linux/arm64"] !== pin.platforms["linux/arm64"]
      ) {
        throw imageDigestMismatch();
      }
      const sourceDeclaration = parsePublisherSourceDeclaration(observation.provenance, pin);
      return {
        role: pin.role,
        componentVersion: pin.componentVersion,
        requirement: pin.requirement,
        tagReference: pin.tagReference,
        pinnedReference,
        indexDigest: pin.indexDigest,
        platforms: { ...pin.platforms },
        sourceDeclaration,
      };
    });

    return {
      schemaVersion: STARKNET_PRIVACY_SERVICE_IMAGE_SCHEMA_VERSION,
      verifiedAt: canonicalTimestamp(input.verifiedAt),
      compatibilityRelease: {
        repository: STARKNET_PRIVACY_SERVICE_SOURCE_REPOSITORY,
        tag: STARKNET_PRIVACY_SDK_RELEASE_TAG,
        commit: STARKNET_PRIVACY_SDK_COMMIT,
      },
      images,
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
    };
  } catch (error) {
    if (error instanceof PrivacyServiceImageError) {
      throw error;
    }
    throw imageManifestInvalid();
  }
}

function immutableImageReference(pin: PrivacyServiceImagePin): string {
  return `${pin.tagReference.slice(0, pin.tagReference.lastIndexOf(":"))}@${pin.indexDigest}`;
}

function parsePublisherSourceDeclaration(
  value: string,
  pin: PrivacyServiceImagePin,
): PrivacyServiceImageEvidence["images"][number]["sourceDeclaration"] {
  try {
    if (
      typeof value !== "string" ||
      value.length < 2 ||
      value.length > MAX_SOURCE_DECLARATION_BYTES
    ) {
      throw sourceDeclarationInvalid();
    }
    const parsed = sourceRecord(JSON.parse(value));
    if (
      Object.keys(parsed).length !== SUPPORTED_PLATFORMS.length ||
      !SUPPORTED_PLATFORMS.every((platform) => Object.hasOwn(parsed, platform))
    ) {
      throw sourceDeclarationInvalid();
    }

    for (const platform of SUPPORTED_PLATFORMS) {
      const entry = sourceRecord(field(parsed, platform));
      const statement = sourceRecord(field(entry, "SLSA"));
      const buildDefinition = sourceRecord(field(statement, "buildDefinition"));
      const internalParameters = sourceRecord(field(buildDefinition, "internalParameters"));
      const runDetails = sourceRecord(field(statement, "runDetails"));
      const builder = sourceRecord(field(runDetails, "builder"));
      const metadata = sourceRecord(field(runDetails, "metadata"));
      const buildkitMetadata = sourceRecord(field(metadata, "buildkit_metadata"));
      const vcs = sourceRecord(field(buildkitMetadata, "vcs"));
      const completeness = sourceRecord(field(metadata, "buildkit_completeness"));
      const declaredBuilderId = field(builder, "id");
      const builderId = declaredBuilderId === "" ? null : declaredBuilderId;

      if (
        field(buildDefinition, "buildType") !== STARKNET_PRIVACY_SERVICE_BUILD_TYPE ||
        field(internalParameters, "builderPlatform") !== platform ||
        field(vcs, "source") !== pin.sourceDeclaration.repository ||
        field(vcs, "revision") !== pin.sourceDeclaration.revision ||
        field(vcs, "localdir:dockerfile") !== pin.sourceDeclaration.dockerfilePath ||
        builderId !== pin.sourceDeclaration.builderId ||
        field(completeness, "request") !== pin.sourceDeclaration.completeness.request ||
        field(completeness, "resolvedDependencies") !==
          pin.sourceDeclaration.completeness.resolvedDependencies
      ) {
        throw sourceDeclarationMismatch();
      }
    }

    return {
      ...pin.sourceDeclaration,
      completeness: { ...pin.sourceDeclaration.completeness },
      buildType: STARKNET_PRIVACY_SERVICE_BUILD_TYPE,
    };
  } catch (error) {
    if (error instanceof PrivacyServiceImageError) {
      throw error;
    }
    throw sourceDeclarationInvalid();
  }
}

function parseImageIndex(value: string): InspectedImageIndex {
  if (typeof value !== "string" || value.length < 2 || value.length > MAX_MANIFEST_BYTES) {
    throw imageManifestInvalid();
  }
  const parsed = plainRecord(JSON.parse(value));
  if (
    field(parsed, "schemaVersion") !== 2 ||
    field(parsed, "mediaType") !== "application/vnd.oci.image.index.v1+json"
  ) {
    throw imageManifestInvalid();
  }
  const indexDigest = digest(field(parsed, "digest"));
  const descriptors = field(parsed, "manifests");
  if (!Array.isArray(descriptors) || descriptors.length < 2 || descriptors.length > 8) {
    throw imageManifestInvalid();
  }

  const platforms: Partial<Record<SupportedPlatform, string>> = {};
  const attestations: string[] = [];
  for (const value of descriptors) {
    const descriptor = plainRecord(value);
    if (field(descriptor, "mediaType") !== "application/vnd.oci.image.manifest.v1+json") {
      throw imageManifestInvalid();
    }
    const descriptorDigest = digest(field(descriptor, "digest"));
    const platform = plainRecord(field(descriptor, "platform"));
    const architecture = field(platform, "architecture");
    if (field(platform, "os") === "linux" && isSupportedArchitecture(architecture)) {
      const key: SupportedPlatform = `linux/${architecture}`;
      if (platforms[key]) {
        throw imageManifestInvalid();
      }
      platforms[key] = descriptorDigest;
      continue;
    }
    if (field(platform, "os") !== "unknown" || architecture !== "unknown") {
      throw imageManifestInvalid();
    }
    const annotations = plainRecord(field(descriptor, "annotations"));
    if (annotations["vnd.docker.reference.type"] !== "attestation-manifest") {
      throw imageManifestInvalid();
    }
    attestations.push(digest(annotations["vnd.docker.reference.digest"]));
  }
  const amd64 = platforms["linux/amd64"];
  const arm64 = platforms["linux/arm64"];
  if (
    !amd64 ||
    !arm64 ||
    attestations.length !== 2 ||
    !attestations.includes(amd64) ||
    !attestations.includes(arm64)
  ) {
    throw imageManifestInvalid();
  }
  return {
    indexDigest,
    platforms: { "linux/amd64": amd64, "linux/arm64": arm64 },
  };
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw imageManifestInvalid();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw imageManifestInvalid();
  }
  return value as Record<string, unknown>;
}

function sourceRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw sourceDeclarationInvalid();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw sourceDeclarationInvalid();
  }
  return value as Record<string, unknown>;
}

function field(value: Readonly<Record<string, unknown>>, key: string): unknown {
  return value[key];
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
    throw imageManifestInvalid();
  }
  return value;
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== "string") {
    throw imageManifestInvalid();
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw imageManifestInvalid();
  }
  return value;
}

function isImageRole(value: unknown): value is PrivacyServiceImageRole {
  return (
    value === "transaction_prover" || value === "discovery_service" || value === "proof_interceptor"
  );
}

function isSupportedArchitecture(value: unknown): value is "amd64" | "arm64" {
  return value === "amd64" || value === "arm64";
}

function imageManifestInvalid(): PrivacyServiceImageError {
  return new PrivacyServiceImageError(
    "image_manifest_invalid",
    "Privacy service image manifest is invalid",
  );
}

function imageSetInvalid(): PrivacyServiceImageError {
  return new PrivacyServiceImageError("image_set_invalid", "Privacy service image set is invalid");
}

function sourceDeclarationInvalid(): PrivacyServiceImageError {
  return new PrivacyServiceImageError(
    "image_source_declaration_invalid",
    "Privacy service image source declaration is invalid",
  );
}

function sourceDeclarationMismatch(): PrivacyServiceImageError {
  return new PrivacyServiceImageError(
    "image_source_declaration_mismatch",
    "Privacy service image source declaration changed from the reviewed source",
  );
}

function imageDigestMismatch(): PrivacyServiceImageError {
  return new PrivacyServiceImageError(
    "image_digest_mismatch",
    "Privacy service release tag changed from the reviewed image",
  );
}

interface InspectedImageIndex {
  readonly indexDigest: string;
  readonly platforms: Record<SupportedPlatform, string>;
}

type SupportedPlatform = "linux/amd64" | "linux/arm64";

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_SOURCE_DECLARATION_BYTES = 256 * 1024;
const SUPPORTED_PLATFORMS = ["linux/amd64", "linux/arm64"] as const;
