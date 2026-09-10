import { describe, expect, it } from "vitest";
import {
  type PrivacyServiceImagePin,
  STARKNET_PRIVACY_SERVICE_BUILD_TYPE,
  STARKNET_PRIVACY_SERVICE_IMAGE_PINS,
} from "./privacy-service-images.js";
import {
  inspectPrivacyServiceImage,
  runPrivacyServiceImageVerificationCommand,
} from "./privacy-service-images-command.js";

const SECRET = "registry-secret-fixture";

describe("privacy service image verification command", () => {
  it("inspects every reviewed tag and emits sanitized evidence", async () => {
    const inspected: string[] = [];
    const output: string[] = [];
    const errors: string[] = [];
    const exitCode = await runPrivacyServiceImageVerificationCommand({
      environment: { NODE_AUTH_TOKEN: SECRET, RPC_URL: "https://private-rpc.example" },
      inspectImage: async (tagReference) => {
        inspected.push(tagReference);
        return imageInspection(pinFor(tagReference));
      },
      now: () => new Date("2026-09-02T01:30:00.000Z"),
      writeOutput: (value) => output.push(value),
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(inspected).toEqual(STARKNET_PRIVACY_SERVICE_IMAGE_PINS.map((pin) => pin.tagReference));
    expect(JSON.parse(output.join(""))).toMatchObject({
      verifiedAt: "2026-09-02T01:30:00.000Z",
      verification: {
        releaseTagsResolveToReviewedIndexes: true,
        publisherAttachedSourceDeclarationsMatch: true,
        imagesPulled: false,
        containersStarted: false,
        deploymentApproved: false,
      },
    });
    expect(output.join("")).not.toContain(SECRET);
    expect(output.join("")).not.toContain("private-rpc");
  });

  it("uses fixed read-only Docker arguments and an allowlisted client environment", async () => {
    const pin = firstPin();
    const calls: Array<{
      readonly executable: string;
      readonly arguments_: readonly string[];
      readonly env: Readonly<Record<string, string>>;
      readonly maxBuffer: number;
      readonly timeout: number;
    }> = [];
    const output = await inspectPrivacyServiceImage(pin.tagReference, {
      environment: {
        HOME: "/Users/operator",
        DOCKER_CONFIG: "/Users/operator/.docker",
        NODE_AUTH_TOKEN: SECRET,
        STARKNET_PRIVATE_KEY: SECRET,
        RPC_URL: "https://private-rpc.example",
      },
      dependencies: {
        executeDocker: async (executable, arguments_, options) => {
          calls.push({ executable, arguments_, ...options });
          if (arguments_[4] === "{{json .Manifest}}") {
            return { stdout: imageManifest(pin) };
          }
          if (arguments_[4] === "{{json .Provenance}}") {
            return { stdout: imageProvenance(pin) };
          }
          throw new Error("unexpected Docker format");
        },
      },
    });

    expect(JSON.parse(output.manifest)).toMatchObject({ digest: pin.indexDigest });
    expect(JSON.parse(output.provenance)).toHaveProperty("linux/amd64.SLSA");
    expect(calls).toEqual([
      {
        executable: "docker",
        arguments_: [
          "buildx",
          "imagetools",
          "inspect",
          "--format",
          "{{json .Manifest}}",
          pin.tagReference,
        ],
        env: {
          LANG: "C",
          PATH: "/usr/local/bin:/usr/bin:/bin",
          DOCKER_CONFIG: "/Users/operator/.docker",
          HOME: "/Users/operator",
        },
        encoding: "utf8",
        maxBuffer: 256 * 1024,
        timeout: 30_000,
      },
      {
        executable: "docker",
        arguments_: [
          "buildx",
          "imagetools",
          "inspect",
          "--format",
          "{{json .Provenance}}",
          immutableImageReference(pin),
        ],
        env: {
          LANG: "C",
          PATH: "/usr/local/bin:/usr/bin:/bin",
          DOCKER_CONFIG: "/Users/operator/.docker",
          HOME: "/Users/operator",
        },
        encoding: "utf8",
        maxBuffer: 256 * 1024,
        timeout: 30_000,
      },
    ]);
    expect(calls.every((call) => !call.arguments_.includes("pull"))).toBe(true);
    expect(calls.every((call) => !call.arguments_.includes("run"))).toBe(true);
    expect(JSON.stringify(calls)).not.toContain(SECRET);
    expect(JSON.stringify(calls)).not.toContain("private-rpc");
  });

  it("rejects an unreviewed reference before Docker access", async () => {
    let calls = 0;
    await expect(
      inspectPrivacyServiceImage("ghcr.io/example/unreviewed:latest", {
        environment: {},
        dependencies: {
          executeDocker: async () => {
            calls += 1;
            return { stdout: "{}" };
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "image_inspection_failed",
      message: "Privacy service image inspection failed",
    });
    expect(calls).toBe(0);
  });

  it.each([
    {
      name: "Docker failure",
      executeDocker: async () => {
        throw new Error(`docker failed ${SECRET}`);
      },
    },
    {
      name: "empty output",
      executeDocker: async () => ({ stdout: "" }),
    },
    {
      name: "oversized output",
      executeDocker: async () => ({ stdout: "x".repeat(256 * 1024 + 1) }),
    },
  ])("redacts $name", async ({ executeDocker }) => {
    const pin = firstPin();
    await expect(
      inspectPrivacyServiceImage(pin.tagReference, {
        environment: {},
        dependencies: { executeDocker },
      }),
    ).rejects.toMatchObject({
      code: "image_inspection_failed",
      message: "Privacy service image inspection failed",
    });
  });

  it("fails closed without leaking dependency errors or malformed registry output", async () => {
    const errors: string[] = [];
    const exitCode = await runPrivacyServiceImageVerificationCommand({
      environment: {},
      inspectImage: async (tagReference) => {
        if (tagReference.includes("discovery-service")) {
          throw new Error(`registry rejected ${SECRET}`);
        }
        return imageInspection(pinFor(tagReference));
      },
      writeOutput: () => undefined,
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(errors.join("")).toBe("Privacy service image verification failed unexpectedly\n");
    expect(errors.join("")).not.toContain(SECRET);

    const malformedErrors: string[] = [];
    const malformedExitCode = await runPrivacyServiceImageVerificationCommand({
      environment: {},
      inspectImage: async (tagReference) =>
        tagReference.includes("transaction-prover")
          ? { ...imageInspection(pinFor(tagReference)), manifest: `not-json-${SECRET}` }
          : imageInspection(pinFor(tagReference)),
      writeOutput: () => undefined,
      writeError: (value) => malformedErrors.push(value),
    });
    expect(malformedExitCode).toBe(1);
    expect(malformedErrors.join("")).toBe("Privacy service image manifest is invalid\n");
    expect(malformedErrors.join("")).not.toContain(SECRET);

    const malformedSourceErrors: string[] = [];
    const malformedSourceExitCode = await runPrivacyServiceImageVerificationCommand({
      environment: {},
      inspectImage: async (tagReference) =>
        tagReference.includes("transaction-prover")
          ? { ...imageInspection(pinFor(tagReference)), provenance: `not-json-${SECRET}` }
          : imageInspection(pinFor(tagReference)),
      writeOutput: () => undefined,
      writeError: (value) => malformedSourceErrors.push(value),
    });
    expect(malformedSourceExitCode).toBe(1);
    expect(malformedSourceErrors.join("")).toBe(
      "Privacy service image source declaration is invalid\n",
    );
    expect(malformedSourceErrors.join("")).not.toContain(SECRET);
  });

  it("rejects hostile Docker environment values and an invalid clock", async () => {
    const pin = firstPin();
    let calls = 0;
    await expect(
      inspectPrivacyServiceImage(pin.tagReference, {
        environment: { HOME: `/tmp/operator\n${SECRET}` },
        dependencies: {
          executeDocker: async () => {
            calls += 1;
            return { stdout: imageManifest(pin) };
          },
        },
      }),
    ).rejects.toMatchObject({ code: "image_inspection_failed" });
    expect(calls).toBe(0);

    const errors: string[] = [];
    let inspections = 0;
    const exitCode = await runPrivacyServiceImageVerificationCommand({
      environment: {},
      inspectImage: async (tagReference) => {
        inspections += 1;
        return imageInspection(pinFor(tagReference));
      },
      now: () => new Date(Number.NaN),
      writeOutput: () => undefined,
      writeError: (value) => errors.push(value),
    });
    expect(exitCode).toBe(1);
    expect(inspections).toBe(0);
    expect(errors.join("")).toBe("Privacy service image inspection failed\n");
  });

  it("passes only the allowlisted Docker client environment to custom inspectors", async () => {
    const environments: unknown[] = [];
    const exitCode = await runPrivacyServiceImageVerificationCommand({
      environment: {
        DOCKER_CONFIG: "/Users/operator/.docker",
        HOME: "/Users/operator",
        NODE_AUTH_TOKEN: SECRET,
        RPC_URL: "https://private-rpc.example",
      },
      inspectImage: async (tagReference, environment) => {
        environments.push(environment);
        return imageInspection(pinFor(tagReference));
      },
      writeOutput: () => undefined,
      writeError: () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(environments).toHaveLength(STARKNET_PRIVACY_SERVICE_IMAGE_PINS.length);
    expect(environments).toEqual(
      Array.from({ length: STARKNET_PRIVACY_SERVICE_IMAGE_PINS.length }, () => ({
        DOCKER_CONFIG: "/Users/operator/.docker",
        HOME: "/Users/operator",
        LANG: "C",
        PATH: "/usr/local/bin:/usr/bin:/bin",
      })),
    );
    expect(JSON.stringify(environments)).not.toContain(SECRET);
    expect(JSON.stringify(environments)).not.toContain("private-rpc");
  });
});

function pinFor(tagReference: string): PrivacyServiceImagePin {
  const pin = STARKNET_PRIVACY_SERVICE_IMAGE_PINS.find(
    (candidate) => candidate.tagReference === tagReference,
  );
  if (!pin) {
    throw new Error("unknown fixture image");
  }
  return pin;
}

function firstPin(): PrivacyServiceImagePin {
  const pin = STARKNET_PRIVACY_SERVICE_IMAGE_PINS[0];
  if (!pin) {
    throw new Error("missing fixture image pin");
  }
  return pin;
}

function immutableImageReference(pin: PrivacyServiceImagePin): string {
  return `${pin.tagReference.slice(0, pin.tagReference.lastIndexOf(":"))}@${pin.indexDigest}`;
}

function imageManifest(pin: PrivacyServiceImagePin): string {
  const amd64 = pin.platforms["linux/amd64"];
  const arm64 = pin.platforms["linux/arm64"];
  return JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    digest: pin.indexDigest,
    manifests: [
      descriptor(amd64, "amd64"),
      descriptor(arm64, "arm64"),
      attestation(`sha256:${"a".repeat(64)}`, amd64),
      attestation(`sha256:${"b".repeat(64)}`, arm64),
    ],
  });
}

function imageInspection(pin: PrivacyServiceImagePin) {
  return { manifest: imageManifest(pin), provenance: imageProvenance(pin) };
}

function imageProvenance(pin: PrivacyServiceImagePin): string {
  return JSON.stringify({
    "linux/amd64": { SLSA: provenanceStatement(pin, "linux/amd64") },
    "linux/arm64": { SLSA: provenanceStatement(pin, "linux/arm64") },
  });
}

function provenanceStatement(pin: PrivacyServiceImagePin, platform: "linux/amd64" | "linux/arm64") {
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
