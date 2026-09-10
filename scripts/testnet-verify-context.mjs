import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

import { runTestnetContextVerificationCommand } from "../services/settlement/dist/testnet-context-command.js";

let exitCode;
try {
  if (existsSync(".env.deployment")) {
    loadEnvFile(".env.deployment");
  }
  exitCode = await runTestnetContextVerificationCommand({
    environment: process.env,
    writeOutput: (value) => process.stdout.write(value),
    writeError: (value) => process.stderr.write(value),
  });
} catch {
  process.stderr.write("Testnet context verification could not load local configuration\n");
  exitCode = 1;
}

process.exitCode = exitCode;
