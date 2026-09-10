import {
  INCOMING_STATES,
  OUTGOING_STATES,
  type StarknetNetwork,
} from "@cashu-strk20/strk20-method";
import { ec } from "starknet";

import {
  STARKNET_PRIVACY_POOL_CLASS_HASH,
  STARKNET_PRIVACY_POOL_VERSION,
  STARKNET_PRIVACY_SDK_COMMIT,
  STARKNET_PRIVACY_SDK_VERSION,
} from "./privacy-evidence.js";
import {
  STARKNET_DISCOVERY_SERVICE_COMPONENT_VERSION,
  STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION,
  STARKNET_TRANSACTION_PROVER_API_VERSION,
  STARKNET_TRANSACTION_PROVER_COMPONENT_VERSION,
} from "./privacy-service-compatibility.js";
import {
  calculateStarknetUdcDeploymentAddress,
  STARKNET_DEPLOYMENT_ORIGIN_VERIFIER_VERSION,
  STARKNET_UDC_ADDRESS,
  STARKNET_UDC_CLASS_HASH,
  STARKNET_UDC_CONTRACT_DEPLOYED_SELECTOR,
  type StarknetDeploymentOriginVerification,
} from "./starknet-deployment-origin-verifier.js";
import {
  STARKNET_DEPLOYMENT_VERIFIER_VERSION,
  type StarknetDeploymentVerification,
} from "./starknet-deployment-verifier.js";
import { STARKNET_DISCOVERY_HEAD_VERIFIER_VERSION } from "./starknet-discovery-head-verifier.js";
import {
  STARKNET_TRANSACTION_FINALITY_POLICIES,
  type StarknetTransactionFinalityPolicy,
} from "./starknet-transaction-observer.js";
import {
  reconstructTestnetDeploymentManifestVerificationEvidence,
  type TestnetDeploymentManifestVerificationEvidence,
} from "./testnet-deployment-manifest.js";
import type { TestnetPrivacyServiceVerificationEvidence } from "./testnet-service-verifier.js";

export const TESTNET_EVIDENCE_SCHEMA_VERSION = "cashu-strk20-testnet-evidence-v4";
export const TESTNET_VERIFIED_CONTEXT_SCHEMA_VERSION = "cashu-strk20-verified-testnet-context-v3";
export const TESTNET_VERIFIED_RUN_SCHEMA_VERSION = "cashu-strk20-verified-run-evidence-v5";
export const TESTNET_DEPLOYMENT_ORIGIN_EVIDENCE_SCHEMA_VERSION =
  "cashu-strk20-testnet-deployment-origin-evidence-v1";
export const TESTNET_CDK_VERSION = "0.17.6";
export const TESTNET_STARKNET_JS_VERSION = "10.5.0";
export const STARKNET_SEPOLIA_CHAIN_ID = "0x534e5f5345504f4c4941";
export const TESTNET_SCREENING_POLICY = "fail_closed_v1";

export interface TestnetRpcProviderConfig {
  readonly id: string;
  readonly operator: string;
  readonly url: string;
}

export interface TestnetServiceConfig {
  readonly operator: string;
  readonly url: string;
  readonly version: string;
}

export interface TestnetScreeningConfig {
  readonly interceptor: TestnetServiceConfig;
  readonly provider: {
    readonly operator: string;
    readonly url: string;
  };
  readonly rpcProviderId: string;
  readonly poolAddress: string;
  readonly policy: typeof TESTNET_SCREENING_POLICY;
  readonly blockNonPoolTransactions: boolean;
  readonly interceptorFailOpen: boolean;
  readonly proverFailOpen: boolean;
}

export interface TestnetProvingPolicy {
  readonly blocksBehind: number;
  readonly minimumRemainingValidityBlocks: number;
  readonly maximumHeadLagBlocks: number;
  readonly maximumBlockAgeSeconds: number;
  readonly maximumFutureBlockTimeSeconds: number;
  readonly requestTimeoutMilliseconds: number;
}

export interface TestnetContractDeploymentDeclaration {
  readonly transactionReference: string;
  readonly manifestUrl: string;
  readonly manifestSha256: string;
}

export interface TestnetPreflightConfig {
  readonly network: StarknetNetwork;
  readonly chainId: string;
  readonly recordedAt: string;
  readonly pool: {
    readonly address: string;
    readonly classHash: string;
    readonly version: string;
    readonly deployment: TestnetContractDeploymentDeclaration;
  };
  readonly token: {
    readonly address: string;
    readonly classHash: string;
    readonly version: string;
    readonly symbol: string;
    readonly decimals: number;
    readonly deployment: TestnetContractDeploymentDeclaration;
  };
  readonly account: {
    readonly address: string;
    readonly classHash: string;
    readonly version: string;
  };
  readonly rpcProviders: readonly TestnetRpcProviderConfig[];
  readonly prover: TestnetServiceConfig;
  readonly discovery: TestnetServiceConfig;
  readonly screening: TestnetScreeningConfig;
  readonly walletApiVersion: string;
  readonly privacySdkVersion: string;
  readonly privacySdkCommit: string;
  readonly starknetJsVersion: string;
  readonly cdkVersion: string;
  readonly finalityPolicy: StarknetTransactionFinalityPolicy;
  readonly provingPolicy: TestnetProvingPolicy;
  readonly signerPrivateKey: string;
  readonly viewingKey: string;
  readonly screeningCredentials: {
    readonly partnerName: string;
    readonly partnerSecret: string;
  };
  readonly safety: {
    readonly testOnlyAccount: boolean;
    readonly cappedFunds: boolean;
  };
}

export type TestnetDeploymentConfig = Omit<
  TestnetPreflightConfig,
  "screeningCredentials" | "signerPrivateKey" | "viewingKey"
>;

export interface TestnetDeploymentEvidence {
  readonly schemaVersion: typeof TESTNET_EVIDENCE_SCHEMA_VERSION;
  readonly recordedAt: string;
  readonly network: "SN_SEPOLIA";
  readonly chainId: typeof STARKNET_SEPOLIA_CHAIN_ID;
  readonly attributionProfile: "signed_payer";
  readonly pool: {
    readonly address: string;
    readonly classHash: string;
    readonly version: string;
    readonly deployment: TestnetContractDeploymentDeclaration;
  };
  readonly token: {
    readonly address: string;
    readonly classHash: string;
    readonly version: string;
    readonly symbol: "USDC";
    readonly decimals: 6;
    readonly deployment: TestnetContractDeploymentDeclaration;
  };
  readonly account: {
    readonly classHash: string;
    readonly version: string;
  };
  readonly rpcProviders: readonly {
    readonly id: string;
    readonly operator: string;
  }[];
  readonly services: {
    readonly prover: { readonly operator: string; readonly version: string };
    readonly discovery: { readonly operator: string; readonly version: string };
    readonly screening: {
      readonly interceptor: {
        readonly operator: string;
        readonly version: typeof STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION;
      };
      readonly provider: { readonly operator: string };
      readonly rpcProviderId: string;
      readonly configuredPolicy: typeof TESTNET_SCREENING_POLICY;
      readonly configuredPoolMatchesDeployment: true;
      readonly configuredBlockNonPoolTransactions: true;
      readonly configuredInterceptorFailOpen: false;
      readonly configuredProverFailOpen: false;
    };
    readonly walletApiVersion: string;
  };
  readonly components: {
    readonly nodeVersion: string;
    readonly privacySdkVersion: typeof STARKNET_PRIVACY_SDK_VERSION;
    readonly privacySdkCommit: typeof STARKNET_PRIVACY_SDK_COMMIT;
    readonly starknetJsVersion: typeof TESTNET_STARKNET_JS_VERSION;
    readonly cdkVersion: typeof TESTNET_CDK_VERSION;
  };
  readonly finalityPolicy: StarknetTransactionFinalityPolicy;
  readonly provingPolicy: TestnetProvingPolicy;
  readonly safety: {
    readonly testOnlyAccount: true;
    readonly cappedFunds: true;
  };
}

export interface TestnetVerifiedDeploymentEvidence {
  readonly schemaVersion: typeof TESTNET_EVIDENCE_SCHEMA_VERSION;
  readonly deployment: TestnetDeploymentEvidence;
  readonly manifestVerification: TestnetDeploymentManifestVerificationEvidence;
  readonly originVerification: TestnetDeploymentOriginEvidence;
  readonly verification: {
    readonly verifiedAt: string;
    readonly blockHash: string;
    readonly blockNumber: string;
    readonly blockTimestamp: number;
    readonly poolClassHash: string;
    readonly tokenClassHash: string;
    readonly accountClassHash: string;
    readonly providerIds: readonly string[];
    readonly verifierVersion: typeof STARKNET_DEPLOYMENT_VERIFIER_VERSION;
    readonly deploymentOriginVerified: true;
    readonly deploymentApproved: false;
  };
  readonly blockers: readonly [
    "manifest_publishers_unauthenticated",
    "deployment_approval_required",
  ];
}

export interface TestnetDeploymentOriginEvidence {
  readonly schemaVersion: typeof TESTNET_DEPLOYMENT_ORIGIN_EVIDENCE_SCHEMA_VERSION;
  readonly verifierVersion: typeof STARKNET_DEPLOYMENT_ORIGIN_VERIFIER_VERSION;
  readonly network: "SN_SEPOLIA";
  readonly finalityPolicy: StarknetTransactionFinalityPolicy;
  readonly udcAddress: typeof STARKNET_UDC_ADDRESS;
  readonly udcClassHash: typeof STARKNET_UDC_CLASS_HASH;
  readonly deploymentEventSelector: typeof STARKNET_UDC_CONTRACT_DEPLOYED_SELECTOR;
  readonly contracts: readonly [
    TestnetDeploymentOriginContractEvidence & { readonly role: "privacy_pool" },
    TestnetDeploymentOriginContractEvidence & { readonly role: "usdc_token" },
  ];
  readonly providerIds: readonly string[];
  readonly verification: {
    readonly addressesDerived: true;
    readonly successfulReceiptsVerified: true;
    readonly canonicalInclusionsVerified: true;
    readonly udcDeploymentEventsVerified: true;
    readonly classesAtDeploymentBlocksVerified: true;
    readonly udcClassAtDeploymentBlocksVerified: true;
  };
}

interface TestnetDeploymentOriginContractEvidence {
  readonly role: "privacy_pool" | "usdc_token";
  readonly address: string;
  readonly classHash: string;
  readonly transactionReference: string;
  readonly blockHash: string;
  readonly blockNumber: string;
  readonly deployer: string;
  readonly salt: string;
  readonly unique: boolean;
  readonly constructorCalldata: readonly string[];
}

export const TESTNET_SCENARIOS = [
  "incoming_attribution",
  "incoming_restart",
  "incoming_reuse_rejection",
  "payout_success",
  "payout_response_loss",
  "payout_provider_outage",
  "payout_reverted",
  "payout_reorg",
] as const;

export type TestnetScenario = (typeof TESTNET_SCENARIOS)[number];
export type TestnetScenarioResult = "FAILED" | "PASSED" | "SKIPPED";
export const TESTNET_RESULT_CODES = [
  "assertion_failed",
  "credentials_unavailable",
  "dependency_gate_failed",
  "operator_stopped",
  "provider_unavailable",
  "prover_unavailable",
  "scenario_not_supported",
  "transaction_failed",
] as const;
export type TestnetResultCode = (typeof TESTNET_RESULT_CODES)[number];
export type TestnetEvidenceState =
  | (typeof INCOMING_STATES)[number]
  | (typeof OUTGOING_STATES)[number]
  | "CONFLICTED"
  | "FINAL"
  | "NOT_FOUND"
  | "NOT_RUN"
  | "PREPARED"
  | "REORGED"
  | "REVERTED";

export const TESTNET_EVIDENCE_STATES = [
  ...INCOMING_STATES,
  ...OUTGOING_STATES,
  "CONFLICTED",
  "FINAL",
  "NOT_FOUND",
  "NOT_RUN",
  "PREPARED",
  "REORGED",
  "REVERTED",
] as const satisfies readonly TestnetEvidenceState[];

export const TESTNET_SCENARIO_EXPECTED_STATES = {
  incoming_attribution: "PAID",
  incoming_restart: "PAID",
  incoming_reuse_rejection: "OPERATOR_REQUIRED",
  payout_success: "PAID",
  payout_response_loss: "PAID",
  payout_provider_outage: "UNKNOWN",
  payout_reverted: "FAILED",
  payout_reorg: "REORGED",
} as const satisfies Readonly<Record<TestnetScenario, TestnetEvidenceState>>;

export interface TestnetPublicTransactionInput {
  readonly transactionReference: string;
  readonly blockHash: string;
  readonly blockNumber: bigint | string;
  readonly disclosureApproved: boolean;
}

export interface TestnetScenarioEvidenceInput {
  readonly scenario: TestnetScenario;
  readonly result: TestnetScenarioResult;
  readonly expectedState: TestnetEvidenceState;
  readonly observedState: TestnetEvidenceState;
  readonly durationMilliseconds: number;
  readonly provingMilliseconds?: number;
  readonly finalityMilliseconds?: number;
  readonly retryCount: number;
  readonly feeFri?: string;
  readonly resultCode?: TestnetResultCode;
  readonly publicTransactions?: readonly TestnetPublicTransactionInput[];
}

export interface TestnetRunEvidenceInput {
  readonly deployment: TestnetDeploymentEvidence;
  readonly command: readonly string[];
  readonly startedAt: string;
  readonly completedAt: string;
  readonly observedBlockRange: {
    readonly first: bigint | string;
    readonly last: bigint | string;
  };
  readonly scenarios: readonly TestnetScenarioEvidenceInput[];
}

export interface TestnetRunEvidence {
  readonly schemaVersion: typeof TESTNET_EVIDENCE_SCHEMA_VERSION;
  readonly deployment: TestnetDeploymentEvidence;
  readonly run: {
    readonly command: readonly string[];
    readonly startedAt: string;
    readonly completedAt: string;
    readonly observedBlockRange: {
      readonly first: string;
      readonly last: string;
    };
  };
  readonly scenarios: readonly {
    readonly scenario: TestnetScenario;
    readonly result: TestnetScenarioResult;
    readonly expectedState: TestnetEvidenceState;
    readonly observedState: TestnetEvidenceState;
    readonly durationMilliseconds: number;
    readonly provingMilliseconds?: number;
    readonly finalityMilliseconds?: number;
    readonly retryCount: number;
    readonly feeFri?: string;
    readonly resultCode?: TestnetResultCode;
    readonly publicTransactions: readonly {
      readonly transactionReference: string;
      readonly blockHash: string;
      readonly blockNumber: string;
    }[];
  }[];
}

export interface TestnetVerifiedRunEvidenceInput {
  readonly verifiedContext: TestnetVerifiedContextEvidence;
  readonly run: TestnetRunEvidence;
}

export interface TestnetVerifiedContextEvidenceInput {
  readonly verifiedDeployment: TestnetVerifiedDeploymentEvidence;
  readonly serviceVerification: TestnetPrivacyServiceVerificationEvidence;
}

export interface TestnetVerifiedContextEvidence {
  readonly schemaVersion: typeof TESTNET_VERIFIED_CONTEXT_SCHEMA_VERSION;
  readonly verifiedDeployment: TestnetVerifiedDeploymentEvidence;
  readonly serviceVerification: TestnetPrivacyServiceVerificationEvidence;
  readonly verification: {
    readonly publicServiceProfileMatchesDeployment: true;
  };
}

export interface TestnetVerifiedRunEvidence {
  readonly schemaVersion: typeof TESTNET_VERIFIED_RUN_SCHEMA_VERSION;
  readonly verifiedContext: TestnetVerifiedContextEvidence;
  readonly run: TestnetRunEvidence;
  readonly verification: {
    readonly runProfileMatchesVerifiedContext: true;
    readonly deploymentVerifiedBeforeRun: true;
    readonly servicesVerifiedBeforeRun: true;
    readonly deploymentVerificationFreshAtRun: true;
    readonly serviceVerificationFreshAtRun: true;
    readonly deploymentBlockNotAfterRunStart: true;
    readonly discoveryBlockNotAfterRunStart: true;
    readonly executionAttested: false;
    readonly artifactAuthenticated: false;
    readonly fundedExecutionApproved: false;
  };
  readonly scenarioCoverage: {
    readonly required: number;
    readonly present: number;
    readonly passed: number;
    readonly missing: readonly TestnetScenario[];
    readonly notPassed: readonly TestnetScenario[];
  };
}

export type TestnetEvidenceErrorCode =
  | "evidence_not_public"
  | "invalid_input"
  | "unsafe_configuration"
  | "version_mismatch";

export class TestnetEvidenceError extends Error {
  readonly code: TestnetEvidenceErrorCode;

  constructor(code: TestnetEvidenceErrorCode, message: string) {
    super(message);
    this.name = "TestnetEvidenceError";
    this.code = code;
  }
}

export function createTestnetDeploymentEvidence(
  config: TestnetDeploymentConfig,
): TestnetDeploymentEvidence {
  if (typeof config !== "object" || config === null) {
    throw invalidInput("Testnet preflight configuration is invalid");
  }
  if (config.network !== "SN_SEPOLIA") {
    throw unsafeConfiguration("Only Starknet Sepolia is enabled for testnet evidence");
  }
  if (normalizedFelt(config.chainId, "chain ID", STARK_FIELD_PRIME) !== STARKNET_SEPOLIA_CHAIN_ID) {
    throw unsafeConfiguration("Testnet preflight is connected to the wrong Starknet chain");
  }
  assertPinnedVersion(config.privacySdkVersion, STARKNET_PRIVACY_SDK_VERSION, "Privacy SDK");
  assertPinnedVersion(config.privacySdkCommit, STARKNET_PRIVACY_SDK_COMMIT, "Privacy SDK commit");
  assertPinnedVersion(config.starknetJsVersion, TESTNET_STARKNET_JS_VERSION, "Starknet.js");
  assertPinnedVersion(config.cdkVersion, TESTNET_CDK_VERSION, "CDK");
  if (!/^24\.[0-9]+\.[0-9]+$/.test(process.versions.node)) {
    throw versionMismatch("Testnet evidence requires Node.js 24");
  }

  const poolAddress = normalizedAddress(config.pool?.address, "privacy pool address");
  const poolClassHash = normalizedFelt(
    config.pool?.classHash,
    "privacy pool class hash",
    STARK_FIELD_PRIME,
  );
  if (poolClassHash !== STARKNET_PRIVACY_POOL_CLASS_HASH) {
    throw versionMismatch(
      "Testnet privacy pool class does not match the pinned Privacy SDK release",
    );
  }
  const tokenAddress = normalizedAddress(config.token?.address, "token address");
  const tokenClassHash = normalizedFelt(
    config.token?.classHash,
    "token class hash",
    STARK_FIELD_PRIME,
  );
  const accountAddress = normalizedAddress(config.account?.address, "settlement account address");
  if (
    poolAddress === tokenAddress ||
    poolAddress === accountAddress ||
    tokenAddress === accountAddress
  ) {
    throw invalidInput("Testnet contract and account addresses must be distinct");
  }
  if (config.token?.symbol !== "USDC" || config.token.decimals !== 6) {
    throw unsafeConfiguration("Testnet token must be six-decimal USDC");
  }
  const accountClassHash = normalizedFelt(
    config.account?.classHash,
    "settlement account class hash",
    STARK_FIELD_PRIME,
  );
  const poolVersion = configuredVersion(config.pool?.version, "privacy pool version");
  if (poolVersion !== STARKNET_PRIVACY_POOL_VERSION) {
    throw versionMismatch(
      "Testnet privacy pool version does not match the pinned Privacy SDK release",
    );
  }
  const tokenVersion = configuredVersion(config.token?.version, "token contract version");
  const poolDeployment = configuredContractDeployment(
    config.pool?.deployment,
    "privacy pool deployment",
  );
  const tokenDeployment = configuredContractDeployment(
    config.token?.deployment,
    "token deployment",
  );
  const accountVersion = configuredVersion(config.account?.version, "settlement account version");
  const walletApiVersion = configuredVersion(config.walletApiVersion, "Wallet API version");

  const rpcProviders = configuredRpcProviders(config.rpcProviders);
  const prover = configuredService(config.prover, "prover", false);
  const discovery = configuredService(config.discovery, "discovery service", true);
  const screening = configuredScreening(config.screening, poolAddress, rpcProviders);
  const finalityPolicy = configuredFinalityPolicy(config.finalityPolicy);
  const provingPolicy = configuredProvingPolicy(config.provingPolicy);
  if (config.safety?.testOnlyAccount !== true || config.safety.cappedFunds !== true) {
    throw unsafeConfiguration("Testnet safety acknowledgements are incomplete");
  }

  return {
    schemaVersion: TESTNET_EVIDENCE_SCHEMA_VERSION,
    recordedAt: canonicalTimestamp(config.recordedAt, "profile timestamp"),
    network: "SN_SEPOLIA",
    chainId: STARKNET_SEPOLIA_CHAIN_ID,
    attributionProfile: "signed_payer",
    pool: {
      address: poolAddress,
      classHash: poolClassHash,
      version: poolVersion,
      deployment: poolDeployment,
    },
    token: {
      address: tokenAddress,
      classHash: tokenClassHash,
      version: tokenVersion,
      symbol: "USDC",
      decimals: 6,
      deployment: tokenDeployment,
    },
    account: { classHash: accountClassHash, version: accountVersion },
    rpcProviders,
    services: {
      prover: { operator: prover.operator, version: prover.version },
      discovery: { operator: discovery.operator, version: discovery.version },
      screening,
      walletApiVersion,
    },
    components: {
      nodeVersion: process.versions.node,
      privacySdkVersion: STARKNET_PRIVACY_SDK_VERSION,
      privacySdkCommit: STARKNET_PRIVACY_SDK_COMMIT,
      starknetJsVersion: TESTNET_STARKNET_JS_VERSION,
      cdkVersion: TESTNET_CDK_VERSION,
    },
    finalityPolicy,
    provingPolicy,
    safety: { testOnlyAccount: true, cappedFunds: true },
  };
}

export function assertTestnetPreflightSecrets(
  config: Pick<TestnetPreflightConfig, "screeningCredentials" | "signerPrivateKey" | "viewingKey">,
): void {
  if (typeof config !== "object" || config === null) {
    throw invalidInput("Testnet preflight secrets are invalid");
  }
  configuredSecretFelt(config.signerPrivateKey, STARK_CURVE_ORDER, "signer private key");
  configuredSecretFelt(config.viewingKey, MAXIMUM_VIEWING_KEY + 1n, "viewing key");
  configuredScreeningCredentials(config.screeningCredentials);
}

export function createTestnetVerifiedDeploymentEvidence(input: {
  readonly deployment: TestnetDeploymentEvidence;
  readonly manifestVerification: TestnetDeploymentManifestVerificationEvidence;
  readonly originVerification:
    | StarknetDeploymentOriginVerification
    | TestnetDeploymentOriginEvidence;
  readonly verification: StarknetDeploymentVerification;
  readonly verifiedAt: string;
}): TestnetVerifiedDeploymentEvidence {
  if (typeof input !== "object" || input === null) {
    throw invalidInput("Testnet deployment verification is invalid");
  }
  const deployment = validatedDeploymentEvidence(input.deployment);
  const manifestVerification = reconstructTestnetDeploymentManifestVerificationEvidence(
    input.manifestVerification,
    deployment,
  );
  const originVerification = validatedDeploymentOriginEvidence(
    input.originVerification,
    deployment,
    manifestVerification,
  );
  const verification = input.verification;
  if (
    typeof verification !== "object" ||
    verification === null ||
    verification.verifierVersion !== STARKNET_DEPLOYMENT_VERIFIER_VERSION
  ) {
    throw invalidInput("Testnet deployment verification is invalid");
  }
  const providerIds = validatedVerificationProviderIds(
    verification.providerIds,
    deployment.rpcProviders,
  );
  const poolClassHash = normalizedFelt(
    verification.poolClassHash,
    "verified privacy pool class hash",
    STARK_FIELD_PRIME,
  );
  const tokenClassHash = normalizedFelt(
    verification.tokenClassHash,
    "verified token class hash",
    STARK_FIELD_PRIME,
  );
  const accountClassHash = normalizedFelt(
    verification.accountClassHash,
    "verified account class hash",
    STARK_FIELD_PRIME,
  );
  if (
    poolClassHash !== deployment.pool.classHash ||
    tokenClassHash !== deployment.token.classHash ||
    accountClassHash !== deployment.account.classHash
  ) {
    throw invalidInput("Verified contract classes conflict with the testnet deployment pins");
  }
  const verifiedAt = canonicalTimestamp(input.verifiedAt, "deployment verification timestamp");
  if (Date.parse(verifiedAt) < Date.parse(deployment.recordedAt)) {
    throw invalidInput("Testnet deployment verification predates its profile");
  }
  if (
    Date.parse(manifestVerification.verifiedAt) < Date.parse(deployment.recordedAt) ||
    Date.parse(manifestVerification.verifiedAt) > Date.parse(verifiedAt)
  ) {
    throw invalidInput("Testnet deployment manifest verification has invalid chronology");
  }
  const blockTimestamp = evidenceTimestampSeconds(
    verification.blockTimestamp,
    "verified block timestamp",
  );
  const verifiedAtSeconds = Math.floor(Date.parse(verifiedAt) / 1_000);
  if (
    blockTimestamp > verifiedAtSeconds + deployment.provingPolicy.maximumFutureBlockTimeSeconds ||
    blockTimestamp < verifiedAtSeconds - deployment.provingPolicy.maximumBlockAgeSeconds
  ) {
    throw invalidInput("Verified deployment block falls outside the configured freshness policy");
  }
  const blockNumber = evidenceBlockNumber(verification.blockNumber, "verified block number");
  if (
    manifestVerification.contracts.some(
      ({ deployment: contractDeployment }) =>
        BigInt(contractDeployment.acceptedBlockNumber) > blockNumber,
    )
  ) {
    throw invalidInput("Testnet deployment manifest names a block after contract verification");
  }

  return {
    schemaVersion: TESTNET_EVIDENCE_SCHEMA_VERSION,
    deployment,
    manifestVerification,
    originVerification,
    verification: {
      verifiedAt,
      blockHash: normalizedFelt(verification.blockHash, "verified block hash", STARK_FIELD_PRIME),
      blockNumber: blockNumber.toString(),
      blockTimestamp,
      poolClassHash,
      tokenClassHash,
      accountClassHash,
      providerIds,
      verifierVersion: STARKNET_DEPLOYMENT_VERIFIER_VERSION,
      deploymentOriginVerified: true,
      deploymentApproved: false,
    },
    blockers: ["manifest_publishers_unauthenticated", "deployment_approval_required"],
  };
}

function validatedDeploymentOriginEvidence(
  value: unknown,
  deployment: TestnetDeploymentEvidence,
  manifestVerification: TestnetDeploymentManifestVerificationEvidence,
): TestnetDeploymentOriginEvidence {
  if (typeof value !== "object" || value === null) {
    throw invalidInput("Testnet deployment-origin verification is invalid");
  }
  const origin = value as {
    readonly schemaVersion?: unknown;
    readonly verifierVersion?: unknown;
    readonly network?: unknown;
    readonly finalityPolicy?: unknown;
    readonly udcAddress?: unknown;
    readonly udcClassHash?: unknown;
    readonly deploymentEventSelector?: unknown;
    readonly contracts?: unknown;
    readonly providerIds?: unknown;
    readonly verification?: unknown;
  };
  if (
    origin.verifierVersion !== STARKNET_DEPLOYMENT_ORIGIN_VERIFIER_VERSION ||
    origin.network !== "SN_SEPOLIA" ||
    origin.finalityPolicy !== deployment.finalityPolicy ||
    normalizedAddress(origin.udcAddress, "verified UDC address") !== STARKNET_UDC_ADDRESS ||
    normalizedFelt(origin.udcClassHash, "verified UDC class hash", STARK_FIELD_PRIME) !==
      STARKNET_UDC_CLASS_HASH ||
    normalizedFelt(
      origin.deploymentEventSelector,
      "verified UDC event selector",
      STARK_FIELD_PRIME,
    ) !== STARKNET_UDC_CONTRACT_DEPLOYED_SELECTOR ||
    !Array.isArray(origin.contracts) ||
    origin.contracts.length !== 2 ||
    !Object.hasOwn(origin.contracts, 0) ||
    !Object.hasOwn(origin.contracts, 1)
  ) {
    throw invalidInput("Testnet deployment-origin verification is invalid");
  }
  const rawResult = origin.contracts.every(
    (contract) =>
      typeof contract === "object" &&
      contract !== null &&
      typeof (contract as { readonly blockNumber?: unknown }).blockNumber === "bigint",
  );
  if (
    rawResult
      ? origin.schemaVersion !== undefined || origin.verification !== undefined
      : origin.schemaVersion !== TESTNET_DEPLOYMENT_ORIGIN_EVIDENCE_SCHEMA_VERSION ||
        !validDeploymentOriginFlags(origin.verification)
  ) {
    throw invalidInput("Testnet deployment-origin verification has an invalid schema");
  }
  const providerIds = validatedVerificationProviderIds(
    origin.providerIds as readonly string[],
    deployment.rpcProviders,
  );
  const pool = validatedDeploymentOriginContract(
    origin.contracts[0],
    manifestVerification.contracts[0],
    "privacy_pool",
  );
  const token = validatedDeploymentOriginContract(
    origin.contracts[1],
    manifestVerification.contracts[1],
    "usdc_token",
  );
  return {
    schemaVersion: TESTNET_DEPLOYMENT_ORIGIN_EVIDENCE_SCHEMA_VERSION,
    verifierVersion: STARKNET_DEPLOYMENT_ORIGIN_VERIFIER_VERSION,
    network: "SN_SEPOLIA",
    finalityPolicy: deployment.finalityPolicy,
    udcAddress: STARKNET_UDC_ADDRESS,
    udcClassHash: STARKNET_UDC_CLASS_HASH,
    deploymentEventSelector: STARKNET_UDC_CONTRACT_DEPLOYED_SELECTOR,
    contracts: [pool, token],
    providerIds,
    verification: { ...TESTNET_DEPLOYMENT_ORIGIN_VERIFICATION_FLAGS },
  };
}

function validatedDeploymentOriginContract<Role extends "privacy_pool" | "usdc_token">(
  value: unknown,
  expected: TestnetDeploymentManifestVerificationEvidence["contracts"][number],
  expectedRole: Role,
): TestnetDeploymentOriginContractEvidence & { readonly role: Role } {
  if (typeof value !== "object" || value === null) {
    throw invalidInput("Testnet deployment-origin contract is invalid");
  }
  const contract = value as Partial<TestnetDeploymentOriginContractEvidence>;
  const role = contract.role;
  if (role !== "privacy_pool" && role !== "usdc_token") {
    throw invalidInput("Testnet deployment-origin contract role is invalid");
  }
  const address = normalizedAddress(contract.address, "origin contract address");
  const classHash = normalizedFelt(
    contract.classHash,
    "origin contract class hash",
    STARK_FIELD_PRIME,
  );
  const transactionReference = normalizedFelt(
    contract.transactionReference,
    "origin transaction reference",
    STARK_FIELD_PRIME,
  );
  const blockHash = normalizedFelt(contract.blockHash, "origin block hash", STARK_FIELD_PRIME);
  const blockNumber = evidenceBlockNumber(contract.blockNumber, "origin block number").toString();
  const deployer = normalizedAddress(contract.deployer, "origin deployer");
  const salt = normalizedFeltAllowZero(contract.salt, "origin deployment salt");
  if (typeof contract.unique !== "boolean" || !Array.isArray(contract.constructorCalldata)) {
    throw invalidInput("Testnet deployment-origin inputs are invalid");
  }
  const constructorCalldata = Array.from(contract.constructorCalldata, (item, index) => {
    if (!Object.hasOwn(contract.constructorCalldata as readonly unknown[], index)) {
      throw invalidInput("Testnet deployment-origin calldata is sparse");
    }
    return normalizedFeltAllowZero(item, "origin constructor calldata");
  });
  let derivedAddress: string;
  try {
    derivedAddress = calculateStarknetUdcDeploymentAddress({
      role,
      address,
      classHash,
      deployment: {
        transactionReference,
        acceptedBlockHash: blockHash,
        acceptedBlockNumber: blockNumber,
        deployer,
        salt,
        unique: contract.unique,
        constructorCalldata,
      },
    });
  } catch {
    throw invalidInput("Testnet deployment-origin inputs are invalid");
  }
  if (
    constructorCalldata.length > MAXIMUM_DEPLOYMENT_CONSTRUCTOR_CALLDATA ||
    derivedAddress !== address ||
    role !== expectedRole ||
    role !== expected.role ||
    address !== expected.address ||
    classHash !== expected.classHash ||
    transactionReference !== expected.deployment.transactionReference ||
    blockHash !== expected.deployment.acceptedBlockHash ||
    blockNumber !== expected.deployment.acceptedBlockNumber ||
    deployer !== expected.deployment.deployer ||
    salt !== expected.deployment.salt ||
    contract.unique !== expected.deployment.unique ||
    constructorCalldata.length !== expected.deployment.constructorCalldata.length ||
    constructorCalldata.some(
      (item, index) => item !== expected.deployment.constructorCalldata[index],
    )
  ) {
    throw invalidInput("Testnet deployment-origin evidence conflicts with its manifest");
  }
  return {
    role: expectedRole,
    address,
    classHash,
    transactionReference,
    blockHash,
    blockNumber,
    deployer,
    salt,
    unique: contract.unique,
    constructorCalldata,
  };
}

function validDeploymentOriginFlags(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const verification = value as Partial<TestnetDeploymentOriginEvidence["verification"]>;
  return (
    verification.addressesDerived === true &&
    verification.successfulReceiptsVerified === true &&
    verification.canonicalInclusionsVerified === true &&
    verification.udcDeploymentEventsVerified === true &&
    verification.classesAtDeploymentBlocksVerified === true &&
    verification.udcClassAtDeploymentBlocksVerified === true
  );
}

export function createTestnetRunEvidence(input: TestnetRunEvidenceInput): TestnetRunEvidence {
  if (typeof input !== "object" || input === null) {
    throw invalidInput("Testnet run evidence is invalid");
  }
  const deployment = validatedDeploymentEvidence(input.deployment);
  const command = createTestnetEvidenceCommand(input.command);
  const startedAt = canonicalTimestamp(input.startedAt, "run start timestamp");
  const completedAt = canonicalTimestamp(input.completedAt, "run completion timestamp");
  if (deployment.components.nodeVersion !== process.versions.node) {
    throw invalidInput("Testnet run runtime does not match its deployment evidence");
  }
  if (Date.parse(deployment.recordedAt) > Date.parse(startedAt)) {
    throw invalidInput("Testnet deployment evidence was recorded after the run started");
  }
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    throw invalidInput("Testnet run completion precedes its start");
  }
  const firstBlock = evidenceBlockNumber(input.observedBlockRange?.first, "first observed block");
  const lastBlock = evidenceBlockNumber(input.observedBlockRange?.last, "last observed block");
  if (lastBlock < firstBlock) {
    throw invalidInput("Testnet observed block range is reversed");
  }
  const scenarios = configuredScenarios(input.scenarios, firstBlock, lastBlock);

  return {
    schemaVersion: TESTNET_EVIDENCE_SCHEMA_VERSION,
    deployment,
    run: {
      command,
      startedAt,
      completedAt,
      observedBlockRange: { first: firstBlock.toString(), last: lastBlock.toString() },
    },
    scenarios,
  };
}

export function createTestnetVerifiedContextEvidence(
  input: TestnetVerifiedContextEvidenceInput,
): TestnetVerifiedContextEvidence {
  try {
    if (typeof input !== "object" || input === null) {
      throw invalidInput("Verified testnet context evidence is invalid");
    }
    const verifiedDeployment = reconstructTestnetVerifiedDeploymentEvidence(
      input.verifiedDeployment,
    );
    const serviceVerification = reconstructTestnetPrivacyServiceVerificationEvidence(
      input.serviceVerification,
    );
    if (!sameDeploymentPublicProfile(verifiedDeployment.deployment, serviceVerification.profile)) {
      throw invalidInput(
        "Testnet service verification and contract deployment profiles do not match",
      );
    }
    return {
      schemaVersion: TESTNET_VERIFIED_CONTEXT_SCHEMA_VERSION,
      verifiedDeployment,
      serviceVerification,
      verification: { publicServiceProfileMatchesDeployment: true },
    };
  } catch (error) {
    if (error instanceof TestnetEvidenceError) {
      throw error;
    }
    throw invalidInput("Verified testnet context evidence is invalid");
  }
}

export function createTestnetVerifiedRunEvidence(
  input: TestnetVerifiedRunEvidenceInput,
): TestnetVerifiedRunEvidence {
  try {
    if (typeof input !== "object" || input === null) {
      throw invalidInput("Verified testnet run evidence is invalid");
    }
    const run = validatedRunEvidence(input.run);
    const verifiedContext = validateTestnetVerifiedContextForRun({
      verifiedContext: input.verifiedContext,
      startedAt: run.run.startedAt,
    });
    const verifiedDeployment = verifiedContext.verifiedDeployment;
    if (!sameDeploymentEvidence(verifiedDeployment.deployment, run.deployment)) {
      throw invalidInput("Verified testnet context and run profiles do not match");
    }
    validateTestnetVerifiedContextForRunBlock({
      verifiedContext,
      firstObservedBlock: run.run.observedBlockRange.first,
    });
    const resultByScenario = new Map(
      run.scenarios.map((scenario) => [scenario.scenario, scenario.result] as const),
    );
    const missing = TESTNET_SCENARIOS.filter((scenario) => !resultByScenario.has(scenario));
    const notPassed = TESTNET_SCENARIOS.filter((scenario) => {
      const result = resultByScenario.get(scenario);
      return result !== undefined && result !== "PASSED";
    });
    return {
      schemaVersion: TESTNET_VERIFIED_RUN_SCHEMA_VERSION,
      verifiedContext,
      run,
      verification: {
        runProfileMatchesVerifiedContext: true,
        deploymentVerifiedBeforeRun: true,
        servicesVerifiedBeforeRun: true,
        deploymentVerificationFreshAtRun: true,
        serviceVerificationFreshAtRun: true,
        deploymentBlockNotAfterRunStart: true,
        discoveryBlockNotAfterRunStart: true,
        executionAttested: false,
        artifactAuthenticated: false,
        fundedExecutionApproved: false,
      },
      scenarioCoverage: {
        required: TESTNET_SCENARIOS.length,
        present: resultByScenario.size,
        passed: [...resultByScenario.values()].filter((result) => result === "PASSED").length,
        missing,
        notPassed,
      },
    };
  } catch (error) {
    if (error instanceof TestnetEvidenceError) {
      throw error;
    }
    throw invalidInput("Verified testnet run evidence is invalid");
  }
}

export function createTestnetEvidenceCommand(value: readonly string[]): readonly string[] {
  return configuredCommand(value);
}

export function reconstructTestnetVerifiedDeploymentEvidence(
  value: unknown,
): TestnetVerifiedDeploymentEvidence {
  try {
    return validatedVerifiedDeploymentEvidence(value as TestnetVerifiedDeploymentEvidence);
  } catch (error) {
    if (error instanceof TestnetEvidenceError) {
      throw error;
    }
    throw invalidInput("Verified testnet deployment evidence is invalid");
  }
}

export function reconstructTestnetPrivacyServiceVerificationEvidence(
  value: unknown,
): TestnetPrivacyServiceVerificationEvidence {
  try {
    return validatedPrivacyServiceVerificationEvidence(
      value as TestnetPrivacyServiceVerificationEvidence,
    );
  } catch (error) {
    if (error instanceof TestnetEvidenceError) {
      throw error;
    }
    throw invalidInput("Testnet privacy service verification evidence is invalid");
  }
}

export function reconstructTestnetVerifiedContextEvidence(
  value: unknown,
): TestnetVerifiedContextEvidence {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      (value as TestnetVerifiedContextEvidence).schemaVersion !==
        TESTNET_VERIFIED_CONTEXT_SCHEMA_VERSION
    ) {
      throw invalidInput("Verified testnet context evidence is invalid");
    }
    const context = value as TestnetVerifiedContextEvidence;
    return createTestnetVerifiedContextEvidence({
      verifiedDeployment: context.verifiedDeployment,
      serviceVerification: context.serviceVerification,
    });
  } catch (error) {
    if (error instanceof TestnetEvidenceError) {
      throw error;
    }
    throw invalidInput("Verified testnet context evidence is invalid");
  }
}

export function reconstructTestnetVerifiedRunEvidence(value: unknown): TestnetVerifiedRunEvidence {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      (value as TestnetVerifiedRunEvidence).schemaVersion !== TESTNET_VERIFIED_RUN_SCHEMA_VERSION
    ) {
      throw invalidInput("Verified testnet run evidence is invalid");
    }
    const evidence = value as TestnetVerifiedRunEvidence;
    return createTestnetVerifiedRunEvidence({
      verifiedContext: evidence.verifiedContext,
      run: evidence.run,
    });
  } catch (error) {
    if (error instanceof TestnetEvidenceError) {
      throw error;
    }
    throw invalidInput("Verified testnet run evidence is invalid");
  }
}

export function serializeTestnetVerifiedRunEvidence(value: unknown): string {
  return `${JSON.stringify(reconstructTestnetVerifiedRunEvidence(value), null, 2)}\n`;
}

export function validateTestnetVerifiedContextForRun(input: {
  readonly verifiedContext: TestnetVerifiedContextEvidence;
  readonly startedAt: string;
}): TestnetVerifiedContextEvidence {
  try {
    if (typeof input !== "object" || input === null) {
      throw invalidInput("Verified testnet run context is invalid");
    }
    const verifiedContext = reconstructTestnetVerifiedContextEvidence(input.verifiedContext);
    const startedAt = canonicalTimestamp(input.startedAt, "run start timestamp");
    const startedAtMilliseconds = Date.parse(startedAt);
    const deploymentVerifiedAtMilliseconds = Date.parse(
      verifiedContext.verifiedDeployment.verification.verifiedAt,
    );
    const servicesVerifiedAtMilliseconds = Date.parse(
      verifiedContext.serviceVerification.verifiedAt,
    );
    if (deploymentVerifiedAtMilliseconds > startedAtMilliseconds) {
      throw invalidInput("Testnet deployment was verified after the run started");
    }
    if (servicesVerifiedAtMilliseconds > startedAtMilliseconds) {
      throw invalidInput("Testnet privacy services were verified after the run started");
    }
    const maximumAgeSeconds =
      verifiedContext.verifiedDeployment.deployment.provingPolicy.maximumBlockAgeSeconds;
    if ((startedAtMilliseconds - deploymentVerifiedAtMilliseconds) / 1_000 > maximumAgeSeconds) {
      throw invalidInput("Testnet deployment verification is stale at run start");
    }
    if ((startedAtMilliseconds - servicesVerifiedAtMilliseconds) / 1_000 > maximumAgeSeconds) {
      throw invalidInput("Testnet privacy service verification is stale at run start");
    }
    return verifiedContext;
  } catch (error) {
    if (error instanceof TestnetEvidenceError) {
      throw error;
    }
    throw invalidInput("Verified testnet run context is invalid");
  }
}

export function validateTestnetVerifiedContextForRunBlock(input: {
  readonly verifiedContext: TestnetVerifiedContextEvidence;
  readonly firstObservedBlock: bigint | string;
}): TestnetVerifiedContextEvidence {
  try {
    if (typeof input !== "object" || input === null) {
      throw invalidInput("Verified testnet run block context is invalid");
    }
    const verifiedContext = reconstructTestnetVerifiedContextEvidence(input.verifiedContext);
    const firstObservedBlock = evidenceBlockNumber(
      input.firstObservedBlock,
      "first observed run block",
    );
    if (BigInt(verifiedContext.verifiedDeployment.verification.blockNumber) > firstObservedBlock) {
      throw invalidInput("Verified deployment block is after the testnet run start");
    }
    if (
      BigInt(verifiedContext.serviceVerification.chainVerification.blockNumber) > firstObservedBlock
    ) {
      throw invalidInput("Verified discovery block is after the testnet run start");
    }
    return verifiedContext;
  } catch (error) {
    if (error instanceof TestnetEvidenceError) {
      throw error;
    }
    throw invalidInput("Verified testnet run block context is invalid");
  }
}

function configuredRpcProviders(
  value: readonly TestnetRpcProviderConfig[],
): TestnetDeploymentEvidence["rpcProviders"] {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAXIMUM_PROVIDER_COUNT) {
    throw unsafeConfiguration(
      "Testnet preflight requires two to sixteen independent RPC providers",
    );
  }
  const ids = new Set<string>();
  const operators = new Set<string>();
  const endpointOrigins = new Set<string>();
  return Array.from(value, (provider) => {
    if (typeof provider !== "object" || provider === null) {
      throw invalidInput("Testnet RPC provider configuration is invalid");
    }
    const id = configuredIdentifier(provider.id, "RPC provider ID");
    const operator = configuredIdentifier(provider.operator, "RPC provider operator");
    const endpoint = configuredEndpoint(provider.url, "RPC provider");
    const endpointOrigin = new URL(endpoint).origin;
    if (ids.has(id) || operators.has(operator) || endpointOrigins.has(endpointOrigin)) {
      throw unsafeConfiguration(
        "Testnet RPC providers must have independent identities and endpoints",
      );
    }
    ids.add(id);
    operators.add(operator);
    endpointOrigins.add(endpointOrigin);
    return { id, operator };
  });
}

function configuredService(
  value: TestnetServiceConfig,
  label: string,
  requiresBaseEndpoint: boolean,
): { readonly operator: string; readonly version: string } {
  if (typeof value !== "object" || value === null) {
    throw invalidInput(`Testnet ${label} configuration is invalid`);
  }
  if (requiresBaseEndpoint) {
    configuredBaseEndpoint(value.url, label);
  } else {
    configuredEndpoint(value.url, label);
  }
  return {
    operator: configuredIdentifier(value.operator, `${label} operator`),
    version: configuredVersion(value.version, `${label} version`),
  };
}

function configuredContractDeployment(
  value: TestnetContractDeploymentDeclaration | undefined,
  label: string,
): TestnetContractDeploymentDeclaration {
  if (typeof value !== "object" || value === null) {
    throw invalidInput(`Testnet ${label} declaration is invalid`);
  }
  return {
    transactionReference: normalizedFelt(
      value.transactionReference,
      `${label} transaction reference`,
      STARK_FIELD_PRIME,
    ),
    manifestUrl: configuredPublicManifestUrl(value.manifestUrl, label),
    manifestSha256: configuredManifestSha256(value.manifestSha256, label),
  };
}

function configuredPublicManifestUrl(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAXIMUM_ENDPOINT_LENGTH ||
    value !== value.trim()
  ) {
    throw evidenceNotPublic(`Testnet ${label} manifest URL is not safe to publish`);
  }
  let manifest: URL;
  try {
    manifest = new URL(value);
  } catch {
    throw evidenceNotPublic(`Testnet ${label} manifest URL is not safe to publish`);
  }
  if (
    manifest.protocol !== "https:" ||
    manifest.username !== "" ||
    manifest.password !== "" ||
    manifest.search !== "" ||
    manifest.hash !== "" ||
    LOOPBACK_HOSTS.has(manifest.hostname) ||
    manifest.hostname.endsWith(".localhost")
  ) {
    throw evidenceNotPublic(`Testnet ${label} manifest URL is not safe to publish`);
  }
  return manifest.href;
}

function configuredManifestSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw invalidInput(`Testnet ${label} manifest SHA-256 is invalid`);
  }
  return value;
}

function configuredScreening(
  value: TestnetScreeningConfig,
  poolAddress: string,
  rpcProviders: TestnetDeploymentEvidence["rpcProviders"],
): TestnetDeploymentEvidence["services"]["screening"] {
  if (typeof value !== "object" || value === null) {
    throw unsafeConfiguration("Testnet screening configuration is invalid");
  }
  const interceptor = configuredService(value.interceptor, "proof interceptor", true);
  assertPinnedVersion(
    interceptor.version,
    STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION,
    "proof interceptor",
  );
  if (typeof value.provider !== "object" || value.provider === null) {
    throw unsafeConfiguration("Testnet screening provider configuration is invalid");
  }
  const screeningProvider = {
    operator: configuredIdentifier(value.provider.operator, "screening provider operator"),
  };
  configuredBaseEndpoint(value.provider.url, "screening provider");
  const rpcProviderId = configuredIdentifier(value.rpcProviderId, "screening RPC provider ID");
  if (!rpcProviders.some(({ id }) => id === rpcProviderId)) {
    throw unsafeConfiguration("Testnet screening RPC must use a configured provider");
  }
  if (normalizedAddress(value.poolAddress, "screening pool address") !== poolAddress) {
    throw unsafeConfiguration("Testnet screening pool does not match the deployment");
  }
  if (
    value.policy !== TESTNET_SCREENING_POLICY ||
    value.blockNonPoolTransactions !== true ||
    value.interceptorFailOpen !== false ||
    value.proverFailOpen !== false
  ) {
    throw unsafeConfiguration("Testnet screening policy is not fail closed");
  }
  return {
    interceptor: {
      operator: interceptor.operator,
      version: STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION,
    },
    provider: screeningProvider,
    rpcProviderId,
    configuredPolicy: TESTNET_SCREENING_POLICY,
    configuredPoolMatchesDeployment: true,
    configuredBlockNonPoolTransactions: true,
    configuredInterceptorFailOpen: false,
    configuredProverFailOpen: false,
  };
}

function configuredEndpoint(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAXIMUM_ENDPOINT_LENGTH) {
    throw unsafeConfiguration(`Testnet ${label} endpoint is invalid`);
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw unsafeConfiguration(`Testnet ${label} endpoint is invalid`);
  }
  if (
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.hash !== "" ||
    (endpoint.protocol !== "https:" &&
      !(endpoint.protocol === "http:" && LOOPBACK_HOSTS.has(endpoint.hostname)))
  ) {
    throw unsafeConfiguration(`Testnet ${label} endpoint violates the transport policy`);
  }
  return endpoint.href;
}

function configuredBaseEndpoint(value: unknown, label: string): string {
  configuredEndpoint(value, label);
  const endpoint = new URL(value as string);
  if (
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    (value as string).includes("?") ||
    (value as string).includes("#") ||
    (value as string).endsWith("/")
  ) {
    throw unsafeConfiguration(`Testnet ${label} base endpoint is incompatible`);
  }
  return value as string;
}

function configuredFinalityPolicy(value: unknown): StarknetTransactionFinalityPolicy {
  if (
    value !== STARKNET_TRANSACTION_FINALITY_POLICIES.L1 &&
    value !== STARKNET_TRANSACTION_FINALITY_POLICIES.L2
  ) {
    throw unsafeConfiguration("Testnet finality policy is invalid");
  }
  return value;
}

function configuredProvingPolicy(value: TestnetProvingPolicy): TestnetProvingPolicy {
  if (typeof value !== "object" || value === null) {
    throw invalidInput("Testnet proving policy is invalid");
  }
  return {
    blocksBehind: configuredPositiveInteger(value.blocksBehind, "proving blocks behind"),
    minimumRemainingValidityBlocks: configuredPositiveInteger(
      value.minimumRemainingValidityBlocks,
      "remaining proof validity",
    ),
    maximumHeadLagBlocks: configuredNonnegativeInteger(
      value.maximumHeadLagBlocks,
      "provider head lag",
    ),
    maximumBlockAgeSeconds: configuredPositiveInteger(
      value.maximumBlockAgeSeconds,
      "proving block age",
    ),
    maximumFutureBlockTimeSeconds: configuredNonnegativeInteger(
      value.maximumFutureBlockTimeSeconds,
      "future block time",
    ),
    requestTimeoutMilliseconds: configuredPositiveInteger(
      value.requestTimeoutMilliseconds,
      "RPC request timeout",
    ),
  };
}

function configuredScenarios(
  value: readonly TestnetScenarioEvidenceInput[],
  firstBlock: bigint,
  lastBlock: bigint,
): TestnetRunEvidence["scenarios"] {
  if (!Array.isArray(value) || value.length === 0 || value.length > TESTNET_SCENARIOS.length) {
    throw invalidInput("Testnet scenario evidence has an invalid size");
  }
  const seen = new Set<TestnetScenario>();
  return Array.from(value, (scenario) => {
    if (typeof scenario !== "object" || scenario === null || !SCENARIO_SET.has(scenario.scenario)) {
      throw invalidInput("Testnet scenario identifier is invalid");
    }
    const scenarioName = scenario.scenario as TestnetScenario;
    if (seen.has(scenarioName)) {
      throw invalidInput("Testnet scenario evidence contains a duplicate scenario");
    }
    seen.add(scenarioName);
    if (!SCENARIO_RESULTS.has(scenario.result)) {
      throw invalidInput("Testnet scenario result is invalid");
    }
    const expectedState = evidenceState(scenario.expectedState, "expected scenario state");
    if (expectedState !== TESTNET_SCENARIO_EXPECTED_STATES[scenarioName]) {
      throw invalidInput("Testnet scenario expected state does not match its canonical criterion");
    }
    const observedState = evidenceState(scenario.observedState, "observed scenario state");
    if (scenario.result === "PASSED" && expectedState !== observedState) {
      throw invalidInput("A passed testnet scenario must match its expected state");
    }
    if (scenario.result === "SKIPPED" && observedState !== "NOT_RUN") {
      throw invalidInput("A skipped testnet scenario must remain not run");
    }
    const resultCode = configuredResultCode(scenario.resultCode, scenario.result);
    const publicTransactions = configuredPublicTransactions(
      scenario.publicTransactions,
      firstBlock,
      lastBlock,
    );
    return {
      scenario: scenarioName,
      result: scenario.result,
      expectedState,
      observedState,
      durationMilliseconds: configuredNonnegativeInteger(
        scenario.durationMilliseconds,
        "scenario duration",
      ),
      ...(scenario.provingMilliseconds === undefined
        ? {}
        : {
            provingMilliseconds: configuredNonnegativeInteger(
              scenario.provingMilliseconds,
              "scenario proving duration",
            ),
          }),
      ...(scenario.finalityMilliseconds === undefined
        ? {}
        : {
            finalityMilliseconds: configuredNonnegativeInteger(
              scenario.finalityMilliseconds,
              "scenario finality duration",
            ),
          }),
      retryCount: configuredNonnegativeInteger(scenario.retryCount, "scenario retry count"),
      ...(scenario.feeFri === undefined
        ? {}
        : { feeFri: evidenceUnsignedDecimal(scenario.feeFri, "scenario fee") }),
      ...(resultCode === undefined ? {} : { resultCode }),
      publicTransactions,
    };
  });
}

function configuredPublicTransactions(
  value: readonly TestnetPublicTransactionInput[] | undefined,
  firstBlock: bigint,
  lastBlock: bigint,
): TestnetRunEvidence["scenarios"][number]["publicTransactions"] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAXIMUM_PUBLIC_TRANSACTIONS_PER_SCENARIO) {
    throw invalidInput("Public transaction evidence has an invalid size");
  }
  const transactionReferences = new Set<string>();
  const publicTransactions: {
    transactionReference: string;
    blockHash: string;
    blockNumber: string;
  }[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null) {
      throw invalidInput("Public transaction evidence is invalid");
    }
    if (candidate.disclosureApproved !== true) {
      continue;
    }
    const transactionReference = normalizedFelt(
      candidate.transactionReference,
      "public transaction reference",
      STARK_FIELD_PRIME,
    );
    const blockHash = normalizedFelt(candidate.blockHash, "public block hash", STARK_FIELD_PRIME);
    const blockNumber = evidenceBlockNumber(candidate.blockNumber, "public transaction block");
    if (
      transactionReferences.has(transactionReference) ||
      blockNumber < firstBlock ||
      blockNumber > lastBlock
    ) {
      throw invalidInput("Public transaction evidence conflicts with the testnet run");
    }
    transactionReferences.add(transactionReference);
    publicTransactions.push({
      transactionReference,
      blockHash,
      blockNumber: blockNumber.toString(),
    });
  }
  return publicTransactions;
}

function validatedVerifiedDeploymentEvidence(
  value: TestnetVerifiedDeploymentEvidence,
): TestnetVerifiedDeploymentEvidence {
  if (
    typeof value !== "object" ||
    value === null ||
    value.schemaVersion !== TESTNET_EVIDENCE_SCHEMA_VERSION ||
    typeof value.verification !== "object" ||
    value.verification === null ||
    value.verification.deploymentOriginVerified !== true ||
    value.verification.deploymentApproved !== false ||
    !Array.isArray(value.blockers) ||
    value.blockers.length !== 2 ||
    value.blockers[0] !== "manifest_publishers_unauthenticated" ||
    value.blockers[1] !== "deployment_approval_required"
  ) {
    throw invalidInput("Verified testnet deployment evidence is invalid");
  }
  return createTestnetVerifiedDeploymentEvidence({
    deployment: value.deployment,
    manifestVerification: value.manifestVerification,
    originVerification: value.originVerification,
    verification: {
      blockHash: value.verification.blockHash,
      blockNumber: evidenceBlockNumber(
        value.verification.blockNumber,
        "verified deployment block number",
      ),
      blockTimestamp: value.verification.blockTimestamp,
      poolClassHash: value.verification.poolClassHash,
      tokenClassHash: value.verification.tokenClassHash,
      accountClassHash: value.verification.accountClassHash,
      providerIds: value.verification.providerIds,
      verifierVersion: value.verification.verifierVersion,
    },
    verifiedAt: value.verification.verifiedAt,
  });
}

function validatedPrivacyServiceVerificationEvidence(
  value: TestnetPrivacyServiceVerificationEvidence,
): TestnetPrivacyServiceVerificationEvidence {
  if (
    typeof value !== "object" ||
    value === null ||
    value.schemaVersion !== TESTNET_PRIVACY_SERVICE_VERIFICATION_SCHEMA_VERSION ||
    value.verifierVersion !== TESTNET_PRIVACY_SERVICE_VERIFIER_VERSION ||
    value.network !== "SN_SEPOLIA"
  ) {
    throw invalidInput("Testnet privacy service verification evidence is invalid");
  }
  const profile = validatedDeploymentEvidence(value.profile);
  const verifiedAt = canonicalTimestamp(value.verifiedAt, "service verification timestamp");
  if (Date.parse(verifiedAt) < Date.parse(profile.recordedAt)) {
    throw invalidInput("Testnet privacy service verification predates its profile");
  }
  if (
    profile.services.prover.version !== STARKNET_TRANSACTION_PROVER_COMPONENT_VERSION ||
    profile.services.discovery.version !== STARKNET_DISCOVERY_SERVICE_COMPONENT_VERSION ||
    profile.services.screening.interceptor.version !== STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION
  ) {
    throw invalidInput("Testnet privacy service verification has incompatible component pins");
  }

  const services = value.services;
  if (typeof services !== "object" || services === null) {
    throw invalidInput("Testnet privacy service verification has invalid services");
  }
  const prover = services.prover;
  if (
    typeof prover !== "object" ||
    prover === null ||
    configuredIdentifier(prover.operator, "verified prover operator") !==
      profile.services.prover.operator ||
    prover.configuredComponentVersion !== STARKNET_TRANSACTION_PROVER_COMPONENT_VERSION ||
    prover.apiVersion !== STARKNET_TRANSACTION_PROVER_API_VERSION
  ) {
    throw invalidInput("Testnet prover verification evidence is invalid");
  }

  const discovery = services.discovery;
  if (
    typeof discovery !== "object" ||
    discovery === null ||
    configuredIdentifier(discovery.operator, "verified discovery operator") !==
      profile.services.discovery.operator ||
    discovery.configuredComponentVersion !== STARKNET_DISCOVERY_SERVICE_COMPONENT_VERSION ||
    discovery.status !== "OK" ||
    typeof discovery.indexedHead !== "object" ||
    discovery.indexedHead === null
  ) {
    throw invalidInput("Testnet discovery verification evidence is invalid");
  }
  const indexedHead = {
    blockNumber: configuredNonnegativeInteger(
      discovery.indexedHead.blockNumber,
      "verified discovery block number",
    ),
    blockHash: normalizedFelt(
      discovery.indexedHead.blockHash,
      "verified discovery block hash",
      STARK_FIELD_PRIME,
    ),
    blockTimestamp: evidenceTimestampSeconds(
      discovery.indexedHead.blockTimestamp,
      "verified discovery block timestamp",
    ),
    reportedLagSeconds: configuredNonnegativeInteger(
      discovery.indexedHead.reportedLagSeconds,
      "verified discovery reported lag",
    ),
  };
  const verifiedAtSeconds = Math.floor(Date.parse(verifiedAt) / 1_000);
  if (
    indexedHead.blockTimestamp < verifiedAtSeconds - profile.provingPolicy.maximumBlockAgeSeconds ||
    indexedHead.blockTimestamp >
      verifiedAtSeconds + profile.provingPolicy.maximumFutureBlockTimeSeconds ||
    indexedHead.reportedLagSeconds > profile.provingPolicy.maximumBlockAgeSeconds
  ) {
    throw invalidInput("Testnet discovery verification evidence is stale");
  }

  const screening = services.screening;
  if (
    typeof screening !== "object" ||
    screening === null ||
    configuredIdentifier(screening.interceptorOperator, "verified interceptor operator") !==
      profile.services.screening.interceptor.operator ||
    configuredIdentifier(
      screening.screeningProviderOperator,
      "verified screening provider operator",
    ) !== profile.services.screening.provider.operator ||
    screening.configuredComponentVersion !== STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION ||
    screening.healthStatus !== "ok" ||
    screening.rpcProviderId !== profile.services.screening.rpcProviderId
  ) {
    throw invalidInput("Testnet screening verification evidence is invalid");
  }

  const chain = value.chainVerification;
  if (
    typeof chain !== "object" ||
    chain === null ||
    chain.verifierVersion !== STARKNET_DISCOVERY_HEAD_VERIFIER_VERSION ||
    (chain.minimumAcceptedStatus !== "ACCEPTED_ON_L1" &&
      chain.minimumAcceptedStatus !== "ACCEPTED_ON_L2")
  ) {
    throw invalidInput("Testnet discovery chain verification evidence is invalid");
  }
  const chainBlockNumber = configuredNonnegativeInteger(
    chain.blockNumber,
    "verified discovery chain block number",
  );
  const chainBlockHash = normalizedFelt(
    chain.blockHash,
    "verified discovery chain block hash",
    STARK_FIELD_PRIME,
  );
  const chainBlockTimestamp = evidenceTimestampSeconds(
    chain.blockTimestamp,
    "verified discovery chain block timestamp",
  );
  if (
    chainBlockNumber !== indexedHead.blockNumber ||
    chainBlockHash !== indexedHead.blockHash ||
    chainBlockTimestamp !== indexedHead.blockTimestamp
  ) {
    throw invalidInput("Testnet discovery and chain verification evidence do not match");
  }
  const providerIds = validatedVerificationProviderIds(chain.providerIds, profile.rpcProviders);
  const verification = validatedPrivacyServiceVerificationFlags(value.verification);
  const blockers = validatedPrivacyServiceVerificationBlockers(value.blockers);

  return {
    schemaVersion: TESTNET_PRIVACY_SERVICE_VERIFICATION_SCHEMA_VERSION,
    verifierVersion: TESTNET_PRIVACY_SERVICE_VERIFIER_VERSION,
    verifiedAt,
    network: "SN_SEPOLIA",
    profile,
    services: {
      prover: {
        operator: profile.services.prover.operator,
        configuredComponentVersion: STARKNET_TRANSACTION_PROVER_COMPONENT_VERSION,
        apiVersion: STARKNET_TRANSACTION_PROVER_API_VERSION,
      },
      discovery: {
        operator: profile.services.discovery.operator,
        configuredComponentVersion: STARKNET_DISCOVERY_SERVICE_COMPONENT_VERSION,
        status: "OK",
        indexedHead,
      },
      screening: {
        interceptorOperator: profile.services.screening.interceptor.operator,
        screeningProviderOperator: profile.services.screening.provider.operator,
        configuredComponentVersion: STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION,
        healthStatus: "ok",
        rpcProviderId: profile.services.screening.rpcProviderId,
      },
    },
    chainVerification: {
      blockNumber: chainBlockNumber,
      blockHash: chainBlockHash,
      blockTimestamp: chainBlockTimestamp,
      minimumAcceptedStatus: chain.minimumAcceptedStatus,
      providerIds,
      verifierVersion: STARKNET_DISCOVERY_HEAD_VERIFIER_VERSION,
    },
    verification,
    blockers,
  };
}

function validatedPrivacyServiceVerificationFlags(
  value: TestnetPrivacyServiceVerificationEvidence["verification"],
): TestnetPrivacyServiceVerificationEvidence["verification"] {
  if (typeof value !== "object" || value === null) {
    throw invalidInput("Testnet privacy service verification flags are invalid");
  }
  for (const key of Object.keys(TESTNET_PRIVACY_SERVICE_VERIFICATION_FLAGS) as Array<
    keyof typeof TESTNET_PRIVACY_SERVICE_VERIFICATION_FLAGS
  >) {
    if (value[key] !== TESTNET_PRIVACY_SERVICE_VERIFICATION_FLAGS[key]) {
      throw invalidInput("Testnet privacy service verification flags are invalid");
    }
  }
  return { ...TESTNET_PRIVACY_SERVICE_VERIFICATION_FLAGS };
}

function validatedPrivacyServiceVerificationBlockers(
  value: TestnetPrivacyServiceVerificationEvidence["blockers"],
): TestnetPrivacyServiceVerificationEvidence["blockers"] {
  if (
    !Array.isArray(value) ||
    value.length !== TESTNET_PRIVACY_SERVICE_VERIFICATION_BLOCKERS.length ||
    !TESTNET_PRIVACY_SERVICE_VERIFICATION_BLOCKERS.every(
      (blocker, index) => value[index] === blocker,
    )
  ) {
    throw invalidInput("Testnet privacy service verification blockers are invalid");
  }
  return TESTNET_PRIVACY_SERVICE_VERIFICATION_BLOCKERS;
}

function validatedRunEvidence(value: TestnetRunEvidence): TestnetRunEvidence {
  if (
    typeof value !== "object" ||
    value === null ||
    value.schemaVersion !== TESTNET_EVIDENCE_SCHEMA_VERSION ||
    typeof value.run !== "object" ||
    value.run === null ||
    !Array.isArray(value.scenarios)
  ) {
    throw invalidInput("Testnet run evidence is invalid");
  }
  const scenarios: TestnetScenarioEvidenceInput[] = Array.from(value.scenarios, (scenario) => ({
    scenario: scenario.scenario,
    result: scenario.result,
    expectedState: scenario.expectedState,
    observedState: scenario.observedState,
    durationMilliseconds: scenario.durationMilliseconds,
    ...(scenario.provingMilliseconds === undefined
      ? {}
      : { provingMilliseconds: scenario.provingMilliseconds }),
    ...(scenario.finalityMilliseconds === undefined
      ? {}
      : { finalityMilliseconds: scenario.finalityMilliseconds }),
    retryCount: scenario.retryCount,
    ...(scenario.feeFri === undefined ? {} : { feeFri: scenario.feeFri }),
    ...(scenario.resultCode === undefined ? {} : { resultCode: scenario.resultCode }),
    publicTransactions: Array.from(
      scenario.publicTransactions,
      (transaction: TestnetRunEvidence["scenarios"][number]["publicTransactions"][number]) => ({
        transactionReference: transaction.transactionReference,
        blockHash: transaction.blockHash,
        blockNumber: transaction.blockNumber,
        disclosureApproved: true,
      }),
    ),
  }));
  return createTestnetRunEvidence({
    deployment: value.deployment,
    command: value.run.command,
    startedAt: value.run.startedAt,
    completedAt: value.run.completedAt,
    observedBlockRange: value.run.observedBlockRange,
    scenarios,
  });
}

function sameDeploymentEvidence(
  left: TestnetDeploymentEvidence,
  right: TestnetDeploymentEvidence,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameDeploymentPublicProfile(
  left: TestnetDeploymentEvidence,
  right: TestnetDeploymentEvidence,
): boolean {
  return (
    JSON.stringify({ ...left, recordedAt: undefined }) ===
    JSON.stringify({ ...right, recordedAt: undefined })
  );
}

function validatedDeploymentEvidence(value: TestnetDeploymentEvidence): TestnetDeploymentEvidence {
  if (
    typeof value !== "object" ||
    value === null ||
    value.schemaVersion !== TESTNET_EVIDENCE_SCHEMA_VERSION ||
    value.network !== "SN_SEPOLIA" ||
    value.chainId !== STARKNET_SEPOLIA_CHAIN_ID ||
    value.attributionProfile !== "signed_payer" ||
    value.components?.privacySdkVersion !== STARKNET_PRIVACY_SDK_VERSION ||
    value.components.privacySdkCommit !== STARKNET_PRIVACY_SDK_COMMIT ||
    value.components.starknetJsVersion !== TESTNET_STARKNET_JS_VERSION ||
    value.components.cdkVersion !== TESTNET_CDK_VERSION ||
    value.safety?.testOnlyAccount !== true ||
    value.safety.cappedFunds !== true ||
    value.token?.symbol !== "USDC" ||
    value.token.decimals !== 6
  ) {
    throw invalidInput("Testnet deployment evidence is invalid");
  }
  const nodeVersion = configuredVersion(value.components.nodeVersion, "evidence Node.js version");
  if (!/^24\.[0-9]+\.[0-9]+$/.test(nodeVersion)) {
    throw invalidInput("Testnet deployment evidence has an invalid Node.js version");
  }
  const poolAddress = normalizedAddress(value.pool?.address, "evidence privacy pool address");
  const poolClassHash = normalizedFelt(
    value.pool?.classHash,
    "evidence privacy pool class hash",
    STARK_FIELD_PRIME,
  );
  const tokenAddress = normalizedAddress(value.token.address, "evidence token address");
  const tokenClassHash = normalizedFelt(
    value.token.classHash,
    "evidence token class hash",
    STARK_FIELD_PRIME,
  );
  if (poolAddress === tokenAddress) {
    throw invalidInput("Testnet deployment evidence has conflicting contract addresses");
  }
  const rpcProviders = validatedEvidenceProviders(value.rpcProviders);
  const poolDeployment = configuredContractDeployment(
    value.pool.deployment,
    "evidence privacy pool deployment",
  );
  const tokenDeployment = configuredContractDeployment(
    value.token.deployment,
    "evidence token deployment",
  );
  const finalityPolicy = configuredFinalityPolicy(value.finalityPolicy);
  const provingPolicy = configuredProvingPolicy(value.provingPolicy);
  return {
    schemaVersion: TESTNET_EVIDENCE_SCHEMA_VERSION,
    recordedAt: canonicalTimestamp(value.recordedAt, "deployment evidence timestamp"),
    network: "SN_SEPOLIA",
    chainId: STARKNET_SEPOLIA_CHAIN_ID,
    attributionProfile: "signed_payer",
    pool: {
      address: poolAddress,
      classHash: poolClassHash,
      version: configuredVersion(value.pool.version, "evidence privacy pool version"),
      deployment: poolDeployment,
    },
    token: {
      address: tokenAddress,
      classHash: tokenClassHash,
      version: configuredVersion(value.token.version, "evidence token version"),
      symbol: "USDC",
      decimals: 6,
      deployment: tokenDeployment,
    },
    account: {
      classHash: normalizedFelt(
        value.account?.classHash,
        "evidence account class hash",
        STARK_FIELD_PRIME,
      ),
      version: configuredVersion(value.account?.version, "evidence account version"),
    },
    rpcProviders,
    services: {
      prover: validatedEvidenceService(value.services?.prover, "evidence prover"),
      discovery: validatedEvidenceService(value.services?.discovery, "evidence discovery service"),
      screening: validatedEvidenceScreening(value.services?.screening, rpcProviders),
      walletApiVersion: configuredVersion(
        value.services?.walletApiVersion,
        "evidence Wallet API version",
      ),
    },
    components: {
      nodeVersion,
      privacySdkVersion: STARKNET_PRIVACY_SDK_VERSION,
      privacySdkCommit: STARKNET_PRIVACY_SDK_COMMIT,
      starknetJsVersion: TESTNET_STARKNET_JS_VERSION,
      cdkVersion: TESTNET_CDK_VERSION,
    },
    finalityPolicy,
    provingPolicy,
    safety: { testOnlyAccount: true, cappedFunds: true },
  };
}

function validatedEvidenceProviders(
  value: TestnetDeploymentEvidence["rpcProviders"],
): TestnetDeploymentEvidence["rpcProviders"] {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAXIMUM_PROVIDER_COUNT) {
    throw invalidInput("Testnet deployment evidence has an invalid provider set");
  }
  const ids = new Set<string>();
  const operators = new Set<string>();
  return Array.from(value, (provider) => {
    if (typeof provider !== "object" || provider === null) {
      throw invalidInput("Testnet deployment evidence has an invalid provider");
    }
    const id = configuredIdentifier(provider.id, "evidence RPC provider ID");
    const operator = configuredIdentifier(provider.operator, "evidence RPC provider operator");
    if (ids.has(id) || operators.has(operator)) {
      throw invalidInput("Testnet deployment evidence has duplicate provider identities");
    }
    ids.add(id);
    operators.add(operator);
    return { id, operator };
  });
}

function validatedVerificationProviderIds(
  value: readonly string[],
  expectedProviders: TestnetDeploymentEvidence["rpcProviders"],
): readonly string[] {
  if (!Array.isArray(value) || value.length !== expectedProviders.length) {
    throw invalidInput("Testnet deployment verification has an invalid provider set");
  }
  const providerIds = Array.from(value, (id) =>
    configuredIdentifier(id, "verified RPC provider ID"),
  );
  if (providerIds.some((id, index) => id !== expectedProviders[index]?.id)) {
    throw invalidInput("Testnet deployment verification used a different provider set");
  }
  return providerIds;
}

function validatedEvidenceService(
  value: { readonly operator: string; readonly version: string } | undefined,
  label: string,
): { readonly operator: string; readonly version: string } {
  if (typeof value !== "object" || value === null) {
    throw invalidInput(`Testnet ${label} is invalid`);
  }
  return {
    operator: configuredIdentifier(value.operator, `${label} operator`),
    version: configuredVersion(value.version, `${label} version`),
  };
}

function validatedEvidenceScreening(
  value: TestnetDeploymentEvidence["services"]["screening"] | undefined,
  rpcProviders: TestnetDeploymentEvidence["rpcProviders"],
): TestnetDeploymentEvidence["services"]["screening"] {
  if (
    typeof value !== "object" ||
    value === null ||
    value.configuredPolicy !== TESTNET_SCREENING_POLICY ||
    value.configuredPoolMatchesDeployment !== true ||
    value.configuredBlockNonPoolTransactions !== true ||
    value.configuredInterceptorFailOpen !== false ||
    value.configuredProverFailOpen !== false
  ) {
    throw invalidInput("Testnet evidence screening policy is invalid");
  }
  const interceptor = validatedEvidenceService(value.interceptor, "evidence proof interceptor");
  if (interceptor.version !== STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION) {
    throw invalidInput("Testnet evidence proof interceptor pin is invalid");
  }
  if (typeof value.provider !== "object" || value.provider === null) {
    throw invalidInput("Testnet evidence screening provider is invalid");
  }
  const rpcProviderId = configuredIdentifier(
    value.rpcProviderId,
    "evidence screening RPC provider ID",
  );
  if (!rpcProviders.some(({ id }) => id === rpcProviderId)) {
    throw invalidInput("Testnet evidence screening RPC provider is invalid");
  }
  return {
    interceptor: {
      operator: interceptor.operator,
      version: STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION,
    },
    provider: {
      operator: configuredIdentifier(
        value.provider.operator,
        "evidence screening provider operator",
      ),
    },
    rpcProviderId,
    configuredPolicy: TESTNET_SCREENING_POLICY,
    configuredPoolMatchesDeployment: true,
    configuredBlockNonPoolTransactions: true,
    configuredInterceptorFailOpen: false,
    configuredProverFailOpen: false,
  };
}

function configuredCommand(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAXIMUM_COMMAND_ARGUMENTS) {
    throw evidenceNotPublic("Testnet evidence command is not safe to publish");
  }
  return Array.from(value, (argument) => {
    if (
      typeof argument !== "string" ||
      argument.length === 0 ||
      argument.length > MAXIMUM_COMMAND_ARGUMENT_LENGTH ||
      !PUBLIC_COMMAND_ARGUMENT_PATTERN.test(argument) ||
      argument.includes("=") ||
      argument.includes("://") ||
      LONG_HEX_PATTERN.test(argument)
    ) {
      throw evidenceNotPublic("Testnet evidence command is not safe to publish");
    }
    return argument;
  });
}

function configuredResultCode(
  value: TestnetResultCode | undefined,
  result: TestnetScenarioResult,
): TestnetResultCode | undefined {
  if (result === "PASSED") {
    if (value !== undefined) {
      throw invalidInput("A passed testnet scenario cannot carry a result code");
    }
    return undefined;
  }
  if (!RESULT_CODE_SET.has(value as TestnetResultCode)) {
    throw invalidInput("Testnet scenario result code is invalid");
  }
  return value as TestnetResultCode;
}

function evidenceState(value: unknown, label: string): TestnetEvidenceState {
  if (!EVIDENCE_STATES.has(value as TestnetEvidenceState)) {
    throw invalidInput(`Testnet ${label} is invalid`);
  }
  return value as TestnetEvidenceState;
}

function assertPinnedVersion(value: unknown, expected: string, label: string): void {
  if (value !== expected) {
    throw versionMismatch(`Testnet ${label} does not match the approved compatibility pin`);
  }
}

function configuredIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAXIMUM_IDENTIFIER_LENGTH ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw invalidInput(`Testnet ${label} is invalid`);
  }
  return value;
}

function configuredVersion(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAXIMUM_VERSION_LENGTH ||
    !VERSION_PATTERN.test(value)
  ) {
    throw invalidInput(`Testnet ${label} is invalid`);
  }
  return value;
}

function configuredSecretFelt(value: unknown, maximumExclusive: bigint, label: string): void {
  try {
    const secret = parsedHex(value);
    if (secret === 0n || secret >= maximumExclusive) {
      throw new Error("out of range");
    }
  } catch {
    throw unsafeConfiguration(`Testnet ${label} is missing or invalid`);
  }
}

function configuredScreeningCredentials(value: unknown): void {
  try {
    if (typeof value !== "object" || value === null) {
      throw new Error("invalid screening credentials");
    }
    const credentials = value as {
      readonly partnerName?: unknown;
      readonly partnerSecret?: unknown;
    };
    if (
      typeof credentials.partnerName !== "string" ||
      credentials.partnerName.length < 1 ||
      credentials.partnerName.length > MAXIMUM_SCREENING_PARTNER_NAME_LENGTH ||
      !SCREENING_PARTNER_NAME_PATTERN.test(credentials.partnerName) ||
      typeof credentials.partnerSecret !== "string" ||
      credentials.partnerSecret.length < 4 ||
      credentials.partnerSecret.length > MAXIMUM_SCREENING_SECRET_LENGTH ||
      !BASE64_PATTERN.test(credentials.partnerSecret)
    ) {
      throw new Error("invalid screening credentials");
    }
    const decoded = Buffer.from(credentials.partnerSecret, "base64");
    if (
      decoded.byteLength === 0 ||
      decoded.byteLength > MAXIMUM_SCREENING_SECRET_BYTES ||
      decoded.toString("base64").replace(/=+$/u, "") !==
        credentials.partnerSecret.replace(/=+$/u, "")
    ) {
      throw new Error("invalid screening credentials");
    }
  } catch {
    throw unsafeConfiguration("Testnet screening credentials are missing or invalid");
  }
}

function normalizedAddress(value: unknown, label: string): string {
  return normalizedFelt(value, label, STARKNET_ADDRESS_BOUND);
}

function normalizedFelt(value: unknown, label: string, maximumExclusive: bigint): string {
  let felt: bigint;
  try {
    felt = parsedHex(value);
  } catch {
    throw invalidInput(`Testnet ${label} is invalid`);
  }
  if (felt === 0n || felt >= maximumExclusive) {
    throw invalidInput(`Testnet ${label} is out of range`);
  }
  return `0x${felt.toString(16)}`;
}

function normalizedFeltAllowZero(value: unknown, label: string): string {
  let felt: bigint;
  try {
    felt = parsedHex(value);
  } catch {
    throw invalidInput(`Testnet ${label} is invalid`);
  }
  if (felt >= STARK_FIELD_PRIME) {
    throw invalidInput(`Testnet ${label} is out of range`);
  }
  return `0x${felt.toString(16)}`;
}

function parsedHex(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    value.length > MAXIMUM_HEX_LENGTH ||
    !/^0x[0-9a-fA-F]+$/.test(value)
  ) {
    throw new Error("invalid hex value");
  }
  return BigInt(value);
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > MAXIMUM_TIMESTAMP_LENGTH) {
    throw invalidInput(`Testnet ${label} is invalid`);
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw invalidInput(`Testnet ${label} is invalid`);
  }
  return value;
}

function evidenceBlockNumber(value: unknown, label: string): bigint {
  if (
    (typeof value !== "bigint" && typeof value !== "string") ||
    (typeof value === "string" &&
      (value.length > MAXIMUM_BLOCK_DECIMAL_LENGTH || !UNSIGNED_DECIMAL_PATTERN.test(value)))
  ) {
    throw invalidInput(`Testnet ${label} is invalid`);
  }
  let number: bigint;
  try {
    number = BigInt(value);
  } catch {
    throw invalidInput(`Testnet ${label} is invalid`);
  }
  if (number < 0n || number > MAXIMUM_BLOCK_NUMBER) {
    throw invalidInput(`Testnet ${label} is invalid`);
  }
  return number;
}

function evidenceTimestampSeconds(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw invalidInput(`Testnet ${label} is invalid`);
  }
  return value as number;
}

function evidenceUnsignedDecimal(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length > MAXIMUM_DECIMAL_LENGTH ||
    !UNSIGNED_DECIMAL_PATTERN.test(value)
  ) {
    throw invalidInput(`Testnet ${label} is invalid`);
  }
  const amount = BigInt(value);
  if (amount > MAXIMUM_FEE_FRI) {
    throw invalidInput(`Testnet ${label} is out of range`);
  }
  return amount.toString();
}

function configuredPositiveInteger(value: unknown, label: string): number {
  const integer = configuredNonnegativeInteger(value, label);
  if (integer === 0) {
    throw invalidInput(`Testnet ${label} must be positive`);
  }
  return integer;
}

function configuredNonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidInput(`Testnet ${label} is invalid`);
  }
  return value as number;
}

function invalidInput(message: string): TestnetEvidenceError {
  return new TestnetEvidenceError("invalid_input", message);
}

function unsafeConfiguration(message: string): TestnetEvidenceError {
  return new TestnetEvidenceError("unsafe_configuration", message);
}

function versionMismatch(message: string): TestnetEvidenceError {
  return new TestnetEvidenceError("version_mismatch", message);
}

function evidenceNotPublic(message: string): TestnetEvidenceError {
  return new TestnetEvidenceError("evidence_not_public", message);
}

const SCENARIO_SET: ReadonlySet<TestnetScenario> = new Set(TESTNET_SCENARIOS);
const SCENARIO_RESULTS: ReadonlySet<TestnetScenarioResult> = new Set([
  "FAILED",
  "PASSED",
  "SKIPPED",
]);
const RESULT_CODE_SET: ReadonlySet<TestnetResultCode> = new Set(TESTNET_RESULT_CODES);
const EVIDENCE_STATES: ReadonlySet<TestnetEvidenceState> = new Set(TESTNET_EVIDENCE_STATES);
const TESTNET_PRIVACY_SERVICE_VERIFICATION_SCHEMA_VERSION =
  "cashu-strk20-testnet-service-verification-v3" satisfies TestnetPrivacyServiceVerificationEvidence["schemaVersion"];
const TESTNET_PRIVACY_SERVICE_VERIFIER_VERSION =
  "starknet-privacy-services@0.14.3-rc.6:health-chain-screening-v1" satisfies TestnetPrivacyServiceVerificationEvidence["verifierVersion"];
const TESTNET_PRIVACY_SERVICE_VERIFICATION_FLAGS = {
  proverApiCompatible: true,
  discoveryHealthCompatible: true,
  discoveryHeadFresh: true,
  noTransactionSubmitted: true,
  noCashuOrTransactionDataSent: true,
  proverRuntimeVersionVerified: false,
  discoveryRuntimeVersionVerified: false,
  proofInterceptorRuntimeVersionVerified: false,
  discoveryChainStateVerified: true,
  proverChainIdentityVerified: false,
  proofInterceptorHealthCompatible: true,
  screeningRuntimeConfigurationVerified: false,
  screeningActivityVerified: false,
  remoteRuntimeImageVerified: false,
  deploymentApproved: false,
} as const satisfies TestnetPrivacyServiceVerificationEvidence["verification"];
const TESTNET_PRIVACY_SERVICE_VERIFICATION_BLOCKERS = [
  "prover_runtime_version_unverifiable",
  "discovery_runtime_version_unverifiable",
  "proof_interceptor_runtime_version_unverifiable",
  "prover_chain_identity_unverified",
  "screening_runtime_configuration_unverified",
  "screening_activity_unverified",
  "remote_runtime_image_unverified",
  "service_contract_bindings_unverified",
] as const satisfies TestnetPrivacyServiceVerificationEvidence["blockers"];
const TESTNET_DEPLOYMENT_ORIGIN_VERIFICATION_FLAGS = {
  addressesDerived: true,
  successfulReceiptsVerified: true,
  canonicalInclusionsVerified: true,
  udcDeploymentEventsVerified: true,
  classesAtDeploymentBlocksVerified: true,
  udcClassAtDeploymentBlocksVerified: true,
} as const satisfies TestnetDeploymentOriginEvidence["verification"];
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SCREENING_PARTNER_NAME_PATTERN = /^[\x21-\x7e]+$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+:/@-]*$/;
const PUBLIC_COMMAND_ARGUMENT_PATTERN = /^[A-Za-z0-9@/._:+-]+$/;
const LONG_HEX_PATTERN = /(?:^|[^A-Za-z0-9])(?:0x)?[0-9a-fA-F]{32,}(?:$|[^A-Za-z0-9])/;
const UNSIGNED_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
const STARKNET_ADDRESS_BOUND = (1n << 251n) - 256n;
const STARK_CURVE_ORDER = ec.starkCurve.CURVE.n;
const MAXIMUM_VIEWING_KEY = STARK_CURVE_ORDER / 2n;
const MAXIMUM_BLOCK_NUMBER = (1n << 64n) - 1n;
const MAXIMUM_BLOCK_DECIMAL_LENGTH = MAXIMUM_BLOCK_NUMBER.toString().length;
const MAXIMUM_FEE_FRI = (1n << 256n) - 1n;
const MAXIMUM_PROVIDER_COUNT = 16;
const MAXIMUM_DEPLOYMENT_CONSTRUCTOR_CALLDATA = 64;
const MAXIMUM_PUBLIC_TRANSACTIONS_PER_SCENARIO = 8;
const MAXIMUM_COMMAND_ARGUMENTS = 32;
const MAXIMUM_COMMAND_ARGUMENT_LENGTH = 256;
const MAXIMUM_DECIMAL_LENGTH = 78;
const MAXIMUM_ENDPOINT_LENGTH = 2_048;
const MAXIMUM_HEX_LENGTH = 66;
const MAXIMUM_IDENTIFIER_LENGTH = 64;
const MAXIMUM_SCREENING_SECRET_BYTES = 512;
const MAXIMUM_SCREENING_SECRET_LENGTH = 684;
const MAXIMUM_SCREENING_PARTNER_NAME_LENGTH = 256;
const MAXIMUM_TIMESTAMP_LENGTH = 32;
const MAXIMUM_VERSION_LENGTH = 128;
