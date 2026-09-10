import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import {
  createPrivacyServiceImageEvidence,
  PrivacyServiceImageError,
  type PrivacyServiceImageObservation,
  STARKNET_PRIVACY_SERVICE_IMAGE_PINS,
} from "./privacy-service-images.js";

export interface PrivacyServiceImageEnvironment {
  readonly [key: string]: string | undefined;
}

export interface PrivacyServiceImageProcessOptions {
  readonly encoding: "utf8";
  readonly env: Readonly<Record<string, string>>;
  readonly maxBuffer: number;
  readonly timeout: number;
}

export interface PrivacyServiceImageCommandInput {
  readonly environment: PrivacyServiceImageEnvironment;
  readonly inspectImage?: (
    tagReference: string,
    environment: PrivacyServiceImageEnvironment,
  ) => Promise<PrivacyServiceImageInspection>;
  readonly now?: () => Date;
  readonly writeOutput: (value: string) => void;
  readonly writeError: (value: string) => void;
}

export interface PrivacyServiceImageInspection {
  readonly manifest: string;
  readonly provenance: string;
}

export interface PrivacyServiceImageCommandDependencies {
  readonly executeDocker: (
    executable: "docker",
    arguments_: readonly string[],
    options: PrivacyServiceImageProcessOptions,
  ) => Promise<{ readonly stdout: string }>;
}

export class PrivacyServiceImageCommandError extends Error {
  readonly code = "image_inspection_failed";

  constructor() {
    super("Privacy service image inspection failed");
    this.name = "PrivacyServiceImageCommandError";
  }
}

export async function runPrivacyServiceImageVerificationCommand(
  input: PrivacyServiceImageCommandInput,
): Promise<0 | 1> {
  try {
    const verifiedAt = timestamp((input.now ?? (() => new Date()))());
    const environment = dockerClientEnvironment(input.environment);
    const inspect =
      input.inspectImage ??
      ((tagReference: string, environment: PrivacyServiceImageEnvironment) =>
        inspectPrivacyServiceImage(tagReference, { environment }));
    const observations: PrivacyServiceImageObservation[] = await Promise.all(
      STARKNET_PRIVACY_SERVICE_IMAGE_PINS.map(async (pin) => {
        const inspection = await inspect(pin.tagReference, environment);
        return {
          role: pin.role,
          tagReference: pin.tagReference,
          manifest: inspection.manifest,
          provenanceReference: immutableImageReference(pin.tagReference, pin.indexDigest),
          provenance: inspection.provenance,
        };
      }),
    );
    const evidence = createPrivacyServiceImageEvidence({
      observations,
      verifiedAt,
    });
    input.writeOutput(`${JSON.stringify(evidence, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message =
      error instanceof PrivacyServiceImageError || error instanceof PrivacyServiceImageCommandError
        ? error.message
        : "Privacy service image verification failed unexpectedly";
    input.writeError(`${message}\n`);
    return 1;
  }
}

export async function inspectPrivacyServiceImage(
  tagReference: string,
  input: {
    readonly environment: PrivacyServiceImageEnvironment;
    readonly dependencies?: PrivacyServiceImageCommandDependencies;
  },
): Promise<PrivacyServiceImageInspection> {
  const pin = STARKNET_PRIVACY_SERVICE_IMAGE_PINS.find(
    (candidate) => candidate.tagReference === tagReference,
  );
  if (!pin) {
    throw new PrivacyServiceImageCommandError();
  }
  const dependencies = input.dependencies ?? DEFAULT_DEPENDENCIES;
  try {
    const environment = dockerClientEnvironment(input.environment);
    const manifest = await dependencies.executeDocker(
      "docker",
      ["buildx", "imagetools", "inspect", "--format", "{{json .Manifest}}", tagReference],
      {
        encoding: "utf8",
        env: environment,
        maxBuffer: MAX_DOCKER_OUTPUT_BYTES,
        timeout: DOCKER_INSPECTION_TIMEOUT_MILLISECONDS,
      },
    );
    const provenance = await dependencies.executeDocker(
      "docker",
      [
        "buildx",
        "imagetools",
        "inspect",
        "--format",
        "{{json .Provenance}}",
        immutableImageReference(pin.tagReference, pin.indexDigest),
      ],
      {
        encoding: "utf8",
        env: environment,
        maxBuffer: MAX_DOCKER_OUTPUT_BYTES,
        timeout: DOCKER_INSPECTION_TIMEOUT_MILLISECONDS,
      },
    );
    return {
      manifest: inspectedOutput(manifest.stdout),
      provenance: inspectedOutput(provenance.stdout),
    };
  } catch {
    throw new PrivacyServiceImageCommandError();
  }
}

function immutableImageReference(tagReference: string, digest: string): string {
  return `${tagReference.slice(0, tagReference.lastIndexOf(":"))}@${digest}`;
}

function inspectedOutput(value: unknown): string {
  if (typeof value !== "string" || value.length < 2 || value.length > MAX_DOCKER_OUTPUT_BYTES) {
    throw new PrivacyServiceImageCommandError();
  }
  return value;
}

function dockerClientEnvironment(
  environment: PrivacyServiceImageEnvironment,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {
    LANG: "C",
    PATH: "/usr/local/bin:/usr/bin:/bin",
  };
  for (const key of DOCKER_CLIENT_ENVIRONMENT_KEYS) {
    let value: unknown;
    try {
      value = Reflect.get(environment, key);
    } catch {
      throw new PrivacyServiceImageCommandError();
    }
    if (value === undefined) {
      continue;
    }
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > MAX_DOCKER_ENVIRONMENT_VALUE_LENGTH ||
      containsControlCharacter(value)
    ) {
      throw new PrivacyServiceImageCommandError();
    }
    result[key] = value;
  }
  return result;
}

function timestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new PrivacyServiceImageCommandError();
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

const execFile = promisify(execFileCallback);
const DEFAULT_DEPENDENCIES: PrivacyServiceImageCommandDependencies = {
  executeDocker: async (executable, arguments_, options) => {
    const result = await execFile(executable, arguments_, options);
    return { stdout: result.stdout };
  },
};
const DOCKER_CLIENT_ENVIRONMENT_KEYS = ["DOCKER_CONFIG", "HOME"] as const;
const MAX_DOCKER_ENVIRONMENT_VALUE_LENGTH = 4096;
const MAX_DOCKER_OUTPUT_BYTES = 256 * 1024;
const DOCKER_INSPECTION_TIMEOUT_MILLISECONDS = 30_000;
