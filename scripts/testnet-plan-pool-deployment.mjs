import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

import { runTestnetPoolDeploymentPlanCommand } from "../services/settlement/dist/testnet-pool-deployment-plan-command.js";

let exitCode;
try {
  if (existsSync(".env.pool-deployment")) {
    loadEnvFile(".env.pool-deployment");
  }
  exitCode = runTestnetPoolDeploymentPlanCommand({
    environment: process.env,
    writeOutput: (value) => process.stdout.write(value),
    writeError: (value) => process.stderr.write(value),
  });
} catch {
  process.stderr.write("Testnet pool deployment planning could not load local configuration\n");
  exitCode = 1;
}

process.exitCode = exitCode;
