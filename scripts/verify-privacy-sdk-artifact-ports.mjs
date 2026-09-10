import { runPrivacySdkArtifactPortCompatibilityCommand } from "../services/settlement/dist/privacy-sdk-artifact-ports-command.js";

let exitCode;
try {
  exitCode = await runPrivacySdkArtifactPortCompatibilityCommand({
    environment: process.env,
    writeOutput: (value) => process.stdout.write(value),
    writeError: (value) => process.stderr.write(value),
  });
} catch {
  process.stderr.write(
    "Privacy SDK authenticated-artifact port compatibility verification could not start\n",
  );
  exitCode = 1;
}

process.exitCode = exitCode;
