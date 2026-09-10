import { createHash } from "node:crypto";

import type { StarknetNetwork } from "@cashu-strk20/strk20-method";
import { type BlockIdentifier, type Call, constants, type EventFilter, hash } from "starknet";

export const STARKNET_COMMON_ROLES_AUTHORITY_VERIFIER_VERSION =
  "starknet@10.5.0:common-roles-event-membership-consensus-v1";
export const STARKWARE_COMMON_ROLES_SOURCE_REVISION = "3e2fd53d99e16c87f6cf2ced53b8c842a2d54a18";
export const STARKNET_ROLE_GRANTED_SELECTOR =
  "0x9d4a59b844ac9d98627ddba326ab3707a7d7e105fd03c777569d0f61a91f1e";
export const STARKNET_ROLE_GRANTED_WITH_DELAY_SELECTOR =
  "0xb98db20e520a01fe400ba29dc6ba0456c03a14c49b3b69e2158fb2d43c0e75";
export const STARKNET_ROLE_REVOKED_SELECTOR =
  "0x2842fd3b01bb0858fef6a2da51cdd9f995c7d36d7625fb68dd5d69fcc0a6d76";
export const STARKNET_ROLE_ADMIN_CHANGED_SELECTOR =
  "0x2b23b0c08c7b22209aea4100552de1b7876a49f04ee5a4d94f83ad24bc4ec1c";

export const STARKNET_COMMON_ROLES = Object.freeze([
  Object.freeze({
    name: "APP_GOVERNOR",
    id: "0xd2ead78c620e94b02d0a996e99298c59ddccfa1d8a0149080ac3a20de06068",
  }),
  Object.freeze({
    name: "APP_ROLE_ADMIN",
    id: "0x3e615638e0b79444a70f8c695bf8f2a47033bf1cf95691ec3130f64939cee99",
  }),
  Object.freeze({
    name: "GOVERNANCE_ADMIN",
    id: "0x3711c9d994faf6055172091cb841fd4831aa743e6f3315163b06a122c841846",
  }),
  Object.freeze({
    name: "OPERATOR",
    id: "0x23edb77f7c8cc9e38e8afe78954f703aeeda7fffe014eeb6e56ea84e62f6da7",
  }),
  Object.freeze({
    name: "TOKEN_ADMIN",
    id: "0x128d63adbf6b09002c26caf55c47e2f26635807e3ef1b027218aa74c8d61a3e",
  }),
  Object.freeze({
    name: "UPGRADE_AGENT",
    id: "0x1d8034a6db21585e9d97ca912eb8113361e6858f64c45c9b321a4d01e949484",
  }),
  Object.freeze({
    name: "UPGRADE_GOVERNOR",
    id: "0x251e864ca2a080f55bce5da2452e8cfcafdbc951a3e7fff5023d558452ec228",
  }),
  Object.freeze({
    name: "SECURITY_ADMIN",
    id: "0x26bd110619d11cfdfc28e281df893bc24828e89177318e9dbd860cdaedeb6b3",
  }),
  Object.freeze({
    name: "SECURITY_AGENT",
    id: "0x37693ba312785932d430dccf0f56ffedd0aa7c0f8b6da2cc4530c2717689b96",
  }),
  Object.freeze({
    name: "SECURITY_GOVERNOR",
    id: "0xa5a83e9807e87f281d865ab54b7b0ed2f7f4bbfef73888810ca16e95e734eb",
  }),
] as const);

export type StarknetCommonRoleName = (typeof STARKNET_COMMON_ROLES)[number]["name"];
export type StarknetCommonRoleAdministrator = StarknetCommonRoleName | "DEFAULT_ADMIN_ROLE";

export interface StarknetCommonRoleAssignmentClaim {
  readonly role: StarknetCommonRoleName;
  readonly account: string;
}

export interface StarknetCommonRoleAdministratorClaim {
  readonly role: StarknetCommonRoleName;
  readonly administrator: StarknetCommonRoleAdministrator;
}

export interface StarknetCommonRolesAuthorityRpc {
  getChainId(): Promise<string>;
  getEvents(eventFilter: EventFilter): Promise<unknown>;
  callContract(call: Call, blockIdentifier?: BlockIdentifier): Promise<string[]>;
}

export interface NamedStarknetCommonRolesAuthorityProvider {
  readonly id: string;
  readonly provider: StarknetCommonRolesAuthorityRpc;
}

interface AuthorityEventBase {
  readonly blockHash: string;
  readonly blockNumber: number;
  readonly transactionHash: string;
  readonly role: StarknetCommonRoleName;
}

export type StarknetCommonRolesAuthorityEvent =
  | (AuthorityEventBase & {
      readonly kind: "ROLE_GRANTED" | "ROLE_REVOKED";
      readonly account: string;
      readonly sender: string;
    })
  | (AuthorityEventBase & {
      readonly kind: "ROLE_GRANTED_WITH_DELAY";
      readonly account: string;
      readonly sender: string;
      readonly delaySeconds: string;
    })
  | (AuthorityEventBase & {
      readonly kind: "ROLE_ADMIN_CHANGED";
      readonly previousAdministrator: StarknetCommonRoleAdministrator;
      readonly administrator: StarknetCommonRoleAdministrator;
    });

export interface StarknetCommonRolesAuthorityVerification {
  readonly network: "SN_SEPOLIA";
  readonly contractAddress: string;
  readonly inventoryFromBlockNumber: number;
  readonly inventoryThroughBlockHash: string;
  readonly inventorySha256: string;
  readonly eventInventoryComplete: true;
  readonly roles: typeof STARKNET_COMMON_ROLES;
  readonly roleAdministrators: readonly StarknetCommonRoleAdministratorClaim[];
  readonly assignments: readonly {
    readonly account: string;
    readonly roles: readonly StarknetCommonRoleName[];
  }[];
  readonly events: readonly StarknetCommonRolesAuthorityEvent[];
  readonly providerIds: readonly string[];
  readonly roleSourceRevision: typeof STARKWARE_COMMON_ROLES_SOURCE_REVISION;
  readonly verifierVersion: typeof STARKNET_COMMON_ROLES_AUTHORITY_VERIFIER_VERSION;
}

export type StarknetCommonRolesAuthorityVerifierErrorCode =
  | "authority_mismatch"
  | "invalid_response"
  | "provider_disagreement"
  | "provider_failure";

export class StarknetCommonRolesAuthorityVerifierConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StarknetCommonRolesAuthorityVerifierConfigurationError";
  }
}

export class StarknetCommonRolesAuthorityVerifierError extends Error {
  readonly code: StarknetCommonRolesAuthorityVerifierErrorCode;

  constructor(code: StarknetCommonRolesAuthorityVerifierErrorCode, message: string) {
    super(message);
    this.name = "StarknetCommonRolesAuthorityVerifierError";
    this.code = code;
  }
}

interface ValidatedConfig {
  readonly network: "SN_SEPOLIA";
  readonly contractAddress: string;
  readonly inventoryFromBlockNumber: number;
  readonly inventoryThroughBlockHash: string;
  readonly expectedEventCount: number;
  readonly expectedInventorySha256: string;
  readonly expectedAssignments: readonly StarknetCommonRoleAssignmentClaim[];
  readonly expectedRoleAdministrators: readonly StarknetCommonRoleAdministratorClaim[];
  readonly providers: readonly NamedStarknetCommonRolesAuthorityProvider[];
  readonly requestTimeoutMilliseconds: number;
}

interface AuthorityInventoryEvent {
  readonly blockHash: string;
  readonly blockNumber: number;
  readonly transactionHash: string;
  readonly fromAddress: string;
  readonly keys: readonly string[];
  readonly data: readonly string[];
}

interface AuthorityMembership {
  readonly role: StarknetCommonRoleName;
  readonly account: string;
  readonly active: boolean;
}

interface ProviderObservation {
  readonly providerId: string;
  readonly chainId: string;
  readonly events: readonly AuthorityInventoryEvent[];
  readonly memberships: readonly AuthorityMembership[];
}

export class StarknetCommonRolesAuthorityVerifier {
  readonly #config: ValidatedConfig;

  readonly verifierVersion = STARKNET_COMMON_ROLES_AUTHORITY_VERIFIER_VERSION;

  constructor(config: {
    readonly network: StarknetNetwork;
    readonly contractAddress: string;
    readonly inventoryFromBlockNumber: number;
    readonly inventoryThroughBlockHash: string;
    readonly expectedEventCount: number;
    readonly expectedInventorySha256: string;
    readonly expectedAssignments: readonly StarknetCommonRoleAssignmentClaim[];
    readonly expectedRoleAdministrators: readonly StarknetCommonRoleAdministratorClaim[];
    readonly providers: readonly NamedStarknetCommonRolesAuthorityProvider[];
    readonly requestTimeoutMilliseconds: number;
  }) {
    this.#config = validateConfig(config);
  }

  async verify(): Promise<StarknetCommonRolesAuthorityVerification> {
    const observations = await Promise.all(
      this.#config.providers.map((provider) => observeProvider(provider, this.#config)),
    );
    assertProviderAgreement(observations);
    const observation = requiredObservation(observations);
    if (observation.chainId !== STARKNET_SEPOLIA_CHAIN_ID) {
      throw authorityMismatch();
    }

    const inventorySha256 = authorityInventorySha256(observation.events);
    if (
      observation.events.length !== this.#config.expectedEventCount ||
      inventorySha256 !== this.#config.expectedInventorySha256
    ) {
      throw authorityMismatch();
    }
    const events = parseAuthorityEvents(observation.events, this.#config);
    const roleAdministrators = currentRoleAdministrators(events);
    assertExpectedRoleAdministrators(roleAdministrators, this.#config.expectedRoleAdministrators);
    assertExpectedAssignments(observation.memberships, this.#config.expectedAssignments);

    return {
      network: this.#config.network,
      contractAddress: this.#config.contractAddress,
      inventoryFromBlockNumber: this.#config.inventoryFromBlockNumber,
      inventoryThroughBlockHash: this.#config.inventoryThroughBlockHash,
      inventorySha256,
      eventInventoryComplete: true,
      roles: STARKNET_COMMON_ROLES,
      roleAdministrators,
      assignments: groupedAssignments(observation.memberships),
      events,
      providerIds: Object.freeze(this.#config.providers.map(({ id }) => id)),
      roleSourceRevision: STARKWARE_COMMON_ROLES_SOURCE_REVISION,
      verifierVersion: this.verifierVersion,
    };
  }
}

async function observeProvider(
  namedProvider: NamedStarknetCommonRolesAuthorityProvider,
  config: ValidatedConfig,
): Promise<ProviderObservation> {
  try {
    return await withTimeout(
      collectProviderObservation(namedProvider, config),
      config.requestTimeoutMilliseconds,
    );
  } catch (error) {
    if (error instanceof StarknetCommonRolesAuthorityVerifierError) {
      throw error;
    }
    throw providerFailure(namedProvider.id);
  }
}

async function collectProviderObservation(
  namedProvider: NamedStarknetCommonRolesAuthorityProvider,
  config: ValidatedConfig,
): Promise<ProviderObservation> {
  const [chainIdValue, events] = await Promise.all([
    namedProvider.provider.getChainId(),
    collectAuthorityInventory(namedProvider, config),
  ]);
  const candidates = membershipCandidates(events, config.expectedAssignments, namedProvider.id);
  const queries = candidates.flatMap((account) =>
    STARKNET_COMMON_ROLES.map(({ name, id }) => ({ role: name, roleId: id, account })),
  );
  const memberships = await mapWithConcurrency(
    queries,
    MAXIMUM_CONCURRENT_ROLE_READS,
    async ({ role, roleId, account }) => ({
      role,
      account,
      active: await readMembership(namedProvider, config, roleId, account),
    }),
  );
  return {
    providerId: namedProvider.id,
    chainId: providerNonzeroFelt(chainIdValue, namedProvider.id, "chain ID"),
    events,
    memberships: Object.freeze(memberships),
  };
}

async function collectAuthorityInventory(
  namedProvider: NamedStarknetCommonRolesAuthorityProvider,
  config: ValidatedConfig,
): Promise<readonly AuthorityInventoryEvent[]> {
  const events: AuthorityInventoryEvent[] = [];
  const continuationTokens = new Set<string>();
  let continuationToken: string | undefined;
  for (let page = 0; page < MAXIMUM_AUTHORITY_EVENT_PAGES; page += 1) {
    const value = await namedProvider.provider.getEvents({
      from_block: { block_number: config.inventoryFromBlockNumber },
      to_block: { block_hash: config.inventoryThroughBlockHash },
      address: config.contractAddress,
      keys: [
        [
          STARKNET_ROLE_GRANTED_SELECTOR,
          STARKNET_ROLE_GRANTED_WITH_DELAY_SELECTOR,
          STARKNET_ROLE_REVOKED_SELECTOR,
          STARKNET_ROLE_ADMIN_CHANGED_SELECTOR,
        ],
      ],
      chunk_size: MAXIMUM_AUTHORITY_EVENTS_PER_PAGE,
      ...(continuationToken === undefined ? {} : { continuation_token: continuationToken }),
    });
    const parsed = providerInventoryPage(value, namedProvider.id);
    events.push(...parsed.events);
    if (events.length > MAXIMUM_TOTAL_AUTHORITY_EVENTS) {
      throw authorityMismatch();
    }
    if (parsed.continuationToken === undefined) {
      return Object.freeze(events);
    }
    if (continuationTokens.has(parsed.continuationToken)) {
      throw invalidResponse(namedProvider.id, "authority event pagination");
    }
    continuationTokens.add(parsed.continuationToken);
    continuationToken = parsed.continuationToken;
  }
  throw invalidResponse(namedProvider.id, "authority event pagination");
}

function providerInventoryPage(
  value: unknown,
  providerId: string,
): {
  readonly events: readonly AuthorityInventoryEvent[];
  readonly continuationToken?: string;
} {
  const chunk = plainProviderRecord(value, providerId, "authority event inventory") as {
    readonly events?: unknown;
    readonly continuation_token?: unknown;
  };
  if (!Array.isArray(chunk.events)) {
    throw invalidResponse(providerId, "authority event inventory");
  }
  const events = Object.freeze(
    denseArray(chunk.events, MAXIMUM_AUTHORITY_EVENTS_PER_PAGE, () =>
      invalidResponse(providerId, "authority event inventory"),
    ).map((event) => providerInventoryEvent(event, providerId)),
  );
  const hasContinuation = Object.hasOwn(chunk, "continuation_token");
  if (
    hasContinuation &&
    (typeof chunk.continuation_token !== "string" ||
      chunk.continuation_token.length === 0 ||
      chunk.continuation_token.length > MAXIMUM_CONTINUATION_TOKEN_LENGTH)
  ) {
    throw invalidResponse(providerId, "authority event inventory");
  }
  return {
    events,
    ...(hasContinuation ? { continuationToken: chunk.continuation_token as string } : {}),
  };
}

function providerInventoryEvent(value: unknown, providerId: string): AuthorityInventoryEvent {
  const event = plainProviderRecord(value, providerId, "authority event") as {
    readonly block_hash?: unknown;
    readonly block_number?: unknown;
    readonly transaction_hash?: unknown;
    readonly from_address?: unknown;
    readonly keys?: unknown;
    readonly data?: unknown;
  };
  if (!Array.isArray(event.keys) || !Array.isArray(event.data)) {
    throw invalidResponse(providerId, "authority event");
  }
  return {
    blockHash: providerNonzeroFelt(event.block_hash, providerId, "event block hash"),
    blockNumber: providerBlockNumber(event.block_number, providerId, "event block number"),
    transactionHash: providerNonzeroFelt(
      event.transaction_hash,
      providerId,
      "event transaction hash",
    ),
    fromAddress: providerAddress(event.from_address, providerId, "event address"),
    keys: providerFeltArray(event.keys, MAXIMUM_EVENT_VALUES, providerId, "event keys"),
    data: providerFeltArray(event.data, MAXIMUM_EVENT_VALUES, providerId, "event data"),
  };
}

async function readMembership(
  namedProvider: NamedStarknetCommonRolesAuthorityProvider,
  config: ValidatedConfig,
  roleId: string,
  account: string,
): Promise<boolean> {
  const value: unknown = await namedProvider.provider.callContract(
    {
      contractAddress: config.contractAddress,
      entrypoint: "has_role",
      calldata: [roleId, account],
    },
    config.inventoryThroughBlockHash,
  );
  if (!Array.isArray(value) || value.length !== 1 || !Object.hasOwn(value, 0)) {
    throw invalidResponse(namedProvider.id, "role membership");
  }
  const result = providerFelt(value[0], namedProvider.id, "role membership");
  if (result !== "0x0" && result !== "0x1") {
    throw invalidResponse(namedProvider.id, "role membership");
  }
  return result === "0x1";
}

function membershipCandidates(
  events: readonly AuthorityInventoryEvent[],
  expectedAssignments: readonly StarknetCommonRoleAssignmentClaim[],
  providerId: string,
): readonly string[] {
  const accounts = new Set(expectedAssignments.map(({ account }) => account));
  for (const event of events) {
    const selector = event.keys[0];
    if (
      selector === STARKNET_ROLE_GRANTED_SELECTOR ||
      selector === STARKNET_ROLE_GRANTED_WITH_DELAY_SELECTOR ||
      selector === STARKNET_ROLE_REVOKED_SELECTOR
    ) {
      const account = event.data[1];
      if (account !== undefined) accounts.add(providerAddress(account, providerId, "role account"));
    }
  }
  if (accounts.size === 0 || accounts.size > MAXIMUM_AUTHORITY_ACCOUNTS) {
    throw authorityMismatch();
  }
  return Object.freeze([...accounts].sort(compareFelts));
}

function parseAuthorityEvents(
  inventory: readonly AuthorityInventoryEvent[],
  config: ValidatedConfig,
): readonly StarknetCommonRolesAuthorityEvent[] {
  let previousBlockNumber = 0;
  return Object.freeze(
    inventory.map((event) => {
      if (
        event.fromAddress !== config.contractAddress ||
        event.blockNumber < config.inventoryFromBlockNumber ||
        event.blockNumber < previousBlockNumber ||
        event.keys.length !== 1
      ) {
        throw authorityMismatch();
      }
      previousBlockNumber = event.blockNumber;
      const role = roleName(event.data[0]);
      const base = {
        blockHash: event.blockHash,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
        role,
      };
      switch (event.keys[0]) {
        case STARKNET_ROLE_GRANTED_SELECTOR:
        case STARKNET_ROLE_REVOKED_SELECTOR: {
          if (event.data.length !== 3) throw authorityMismatch();
          return {
            ...base,
            kind:
              event.keys[0] === STARKNET_ROLE_GRANTED_SELECTOR
                ? ("ROLE_GRANTED" as const)
                : ("ROLE_REVOKED" as const),
            account: authorityAddress(event.data[1]),
            sender: authorityAddress(event.data[2]),
          };
        }
        case STARKNET_ROLE_GRANTED_WITH_DELAY_SELECTOR: {
          if (event.data.length !== 4) throw authorityMismatch();
          const delay = feltU64(event.data[3]);
          return {
            ...base,
            kind: "ROLE_GRANTED_WITH_DELAY" as const,
            account: authorityAddress(event.data[1]),
            sender: authorityAddress(event.data[2]),
            delaySeconds: delay.toString(10),
          };
        }
        case STARKNET_ROLE_ADMIN_CHANGED_SELECTOR:
          if (event.data.length !== 3) throw authorityMismatch();
          return {
            ...base,
            kind: "ROLE_ADMIN_CHANGED" as const,
            previousAdministrator: administratorName(event.data[1]),
            administrator: administratorName(event.data[2]),
          };
        default:
          throw authorityMismatch();
      }
    }),
  );
}

function currentRoleAdministrators(
  events: readonly StarknetCommonRolesAuthorityEvent[],
): readonly StarknetCommonRoleAdministratorClaim[] {
  const administrators = new Map<StarknetCommonRoleName, StarknetCommonRoleAdministrator>(
    STARKNET_COMMON_ROLES.map(({ name }) => [name, "DEFAULT_ADMIN_ROLE"]),
  );
  for (const event of events) {
    if (event.kind !== "ROLE_ADMIN_CHANGED") continue;
    if (administrators.get(event.role) !== event.previousAdministrator) {
      throw authorityMismatch();
    }
    administrators.set(event.role, event.administrator);
  }
  return Object.freeze(
    STARKNET_COMMON_ROLES.map(({ name }) => ({
      role: name,
      administrator: requiredAdministrator(administrators, name),
    })),
  );
}

function groupedAssignments(
  memberships: readonly AuthorityMembership[],
): readonly { readonly account: string; readonly roles: readonly StarknetCommonRoleName[] }[] {
  const accounts = [...new Set(memberships.map(({ account }) => account))].sort(compareFelts);
  return Object.freeze(
    accounts.flatMap((account) => {
      const roles = Object.freeze(
        memberships
          .filter((membership) => membership.account === account && membership.active)
          .map(({ role }) => role),
      );
      return roles.length === 0 ? [] : [{ account, roles }];
    }),
  );
}

function assertProviderAgreement(observations: readonly ProviderObservation[]): void {
  const first = requiredObservation(observations);
  if (observations.some((observation) => !sameObservation(first, observation))) {
    throw new StarknetCommonRolesAuthorityVerifierError(
      "provider_disagreement",
      "Starknet providers disagreed on the common-roles authority state",
    );
  }
}

function sameObservation(left: ProviderObservation, right: ProviderObservation): boolean {
  return (
    left.chainId === right.chainId &&
    left.events.length === right.events.length &&
    left.events.every((event, index) => sameInventoryEvent(event, right.events[index])) &&
    left.memberships.length === right.memberships.length &&
    left.memberships.every((membership, index) => {
      const other = right.memberships[index];
      return (
        other !== undefined &&
        membership.role === other.role &&
        membership.account === other.account &&
        membership.active === other.active
      );
    })
  );
}

function sameInventoryEvent(
  left: AuthorityInventoryEvent,
  right: AuthorityInventoryEvent | undefined,
): boolean {
  return (
    right !== undefined &&
    left.blockHash === right.blockHash &&
    left.blockNumber === right.blockNumber &&
    left.transactionHash === right.transactionHash &&
    left.fromAddress === right.fromAddress &&
    arraysEqual(left.keys, right.keys) &&
    arraysEqual(left.data, right.data)
  );
}

function assertExpectedAssignments(
  memberships: readonly AuthorityMembership[],
  expectedAssignments: readonly StarknetCommonRoleAssignmentClaim[],
): void {
  const observed = memberships
    .filter(({ active }) => active)
    .map(({ role, account }) => assignmentKey(role, account))
    .sort();
  const expected = expectedAssignments
    .map(({ role, account }) => assignmentKey(role, account))
    .sort();
  if (!arraysEqual(observed, expected)) throw authorityMismatch();
}

function assertExpectedRoleAdministrators(
  observed: readonly StarknetCommonRoleAdministratorClaim[],
  expected: readonly StarknetCommonRoleAdministratorClaim[],
): void {
  const expectedByRole = new Map(expected.map((claim) => [claim.role, claim.administrator]));
  if (observed.some(({ role, administrator }) => expectedByRole.get(role) !== administrator)) {
    throw authorityMismatch();
  }
}

function validateConfig(value: unknown): ValidatedConfig {
  if (typeof value !== "object" || value === null) {
    throw configurationInvalid("authority verifier");
  }
  const config = value as {
    readonly network?: unknown;
    readonly contractAddress?: unknown;
    readonly inventoryFromBlockNumber?: unknown;
    readonly inventoryThroughBlockHash?: unknown;
    readonly expectedEventCount?: unknown;
    readonly expectedInventorySha256?: unknown;
    readonly expectedAssignments?: unknown;
    readonly expectedRoleAdministrators?: unknown;
    readonly providers?: unknown;
    readonly requestTimeoutMilliseconds?: unknown;
  };
  if (config.network !== "SN_SEPOLIA") throw configurationInvalid("authority network");
  return {
    network: config.network,
    contractAddress: configuredAddress(config.contractAddress, "authority contract"),
    inventoryFromBlockNumber: configuredPositiveInteger(
      config.inventoryFromBlockNumber,
      "authority inventory start block",
      Number.MAX_SAFE_INTEGER,
    ),
    inventoryThroughBlockHash: configuredNonzeroFelt(
      config.inventoryThroughBlockHash,
      "authority inventory head block hash",
    ),
    expectedEventCount: configuredPositiveInteger(
      config.expectedEventCount,
      "authority event count",
      MAXIMUM_TOTAL_AUTHORITY_EVENTS,
    ),
    expectedInventorySha256: configuredSha256(config.expectedInventorySha256),
    expectedAssignments: validatedAssignments(config.expectedAssignments),
    expectedRoleAdministrators: validatedRoleAdministrators(config.expectedRoleAdministrators),
    providers: validatedProviders(config.providers),
    requestTimeoutMilliseconds: configuredPositiveInteger(
      config.requestTimeoutMilliseconds,
      "authority request timeout",
      MAXIMUM_REQUEST_TIMEOUT_MILLISECONDS,
    ),
  };
}

function validatedAssignments(value: unknown): readonly StarknetCommonRoleAssignmentClaim[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAXIMUM_ROLE_ASSIGNMENTS) {
    throw configurationInvalid("authority assignments");
  }
  const seen = new Set<string>();
  return Object.freeze(
    denseArray(value, MAXIMUM_ROLE_ASSIGNMENTS, () =>
      configurationInvalid("authority assignments"),
    ).map((item) => {
      if (typeof item !== "object" || item === null) {
        throw configurationInvalid("authority assignment");
      }
      const assignment = item as { readonly role?: unknown; readonly account?: unknown };
      const role = configuredRoleName(assignment.role);
      const account = configuredAddress(assignment.account, "authority account");
      const key = assignmentKey(role, account);
      if (seen.has(key)) throw configurationInvalid("authority assignments");
      seen.add(key);
      return { role, account };
    }),
  );
}

function validatedRoleAdministrators(
  value: unknown,
): readonly StarknetCommonRoleAdministratorClaim[] {
  if (!Array.isArray(value) || value.length !== STARKNET_COMMON_ROLES.length) {
    throw configurationInvalid("role administrators");
  }
  const seen = new Set<StarknetCommonRoleName>();
  const claims = Object.freeze(
    denseArray(value, STARKNET_COMMON_ROLES.length, () =>
      configurationInvalid("role administrators"),
    ).map((item) => {
      if (typeof item !== "object" || item === null) {
        throw configurationInvalid("role administrator");
      }
      const claim = item as { readonly role?: unknown; readonly administrator?: unknown };
      const role = configuredRoleName(claim.role);
      const administrator = configuredAdministratorName(claim.administrator);
      if (seen.has(role)) throw configurationInvalid("role administrators");
      seen.add(role);
      return { role, administrator };
    }),
  );
  if (STARKNET_COMMON_ROLES.some(({ name }) => !seen.has(name))) {
    throw configurationInvalid("role administrators");
  }
  return claims;
}

function validatedProviders(value: unknown): readonly NamedStarknetCommonRolesAuthorityProvider[] {
  if (
    !Array.isArray(value) ||
    value.length < MINIMUM_PROVIDER_COUNT ||
    value.length > MAXIMUM_PROVIDER_COUNT
  ) {
    throw configurationInvalid("authority providers");
  }
  const ids = new Set<string>();
  const instances = new Set<StarknetCommonRolesAuthorityRpc>();
  return Object.freeze(
    Array.from(value, (item) => {
      if (
        typeof item !== "object" ||
        item === null ||
        typeof item.id !== "string" ||
        !PROVIDER_ID_PATTERN.test(item.id) ||
        typeof item.provider !== "object" ||
        item.provider === null ||
        typeof item.provider.getChainId !== "function" ||
        typeof item.provider.getEvents !== "function" ||
        typeof item.provider.callContract !== "function" ||
        ids.has(item.id) ||
        instances.has(item.provider)
      ) {
        throw configurationInvalid("authority providers");
      }
      ids.add(item.id);
      instances.add(item.provider);
      return { id: item.id, provider: item.provider };
    }),
  );
}

function roleName(value: string | undefined): StarknetCommonRoleName {
  const role = STARKNET_COMMON_ROLES.find(({ id }) => id === value);
  if (role === undefined) throw authorityMismatch();
  return role.name;
}

function administratorName(value: string | undefined): StarknetCommonRoleAdministrator {
  if (value === "0x0") return "DEFAULT_ADMIN_ROLE";
  return roleName(value);
}

function configuredRoleName(value: unknown): StarknetCommonRoleName {
  if (typeof value !== "string") throw configurationInvalid("authority role");
  const role = STARKNET_COMMON_ROLES.find(({ name }) => name === value);
  if (role === undefined) throw configurationInvalid("authority role");
  return role.name;
}

function configuredAdministratorName(value: unknown): StarknetCommonRoleAdministrator {
  if (value === "DEFAULT_ADMIN_ROLE") return value;
  return configuredRoleName(value);
}

function requiredAdministrator(
  administrators: ReadonlyMap<StarknetCommonRoleName, StarknetCommonRoleAdministrator>,
  role: StarknetCommonRoleName,
): StarknetCommonRoleAdministrator {
  const administrator = administrators.get(role);
  if (administrator === undefined) throw authorityMismatch();
  return administrator;
}

function requiredObservation(observations: readonly ProviderObservation[]): ProviderObservation {
  const observation = observations[0];
  if (observation === undefined) {
    throw new StarknetCommonRolesAuthorityVerifierError(
      "invalid_response",
      "The common-roles authority verifier has no provider evidence",
    );
  }
  return observation;
}

function authorityInventorySha256(events: readonly AuthorityInventoryEvent[]): string {
  return createHash("sha256").update(JSON.stringify(events), "utf8").digest("hex");
}

function assignmentKey(role: StarknetCommonRoleName, account: string): string {
  return `${role}:${account}`;
}

function authorityAddress(value: string | undefined): string {
  if (value === undefined || value === "0x0" || BigInt(value) >= STARKNET_ADDRESS_BOUND) {
    throw authorityMismatch();
  }
  return value;
}

function feltU64(value: string | undefined): bigint {
  if (value === undefined) throw authorityMismatch();
  const parsed = BigInt(value);
  if (parsed > MAXIMUM_U64) throw authorityMismatch();
  return parsed;
}

function plainProviderRecord(value: unknown, providerId: string, label: string): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidResponse(providerId, label);
  }
  return value;
}

function providerFeltArray(
  value: readonly unknown[],
  maximum: number,
  providerId: string,
  label: string,
): readonly string[] {
  return Object.freeze(
    denseArray(value, maximum, () => invalidResponse(providerId, label)).map((item) =>
      providerFelt(item, providerId, label),
    ),
  );
}

function providerAddress(value: unknown, providerId: string, label: string): string {
  const address = providerNonzeroFelt(value, providerId, label);
  if (BigInt(address) >= STARKNET_ADDRESS_BOUND) throw invalidResponse(providerId, label);
  return address;
}

function providerNonzeroFelt(value: unknown, providerId: string, label: string): string {
  const felt = providerFelt(value, providerId, label);
  if (felt === "0x0") throw invalidResponse(providerId, label);
  return felt;
}

function providerFelt(value: unknown, providerId: string, label: string): string {
  try {
    return canonicalFelt(value);
  } catch {
    throw invalidResponse(providerId, label);
  }
}

function providerBlockNumber(value: unknown, providerId: string, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw invalidResponse(providerId, label);
  }
  return value as number;
}

function configuredAddress(value: unknown, label: string): string {
  const address = configuredNonzeroFelt(value, label);
  if (BigInt(address) >= STARKNET_ADDRESS_BOUND) throw configurationInvalid(label);
  return address;
}

function configuredNonzeroFelt(value: unknown, label: string): string {
  let felt: string;
  try {
    felt = canonicalFelt(value);
  } catch {
    throw configurationInvalid(label);
  }
  if (felt === "0x0") throw configurationInvalid(label);
  return felt;
}

function canonicalFelt(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > MAXIMUM_FELT_TEXT_LENGTH ||
    !FELT_PATTERN.test(value)
  ) {
    throw new Error("Invalid Starknet felt");
  }
  const felt = BigInt(value);
  if (felt >= STARK_FIELD_PRIME) throw new Error("Invalid Starknet felt");
  return `0x${felt.toString(16)}`;
}

function configuredPositiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw configurationInvalid(label);
  }
  return value as number;
}

function configuredSha256(value: unknown): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw configurationInvalid("authority inventory digest");
  }
  return value;
}

function denseArray(
  value: readonly unknown[],
  maximum: number,
  error: () => Error,
): readonly unknown[] {
  if (value.length > maximum) throw error();
  return Array.from(value, (item, index) => {
    if (!Object.hasOwn(value, index)) throw error();
    return item;
  });
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  mapper: (value: Input) => Promise<Output>,
): Promise<readonly Output[]> {
  const results: Output[] = [];
  let nextIndex = 0;
  let stopped = false;
  const worker = async (): Promise<void> => {
    while (!stopped && nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value === undefined) continue;
      try {
        results[index] = await mapper(value);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => worker()),
  );
  return results;
}

function compareFelts(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function configurationInvalid(
  label: string,
): StarknetCommonRolesAuthorityVerifierConfigurationError {
  return new StarknetCommonRolesAuthorityVerifierConfigurationError(
    `Configured ${label} is invalid`,
  );
}

function invalidResponse(
  providerId: string,
  label: string,
): StarknetCommonRolesAuthorityVerifierError {
  return new StarknetCommonRolesAuthorityVerifierError(
    "invalid_response",
    `Starknet provider ${providerId} returned an invalid ${label}`,
  );
}

function providerFailure(providerId: string): StarknetCommonRolesAuthorityVerifierError {
  return new StarknetCommonRolesAuthorityVerifierError(
    "provider_failure",
    `Starknet provider ${providerId} could not read the common-roles authority state`,
  );
}

function authorityMismatch(): StarknetCommonRolesAuthorityVerifierError {
  return new StarknetCommonRolesAuthorityVerifierError(
    "authority_mismatch",
    "The contract common-roles authority state does not match the reviewed profile",
  );
}

function withTimeout<Value>(
  operation: Promise<Value>,
  timeoutMilliseconds: number,
): Promise<Value> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Starknet common-roles authority request timed out")),
      timeoutMilliseconds,
    );
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

const MINIMUM_PROVIDER_COUNT = 2;
const MAXIMUM_PROVIDER_COUNT = 16;
const MAXIMUM_REQUEST_TIMEOUT_MILLISECONDS = 120_000;
const MAXIMUM_AUTHORITY_EVENT_PAGES = 256;
const MAXIMUM_AUTHORITY_EVENTS_PER_PAGE = 100;
const MAXIMUM_TOTAL_AUTHORITY_EVENTS = 128;
const MAXIMUM_AUTHORITY_ACCOUNTS = 32;
const MAXIMUM_ROLE_ASSIGNMENTS = STARKNET_COMMON_ROLES.length * MAXIMUM_AUTHORITY_ACCOUNTS;
const MAXIMUM_CONCURRENT_ROLE_READS = 16;
const MAXIMUM_CONTINUATION_TOKEN_LENGTH = 1_024;
const MAXIMUM_EVENT_VALUES = 8;
const MAXIMUM_FELT_TEXT_LENGTH = 66;
const MAXIMUM_U64 = (1n << 64n) - 1n;
const STARKNET_ADDRESS_BOUND = (1n << 251n) - 256n;
const STARK_FIELD_PRIME = (1n << 251n) + (17n << 192n) + 1n;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const FELT_PATTERN = /^0x[0-9a-fA-F]+$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const STARKNET_SEPOLIA_CHAIN_ID = canonicalFelt(constants.StarknetChainId.SN_SEPOLIA);

if (
  hash.getSelectorFromName("RoleGranted") !== STARKNET_ROLE_GRANTED_SELECTOR ||
  hash.getSelectorFromName("RoleGrantedWithDelay") !== STARKNET_ROLE_GRANTED_WITH_DELAY_SELECTOR ||
  hash.getSelectorFromName("RoleRevoked") !== STARKNET_ROLE_REVOKED_SELECTOR ||
  hash.getSelectorFromName("RoleAdminChanged") !== STARKNET_ROLE_ADMIN_CHANGED_SELECTOR
) {
  throw new Error("starknet@10.5.0 selectors do not match the common-roles authority verifier");
}
