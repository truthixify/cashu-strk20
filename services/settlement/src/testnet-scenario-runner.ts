import { performance } from "node:perf_hooks";

import {
  createTestnetEvidenceCommand,
  createTestnetRunEvidence,
  createTestnetVerifiedRunEvidence,
  reconstructTestnetVerifiedContextEvidence,
  TESTNET_EVIDENCE_STATES,
  TESTNET_RESULT_CODES,
  TESTNET_SCENARIO_EXPECTED_STATES,
  TESTNET_SCENARIOS,
  type TestnetEvidenceState,
  type TestnetPublicTransactionInput,
  type TestnetResultCode,
  type TestnetScenario,
  type TestnetScenarioEvidenceInput,
  type TestnetVerifiedContextEvidence,
  type TestnetVerifiedRunEvidence,
  validateTestnetVerifiedContextForRun,
  validateTestnetVerifiedContextForRunBlock,
} from "./testnet-evidence.js";

export interface TestnetScenarioMetrics {
  readonly retryCount: number;
  readonly provingMilliseconds?: number;
  readonly finalityMilliseconds?: number;
  readonly feeFri?: string;
  readonly publicTransactions?: readonly TestnetPublicTransactionInput[];
}

export interface TestnetObservedScenarioOutcome extends TestnetScenarioMetrics {
  readonly kind: "OBSERVED";
  readonly observedState: TestnetEvidenceState;
}

export interface TestnetFailedScenarioOutcome extends TestnetScenarioMetrics {
  readonly kind: "FAILED";
  readonly observedState: TestnetEvidenceState;
  readonly resultCode: TestnetResultCode;
}

export interface TestnetSkippedScenarioOutcome {
  readonly kind: "SKIPPED";
  readonly resultCode: TestnetResultCode;
}

export type TestnetScenarioOutcome =
  | TestnetFailedScenarioOutcome
  | TestnetObservedScenarioOutcome
  | TestnetSkippedScenarioOutcome;

export interface TestnetScenarioDefinition {
  readonly scenario: TestnetScenario;
  readonly execute: () => Promise<TestnetScenarioOutcome>;
}

export interface TestnetScenarioRunnerConfig {
  readonly verifiedContext: TestnetVerifiedContextEvidence;
  readonly command: readonly string[];
  readonly scenarios: readonly TestnetScenarioDefinition[];
  readonly readAcceptedBlockNumber: () => Promise<unknown>;
  readonly now?: () => Date;
  readonly monotonicNow?: () => number;
}

export type TestnetScenarioRunnerState = "COMPLETED" | "FAILED" | "IDLE" | "RUNNING";
export type TestnetScenarioRunnerErrorCode =
  | "already_run"
  | "block_source_failure"
  | "clock_invalid"
  | "evidence_invalid";

const EVIDENCE_STATES: ReadonlySet<TestnetEvidenceState> = new Set(TESTNET_EVIDENCE_STATES);
const RESULT_CODES: ReadonlySet<TestnetResultCode> = new Set(TESTNET_RESULT_CODES);
const MAXIMUM_PUBLIC_TRANSACTIONS_PER_SCENARIO = 8;
const MAXIMUM_FEE_DECIMAL_LENGTH = 78;
const MAXIMUM_BLOCK_DECIMAL_LENGTH = 20;

export class TestnetScenarioRunnerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestnetScenarioRunnerConfigurationError";
  }
}

export class TestnetScenarioRunnerError extends Error {
  readonly code: TestnetScenarioRunnerErrorCode;

  constructor(code: TestnetScenarioRunnerErrorCode, message: string) {
    super(message);
    this.name = "TestnetScenarioRunnerError";
    this.code = code;
  }
}

export class TestnetScenarioRunner {
  readonly #verifiedContext: TestnetVerifiedContextEvidence;
  readonly #command: readonly string[];
  readonly #scenarios: readonly TestnetScenarioDefinition[];
  readonly #readAcceptedBlockNumber: () => Promise<unknown>;
  readonly #now: () => Date;
  readonly #monotonicNow: () => number;
  #state: TestnetScenarioRunnerState = "IDLE";

  constructor(config: TestnetScenarioRunnerConfig) {
    try {
      if (typeof config !== "object" || config === null) {
        throw new Error("invalid config");
      }
      this.#verifiedContext = reconstructTestnetVerifiedContextEvidence(config.verifiedContext);
      this.#command = createTestnetEvidenceCommand(config.command);
      this.#scenarios = configuredScenarios(config.scenarios);
      if (
        typeof config.readAcceptedBlockNumber !== "function" ||
        (config.now !== undefined && typeof config.now !== "function") ||
        (config.monotonicNow !== undefined && typeof config.monotonicNow !== "function")
      ) {
        throw new Error("invalid callbacks");
      }
      this.#readAcceptedBlockNumber = config.readAcceptedBlockNumber;
      this.#now = config.now ?? (() => new Date());
      this.#monotonicNow = config.monotonicNow ?? (() => performance.now());
    } catch {
      throw new TestnetScenarioRunnerConfigurationError(
        "Configured testnet scenario runner is invalid",
      );
    }
  }

  get state(): TestnetScenarioRunnerState {
    return this.#state;
  }

  async run(): Promise<TestnetVerifiedRunEvidence> {
    if (this.#state !== "IDLE") {
      throw new TestnetScenarioRunnerError(
        "already_run",
        "Testnet scenario runner can execute only once",
      );
    }
    this.#state = "RUNNING";
    try {
      const startedAt = this.#timestamp();
      validateTestnetVerifiedContextForRun({
        verifiedContext: this.#verifiedContext,
        startedAt,
      });
      const firstBlock = await this.#blockNumber();
      validateTestnetVerifiedContextForRunBlock({
        verifiedContext: this.#verifiedContext,
        firstObservedBlock: firstBlock,
      });
      const scenarios: TestnetScenarioEvidenceInput[] = [];
      let stopped = false;
      for (const definition of this.#scenarios) {
        if (stopped) {
          scenarios.push(stoppedScenario(definition));
          continue;
        }
        const result = await this.#executeScenario(definition);
        scenarios.push(result);
        stopped = result.result !== "PASSED";
      }
      const lastBlock = await this.#blockNumber();
      if (lastBlock < firstBlock) {
        throw new TestnetScenarioRunnerError(
          "block_source_failure",
          "Testnet scenario block source returned a reversed range",
        );
      }
      const completedAt = this.#timestamp();
      if (Date.parse(completedAt) < Date.parse(startedAt)) {
        throw clockInvalid();
      }
      const run = createTestnetRunEvidence({
        deployment: this.#verifiedContext.verifiedDeployment.deployment,
        command: this.#command,
        startedAt,
        completedAt,
        observedBlockRange: { first: firstBlock, last: lastBlock },
        scenarios,
      });
      const evidence = createTestnetVerifiedRunEvidence({
        verifiedContext: this.#verifiedContext,
        run,
      });
      this.#state = "COMPLETED";
      return evidence;
    } catch (error) {
      this.#state = "FAILED";
      if (error instanceof TestnetScenarioRunnerError) {
        throw error;
      }
      throw new TestnetScenarioRunnerError(
        "evidence_invalid",
        "Testnet scenario runner could not create valid public evidence",
      );
    }
  }

  async #executeScenario(
    definition: TestnetScenarioDefinition,
  ): Promise<TestnetScenarioEvidenceInput> {
    const startedAt = this.#monotonicTimestamp();
    let result: Omit<TestnetScenarioEvidenceInput, "durationMilliseconds">;
    try {
      result = scenarioResult(definition, await definition.execute());
    } catch {
      result = failedScenario(definition);
    }
    const durationMilliseconds = elapsedMilliseconds(startedAt, this.#monotonicTimestamp());
    return { ...result, durationMilliseconds };
  }

  async #blockNumber(): Promise<bigint> {
    try {
      return acceptedBlockNumber(await this.#readAcceptedBlockNumber());
    } catch {
      throw new TestnetScenarioRunnerError(
        "block_source_failure",
        "Testnet scenario runner could not read an accepted block boundary",
      );
    }
  }

  #timestamp(): string {
    let value: Date;
    try {
      value = this.#now();
    } catch {
      throw clockInvalid();
    }
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw clockInvalid();
    }
    return value.toISOString();
  }

  #monotonicTimestamp(): number {
    let value: number;
    try {
      value = this.#monotonicNow();
    } catch {
      throw clockInvalid();
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw clockInvalid();
    }
    return value;
  }
}

function configuredScenarios(
  value: readonly TestnetScenarioDefinition[],
): readonly TestnetScenarioDefinition[] {
  if (!Array.isArray(value) || value.length !== TESTNET_SCENARIOS.length) {
    throw new Error("invalid scenario definitions");
  }
  return Object.freeze(
    Array.from(value, (definition, index) => {
      if (
        typeof definition !== "object" ||
        definition === null ||
        definition.scenario !== TESTNET_SCENARIOS[index] ||
        typeof definition.execute !== "function"
      ) {
        throw new Error("invalid scenario definition");
      }
      return {
        scenario: definition.scenario,
        execute: definition.execute,
      };
    }),
  );
}

function scenarioResult(
  definition: TestnetScenarioDefinition,
  value: TestnetScenarioOutcome,
): Omit<TestnetScenarioEvidenceInput, "durationMilliseconds"> {
  const expectedState = TESTNET_SCENARIO_EXPECTED_STATES[definition.scenario];
  if (typeof value !== "object" || value === null) {
    throw new Error("invalid scenario outcome");
  }
  if (value.kind === "SKIPPED") {
    return {
      scenario: definition.scenario,
      result: "SKIPPED",
      expectedState,
      observedState: "NOT_RUN",
      retryCount: 0,
      resultCode: resultCode(value.resultCode),
    };
  }
  if (value.kind !== "OBSERVED" && value.kind !== "FAILED") {
    throw new Error("invalid scenario outcome");
  }
  const observedState = evidenceState(value.observedState);
  const metrics = scenarioMetrics(value);
  if (value.kind === "FAILED") {
    return {
      scenario: definition.scenario,
      result: "FAILED",
      expectedState,
      observedState,
      ...metrics,
      resultCode: resultCode(value.resultCode),
    };
  }
  const passed = observedState === expectedState;
  return {
    scenario: definition.scenario,
    result: passed ? "PASSED" : "FAILED",
    expectedState,
    observedState,
    ...metrics,
    ...(passed ? {} : { resultCode: "assertion_failed" as const }),
  };
}

function scenarioMetrics(value: TestnetScenarioMetrics): TestnetScenarioMetrics {
  const retryCount = nonnegativeSafeInteger(value.retryCount);
  const provingMilliseconds = optionalNonnegativeSafeInteger(value.provingMilliseconds);
  const finalityMilliseconds = optionalNonnegativeSafeInteger(value.finalityMilliseconds);
  const feeFri = optionalFee(value.feeFri);
  const publicTransactions = optionalPublicTransactions(value.publicTransactions);
  return {
    retryCount,
    ...(provingMilliseconds === undefined ? {} : { provingMilliseconds }),
    ...(finalityMilliseconds === undefined ? {} : { finalityMilliseconds }),
    ...(feeFri === undefined ? {} : { feeFri }),
    ...(publicTransactions === undefined ? {} : { publicTransactions }),
  };
}

function optionalPublicTransactions(
  value: unknown,
): readonly TestnetPublicTransactionInput[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > MAXIMUM_PUBLIC_TRANSACTIONS_PER_SCENARIO) {
    throw new Error("invalid public transactions");
  }
  return Array.from(value, (transaction) => {
    if (
      typeof transaction !== "object" ||
      transaction === null ||
      typeof transaction.transactionReference !== "string" ||
      typeof transaction.blockHash !== "string" ||
      (typeof transaction.blockNumber !== "bigint" &&
        typeof transaction.blockNumber !== "string") ||
      typeof transaction.disclosureApproved !== "boolean"
    ) {
      throw new Error("invalid public transaction");
    }
    return {
      transactionReference: transaction.transactionReference,
      blockHash: transaction.blockHash,
      blockNumber: transaction.blockNumber,
      disclosureApproved: transaction.disclosureApproved,
    };
  });
}

function optionalFee(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "string" ||
    value.length > MAXIMUM_FEE_DECIMAL_LENGTH ||
    !/^(0|[1-9][0-9]*)$/u.test(value) ||
    BigInt(value) >= 1n << 256n
  ) {
    throw new Error("invalid fee");
  }
  return value;
}

function evidenceState(value: TestnetEvidenceState): TestnetEvidenceState {
  if (!EVIDENCE_STATES.has(value)) {
    throw new Error("invalid evidence state");
  }
  return value;
}

function resultCode(value: TestnetResultCode): TestnetResultCode {
  if (!RESULT_CODES.has(value)) {
    throw new Error("invalid result code");
  }
  return value;
}

function nonnegativeSafeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("invalid integer");
  }
  return value;
}

function optionalNonnegativeSafeInteger(value: number | undefined): number | undefined {
  return value === undefined ? undefined : nonnegativeSafeInteger(value);
}

function elapsedMilliseconds(startedAt: number, completedAt: number): number {
  const elapsed = Math.ceil(completedAt - startedAt);
  if (!Number.isSafeInteger(elapsed) || elapsed < 0) {
    throw clockInvalid();
  }
  return elapsed;
}

function acceptedBlockNumber(value: unknown): bigint {
  if (
    (typeof value !== "bigint" && typeof value !== "string") ||
    (typeof value === "string" &&
      (value.length > MAXIMUM_BLOCK_DECIMAL_LENGTH || !/^(0|[1-9][0-9]*)$/u.test(value)))
  ) {
    throw new Error("invalid block number");
  }
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > (1n << 64n) - 1n) {
    throw new Error("invalid block number");
  }
  return parsed;
}

function failedScenario(
  definition: TestnetScenarioDefinition,
): Omit<TestnetScenarioEvidenceInput, "durationMilliseconds"> {
  return {
    scenario: definition.scenario,
    result: "FAILED",
    expectedState: TESTNET_SCENARIO_EXPECTED_STATES[definition.scenario],
    observedState: "OPERATOR_REQUIRED",
    retryCount: 0,
    resultCode: "assertion_failed",
  };
}

function stoppedScenario(definition: TestnetScenarioDefinition): TestnetScenarioEvidenceInput {
  return {
    scenario: definition.scenario,
    result: "SKIPPED",
    expectedState: TESTNET_SCENARIO_EXPECTED_STATES[definition.scenario],
    observedState: "NOT_RUN",
    durationMilliseconds: 0,
    retryCount: 0,
    resultCode: "operator_stopped",
  };
}

function clockInvalid(): TestnetScenarioRunnerError {
  return new TestnetScenarioRunnerError(
    "clock_invalid",
    "Testnet scenario runner clock returned an invalid time",
  );
}
