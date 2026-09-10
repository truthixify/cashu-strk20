import {
  STARKNET_DISCOVERY_SERVICE_COMPONENT_VERSION,
  STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION,
  STARKNET_TRANSACTION_PROVER_API_VERSION,
  STARKNET_TRANSACTION_PROVER_COMPONENT_VERSION,
} from "./privacy-service-compatibility.js";
import {
  type NamedStarknetDiscoveryHeadProvider,
  type StarknetDiscoveryHeadVerification,
  StarknetDiscoveryHeadVerifier,
} from "./starknet-discovery-head-verifier.js";
import {
  createTestnetDeploymentEvidence,
  type TestnetDeploymentConfig,
  type TestnetDeploymentEvidence,
} from "./testnet-evidence.js";

export {
  STARKNET_DISCOVERY_SERVICE_COMPONENT_VERSION,
  STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION,
  STARKNET_TRANSACTION_PROVER_API_VERSION,
  STARKNET_TRANSACTION_PROVER_COMPONENT_VERSION,
} from "./privacy-service-compatibility.js";

export const TESTNET_PRIVACY_SERVICE_VERIFICATION_SCHEMA_VERSION =
  "cashu-strk20-testnet-service-verification-v3";
export const TESTNET_PRIVACY_SERVICE_VERIFIER_VERSION =
  "starknet-privacy-services@0.14.3-rc.6:health-chain-screening-v1";

export interface TestnetPrivacyServiceVerificationEvidence {
  readonly schemaVersion: typeof TESTNET_PRIVACY_SERVICE_VERIFICATION_SCHEMA_VERSION;
  readonly verifierVersion: typeof TESTNET_PRIVACY_SERVICE_VERIFIER_VERSION;
  readonly verifiedAt: string;
  readonly network: "SN_SEPOLIA";
  readonly profile: TestnetDeploymentEvidence;
  readonly services: {
    readonly prover: {
      readonly operator: string;
      readonly configuredComponentVersion: typeof STARKNET_TRANSACTION_PROVER_COMPONENT_VERSION;
      readonly apiVersion: typeof STARKNET_TRANSACTION_PROVER_API_VERSION;
    };
    readonly discovery: {
      readonly operator: string;
      readonly configuredComponentVersion: typeof STARKNET_DISCOVERY_SERVICE_COMPONENT_VERSION;
      readonly status: "OK";
      readonly indexedHead: {
        readonly blockNumber: number;
        readonly blockHash: string;
        readonly blockTimestamp: number;
        readonly reportedLagSeconds: number;
      };
    };
    readonly screening: {
      readonly interceptorOperator: string;
      readonly screeningProviderOperator: string;
      readonly configuredComponentVersion: typeof STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION;
      readonly healthStatus: "ok";
      readonly rpcProviderId: string;
    };
  };
  readonly chainVerification: StarknetDiscoveryHeadVerification;
  readonly verification: {
    readonly proverApiCompatible: true;
    readonly discoveryHealthCompatible: true;
    readonly discoveryHeadFresh: true;
    readonly noTransactionSubmitted: true;
    readonly noCashuOrTransactionDataSent: true;
    readonly proverRuntimeVersionVerified: false;
    readonly discoveryRuntimeVersionVerified: false;
    readonly proofInterceptorRuntimeVersionVerified: false;
    readonly discoveryChainStateVerified: true;
    readonly proverChainIdentityVerified: false;
    readonly proofInterceptorHealthCompatible: true;
    readonly screeningRuntimeConfigurationVerified: false;
    readonly screeningActivityVerified: false;
    readonly remoteRuntimeImageVerified: false;
    readonly deploymentApproved: false;
  };
  readonly blockers: readonly [
    "prover_runtime_version_unverifiable",
    "discovery_runtime_version_unverifiable",
    "proof_interceptor_runtime_version_unverifiable",
    "prover_chain_identity_unverified",
    "screening_runtime_configuration_unverified",
    "screening_activity_unverified",
    "remote_runtime_image_unverified",
    "service_contract_bindings_unverified",
  ];
}

export type TestnetPrivacyServiceVerifierErrorCode =
  | "discovery_endpoint_incompatible"
  | "discovery_response_invalid"
  | "discovery_stale"
  | "discovery_unavailable"
  | "proof_interceptor_endpoint_incompatible"
  | "proof_interceptor_response_invalid"
  | "proof_interceptor_unavailable"
  | "prover_response_invalid"
  | "prover_unavailable"
  | "prover_version_mismatch"
  | "service_configuration_invalid";

export class TestnetPrivacyServiceVerifierError extends Error {
  readonly code: TestnetPrivacyServiceVerifierErrorCode;

  constructor(code: TestnetPrivacyServiceVerifierErrorCode, message: string) {
    super(message);
    this.name = "TestnetPrivacyServiceVerifierError";
    this.code = code;
  }
}

export async function verifyTestnetPrivacyServices(input: {
  readonly config: TestnetDeploymentConfig;
  readonly providers: readonly NamedStarknetDiscoveryHeadProvider[];
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => Date;
}): Promise<TestnetPrivacyServiceVerificationEvidence> {
  const request = verificationRequest(input);
  const [proverResult, discoveryResult, proofInterceptorResult] = await Promise.allSettled([
    probeProver(request.config.prover.url, request.fetchImplementation),
    probeDiscovery(request.config.discovery.healthUrl, request.fetchImplementation),
    probeProofInterceptor(
      request.config.screening.interceptorHealthUrl,
      request.fetchImplementation,
    ),
  ]);
  const proverApiVersion = settledProbe(proverResult, "prover");
  const discovery = settledProbe(discoveryResult, "discovery");
  settledProbe(proofInterceptorResult, "proof_interceptor");
  if (proverApiVersion !== STARKNET_TRANSACTION_PROVER_API_VERSION) {
    throw new TestnetPrivacyServiceVerifierError(
      "prover_version_mismatch",
      "Testnet prover API version does not match the reviewed release",
    );
  }
  const observedAt = verificationTimestamp(request.now);
  if (Date.parse(observedAt) < Date.parse(request.config.profile.recordedAt)) {
    throw serviceConfigurationInvalid();
  }
  assertDiscoveryFreshness(discovery, observedAt, request.config.provingPolicy);
  const chainVerification = await request.discoveryHeadVerifier.verify({
    blockNumber: discovery.blockNumber,
    blockHash: discovery.blockHash,
    blockTimestamp: discovery.blockTimestamp,
  });
  const verifiedAt = verificationTimestamp(request.now);
  if (Date.parse(verifiedAt) < Date.parse(observedAt)) {
    throw serviceConfigurationInvalid();
  }
  assertDiscoveryFreshness(discovery, verifiedAt, request.config.provingPolicy);

  return {
    schemaVersion: TESTNET_PRIVACY_SERVICE_VERIFICATION_SCHEMA_VERSION,
    verifierVersion: TESTNET_PRIVACY_SERVICE_VERIFIER_VERSION,
    verifiedAt,
    network: "SN_SEPOLIA",
    profile: request.config.profile,
    services: {
      prover: {
        operator: request.config.prover.operator,
        configuredComponentVersion: STARKNET_TRANSACTION_PROVER_COMPONENT_VERSION,
        apiVersion: STARKNET_TRANSACTION_PROVER_API_VERSION,
      },
      discovery: {
        operator: request.config.discovery.operator,
        configuredComponentVersion: STARKNET_DISCOVERY_SERVICE_COMPONENT_VERSION,
        status: "OK",
        indexedHead: {
          blockNumber: discovery.blockNumber,
          blockHash: discovery.blockHash,
          blockTimestamp: discovery.blockTimestamp,
          reportedLagSeconds: discovery.reportedLagSeconds,
        },
      },
      screening: {
        interceptorOperator: request.config.screening.interceptorOperator,
        screeningProviderOperator: request.config.screening.providerOperator,
        configuredComponentVersion: STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION,
        healthStatus: "ok",
        rpcProviderId: request.config.screening.rpcProviderId,
      },
    },
    chainVerification,
    verification: {
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
    },
    blockers: [
      "prover_runtime_version_unverifiable",
      "discovery_runtime_version_unverifiable",
      "proof_interceptor_runtime_version_unverifiable",
      "prover_chain_identity_unverified",
      "screening_runtime_configuration_unverified",
      "screening_activity_unverified",
      "remote_runtime_image_unverified",
      "service_contract_bindings_unverified",
    ],
  };
}

function verificationRequest(input: {
  readonly config: TestnetDeploymentConfig;
  readonly providers: readonly NamedStarknetDiscoveryHeadProvider[];
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => Date;
}): ValidatedVerificationRequest {
  try {
    if (typeof input !== "object" || input === null) {
      throw serviceConfigurationInvalid();
    }
    const config = validatedConfiguration(input.config);
    const fetchImplementation = input.fetchImplementation ?? fetch;
    const now = input.now ?? (() => new Date());
    if (typeof fetchImplementation !== "function" || typeof now !== "function") {
      throw serviceConfigurationInvalid();
    }
    const providers = profileProviders(input.providers, config.profile.rpcProviders);
    const discoveryHeadVerifier = new StarknetDiscoveryHeadVerifier({
      network: "SN_SEPOLIA",
      providers,
      requestTimeoutMilliseconds: config.profile.provingPolicy.requestTimeoutMilliseconds,
    });
    return { config, discoveryHeadVerifier, fetchImplementation, now };
  } catch (error) {
    if (error instanceof TestnetPrivacyServiceVerifierError) {
      throw error;
    }
    throw serviceConfigurationInvalid();
  }
}

function profileProviders(
  value: readonly NamedStarknetDiscoveryHeadProvider[],
  expected: TestnetDeploymentEvidence["rpcProviders"],
): readonly NamedStarknetDiscoveryHeadProvider[] {
  if (!Array.isArray(value) || value.length !== expected.length) {
    throw serviceConfigurationInvalid();
  }
  return Object.freeze(
    Array.from(value, (provider, index) => {
      if (
        typeof provider !== "object" ||
        provider === null ||
        provider.id !== expected[index]?.id
      ) {
        throw serviceConfigurationInvalid();
      }
      return { id: provider.id, provider: provider.provider };
    }),
  );
}

function validatedConfiguration(config: TestnetDeploymentConfig): ValidatedServiceConfig {
  try {
    if (
      typeof config !== "object" ||
      config === null ||
      config.network !== "SN_SEPOLIA" ||
      config.prover?.version !== STARKNET_TRANSACTION_PROVER_COMPONENT_VERSION ||
      config.discovery?.version !== STARKNET_DISCOVERY_SERVICE_COMPONENT_VERSION ||
      config.screening?.interceptor?.version !== STARKNET_PROOF_INTERCEPTOR_COMPONENT_VERSION ||
      !publicOperator(config.prover.operator) ||
      !publicOperator(config.discovery.operator) ||
      !publicOperator(config.screening.interceptor.operator)
    ) {
      throw serviceConfigurationInvalid();
    }
    const prover = {
      operator: config.prover.operator,
      url: serviceEndpoint(config.prover.url),
    };
    const discoveryUrl = config.discovery.url;
    if (typeof discoveryUrl !== "string") {
      throw serviceConfigurationInvalid();
    }
    const healthUrl = discoveryHealthUrl(discoveryUrl);
    serviceEndpoint(discoveryUrl);
    const discovery = {
      operator: config.discovery.operator,
      healthUrl,
    };
    const interceptorUrl = config.screening.interceptor.url;
    if (typeof interceptorUrl !== "string") {
      throw serviceConfigurationInvalid();
    }
    const interceptorHealthUrl = proofInterceptorHealthUrl(interceptorUrl);
    serviceEndpoint(interceptorUrl);
    const provingPolicy = {
      maximumBlockAgeSeconds: positiveSafeConfigurationInteger(
        config.provingPolicy?.maximumBlockAgeSeconds,
      ),
      maximumFutureBlockTimeSeconds: nonnegativeSafeConfigurationInteger(
        config.provingPolicy?.maximumFutureBlockTimeSeconds,
      ),
    };
    const profile = createTestnetDeploymentEvidence(config);
    const screening = {
      interceptorOperator: profile.services.screening.interceptor.operator,
      providerOperator: profile.services.screening.provider.operator,
      interceptorHealthUrl,
      rpcProviderId: profile.services.screening.rpcProviderId,
    };
    return { prover, discovery, screening, provingPolicy, profile };
  } catch (error) {
    if (
      error instanceof TestnetPrivacyServiceVerifierError &&
      (error.code === "discovery_endpoint_incompatible" ||
        error.code === "proof_interceptor_endpoint_incompatible")
    ) {
      throw error;
    }
    throw serviceConfigurationInvalid();
  }
}

async function probeProver(url: string, fetchImplementation: typeof fetch): Promise<string> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "starknet_specVersion",
    params: [],
  });
  const response = await request("prover", fetchImplementation, url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "cashu-strk20-service-verifier/1",
    },
    body,
  });
  const record = responseRecord(response, "prover");
  if (
    field(record, "jsonrpc") !== "2.0" ||
    field(record, "id") !== 1 ||
    typeof field(record, "result") !== "string" ||
    Object.hasOwn(record, "error")
  ) {
    throw invalidResponse("prover");
  }
  return field(record, "result") as string;
}

async function probeDiscovery(
  healthUrl: string,
  fetchImplementation: typeof fetch,
): Promise<DiscoveryObservation> {
  const response = await request("discovery", fetchImplementation, healthUrl, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "cashu-strk20-service-verifier/1",
    },
  });
  const record = responseRecord(response, "discovery");
  const chainHead = plainRecord(field(record, "chain_head"), "discovery");
  if (field(record, "status") !== "OK") {
    throw invalidResponse("discovery");
  }
  return {
    blockNumber: nonnegativeSafeInteger(field(chainHead, "block_number"), "discovery"),
    blockHash: normalizedFelt(field(chainHead, "block_hash"), "discovery"),
    blockTimestamp: positiveSafeInteger(field(chainHead, "timestamp"), "discovery"),
    reportedLagSeconds: nonnegativeSafeInteger(field(record, "lag_secs"), "discovery"),
  };
}

async function probeProofInterceptor(
  healthUrl: string,
  fetchImplementation: typeof fetch,
): Promise<true> {
  const response = await request("proof_interceptor", fetchImplementation, healthUrl, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "cashu-strk20-service-verifier/1",
    },
  });
  const record = responseRecord(response, "proof_interceptor");
  if (Object.keys(record).length !== 1 || field(record, "status") !== "ok") {
    throw invalidResponse("proof_interceptor");
  }
  return true;
}

async function request(
  role: ServiceRole,
  fetchImplementation: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImplementation(url, {
      ...init,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(SERVICE_REQUEST_TIMEOUT_MILLISECONDS),
    });
  } catch {
    throw unavailable(role);
  }
  try {
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        // The status is already sufficient to classify the endpoint as unavailable.
      }
      throw unavailable(role);
    }
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      throw invalidResponse(role);
    }
    const body = await boundedResponseBody(response, role);
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(body);
      return JSON.parse(decoded) as unknown;
    } catch {
      throw invalidResponse(role);
    }
  } catch (error) {
    if (error instanceof TestnetPrivacyServiceVerifierError) {
      throw error;
    }
    throw invalidResponse(role);
  }
}

function settledProbe<T>(result: PromiseSettledResult<T>, role: ServiceRole): T {
  if (result.status === "fulfilled") {
    return result.value;
  }
  if (result.reason instanceof TestnetPrivacyServiceVerifierError) {
    throw result.reason;
  }
  throw invalidResponse(role);
}

async function boundedResponseBody(response: Response, role: ServiceRole): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(length) || Number(length) > MAXIMUM_RESPONSE_BYTES)
  ) {
    throw invalidResponse(role);
  }
  if (response.body === null) {
    throw invalidResponse(role);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let failure: TestnetPrivacyServiceVerifierError | undefined;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      if (!(result.value instanceof Uint8Array)) {
        throw invalidResponse(role);
      }
      total += result.value.byteLength;
      if (!Number.isSafeInteger(total) || total > MAXIMUM_RESPONSE_BYTES) {
        throw invalidResponse(role);
      }
      chunks.push(Uint8Array.from(result.value));
    }
  } catch (error) {
    failure = error instanceof TestnetPrivacyServiceVerifierError ? error : invalidResponse(role);
  }
  try {
    reader.releaseLock();
  } catch {
    failure ??= invalidResponse(role);
  }
  if (failure) {
    throw failure;
  }
  if (total < 1) {
    throw invalidResponse(role);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function responseRecord(value: unknown, role: ServiceRole): Record<string, unknown> {
  return plainRecord(value, role);
}

function plainRecord(value: unknown, role: ServiceRole): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidResponse(role);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidResponse(role);
  }
  return value as Record<string, unknown>;
}

function field(value: Readonly<Record<string, unknown>>, key: string): unknown {
  return value[key];
}

function discoveryHealthUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (
      parsed.search !== "" ||
      parsed.hash !== "" ||
      value.includes("?") ||
      value.includes("#") ||
      value.endsWith("/")
    ) {
      throw discoveryEndpointIncompatible();
    }
    return `${value}/health`;
  } catch (error) {
    if (error instanceof TestnetPrivacyServiceVerifierError) {
      throw error;
    }
    throw discoveryEndpointIncompatible();
  }
}

function proofInterceptorHealthUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (
      parsed.search !== "" ||
      parsed.hash !== "" ||
      value.includes("?") ||
      value.includes("#") ||
      value.endsWith("/")
    ) {
      throw proofInterceptorEndpointIncompatible();
    }
    return `${value}/health`;
  } catch (error) {
    if (error instanceof TestnetPrivacyServiceVerifierError) {
      throw error;
    }
    throw proofInterceptorEndpointIncompatible();
  }
}

function serviceEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAXIMUM_ENDPOINT_LENGTH) {
    throw serviceConfigurationInvalid();
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw serviceConfigurationInvalid();
  }
  if (
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.hash !== "" ||
    (endpoint.protocol !== "https:" &&
      !(endpoint.protocol === "http:" && LOOPBACK_HOSTS.has(endpoint.hostname)))
  ) {
    throw serviceConfigurationInvalid();
  }
  return value;
}

function publicOperator(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAXIMUM_OPERATOR_LENGTH &&
    OPERATOR_PATTERN.test(value)
  );
}

function assertDiscoveryFreshness(
  observation: DiscoveryObservation,
  verifiedAt: string,
  policy: ValidatedServiceConfig["provingPolicy"],
): void {
  const verifiedAtSeconds = Math.floor(Date.parse(verifiedAt) / 1_000);
  if (
    observation.blockTimestamp < verifiedAtSeconds - policy.maximumBlockAgeSeconds ||
    observation.blockTimestamp > verifiedAtSeconds + policy.maximumFutureBlockTimeSeconds ||
    observation.reportedLagSeconds > policy.maximumBlockAgeSeconds
  ) {
    throw new TestnetPrivacyServiceVerifierError(
      "discovery_stale",
      "Testnet discovery service head is outside the configured freshness policy",
    );
  }
}

function positiveSafeConfigurationInteger(value: unknown): number {
  const parsed = nonnegativeSafeConfigurationInteger(value);
  if (parsed === 0) {
    throw serviceConfigurationInvalid();
  }
  return parsed;
}

function nonnegativeSafeConfigurationInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw serviceConfigurationInvalid();
  }
  return value as number;
}

function nonnegativeSafeInteger(value: unknown, role: ServiceRole): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidResponse(role);
  }
  return value as number;
}

function positiveSafeInteger(value: unknown, role: ServiceRole): number {
  const parsed = nonnegativeSafeInteger(value, role);
  if (parsed === 0) {
    throw invalidResponse(role);
  }
  return parsed;
}

function normalizedFelt(value: unknown, role: ServiceRole): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/u.test(value)) {
    throw invalidResponse(role);
  }
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw invalidResponse(role);
  }
  if (parsed <= 0n || parsed >= STARKNET_FIELD_PRIME || `0x${parsed.toString(16)}` !== value) {
    throw invalidResponse(role);
  }
  return value;
}

function timestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw serviceConfigurationInvalid();
  }
  return value.toISOString();
}

function verificationTimestamp(now: () => Date): string {
  try {
    return timestamp(now());
  } catch {
    throw serviceConfigurationInvalid();
  }
}

function unavailable(role: ServiceRole): TestnetPrivacyServiceVerifierError {
  if (role === "prover") {
    return new TestnetPrivacyServiceVerifierError(
      "prover_unavailable",
      "Testnet prover service is unavailable",
    );
  }
  if (role === "discovery") {
    return new TestnetPrivacyServiceVerifierError(
      "discovery_unavailable",
      "Testnet discovery service is unavailable",
    );
  }
  return new TestnetPrivacyServiceVerifierError(
    "proof_interceptor_unavailable",
    "Testnet proof interceptor is unavailable",
  );
}

function invalidResponse(role: ServiceRole): TestnetPrivacyServiceVerifierError {
  if (role === "prover") {
    return new TestnetPrivacyServiceVerifierError(
      "prover_response_invalid",
      "Testnet prover service returned an invalid response",
    );
  }
  if (role === "discovery") {
    return new TestnetPrivacyServiceVerifierError(
      "discovery_response_invalid",
      "Testnet discovery service returned an invalid response",
    );
  }
  return new TestnetPrivacyServiceVerifierError(
    "proof_interceptor_response_invalid",
    "Testnet proof interceptor returned an invalid response",
  );
}

function discoveryEndpointIncompatible(): TestnetPrivacyServiceVerifierError {
  return new TestnetPrivacyServiceVerifierError(
    "discovery_endpoint_incompatible",
    "Testnet discovery endpoint is incompatible with the pinned SDK",
  );
}

function proofInterceptorEndpointIncompatible(): TestnetPrivacyServiceVerifierError {
  return new TestnetPrivacyServiceVerifierError(
    "proof_interceptor_endpoint_incompatible",
    "Testnet proof interceptor endpoint is incompatible with the pinned release",
  );
}

function serviceConfigurationInvalid(): TestnetPrivacyServiceVerifierError {
  return new TestnetPrivacyServiceVerifierError(
    "service_configuration_invalid",
    "Testnet privacy service configuration is invalid",
  );
}

interface DiscoveryObservation {
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly blockTimestamp: number;
  readonly reportedLagSeconds: number;
}

interface ValidatedServiceConfig {
  readonly profile: TestnetDeploymentEvidence;
  readonly prover: {
    readonly operator: string;
    readonly url: string;
  };
  readonly discovery: {
    readonly operator: string;
    readonly healthUrl: string;
  };
  readonly screening: {
    readonly interceptorOperator: string;
    readonly providerOperator: string;
    readonly interceptorHealthUrl: string;
    readonly rpcProviderId: string;
  };
  readonly provingPolicy: {
    readonly maximumBlockAgeSeconds: number;
    readonly maximumFutureBlockTimeSeconds: number;
  };
}

type ServiceRole = "discovery" | "proof_interceptor" | "prover";

interface ValidatedVerificationRequest {
  readonly config: ValidatedServiceConfig;
  readonly discoveryHeadVerifier: StarknetDiscoveryHeadVerifier;
  readonly fetchImplementation: typeof fetch;
  readonly now: () => Date;
}

const SERVICE_REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const MAXIMUM_RESPONSE_BYTES = 64 * 1024;
const MAXIMUM_ENDPOINT_LENGTH = 2_048;
const MAXIMUM_OPERATOR_LENGTH = 64;
const OPERATOR_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const STARKNET_FIELD_PRIME = 2n ** 251n + 17n * 2n ** 192n + 1n;
