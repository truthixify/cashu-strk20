import { runIntegrationSepoliaObservationCommand } from "../services/settlement/dist/integration-sepolia-command.js";

let exitCode;
try {
  exitCode = await runIntegrationSepoliaObservationCommand({
    requestTimeoutMilliseconds: 60_000,
    writeOutput: (value) => process.stdout.write(value),
    writeError: (value) => process.stderr.write(value),
  });
} catch {
  process.stderr.write("Integration Sepolia observation could not start\n");
  exitCode = 1;
}

process.exitCode = exitCode;
