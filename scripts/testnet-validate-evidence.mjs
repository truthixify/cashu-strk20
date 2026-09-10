import {
  MAXIMUM_TESTNET_EVIDENCE_INPUT_BYTES,
  runTestnetEvidenceValidationCommand,
} from "../services/settlement/dist/testnet-evidence-command.js";

let exitCode;
try {
  if (process.stdin.isTTY) {
    throw new Error("missing input");
  }
  const chunks = [];
  let total = 0;
  for await (const value of process.stdin) {
    const chunk = value instanceof Uint8Array ? value : Buffer.from(value);
    total += chunk.byteLength;
    if (total > MAXIMUM_TESTNET_EVIDENCE_INPUT_BYTES) {
      throw new Error("oversized input");
    }
    chunks.push(Uint8Array.from(chunk));
  }
  const encoded = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    encoded.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const encodedEvidence = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
  exitCode = runTestnetEvidenceValidationCommand({
    encodedEvidence,
    writeOutput: (value) => process.stdout.write(value),
    writeError: (value) => process.stderr.write(value),
  });
} catch {
  process.stderr.write("Verified testnet run artifact is invalid\n");
  exitCode = 1;
}

process.exitCode = exitCode;
