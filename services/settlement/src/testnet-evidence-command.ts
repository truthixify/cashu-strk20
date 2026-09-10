import { serializeTestnetVerifiedRunEvidence, TestnetEvidenceError } from "./testnet-evidence.js";

export const MAXIMUM_TESTNET_EVIDENCE_INPUT_BYTES = 1024 * 1024;

export interface TestnetEvidenceValidationCommandInput {
  readonly encodedEvidence: string;
  readonly writeOutput: (value: string) => void;
  readonly writeError: (value: string) => void;
}

export class TestnetEvidenceArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestnetEvidenceArtifactError";
  }
}

export function runTestnetEvidenceValidationCommand(
  input: TestnetEvidenceValidationCommandInput,
): 0 | 1 {
  try {
    const parsed = parseEvidence(input.encodedEvidence);
    const canonicalEncoding = serializeTestnetVerifiedRunEvidence(parsed);
    if (input.encodedEvidence !== canonicalEncoding) {
      throw new TestnetEvidenceArtifactError("Verified testnet run artifact is not canonical");
    }
    input.writeOutput(canonicalEncoding);
    return 0;
  } catch (error) {
    const message =
      error instanceof TestnetEvidenceArtifactError || error instanceof TestnetEvidenceError
        ? error.message
        : "Testnet evidence validation failed unexpectedly";
    input.writeError(`${message}\n`);
    return 1;
  }
}

function parseEvidence(value: unknown): unknown {
  if (typeof value !== "string") {
    throw new TestnetEvidenceArtifactError("Verified testnet run artifact is invalid");
  }
  let encoded: Uint8Array;
  try {
    encoded = new TextEncoder().encode(value);
  } catch {
    throw new TestnetEvidenceArtifactError("Verified testnet run artifact is invalid");
  }
  if (encoded.byteLength < 1 || encoded.byteLength > MAXIMUM_TESTNET_EVIDENCE_INPUT_BYTES) {
    throw new TestnetEvidenceArtifactError("Verified testnet run artifact is invalid");
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new TestnetEvidenceArtifactError("Verified testnet run artifact is invalid");
  }
}
