import { runPrivacySdkSourceBuildVerificationCommand } from "../services/settlement/dist/privacy-sdk-source-build-command.js";

let exitCode;
try {
  exitCode = await runPrivacySdkSourceBuildVerificationCommand({
    environment: process.env,
    writeOutput: (value) => process.stdout.write(value),
    writeError: (value) => process.stderr.write(value),
  });
} catch {
  process.stderr.write("Privacy SDK source build verification could not start\n");
  exitCode = 1;
}

process.exitCode = exitCode;
