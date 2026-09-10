import { createHash } from "node:crypto";

import type { BlockIdentifier, Call, EventFilter, RpcProvider } from "starknet";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  type NamedStarknetCommonRolesAuthorityProvider,
  STARKNET_COMMON_ROLES,
  STARKNET_COMMON_ROLES_AUTHORITY_VERIFIER_VERSION,
  STARKNET_ROLE_ADMIN_CHANGED_SELECTOR,
  STARKNET_ROLE_GRANTED_SELECTOR,
  STARKNET_ROLE_GRANTED_WITH_DELAY_SELECTOR,
  STARKNET_ROLE_REVOKED_SELECTOR,
  STARKWARE_COMMON_ROLES_SOURCE_REVISION,
  type StarknetCommonRoleAdministratorClaim,
  type StarknetCommonRoleAssignmentClaim,
  type StarknetCommonRoleName,
  type StarknetCommonRolesAuthorityRpc,
  StarknetCommonRolesAuthorityVerifier,
  StarknetCommonRolesAuthorityVerifierConfigurationError,
} from "./starknet-common-roles-authority-verifier.js";

const CONTRACT = "0x254";
const HEAD_BLOCK_HASH = "0x999";
const ACCOUNT_A = "0x111";
const ACCOUNT_B = "0x222";
const DEPLOYER = "0x333";
const SEPOLIA_CHAIN_ID = "0x534e5f5345504f4c4941";

const ROLE_IDS = new Map<StarknetCommonRoleName, string>(
  STARKNET_COMMON_ROLES.map(({ name, id }) => [name, id]),
);

const EXPECTED_ADMINISTRATORS: readonly StarknetCommonRoleAdministratorClaim[] = Object.freeze([
  { role: "APP_GOVERNOR", administrator: "APP_ROLE_ADMIN" },
  { role: "APP_ROLE_ADMIN", administrator: "GOVERNANCE_ADMIN" },
  { role: "GOVERNANCE_ADMIN", administrator: "GOVERNANCE_ADMIN" },
  { role: "OPERATOR", administrator: "APP_ROLE_ADMIN" },
  { role: "TOKEN_ADMIN", administrator: "APP_ROLE_ADMIN" },
  { role: "UPGRADE_AGENT", administrator: "APP_ROLE_ADMIN" },
  { role: "UPGRADE_GOVERNOR", administrator: "GOVERNANCE_ADMIN" },
  { role: "SECURITY_ADMIN", administrator: "SECURITY_ADMIN" },
  { role: "SECURITY_AGENT", administrator: "SECURITY_ADMIN" },
  { role: "SECURITY_GOVERNOR", administrator: "SECURITY_ADMIN" },
]);

const EXPECTED_ASSIGNMENTS: readonly StarknetCommonRoleAssignmentClaim[] = Object.freeze([
  { role: "GOVERNANCE_ADMIN", account: ACCOUNT_A },
  { role: "UPGRADE_GOVERNOR", account: ACCOUNT_A },
  { role: "UPGRADE_GOVERNOR", account: ACCOUNT_B },
  { role: "SECURITY_AGENT", account: ACCOUNT_B },
]);

describe("Starknet common-roles authority verifier", () => {
  it("verifies the exact event history, administrators, and active memberships", async () => {
    const first = new FakeAuthorityRpc();
    const second = new FakeAuthorityRpc();

    const evidence = await verifier(first, second).verify();

    expect(evidence).toMatchObject({
      network: "SN_SEPOLIA",
      contractAddress: CONTRACT,
      inventoryFromBlockNumber: 100,
      inventoryThroughBlockHash: HEAD_BLOCK_HASH,
      inventorySha256: inventorySha256(first.events),
      eventInventoryComplete: true,
      providerIds: ["publicnode", "cartridge"],
      roleSourceRevision: STARKWARE_COMMON_ROLES_SOURCE_REVISION,
      verifierVersion: STARKNET_COMMON_ROLES_AUTHORITY_VERIFIER_VERSION,
    });
    expect(evidence.roleAdministrators).toEqual(EXPECTED_ADMINISTRATORS);
    expect(evidence.assignments).toEqual([
      { account: ACCOUNT_A, roles: ["GOVERNANCE_ADMIN", "UPGRADE_GOVERNOR"] },
      { account: ACCOUNT_B, roles: ["UPGRADE_GOVERNOR", "SECURITY_AGENT"] },
    ]);
    expect(evidence.events.at(-1)).toMatchObject({
      kind: "ROLE_GRANTED_WITH_DELAY",
      role: "SECURITY_AGENT",
      account: ACCOUNT_B,
      delaySeconds: "30",
    });
    expect(first.eventFilters).toEqual([
      {
        from_block: { block_number: 100 },
        to_block: { block_hash: HEAD_BLOCK_HASH },
        address: CONTRACT,
        keys: [
          [
            STARKNET_ROLE_GRANTED_SELECTOR,
            STARKNET_ROLE_GRANTED_WITH_DELAY_SELECTOR,
            STARKNET_ROLE_REVOKED_SELECTOR,
            STARKNET_ROLE_ADMIN_CHANGED_SELECTOR,
          ],
        ],
        chunk_size: 100,
      },
    ]);
    expect(first.membershipBlocks).toEqual(
      Array.from({ length: STARKNET_COMMON_ROLES.length * 2 }, () => HEAD_BLOCK_HASH),
    );
  });

  it("rejects an agreed inventory outside the reviewed fingerprint", async () => {
    await expect(
      verifier(new FakeAuthorityRpc(), new FakeAuthorityRpc(), {
        expectedInventorySha256: "0".repeat(64),
      }).verify(),
    ).rejects.toMatchObject({ code: "authority_mismatch" });
  });

  it("rejects provider disagreement on role events", async () => {
    const second = new FakeAuthorityRpc();
    requiredEvent(second.events, second.events.length - 1).block_hash = "0x888";

    await expect(verifier(new FakeAuthorityRpc(), second).verify()).rejects.toMatchObject({
      code: "provider_disagreement",
    });
  });

  it("rejects provider disagreement on current membership", async () => {
    const second = new FakeAuthorityRpc();
    second.activeAssignments.delete(assignmentKey("SECURITY_AGENT", ACCOUNT_B));

    await expect(verifier(new FakeAuthorityRpc(), second).verify()).rejects.toMatchObject({
      code: "provider_disagreement",
    });
  });

  it("rejects an agreed current membership outside the reviewed assignment set", async () => {
    const first = new FakeAuthorityRpc();
    const second = new FakeAuthorityRpc();
    for (const rpc of [first, second]) {
      rpc.activeAssignments.delete(assignmentKey("SECURITY_AGENT", ACCOUNT_B));
    }

    await expect(verifier(first, second).verify()).rejects.toMatchObject({
      code: "authority_mismatch",
    });
  });

  it("rejects unknown role identifiers even when their inventory is pinned", async () => {
    const first = new FakeAuthorityRpc();
    const second = new FakeAuthorityRpc();
    for (const rpc of [first, second]) replaceEventData(rpc.events, 0, 0, "0x777");

    await expect(
      verifier(first, second, { expectedInventorySha256: inventorySha256(first.events) }).verify(),
    ).rejects.toMatchObject({ code: "authority_mismatch" });
  });

  it("rejects a discontinuous role-administrator history", async () => {
    const first = new FakeAuthorityRpc();
    const second = new FakeAuthorityRpc();
    for (const rpc of [first, second]) {
      replaceEventData(rpc.events, 0, 1, roleId("SECURITY_ADMIN"));
    }

    await expect(
      verifier(first, second, { expectedInventorySha256: inventorySha256(first.events) }).verify(),
    ).rejects.toMatchObject({ code: "authority_mismatch" });
  });

  it("collects empty continuation pages before verifying the inventory", async () => {
    const second = new FakeAuthorityRpc();
    second.paginateAfterEmptyPage = true;

    await expect(verifier(new FakeAuthorityRpc(), second).verify()).resolves.toMatchObject({
      eventInventoryComplete: true,
    });
    expect(second.eventFilters).toHaveLength(2);
    expect(second.eventFilters[1]).toMatchObject({ continuation_token: "next-page" });
  });

  it("rejects repeated continuation tokens", async () => {
    const first = new FakeAuthorityRpc();
    const second = new FakeAuthorityRpc();
    first.continuationToken = "same-page";
    second.continuationToken = "same-page";

    await expect(verifier(first, second).verify()).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("rejects invalid role membership responses", async () => {
    const first = new FakeAuthorityRpc();
    const second = new FakeAuthorityRpc();
    first.membershipResult = ["0x2"];
    second.membershipResult = ["0x2"];

    await expect(verifier(first, second).verify()).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("attributes an invalid event-derived account to the provider that returned it", async () => {
    const first = new FakeAuthorityRpc();
    replaceEventData(
      first.events,
      first.events.length - 1,
      1,
      "0x7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00",
    );

    await expect(
      verifier(first, new FakeAuthorityRpc(), {
        expectedInventorySha256: inventorySha256(first.events),
      }).verify(),
    ).rejects.toThrow("Starknet provider publicnode returned an invalid role account");
  });

  it("bounds concurrent role membership reads", async () => {
    const first = new FakeAuthorityRpc();
    const second = new FakeAuthorityRpc();
    first.trackMembershipConcurrency = true;
    second.trackMembershipConcurrency = true;

    await expect(verifier(first, second).verify()).resolves.toMatchObject({
      eventInventoryComplete: true,
    });
    expect(first.maximumConcurrentMembershipCalls).toBe(16);
    expect(second.maximumConcurrentMembershipCalls).toBe(16);
  });

  it("rejects a non-Sepolia provider consensus", async () => {
    const first = new FakeAuthorityRpc();
    const second = new FakeAuthorityRpc();
    first.chainId = "0x1";
    second.chainId = "0x1";

    await expect(verifier(first, second).verify()).rejects.toMatchObject({
      code: "authority_mismatch",
    });
  });

  it("bounds and redacts provider failures", async () => {
    const secret = "authority-provider-secret";
    const failing = new FakeAuthorityRpc();
    failing.failure = new Error(secret);
    try {
      await verifier(new FakeAuthorityRpc(), failing).verify();
      expect.unreachable("Provider failure was accepted");
    } catch (error) {
      expect(error).toMatchObject({ code: "provider_failure" });
      expect((error as Error).message).not.toContain(secret);
    }

    const hanging = new FakeAuthorityRpc();
    hanging.eventPromise = new Promise<unknown>(() => undefined);
    await expect(verifier(new FakeAuthorityRpc(), hanging, {}, 5).verify()).rejects.toMatchObject({
      code: "provider_failure",
    });
  });

  it("rejects invalid configuration before querying providers", () => {
    const provider = new FakeAuthorityRpc();
    expect(
      () =>
        new StarknetCommonRolesAuthorityVerifier({
          ...verifierConfig(provider, new FakeAuthorityRpc()),
          expectedAssignments: [
            requiredAssignment(EXPECTED_ASSIGNMENTS, 0),
            requiredAssignment(EXPECTED_ASSIGNMENTS, 0),
          ],
        }),
    ).toThrow(StarknetCommonRolesAuthorityVerifierConfigurationError);
    expect(provider.eventFilters).toEqual([]);
  });

  it("is structurally compatible with the pinned Starknet provider", () => {
    expectTypeOf<RpcProvider>().toMatchTypeOf<StarknetCommonRolesAuthorityRpc>();
  });
});

interface RawAuthorityEvent {
  block_hash: string;
  block_number: number;
  transaction_hash: string;
  from_address: string;
  keys: string[];
  data: string[];
}

class FakeAuthorityRpc implements StarknetCommonRolesAuthorityRpc {
  chainId = SEPOLIA_CHAIN_ID;
  readonly events = authorityEvents();
  readonly activeAssignments = new Set(
    EXPECTED_ASSIGNMENTS.map(({ role, account }) => assignmentKey(role, account)),
  );
  readonly eventFilters: EventFilter[] = [];
  readonly membershipBlocks: BlockIdentifier[] = [];
  continuationToken?: string;
  paginateAfterEmptyPage = false;
  membershipResult?: string[];
  failure?: Error;
  eventPromise?: Promise<unknown>;
  trackMembershipConcurrency = false;
  maximumConcurrentMembershipCalls = 0;
  #activeMembershipCalls = 0;

  async getChainId(): Promise<string> {
    if (this.failure) throw this.failure;
    return this.chainId;
  }

  async getEvents(eventFilter: EventFilter): Promise<unknown> {
    this.eventFilters.push(eventFilter);
    if (this.failure) throw this.failure;
    if (this.eventPromise) return this.eventPromise;
    if (this.paginateAfterEmptyPage && !("continuation_token" in eventFilter)) {
      return { events: [], continuation_token: "next-page" };
    }
    return {
      events: this.events,
      ...(this.continuationToken === undefined
        ? {}
        : { continuation_token: this.continuationToken }),
    };
  }

  async callContract(call: Call, blockIdentifier?: BlockIdentifier): Promise<string[]> {
    if (this.failure) throw this.failure;
    if (blockIdentifier === undefined) throw new Error("missing block");
    this.membershipBlocks.push(blockIdentifier);
    if (this.membershipResult) return this.membershipResult;
    if (
      call.entrypoint !== "has_role" ||
      !Array.isArray(call.calldata) ||
      call.calldata.length !== 2
    ) {
      throw new Error("unexpected call");
    }
    const role = roleName(String(call.calldata[0]));
    const account = String(call.calldata[1]);
    this.#activeMembershipCalls += 1;
    this.maximumConcurrentMembershipCalls = Math.max(
      this.maximumConcurrentMembershipCalls,
      this.#activeMembershipCalls,
    );
    try {
      if (this.trackMembershipConcurrency)
        await new Promise<void>((resolve) => setImmediate(resolve));
      return [this.activeAssignments.has(assignmentKey(role, account)) ? "0x1" : "0x0"];
    } finally {
      this.#activeMembershipCalls -= 1;
    }
  }
}

function verifier(
  first: FakeAuthorityRpc,
  second: FakeAuthorityRpc,
  change: { readonly expectedInventorySha256?: string } = {},
  requestTimeoutMilliseconds = 1_000,
): StarknetCommonRolesAuthorityVerifier {
  return new StarknetCommonRolesAuthorityVerifier({
    ...verifierConfig(first, second, requestTimeoutMilliseconds),
    expectedInventorySha256: change.expectedInventorySha256 ?? inventorySha256(first.events),
  });
}

function verifierConfig(
  first: StarknetCommonRolesAuthorityRpc,
  second: StarknetCommonRolesAuthorityRpc,
  requestTimeoutMilliseconds = 1_000,
) {
  return {
    network: "SN_SEPOLIA" as const,
    contractAddress: CONTRACT,
    inventoryFromBlockNumber: 100,
    inventoryThroughBlockHash: HEAD_BLOCK_HASH,
    expectedEventCount: authorityEvents().length,
    expectedInventorySha256: inventorySha256(authorityEvents()),
    expectedAssignments: EXPECTED_ASSIGNMENTS,
    expectedRoleAdministrators: EXPECTED_ADMINISTRATORS,
    providers: [
      { id: "publicnode", provider: first },
      { id: "cartridge", provider: second },
    ] satisfies readonly NamedStarknetCommonRolesAuthorityProvider[],
    requestTimeoutMilliseconds,
  };
}

function authorityEvents(): RawAuthorityEvent[] {
  const events = EXPECTED_ADMINISTRATORS.map(({ role, administrator }) =>
    rawEvent(STARKNET_ROLE_ADMIN_CHANGED_SELECTOR, [
      roleId(role),
      "0x0",
      administrator === "DEFAULT_ADMIN_ROLE" ? "0x0" : roleId(administrator),
    ]),
  );
  events.push(
    rawEvent(
      STARKNET_ROLE_GRANTED_SELECTOR,
      [roleId("GOVERNANCE_ADMIN"), ACCOUNT_A, DEPLOYER],
      101,
    ),
    rawEvent(
      STARKNET_ROLE_GRANTED_SELECTOR,
      [roleId("UPGRADE_GOVERNOR"), ACCOUNT_A, DEPLOYER],
      101,
    ),
    rawEvent(
      STARKNET_ROLE_GRANTED_SELECTOR,
      [roleId("UPGRADE_GOVERNOR"), ACCOUNT_B, ACCOUNT_A],
      101,
    ),
    rawEvent(STARKNET_ROLE_GRANTED_SELECTOR, [roleId("OPERATOR"), ACCOUNT_B, ACCOUNT_A], 102),
    rawEvent(STARKNET_ROLE_REVOKED_SELECTOR, [roleId("OPERATOR"), ACCOUNT_B, ACCOUNT_A], 103),
    rawEvent(
      STARKNET_ROLE_GRANTED_WITH_DELAY_SELECTOR,
      [roleId("SECURITY_AGENT"), ACCOUNT_B, ACCOUNT_A, "0x1e"],
      104,
    ),
  );
  return events;
}

function rawEvent(selector: string, data: string[], blockNumber = 100): RawAuthorityEvent {
  return {
    block_hash: `0x${blockNumber.toString(16)}`,
    block_number: blockNumber,
    transaction_hash: `0x${(blockNumber + data.length).toString(16)}`,
    from_address: CONTRACT,
    keys: [selector],
    data,
  };
}

function inventorySha256(events: readonly RawAuthorityEvent[]): string {
  const normalized = events.map((event) => ({
    blockHash: event.block_hash,
    blockNumber: event.block_number,
    transactionHash: event.transaction_hash,
    fromAddress: event.from_address,
    keys: event.keys,
    data: event.data,
  }));
  return createHash("sha256").update(JSON.stringify(normalized), "utf8").digest("hex");
}

function roleId(role: StarknetCommonRoleName): string {
  const value = ROLE_IDS.get(role);
  if (value === undefined) throw new Error("unknown role");
  return value;
}

function roleName(roleIdValue: string): StarknetCommonRoleName {
  const role = STARKNET_COMMON_ROLES.find(({ id }) => id === roleIdValue);
  if (role === undefined) throw new Error("unknown role");
  return role.name;
}

function assignmentKey(role: StarknetCommonRoleName, account: string): string {
  return `${role}:${account}`;
}

function requiredEvent(events: RawAuthorityEvent[], index: number): RawAuthorityEvent {
  const event = events[index];
  if (event === undefined) throw new Error("missing fixture event");
  return event;
}

function replaceEventData(
  events: RawAuthorityEvent[],
  eventIndex: number,
  dataIndex: number,
  value: string,
): void {
  const event = requiredEvent(events, eventIndex);
  if (event.data[dataIndex] === undefined) throw new Error("missing fixture event data");
  event.data[dataIndex] = value;
}

function requiredAssignment(
  assignments: readonly StarknetCommonRoleAssignmentClaim[],
  index: number,
): StarknetCommonRoleAssignmentClaim {
  const assignment = assignments[index];
  if (assignment === undefined) throw new Error("missing fixture assignment");
  return assignment;
}
