import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

import { runTestnetPreflightCommand } from "../services/settlement/dist/testnet-preflight-config.js";

let exitCode;
try {
  if (existsSync(".env")) {
    loadEnvFile(".env");
  }
  exitCode = runTestnetPreflightCommand({
    environment: process.env,
    recordedAt: new Date().toISOString(),
    writeOutput: (value) => process.stdout.write(value),
    writeError: (value) => process.stderr.write(value),
  });
} catch {
  process.stderr.write("Testnet preflight could not load local environment configuration\n");
  exitCode = 1;
}

process.exitCode = exitCode;
