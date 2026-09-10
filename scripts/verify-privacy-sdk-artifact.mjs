import { runPrivacySdkArtifactVerificationCommand } from "../services/settlement/dist/privacy-sdk-artifact-command.js";

let exitCode;
try {
  exitCode = await runPrivacySdkArtifactVerificationCommand({
    environment: process.env,
    writeOutput: (value) => process.stdout.write(value),
    writeError: (value) => process.stderr.write(value),
  });
} catch {
  process.stderr.write("Privacy SDK artifact verification could not start\n");
  exitCode = 1;
}

process.exitCode = exitCode;
