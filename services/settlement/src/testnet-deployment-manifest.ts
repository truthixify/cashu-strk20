import { createHash } from "node:crypto";

import { STARKNET_PRIVACY_SDK_COMMIT } from "./privacy-evidence.js";
import type { TestnetDeploymentEvidence } from "./testnet-evidence.js";

export const TESTNET_DEPLOYMENT_MANIFEST_SCHEMA_VERSION =
  "cashu-strk20-testnet-deployment-manifest-v1";
export const TESTNET_DEPLOYMENT_MANIFEST_VERIFICATION_SCHEMA_VERSION =
  "cashu-strk20-testnet-deployment-manifest-verification-v1";
export const TESTNET_DEPLOYMENT_MANIFEST_VERIFIER_VERSION =
  "cashu-strk20-deployment-manifest-verifier-v1";
export const STARKNET_PRIVACY_SOURCE_REPOSITORY =
  "https://github.com/starkware-libs/starknet-privacy";
export const STARKNET_PRIVACY_CONTRACT_PATH = "packages/privacy/src/privacy.cairo";

export type TestnetDeploymentContractRole = "privacy_pool" | "usdc_token";

export type TestnetDeploymentManifestProfile = Pick<
  TestnetDeploymentEvidence,
  "chainId" | "network" | "pool" | "token"
>;

export interface TestnetDeploymentManifestSource {
  readonly repository: string;
  readonly commit: string;
  readonly contractPath: string;
}

export interface TestnetDeploymentManifestTransaction {
  readonly transactionReference: string;
  readonly acceptedBlockHash: string;
  readonly acceptedBlockNumber: string;
  readonly deployer: string;
  readonly salt: string;
  readonly unique: boolean;
  readonly constructorCalldata: readonly string[];
}

interface TestnetDeploymentManifestContractBase {
  readonly address: string;
  readonly classHash: string;
  readonly version: string;
  readonly source: TestnetDeploymentManifestSource;
  readonly deployment: TestnetDeploymentManifestTransaction;
}

export interface TestnetPrivacyPoolManifestContract extends TestnetDeploymentManifestContractBase {
  readonly role: "privacy_pool";
  readonly configuration: {
    readonly governanceAdmin: string;
    readonly auditorPublicKey: string;
    readonly screenerPublicKey: string;
    readonly proofValidityBlocks: string;
  };
}

export interface TestnetUsdcTokenManifestContract extends TestnetDeploymentManifestContractBase {
  readonly role: "usdc_token";
  readonly configuration: {
    readonly symbol: "USDC";
    readonly decimals: 6;
    readonly mintAuthority: string;
    readonly supplyPolicy: "capped_test_supply_v1";
    readonly maximumSupplyBaseUnits: string;
  };
}

export type TestnetDeploymentManifestContract =
  | TestnetPrivacyPoolManifestContract
  | TestnetUsdcTokenManifestContract;

export interface TestnetDeploymentManifestDocument {
  readonly schemaVersion: typeof TESTNET_DEPLOYMENT_MANIFEST_SCHEMA_VERSION;
  readonly network: "SN_SEPOLIA";
  readonly chainId: string;
  readonly contracts: readonly TestnetDeploymentManifestContract[];
}

export interface TestnetDeploymentManifestDocumentInput {
  readonly url: string;
  readonly bytes: Uint8Array;
}

export interface TestnetDeploymentManifestVerificationEvidence {
  readonly schemaVersion: typeof TESTNET_DEPLOYMENT_MANIFEST_VERIFICATION_SCHEMA_VERSION;
  readonly verifierVersion: typeof TESTNET_DEPLOYMENT_MANIFEST_VERIFIER_VERSION;
  readonly verifiedAt: string;
  readonly network: "SN_SEPOLIA";
  readonly chainId: string;
  readonly contracts: readonly [
    TestnetPrivacyPoolManifestContract & ManifestArtifactIdentity,
    TestnetUsdcTokenManifestContract & ManifestArtifactIdentity,
  ];
  readonly verification: {
    readonly manifestBytesRetrieved: true;
    readonly manifestHashesMatch: true;
    readonly canonicalJsonVerified: true;
    readonly contractProfilesMatch: true;
    readonly poolConstructorMatchesPinnedAbi: true;
    readonly sourcePublishersAuthenticated: false;
    readonly transactionReceiptsVerified: false;
    readonly deploymentApproved: false;
  };
  readonly blockers: readonly [
    "manifest_publishers_unauthenticated",
    "deployment_transactions_unverified",
    "deployment_approval_required",
  ];
}

interface ManifestArtifactIdentity {
  readonly manifestUrl: string;
  readonly manifestSha256: string;
  readonly manifestBytes: number;
}

export type TestnetDeploymentManifestErrorCode =
  | "configuration_invalid"
  | "manifest_content_invalid"
  | "manifest_hash_mismatch"
  | "manifest_profile_mismatch"
  | "manifest_response_invalid"
  | "manifest_unavailable";

export class TestnetDeploymentManifestError extends Error {
  readonly code: TestnetDeploymentManifestErrorCode;

  constructor(code: TestnetDeploymentManifestErrorCode, message: string) {
    super(message);
    this.name = "TestnetDeploymentManifestError";
    this.code = code;
  }
}

export function serializeTestnetDeploymentManifest(
  value: TestnetDeploymentManifestDocument,
): string {
  const manifest = validatedManifestDocument(value);
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function createTestnetDeploymentManifestVerificationEvidence(input: {
  readonly profile: TestnetDeploymentManifestProfile;
  readonly documents: readonly TestnetDeploymentManifestDocumentInput[];
  readonly verifiedAt: string;
}): TestnetDeploymentManifestVerificationEvidence {
  try {
    const expected = expectedContracts(input.profile);
    const documents = validatedDocuments(input.documents, expected);
    const pool = contractEvidenceFor("privacy_pool", expected, documents);
    const token = contractEvidenceFor("usdc_token", expected, documents);
    if (pool.role !== "privacy_pool" || token.role !== "usdc_token") {
      throw manifestContentInvalid();
    }
    const contracts: TestnetDeploymentManifestVerificationEvidence["contracts"] = [pool, token];
    const chainId = expected.get("privacy_pool")?.chainId;
    if (chainId === undefined) {
      throw configurationInvalid();
    }

    return {
      schemaVersion: TESTNET_DEPLOYMENT_MANIFEST_VERIFICATION_SCHEMA_VERSION,
      verifierVersion: TESTNET_DEPLOYMENT_MANIFEST_VERIFIER_VERSION,
      verifiedAt: canonicalTimestamp(input.verifiedAt),
      network: "SN_SEPOLIA",
      chainId,
      contracts,
      verification: { ...VERIFICATION_FLAGS },
      blockers: [...VERIFICATION_BLOCKERS],
    };
  } catch (error) {
    if (error instanceof TestnetDeploymentManifestError) {
      throw error;
    }
    throw configurationInvalid();
  }
}

export function reconstructTestnetDeploymentManifestVerificationEvidence(
  value: unknown,
  profile: TestnetDeploymentManifestProfile,
): TestnetDeploymentManifestVerificationEvidence {
  try {
    const record = plainRecord(value);
    if (
      field(record, "schemaVersion") !== TESTNET_DEPLOYMENT_MANIFEST_VERIFICATION_SCHEMA_VERSION ||
      field(record, "verifierVersion") !== TESTNET_DEPLOYMENT_MANIFEST_VERIFIER_VERSION
    ) {
      throw manifestContentInvalid();
    }
    const expected = expectedContracts(profile);
    const rawContracts = denseArray(field(record, "contracts"), 2, 2);
    const pool = reconstructedContractEvidence(rawContracts[0], "privacy_pool", expected);
    const token = reconstructedContractEvidence(rawContracts[1], "usdc_token", expected);
    if (pool.role !== "privacy_pool" || token.role !== "usdc_token") {
      throw manifestContentInvalid();
    }
    const contracts: TestnetDeploymentManifestVerificationEvidence["contracts"] = [pool, token];
    const chainId = expected.get("privacy_pool")?.chainId;
    if (field(record, "network") !== "SN_SEPOLIA" || chainId === undefined) {
      throw manifestContentInvalid();
    }
    if (canonicalFelt(field(record, "chainId"), false) !== chainId) {
      throw manifestProfileMismatch();
    }
    if (!exactRecord(field(record, "verification"), VERIFICATION_FLAGS)) {
      throw manifestContentInvalid();
    }
    const blockers = denseArray(field(record, "blockers"), 3, 3);
    if (!VERIFICATION_BLOCKERS.every((blocker, index) => blockers[index] === blocker)) {
      throw manifestContentInvalid();
    }
    return {
      schemaVersion: TESTNET_DEPLOYMENT_MANIFEST_VERIFICATION_SCHEMA_VERSION,
      verifierVersion: TESTNET_DEPLOYMENT_MANIFEST_VERIFIER_VERSION,
      verifiedAt: canonicalTimestamp(field(record, "verifiedAt")),
      network: "SN_SEPOLIA",
      chainId,
      contracts,
      verification: { ...VERIFICATION_FLAGS },
      blockers: [...VERIFICATION_BLOCKERS],
    };
  } catch (error) {
    if (error instanceof TestnetDeploymentManifestError) {
      throw error;
    }
    throw manifestContentInvalid();
  }
}

export function assertTestnetDeploymentManifestsDoNotExposeAddresses(
  evidence: TestnetDeploymentManifestVerificationEvidence,
  values: readonly string[],
): void {
  const forbidden = new Set(
    denseArray(values, 1, MAXIMUM_FORBIDDEN_ADDRESSES).map((value) => canonicalAddress(value)),
  );
  for (const contract of evidence.contracts) {
    const publicValues = [
      contract.address,
      contract.deployment.deployer,
      ...contract.deployment.constructorCalldata,
      ...(contract.role === "privacy_pool"
        ? [
            contract.configuration.governanceAdmin,
            contract.configuration.auditorPublicKey,
            contract.configuration.screenerPublicKey,
          ]
        : [contract.configuration.mintAuthority]),
    ];
    if (publicValues.some((value) => forbidden.has(value))) {
      throw configurationInvalid();
    }
  }
}

function contractEvidenceFor(
  role: TestnetDeploymentContractRole,
  expected: ReadonlyMap<TestnetDeploymentContractRole, ExpectedContract>,
  documents: ReadonlyMap<string, ValidatedDocument>,
): TestnetDeploymentManifestContract & ManifestArtifactIdentity {
  const expectation = expected.get(role);
  if (expectation === undefined) {
    throw configurationInvalid();
  }
  const document = documents.get(expectation.manifestUrl);
  if (document === undefined) {
    throw manifestContentInvalid();
  }
  const contract = document.manifest.contracts.find((candidate) => candidate.role === role);
  if (contract === undefined) {
    throw manifestContentInvalid();
  }
  assertContractMatchesProfile(contract, expectation);
  return {
    ...contract,
    manifestUrl: expectation.manifestUrl,
    manifestSha256: expectation.manifestSha256,
    manifestBytes: document.bytes,
  };
}

function reconstructedContractEvidence(
  value: unknown,
  role: TestnetDeploymentContractRole,
  expected: ReadonlyMap<TestnetDeploymentContractRole, ExpectedContract>,
): TestnetDeploymentManifestContract & ManifestArtifactIdentity {
  const contractRecord = plainRecord(value);
  if (field(contractRecord, "role") !== role) {
    throw manifestContentInvalid();
  }
  const contract = validatedManifestContract(contractRecord);
  const expectation = expected.get(role);
  if (expectation === undefined) {
    throw configurationInvalid();
  }
  assertContractMatchesProfile(contract, expectation);
  const manifestUrl = publicUrl(field(contractRecord, "manifestUrl"));
  const manifestSha256 = sha256Hex(field(contractRecord, "manifestSha256"));
  const manifestBytes = positiveSafeInteger(field(contractRecord, "manifestBytes"));
  if (
    manifestUrl !== expectation.manifestUrl ||
    manifestSha256 !== expectation.manifestSha256 ||
    manifestBytes > MAXIMUM_MANIFEST_BYTES
  ) {
    throw manifestProfileMismatch();
  }
  return { ...contract, manifestUrl, manifestSha256, manifestBytes };
}

export async function verifyTestnetDeploymentManifests(input: {
  readonly profile: TestnetDeploymentManifestProfile;
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => Date;
}): Promise<TestnetDeploymentManifestVerificationEvidence> {
  let expected: Map<TestnetDeploymentContractRole, ExpectedContract>;
  try {
    expected = expectedContracts(input.profile);
  } catch (error) {
    if (error instanceof TestnetDeploymentManifestError) {
      throw error;
    }
    throw configurationInvalid();
  }
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const now = input.now ?? (() => new Date());
  if (typeof fetchImplementation !== "function" || typeof now !== "function") {
    throw configurationInvalid();
  }
  const urls = [...new Set([...expected.values()].map(({ manifestUrl }) => manifestUrl))];
  const settled = await Promise.allSettled(
    urls.map(async (url) => ({ url, bytes: await retrieveManifest(url, fetchImplementation) })),
  );
  const documents = settled.map((result) => {
    if (result.status === "rejected") {
      if (result.reason instanceof TestnetDeploymentManifestError) {
        throw result.reason;
      }
      throw manifestResponseInvalid();
    }
    return result.value;
  });
  return createTestnetDeploymentManifestVerificationEvidence({
    profile: input.profile,
    documents,
    verifiedAt: verifiedTimestamp(now),
  });
}

function validatedDocuments(
  value: readonly TestnetDeploymentManifestDocumentInput[],
  expected: ReadonlyMap<TestnetDeploymentContractRole, ExpectedContract>,
): ReadonlyMap<string, ValidatedDocument> {
  const expectedByUrl = new Map<string, ExpectedContract[]>();
  for (const expectation of expected.values()) {
    const existing = expectedByUrl.get(expectation.manifestUrl) ?? [];
    if (existing.some(({ manifestSha256 }) => manifestSha256 !== expectation.manifestSha256)) {
      throw configurationInvalid();
    }
    existing.push(expectation);
    expectedByUrl.set(expectation.manifestUrl, existing);
  }
  if (!Array.isArray(value) || value.length !== expectedByUrl.size) {
    throw manifestContentInvalid();
  }
  const documents = new Map<string, ValidatedDocument>();
  for (const candidate of Array.from(value)) {
    if (typeof candidate !== "object" || candidate === null) {
      throw manifestContentInvalid();
    }
    const url = publicUrl(candidate.url);
    const expectations = expectedByUrl.get(url);
    if (expectations === undefined || documents.has(url)) {
      throw manifestContentInvalid();
    }
    const bytes = ownedManifestBytes(candidate.bytes);
    const expectedHash = expectations[0]?.manifestSha256;
    if (expectedHash === undefined || sha256(bytes) !== expectedHash) {
      throw manifestHashMismatch();
    }
    const encoded = decodeManifest(bytes);
    const manifest = parsedManifest(encoded);
    if (serializeTestnetDeploymentManifest(manifest) !== encoded) {
      throw manifestContentInvalid();
    }
    if (
      expectations.some(
        ({ network, chainId }) => manifest.network !== network || manifest.chainId !== chainId,
      )
    ) {
      throw manifestProfileMismatch();
    }
    const expectedRoles = expectations.map(({ role }) => role).sort(roleOrder);
    if (
      manifest.contracts.length !== expectedRoles.length ||
      manifest.contracts.some((contract, index) => contract.role !== expectedRoles[index])
    ) {
      throw manifestContentInvalid();
    }
    documents.set(url, { manifest, bytes: bytes.byteLength });
  }
  return documents;
}

function expectedContracts(
  profile: TestnetDeploymentManifestProfile,
): Map<TestnetDeploymentContractRole, ExpectedContract> {
  if (
    typeof profile !== "object" ||
    profile === null ||
    profile.network !== "SN_SEPOLIA" ||
    typeof profile.chainId !== "string"
  ) {
    throw configurationInvalid();
  }
  const expected = new Map<TestnetDeploymentContractRole, ExpectedContract>([
    [
      "privacy_pool",
      {
        role: "privacy_pool",
        network: "SN_SEPOLIA",
        chainId: canonicalFelt(profile.chainId, false),
        address: canonicalAddress(profile.pool?.address),
        classHash: canonicalFelt(profile.pool?.classHash, false),
        version: version(profile.pool?.version),
        transactionReference: canonicalFelt(profile.pool?.deployment?.transactionReference, false),
        manifestUrl: publicUrl(profile.pool?.deployment?.manifestUrl),
        manifestSha256: sha256Hex(profile.pool?.deployment?.manifestSha256),
      } satisfies ExpectedContract,
    ],
    [
      "usdc_token",
      {
        role: "usdc_token",
        network: "SN_SEPOLIA",
        chainId: canonicalFelt(profile.chainId, false),
        address: canonicalAddress(profile.token?.address),
        classHash: canonicalFelt(profile.token?.classHash, false),
        version: version(profile.token?.version),
        transactionReference: canonicalFelt(profile.token?.deployment?.transactionReference, false),
        manifestUrl: publicUrl(profile.token?.deployment?.manifestUrl),
        manifestSha256: sha256Hex(profile.token?.deployment?.manifestSha256),
      } satisfies ExpectedContract,
    ],
  ]);
  const hashByUrl = new Map<string, string>();
  for (const contract of expected.values()) {
    const existing = hashByUrl.get(contract.manifestUrl);
    if (existing !== undefined && existing !== contract.manifestSha256) {
      throw configurationInvalid();
    }
    hashByUrl.set(contract.manifestUrl, contract.manifestSha256);
  }
  return expected;
}

function assertContractMatchesProfile(
  contract: TestnetDeploymentManifestContract,
  expected: ExpectedContract,
): void {
  if (
    contract.role !== expected.role ||
    contract.address !== expected.address ||
    contract.classHash !== expected.classHash ||
    contract.version !== expected.version ||
    contract.deployment.transactionReference !== expected.transactionReference
  ) {
    throw manifestProfileMismatch();
  }
  if (
    contract.role === "privacy_pool" &&
    (contract.source.repository !== STARKNET_PRIVACY_SOURCE_REPOSITORY ||
      contract.source.commit !== STARKNET_PRIVACY_SDK_COMMIT ||
      contract.source.contractPath !== STARKNET_PRIVACY_CONTRACT_PATH)
  ) {
    throw manifestProfileMismatch();
  }
}

function validatedManifestDocument(value: unknown): TestnetDeploymentManifestDocument {
  const record = plainRecord(value);
  if (
    field(record, "schemaVersion") !== TESTNET_DEPLOYMENT_MANIFEST_SCHEMA_VERSION ||
    field(record, "network") !== "SN_SEPOLIA"
  ) {
    throw manifestContentInvalid();
  }
  const contracts = denseArray(field(record, "contracts"), 1, 2).map((contract) =>
    validatedManifestContract(plainRecord(contract)),
  );
  const roles = contracts.map(({ role }) => role);
  if (
    new Set(roles).size !== roles.length ||
    roles.some(
      (role, index) =>
        index > 0 && roleOrder(roles[index - 1] as TestnetDeploymentContractRole, role) >= 0,
    )
  ) {
    throw manifestContentInvalid();
  }
  return {
    schemaVersion: TESTNET_DEPLOYMENT_MANIFEST_SCHEMA_VERSION,
    network: "SN_SEPOLIA",
    chainId: canonicalFelt(field(record, "chainId"), false),
    contracts,
  };
}

function validatedManifestContract(
  value: Record<string, unknown>,
): TestnetDeploymentManifestContract {
  const role = field(value, "role");
  const base = {
    address: canonicalAddress(field(value, "address")),
    classHash: canonicalFelt(field(value, "classHash"), false),
    version: version(field(value, "version")),
    source: validatedSource(field(value, "source")),
    deployment: validatedTransaction(field(value, "deployment")),
  };
  const configuration = plainRecord(field(value, "configuration"));
  if (role === "privacy_pool") {
    const governanceAdmin = canonicalAddress(field(configuration, "governanceAdmin"));
    const auditorPublicKey = canonicalFelt(field(configuration, "auditorPublicKey"), false);
    const screenerPublicKey = canonicalFelt(field(configuration, "screenerPublicKey"), false);
    const proofValidityBlocks = boundedDecimal(
      field(configuration, "proofValidityBlocks"),
      U64_MAX,
      false,
    );
    const expectedCalldata = [
      governanceAdmin,
      auditorPublicKey,
      screenerPublicKey,
      `0x${BigInt(proofValidityBlocks).toString(16)}`,
    ];
    if (
      base.deployment.constructorCalldata.length !== expectedCalldata.length ||
      base.deployment.constructorCalldata.some((felt, index) => felt !== expectedCalldata[index])
    ) {
      throw manifestContentInvalid();
    }
    return {
      role,
      ...base,
      configuration: {
        governanceAdmin,
        auditorPublicKey,
        screenerPublicKey,
        proofValidityBlocks,
      },
    };
  }
  if (role === "usdc_token") {
    if (
      field(configuration, "symbol") !== "USDC" ||
      field(configuration, "decimals") !== 6 ||
      field(configuration, "supplyPolicy") !== "capped_test_supply_v1"
    ) {
      throw manifestContentInvalid();
    }
    return {
      role,
      ...base,
      configuration: {
        symbol: "USDC",
        decimals: 6,
        mintAuthority: canonicalAddress(field(configuration, "mintAuthority")),
        supplyPolicy: "capped_test_supply_v1",
        maximumSupplyBaseUnits: boundedDecimal(
          field(configuration, "maximumSupplyBaseUnits"),
          U256_MAX,
          false,
        ),
      },
    };
  }
  throw manifestContentInvalid();
}

function validatedSource(value: unknown): TestnetDeploymentManifestSource {
  const source = plainRecord(value);
  const contractPath = field(source, "contractPath");
  if (
    typeof contractPath !== "string" ||
    contractPath.length < 1 ||
    contractPath.length > MAXIMUM_CONTRACT_PATH_LENGTH ||
    contractPath.startsWith("/") ||
    contractPath.includes("\\") ||
    !PATH_PATTERN.test(contractPath) ||
    contractPath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw manifestContentInvalid();
  }
  const commit = field(source, "commit");
  if (typeof commit !== "string" || !COMMIT_PATTERN.test(commit)) {
    throw manifestContentInvalid();
  }
  return {
    repository: publicUrl(field(source, "repository")),
    commit,
    contractPath,
  };
}

function validatedTransaction(value: unknown): TestnetDeploymentManifestTransaction {
  const deployment = plainRecord(value);
  const constructorCalldata = denseArray(
    field(deployment, "constructorCalldata"),
    0,
    MAXIMUM_CONSTRUCTOR_CALLDATA,
  ).map((felt) => canonicalFelt(felt, true));
  const unique = field(deployment, "unique");
  if (typeof unique !== "boolean") {
    throw manifestContentInvalid();
  }
  return {
    transactionReference: canonicalFelt(field(deployment, "transactionReference"), false),
    acceptedBlockHash: canonicalFelt(field(deployment, "acceptedBlockHash"), false),
    acceptedBlockNumber: boundedDecimal(field(deployment, "acceptedBlockNumber"), U64_MAX, true),
    deployer: canonicalAddress(field(deployment, "deployer")),
    salt: canonicalFelt(field(deployment, "salt"), true),
    unique,
    constructorCalldata,
  };
}

async function retrieveManifest(
  url: string,
  fetchImplementation: typeof fetch,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchImplementation(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "identity",
        "User-Agent": "cashu-strk20-deployment-manifest-verifier/1",
      },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
    });
  } catch {
    throw manifestUnavailable();
  }
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // The HTTP status already establishes that the manifest is unavailable.
    }
    throw manifestUnavailable();
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const contentEncoding = response.headers.get("content-encoding");
  if (
    contentType !== "application/json" ||
    (contentEncoding !== null && contentEncoding.toLowerCase() !== "identity")
  ) {
    throw manifestResponseInvalid();
  }
  return boundedResponseBody(response);
}

async function boundedResponseBody(response: Response): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!UNSIGNED_DECIMAL_PATTERN.test(length) || Number(length) > MAXIMUM_MANIFEST_BYTES)
  ) {
    throw manifestResponseInvalid();
  }
  if (response.body === null) {
    throw manifestResponseInvalid();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let failure: TestnetDeploymentManifestError | undefined;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      if (!(result.value instanceof Uint8Array)) {
        throw manifestResponseInvalid();
      }
      total += result.value.byteLength;
      if (!Number.isSafeInteger(total) || total > MAXIMUM_MANIFEST_BYTES) {
        throw manifestResponseInvalid();
      }
      chunks.push(Uint8Array.from(result.value));
    }
  } catch (error) {
    failure = error instanceof TestnetDeploymentManifestError ? error : manifestResponseInvalid();
  }
  try {
    reader.releaseLock();
  } catch {
    failure ??= manifestResponseInvalid();
  }
  if (failure !== undefined || total < 1) {
    throw failure ?? manifestResponseInvalid();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function ownedManifestBytes(value: Uint8Array): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < 1 ||
    value.byteLength > MAXIMUM_MANIFEST_BYTES
  ) {
    throw manifestContentInvalid();
  }
  return Uint8Array.from(value);
}

function decodeManifest(value: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw manifestContentInvalid();
  }
}

function parsedManifest(value: string): TestnetDeploymentManifestDocument {
  try {
    return validatedManifestDocument(JSON.parse(value) as unknown);
  } catch (error) {
    if (error instanceof TestnetDeploymentManifestError) {
      throw error;
    }
    throw manifestContentInvalid();
  }
}

function publicUrl(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAXIMUM_URL_LENGTH ||
    value !== value.trim()
  ) {
    throw manifestContentInvalid();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw manifestContentInvalid();
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    LOOPBACK_HOSTS.has(url.hostname) ||
    url.hostname.endsWith(".localhost")
  ) {
    throw manifestContentInvalid();
  }
  return url.href;
}

function canonicalAddress(value: unknown): string {
  return canonicalFelt(value, false, STARKNET_ADDRESS_BOUND);
}

function canonicalFelt(
  value: unknown,
  allowZero: boolean,
  maximumExclusive = STARKNET_FIELD_PRIME,
): string {
  if (
    typeof value !== "string" ||
    value.length > MAXIMUM_FELT_LENGTH ||
    !FELT_PATTERN.test(value)
  ) {
    throw manifestContentInvalid();
  }
  let felt: bigint;
  try {
    felt = BigInt(value);
  } catch {
    throw manifestContentInvalid();
  }
  if ((!allowZero && felt === 0n) || felt >= maximumExclusive) {
    throw manifestContentInvalid();
  }
  const canonical = `0x${felt.toString(16)}`;
  if (canonical !== value) {
    throw manifestContentInvalid();
  }
  return value;
}

function boundedDecimal(value: unknown, maximum: bigint, allowZero: boolean): string {
  if (
    typeof value !== "string" ||
    value.length > MAXIMUM_DECIMAL_LENGTH ||
    !UNSIGNED_DECIMAL_PATTERN.test(value)
  ) {
    throw manifestContentInvalid();
  }
  const number = BigInt(value);
  if ((!allowZero && number === 0n) || number > maximum) {
    throw manifestContentInvalid();
  }
  return value;
}

function version(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAXIMUM_VERSION_LENGTH ||
    !VERSION_PATTERN.test(value)
  ) {
    throw manifestContentInvalid();
  }
  return value;
}

function sha256Hex(value: unknown): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw manifestContentInvalid();
  }
  return value;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256")
    .update(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
    .digest("hex");
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > MAXIMUM_TIMESTAMP_LENGTH) {
    throw manifestContentInvalid();
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw manifestContentInvalid();
  }
  return value;
}

function verifiedTimestamp(now: () => Date): string {
  try {
    return canonicalTimestamp(now().toISOString());
  } catch {
    throw configurationInvalid();
  }
}

function denseArray(value: unknown, minimum: number, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw manifestContentInvalid();
  }
  return Array.from(value, (item, index) => {
    if (!Object.hasOwn(value, index)) {
      throw manifestContentInvalid();
    }
    return item;
  });
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw manifestContentInvalid();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw manifestContentInvalid();
  }
  return value as Record<string, unknown>;
}

function field(value: Readonly<Record<string, unknown>>, key: string): unknown {
  if (!Object.hasOwn(value, key)) {
    throw manifestContentInvalid();
  }
  return value[key];
}

function exactRecord(value: unknown, expected: Readonly<Record<string, unknown>>): boolean {
  try {
    const record = plainRecord(value);
    const keys = Object.keys(record);
    return (
      keys.length === Object.keys(expected).length &&
      keys.every((key) => Object.hasOwn(expected, key) && record[key] === expected[key])
    );
  } catch {
    return false;
  }
}

function positiveSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw manifestContentInvalid();
  }
  return value as number;
}

function roleOrder(
  left: TestnetDeploymentContractRole,
  right: TestnetDeploymentContractRole,
): number {
  return ROLE_ORDER.indexOf(left) - ROLE_ORDER.indexOf(right);
}

function configurationInvalid(): TestnetDeploymentManifestError {
  return new TestnetDeploymentManifestError(
    "configuration_invalid",
    "Testnet deployment manifest verification configuration is invalid",
  );
}

function manifestContentInvalid(): TestnetDeploymentManifestError {
  return new TestnetDeploymentManifestError(
    "manifest_content_invalid",
    "Testnet deployment manifest content is invalid",
  );
}

function manifestHashMismatch(): TestnetDeploymentManifestError {
  return new TestnetDeploymentManifestError(
    "manifest_hash_mismatch",
    "Testnet deployment manifest does not match its declared SHA-256",
  );
}

function manifestProfileMismatch(): TestnetDeploymentManifestError {
  return new TestnetDeploymentManifestError(
    "manifest_profile_mismatch",
    "Testnet deployment manifest conflicts with the configured contract profile",
  );
}

function manifestResponseInvalid(): TestnetDeploymentManifestError {
  return new TestnetDeploymentManifestError(
    "manifest_response_invalid",
    "Testnet deployment manifest returned an invalid response",
  );
}

function manifestUnavailable(): TestnetDeploymentManifestError {
  return new TestnetDeploymentManifestError(
    "manifest_unavailable",
    "Testnet deployment manifest is unavailable",
  );
}

interface ExpectedContract {
  readonly role: TestnetDeploymentContractRole;
  readonly network: "SN_SEPOLIA";
  readonly chainId: string;
  readonly address: string;
  readonly classHash: string;
  readonly version: string;
  readonly transactionReference: string;
  readonly manifestUrl: string;
  readonly manifestSha256: string;
}

interface ValidatedDocument {
  readonly manifest: TestnetDeploymentManifestDocument;
  readonly bytes: number;
}

const ROLE_ORDER = ["privacy_pool", "usdc_token"] as const;
const VERIFICATION_FLAGS = Object.freeze({
  manifestBytesRetrieved: true,
  manifestHashesMatch: true,
  canonicalJsonVerified: true,
  contractProfilesMatch: true,
  poolConstructorMatchesPinnedAbi: true,
  sourcePublishersAuthenticated: false,
  transactionReceiptsVerified: false,
  deploymentApproved: false,
} as const);
const VERIFICATION_BLOCKERS = Object.freeze([
  "manifest_publishers_unauthenticated",
  "deployment_transactions_unverified",
  "deployment_approval_required",
] as const);
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const FELT_PATTERN = /^0x[0-9a-f]+$/u;
const PATH_PATTERN = /^[A-Za-z0-9._/-]+$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UNSIGNED_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+:/@-]*$/u;
const STARKNET_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
const STARKNET_ADDRESS_BOUND = (1n << 251n) - 256n;
const U64_MAX = (1n << 64n) - 1n;
const U256_MAX = (1n << 256n) - 1n;
const MAXIMUM_CONSTRUCTOR_CALLDATA = 64;
const MAXIMUM_CONTRACT_PATH_LENGTH = 256;
const MAXIMUM_DECIMAL_LENGTH = 78;
const MAXIMUM_FELT_LENGTH = 66;
const MAXIMUM_FORBIDDEN_ADDRESSES = 16;
const MAXIMUM_MANIFEST_BYTES = 64 * 1024;
const MAXIMUM_TIMESTAMP_LENGTH = 32;
const MAXIMUM_URL_LENGTH = 2_048;
const MAXIMUM_VERSION_LENGTH = 128;
const REQUEST_TIMEOUT_MILLISECONDS = 10_000;
