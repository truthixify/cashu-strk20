import { runPrivacySdkSourcePortCompatibilityCommand } from "../services/settlement/dist/privacy-sdk-source-ports-command.js";

let exitCode;
try {
  exitCode = await runPrivacySdkSourcePortCompatibilityCommand({
    environment: process.env,
    writeOutput: (value) => process.stdout.write(value),
    writeError: (value) => process.stderr.write(value),
  });
} catch {
  process.stderr.write("Privacy SDK source-port compatibility verification could not start\n");
  exitCode = 1;
}

process.exitCode = exitCode;
