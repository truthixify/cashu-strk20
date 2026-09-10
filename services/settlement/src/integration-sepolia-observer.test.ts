import type { BlockIdentifier, Call, EventFilter, RpcProvider } from "starknet";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  integrationSepoliaAuthorityInventory,
  integrationSepoliaRoleMembership,
} from "./integration-sepolia-authority.test-helper.js";
import {
  INTEGRATION_SEPOLIA_OBSERVATION_SCHEMA_VERSION,
  INTEGRATION_SEPOLIA_OBSERVER_VERSION,
  type IntegrationSepoliaRpc,
  observeStarkwareIntegrationSepolia,
  STARKWARE_INTEGRATION_SEPOLIA_PROFILE,
} from "./integration-sepolia-observer.js";
import {
  STARKNET_COMMON_ROLES_AUTHORITY_VERIFIER_VERSION,
  STARKNET_ROLE_ADMIN_CHANGED_SELECTOR,
  STARKNET_ROLE_GRANTED_SELECTOR,
  STARKNET_ROLE_GRANTED_WITH_DELAY_SELECTOR,
  STARKNET_ROLE_REVOKED_SELECTOR,
  STARKWARE_COMMON_ROLES_SOURCE_REVISION,
} from "./starknet-common-roles-authority-verifier.js";
import {
  STARKNET_CONTRACT_UPGRADE_LINEAGE_VERIFIER_VERSION,
  STARKNET_CONTRACT_UPGRADE_VERIFIER_VERSION,
  STARKNET_IMPLEMENTATION_REPLACED_SELECTOR,
  STARKNET_REPLACE_TO_SELECTOR,
} from "./starknet-contract-upgrade-verifier.js";
import {
  STARKNET_DEPLOYMENT_ORIGIN_VERIFIER_VERSION,
  STARKNET_UDC_ADDRESS,
  STARKNET_UDC_CLASS_HASH,
  STARKNET_UDC_CONTRACT_DEPLOYED_SELECTOR,
} from "./starknet-deployment-origin-verifier.js";
import { STARKNET_DISCOVERY_HEAD_VERIFIER_VERSION } from "./starknet-discovery-head-verifier.js";
import { STARKNET_TRANSACTION_FINALITY_POLICIES } from "./starknet-transaction-observer.js";

const NOW_SECONDS = 2_000_000_000;
const BLOCK_NUMBER = 15_000_000;
const BLOCK_HASH = "0xabc";
const AUDITOR_KEY = "0x111";
const SCREENER_KEY = "0x222";
const FEE_AMOUNT = "0x1bc16d674ec80000";
const FEE_COLLECTOR = "0x333";
const SEPOLIA_CHAIN_ID = "0x534e5f5345504f4c4941";

describe("StarkWare integration Sepolia observer", () => {
  it("confirms the shared RC.6 pool and six-decimal USDC at one discovery block", async () => {
    const first = new FakeIntegrationRpc();
    const second = new FakeIntegrationRpc();
    const fetchImplementation = serviceFetch();

    const evidence = await observeStarkwareIntegrationSepolia({
      providers: namedProviders(first, second),
      fetchImplementation,
      now: fixedNow,
    });

    expect(evidence).toEqual({
      schemaVersion: INTEGRATION_SEPOLIA_OBSERVATION_SCHEMA_VERSION,
      observerVersion: INTEGRATION_SEPOLIA_OBSERVER_VERSION,
      observedAt: new Date(NOW_SECONDS * 1_000).toISOString(),
      profile: {
        id: "starkware-integration-sepolia",
        network: "SN_SEPOLIA",
        sources: STARKWARE_INTEGRATION_SEPOLIA_PROFILE.sources,
        rpcProviders: [
          { id: "publicnode", operator: "publicnode" },
          { id: "cartridge", operator: "cartridge" },
        ],
      },
      chain: {
        blockNumber: BLOCK_NUMBER,
        blockHash: BLOCK_HASH,
        blockTimestamp: NOW_SECONDS - 5,
        minimumAcceptedStatus: "ACCEPTED_ON_L1",
        providerIds: ["publicnode", "cartridge"],
        verifierVersion: STARKNET_DISCOVERY_HEAD_VERIFIER_VERSION,
      },
      deployment: expectedDeploymentEvidence(),
      replaceToLineage: expectedUpgradeLineage(),
      commonRolesAuthority: expect.objectContaining({
        network: "SN_SEPOLIA",
        contractAddress: STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.address,
        inventoryFromBlockNumber: Number(
          STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.deployment.deployment.acceptedBlockNumber,
        ),
        inventoryThroughBlockHash: BLOCK_HASH,
        inventorySha256:
          STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.authority.expectedInventorySha256,
        eventInventoryComplete: true,
        providerIds: ["publicnode", "cartridge"],
        roleSourceRevision: STARKWARE_COMMON_ROLES_SOURCE_REVISION,
        verifierVersion: STARKNET_COMMON_ROLES_AUTHORITY_VERIFIER_VERSION,
      }),
      pool: {
        address: STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.address,
        classHash: STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.classHash,
        version: "2.1",
        auditorPublicKey: AUDITOR_KEY,
        screenerPublicKey: SCREENER_KEY,
        proofValidityBlocks: 450,
        feeAmountFri: BigInt(FEE_AMOUNT).toString(10),
        feeCollector: FEE_COLLECTOR,
      },
      token: {
        address: STARKWARE_INTEGRATION_SEPOLIA_PROFILE.token.address,
        classHash: STARKWARE_INTEGRATION_SEPOLIA_PROFILE.token.classHash,
        symbol: "USDC",
        decimals: 6,
      },
      services: {
        discovery: {
          operator: "starkware-integration",
          configuredComponentVersion: "PRIVACY-0.14.3-RC.2",
          status: "OK",
          reportedLagSeconds: 5,
        },
        prover: {
          operator: "starkware-integration",
          configuredComponentVersion: "PRIVACY-0.14.3-RC.2",
          apiVersion: "0.10.3-rc.2",
        },
      },
      verification: {
        poolClassCompatible: true,
        poolConfigurationCompatible: true,
        usdcClassPinned: true,
        usdcDecimalsCompatible: true,
        discoveryChainStateVerified: true,
        proverApiCompatible: true,
        noTransactionSubmitted: true,
        noCashuOrPrivateTransactionDataSent: true,
        deploymentOwnerManifestVerified: false,
        poolDeploymentOriginVerified: true,
        poolReplaceToLineageVerified: true,
        poolCommonRolesAuthorityStateVerified: true,
        remoteRuntimeVersionsVerified: false,
        screeningRuntimeConfigurationVerified: false,
        screeningActivityVerified: false,
        fundedExecutionApproved: false,
      },
      blockers: [
        "deployment_owner_manifest_unverified",
        "remote_runtime_versions_unverified",
        "screening_runtime_configuration_unverified",
        "screening_activity_unverified",
        "settlement_account_unconfigured",
        "funded_execution_not_run",
      ],
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    const expectedBlocks = [
      BLOCK_NUMBER,
      STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.deployment.deployment.acceptedBlockNumber,
      ...STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.upgrades.map(({ blockNumber }) => blockNumber),
    ];
    expect(first.blockIdentifiers).toHaveLength(expectedBlocks.length);
    expect(first.blockIdentifiers).toEqual(expect.arrayContaining(expectedBlocks));
    expect(second.blockIdentifiers).toEqual(expect.arrayContaining(expectedBlocks));
    expect(first.stateBlockIdentifiers).toHaveLength(41);
    expect(first.stateBlockIdentifiers).toEqual(
      expect.arrayContaining([
        ...Array(9).fill(BLOCK_HASH),
        STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.deployment.deployment.acceptedBlockHash,
        ...STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.upgrades.flatMap(
          ({ blockHash, parentBlockHash }) => [parentBlockHash, blockHash],
        ),
        ...Array(20).fill(BLOCK_HASH),
      ]),
    );
    expect(second.stateBlockIdentifiers).toHaveLength(41);
    expect(first.eventFilters).toEqual([sharedEventFilter()]);
    expect(second.eventFilters).toEqual([sharedEventFilter()]);
    expect(evidence.commonRolesAuthority.events).toHaveLength(21);
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("sw-dev.io");
    expect(serialized).not.toContain("publicnode.com");
    expect(serialized).not.toContain("cartridge.gg");
  });

  it("rejects provider disagreement on shared pool state", async () => {
    const first = new FakeIntegrationRpc();
    const second = new FakeIntegrationRpc();
    second.views.set("get_fee_amount", ["0x1"]);

    await expect(observe(first, second)).rejects.toMatchObject({
      code: "provider_disagreement",
    });
  });

  it("rejects a shared pool without the pinned canonical upgrade transition", async () => {
    const first = new FakeIntegrationRpc();
    const second = new FakeIntegrationRpc();
    const upgrade = requiredUpgrade(-1);
    first.upgradeReceipts.set(upgrade.transactionHash, { ...upgradeReceipt(upgrade), events: [] });
    second.upgradeReceipts.set(upgrade.transactionHash, { ...upgradeReceipt(upgrade), events: [] });

    await expect(observe(first, second)).rejects.toMatchObject({ code: "upgrade_mismatch" });
  });

  it("rejects an agreed incomplete pool upgrade inventory", async () => {
    const first = new FakeIntegrationRpc();
    const second = new FakeIntegrationRpc();
    first.upgradeEvents.pop();
    second.upgradeEvents.pop();

    await expect(observe(first, second)).rejects.toMatchObject({ code: "upgrade_mismatch" });
  });

  it("rejects an agreed authority history outside the reviewed inventory", async () => {
    const first = new FakeIntegrationRpc();
    const second = new FakeIntegrationRpc();
    first.authorityEvents.pop();
    second.authorityEvents.pop();

    await expect(observe(first, second)).rejects.toMatchObject({ code: "authority_mismatch" });
  });

  it.each([
    {
      name: "wrong pool class",
      change: (rpc: FakeIntegrationRpc) => {
        rpc.classHashes.set(STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.address, "0x999");
      },
    },
    {
      name: "wrong USDC class",
      change: (rpc: FakeIntegrationRpc) => {
        rpc.classHashes.set(STARKWARE_INTEGRATION_SEPOLIA_PROFILE.token.address, "0x999");
      },
    },
    {
      name: "18-decimal token",
      change: (rpc: FakeIntegrationRpc) => {
        rpc.views.set("decimals", ["0x12"]);
      },
    },
    {
      name: "wrong pool version",
      change: (rpc: FakeIntegrationRpc) => {
        rpc.views.set("get_version", ["0x322e30"]);
      },
    },
    {
      name: "zero auditor key",
      change: (rpc: FakeIntegrationRpc) => {
        rpc.views.set("get_auditor_public_key", ["0x0"]);
      },
    },
    {
      name: "zero screener key",
      change: (rpc: FakeIntegrationRpc) => {
        rpc.views.set("get_screener_public_key", ["0x0"]);
      },
    },
    {
      name: "changed proof window",
      change: (rpc: FakeIntegrationRpc) => {
        rpc.views.set("get_proof_validity_blocks", ["0x1c1"]);
      },
    },
    {
      name: "fee without collector",
      change: (rpc: FakeIntegrationRpc) => {
        rpc.views.set("get_fee_collector", ["0x0"]);
      },
    },
  ])("rejects an agreed $name", async ({ change }) => {
    const first = new FakeIntegrationRpc();
    const second = new FakeIntegrationRpc();
    change(first);
    change(second);

    await expect(observe(first, second)).rejects.toMatchObject({ code: "profile_mismatch" });
  });

  it("accepts a zero fee with no collector", async () => {
    const first = new FakeIntegrationRpc();
    const second = new FakeIntegrationRpc();
    for (const rpc of [first, second]) {
      rpc.views.set("get_fee_amount", ["0x0"]);
      rpc.views.set("get_fee_collector", ["0x0"]);
    }

    await expect(observe(first, second)).resolves.toMatchObject({
      pool: { feeAmountFri: "0", feeCollector: "0x0" },
    });
  });

  it("rejects a stale discovery head", async () => {
    await expect(
      observe(new FakeIntegrationRpc(), new FakeIntegrationRpc(), {
        discoveryTimestamp: NOW_SECONDS - 181,
      }),
    ).rejects.toMatchObject({ code: "discovery_stale" });
  });

  it("rejects a mismatched prover API", async () => {
    await expect(
      observe(new FakeIntegrationRpc(), new FakeIntegrationRpc(), {
        proverVersion: "0.10.4",
      }),
    ).rejects.toMatchObject({ code: "prover_version_mismatch" });
  });

  it("rejects malformed and oversized service responses", async () => {
    const oversizedFetch: typeof fetch = async (input) => {
      if (String(input).endsWith("/health")) {
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json", "content-length": "65537" },
        });
      }
      return jsonResponse(proverBody());
    };

    await expect(
      observeStarkwareIntegrationSepolia({
        providers: namedProviders(new FakeIntegrationRpc(), new FakeIntegrationRpc()),
        fetchImplementation: oversizedFetch,
        now: fixedNow,
      }),
    ).rejects.toMatchObject({ code: "discovery_response_invalid" });
  });

  it("bounds a fetch implementation that never settles", async () => {
    const hangingFetch: typeof fetch = async (input) => {
      if (String(input).endsWith("/health")) {
        return new Promise<Response>(() => undefined);
      }
      return jsonResponse(proverBody());
    };

    await expect(
      observeStarkwareIntegrationSepolia({
        providers: namedProviders(new FakeIntegrationRpc(), new FakeIntegrationRpc()),
        fetchImplementation: hangingFetch,
        now: fixedNow,
        requestTimeoutMilliseconds: 5,
      }),
    ).rejects.toMatchObject({ code: "discovery_unavailable" });
  });

  it("bounds a service response body that never settles", async () => {
    const hangingBodyFetch: typeof fetch = async (input) => {
      if (String(input).endsWith("/health")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            pull: () => new Promise<void>(() => undefined),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return jsonResponse(proverBody());
    };

    await expect(
      observeStarkwareIntegrationSepolia({
        providers: namedProviders(new FakeIntegrationRpc(), new FakeIntegrationRpc()),
        fetchImplementation: hangingBodyFetch,
        now: fixedNow,
        requestTimeoutMilliseconds: 5,
      }),
    ).rejects.toMatchObject({ code: "discovery_unavailable" });
  });

  it("bounds a provider that never returns", async () => {
    const first = new FakeIntegrationRpc();
    const second = new FakeIntegrationRpc();
    second.classHashPromise = new Promise<string>(() => undefined);

    await expect(
      observeStarkwareIntegrationSepolia({
        providers: namedProviders(first, second),
        fetchImplementation: serviceFetch(),
        now: fixedNow,
        requestTimeoutMilliseconds: 5,
      }),
    ).rejects.toMatchObject({ code: "provider_failure" });
  });

  it("redacts provider and service errors", async () => {
    const secret = "credential-bearing-upstream-detail";
    const second = new FakeIntegrationRpc();
    second.failure = new Error(secret);
    try {
      await observe(new FakeIntegrationRpc(), second);
      expect.unreachable("Provider failure was accepted");
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }

    const failingFetch: typeof fetch = async () => {
      throw new Error(secret);
    };
    try {
      await observeStarkwareIntegrationSepolia({
        providers: namedProviders(new FakeIntegrationRpc(), new FakeIntegrationRpc()),
        fetchImplementation: failingFetch,
        now: fixedNow,
      });
      expect.unreachable("Service failure was accepted");
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it.each([
    { name: "one provider", providers: [{ id: "publicnode", provider: new FakeIntegrationRpc() }] },
    {
      name: "wrong order",
      providers: [
        { id: "cartridge", provider: new FakeIntegrationRpc() },
        { id: "publicnode", provider: new FakeIntegrationRpc() },
      ],
    },
    {
      name: "duplicate instance",
      providers: (() => {
        const provider = new FakeIntegrationRpc();
        return [
          { id: "publicnode", provider },
          { id: "cartridge", provider },
        ];
      })(),
    },
  ])("rejects a profile with $name", async ({ providers }) => {
    await expect(
      observeStarkwareIntegrationSepolia({
        providers,
        fetchImplementation: serviceFetch(),
        now: fixedNow,
      }),
    ).rejects.toMatchObject({ code: "profile_mismatch" });
  });

  it("is structurally compatible with the pinned Starknet provider", () => {
    expectTypeOf<RpcProvider>().toMatchTypeOf<IntegrationSepoliaRpc>();
  });
});

class FakeIntegrationRpc implements IntegrationSepoliaRpc {
  chainId = SEPOLIA_CHAIN_ID;
  block: unknown = acceptedBlock();
  deploymentReceiptValue: unknown = deploymentReceipt();
  deploymentBlockValue: unknown = deploymentBlock();
  readonly upgradeTransactions = new Map(
    STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.upgrades.map((upgrade) => [
      upgrade.transactionHash,
      upgradeTransaction(upgrade),
    ]),
  );
  readonly upgradeReceipts = new Map(
    STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.upgrades.map((upgrade) => [
      upgrade.transactionHash,
      upgradeReceipt(upgrade),
    ]),
  );
  readonly upgradeBlocks = new Map(
    STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.upgrades.map((upgrade) => [
      upgrade.blockNumber,
      upgradeBlock(upgrade),
    ]),
  );
  readonly upgradeEvents = STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.upgrades.map((upgrade) =>
    upgradeInventoryEvent(upgrade),
  );
  readonly authorityEvents = integrationSepoliaAuthorityInventory();
  failure?: Error;
  classHashPromise?: Promise<string>;
  readonly classHashes = new Map<string, string>([
    [
      STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.address,
      STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.classHash,
    ],
    [
      STARKWARE_INTEGRATION_SEPOLIA_PROFILE.token.address,
      STARKWARE_INTEGRATION_SEPOLIA_PROFILE.token.classHash,
    ],
  ]);
  readonly views = new Map<string, string[]>([
    ["get_version", [STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.versionFelt]],
    ["get_auditor_public_key", [AUDITOR_KEY]],
    ["get_screener_public_key", [SCREENER_KEY]],
    ["get_proof_validity_blocks", ["0x1c2"]],
    ["get_fee_amount", [FEE_AMOUNT]],
    ["get_fee_collector", [FEE_COLLECTOR]],
    ["decimals", ["0x6"]],
  ]);
  readonly blockIdentifiers: BlockIdentifier[] = [];
  readonly stateBlockIdentifiers: BlockIdentifier[] = [];
  readonly eventFilters: EventFilter[] = [];

  async getChainId(): Promise<string> {
    if (this.failure) throw this.failure;
    return this.chainId;
  }

  async getBlockWithTxHashes(blockIdentifier: BlockIdentifier = "latest"): Promise<unknown> {
    this.blockIdentifiers.push(blockIdentifier);
    if (this.failure) throw this.failure;
    if (
      String(blockIdentifier) ===
      STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.deployment.deployment.acceptedBlockNumber
    )
      return this.deploymentBlockValue;
    const upgradeBlockValue = this.upgradeBlocks.get(blockIdentifier as number);
    if (upgradeBlockValue !== undefined) return upgradeBlockValue;
    return this.block;
  }

  async getTransactionByHash(transactionHash: string): Promise<unknown> {
    if (this.failure) throw this.failure;
    const value = this.upgradeTransactions.get(transactionHash);
    if (value === undefined) throw new Error("unknown transaction");
    return value;
  }

  async getTransactionReceipt(transactionHash: string): Promise<unknown> {
    if (this.failure) throw this.failure;
    if (
      transactionHash ===
      STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.deployment.deployment.transactionReference
    )
      return this.deploymentReceiptValue;
    const value = this.upgradeReceipts.get(transactionHash);
    if (value === undefined) throw new Error("unknown transaction");
    return value;
  }

  async getClassHashAt(
    contractAddress: string,
    blockIdentifier?: BlockIdentifier,
  ): Promise<string> {
    if (blockIdentifier !== undefined) this.stateBlockIdentifiers.push(blockIdentifier);
    if (this.failure) throw this.failure;
    if (this.classHashPromise) return this.classHashPromise;
    const profile = STARKWARE_INTEGRATION_SEPOLIA_PROFILE;
    if (
      blockIdentifier === profile.pool.deployment.deployment.acceptedBlockHash &&
      contractAddress === profile.pool.address
    ) {
      return profile.pool.deployment.classHash;
    }
    if (
      blockIdentifier === profile.pool.deployment.deployment.acceptedBlockHash &&
      contractAddress === STARKNET_UDC_ADDRESS
    ) {
      return STARKNET_UDC_CLASS_HASH;
    }
    for (const upgrade of profile.pool.upgrades) {
      if (contractAddress === profile.pool.address && blockIdentifier === upgrade.parentBlockHash) {
        return upgrade.previousClassHash;
      }
      if (contractAddress === profile.pool.address && blockIdentifier === upgrade.blockHash) {
        return upgrade.classHash;
      }
    }
    const value = this.classHashes.get(contractAddress);
    if (!value) throw new Error("unknown class");
    return value;
  }

  async callContract(call: Call, blockIdentifier?: BlockIdentifier): Promise<string[]> {
    if (blockIdentifier !== undefined) this.stateBlockIdentifiers.push(blockIdentifier);
    if (this.failure) throw this.failure;
    const membership = integrationSepoliaRoleMembership(call);
    if (membership !== undefined) return membership;
    const value = this.views.get(call.entrypoint);
    if (!value) throw new Error("unknown view");
    return [...value];
  }

  async getEvents(eventFilter: EventFilter): Promise<unknown> {
    this.eventFilters.push(eventFilter);
    if (this.failure) throw this.failure;
    return {
      events: [...this.upgradeEvents, ...this.authorityEvents].sort(
        (left, right) => left.block_number - right.block_number,
      ),
    };
  }
}

function sharedEventFilter(): EventFilter {
  const profile = STARKWARE_INTEGRATION_SEPOLIA_PROFILE;
  return {
    from_block: { block_number: Number(profile.pool.deployment.deployment.acceptedBlockNumber) },
    to_block: { block_hash: BLOCK_HASH },
    address: profile.pool.address,
    keys: [
      [
        STARKNET_IMPLEMENTATION_REPLACED_SELECTOR,
        STARKNET_ROLE_GRANTED_SELECTOR,
        STARKNET_ROLE_GRANTED_WITH_DELAY_SELECTOR,
        STARKNET_ROLE_REVOKED_SELECTOR,
        STARKNET_ROLE_ADMIN_CHANGED_SELECTOR,
      ],
    ],
    chunk_size: 100,
  };
}

async function observe(
  first: FakeIntegrationRpc,
  second: FakeIntegrationRpc,
  serviceChange: ServiceChange = {},
) {
  return observeStarkwareIntegrationSepolia({
    providers: namedProviders(first, second),
    fetchImplementation: serviceFetch(serviceChange),
    now: fixedNow,
  });
}

function namedProviders(first: IntegrationSepoliaRpc, second: IntegrationSepoliaRpc) {
  return [
    { id: "publicnode", provider: first },
    { id: "cartridge", provider: second },
  ] as const;
}

interface ServiceChange {
  readonly discoveryTimestamp?: number;
  readonly proverVersion?: string;
}

function serviceFetch(change: ServiceChange = {}): typeof fetch {
  return vi.fn(async (input) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return jsonResponse({
        status: "OK",
        chain_head: {
          block_number: BLOCK_NUMBER,
          block_hash: BLOCK_HASH,
          timestamp: change.discoveryTimestamp ?? NOW_SECONDS - 5,
        },
        lag_secs: 5,
      });
    }
    return jsonResponse(proverBody(change.proverVersion));
  }) as typeof fetch;
}

function proverBody(version = "0.10.3-rc.2") {
  return { jsonrpc: "2.0", id: 1, result: version };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function acceptedBlock() {
  return {
    status: "ACCEPTED_ON_L1",
    block_hash: BLOCK_HASH,
    block_number: BLOCK_NUMBER,
    timestamp: NOW_SECONDS - 5,
    transactions: [],
  };
}

type ProfileUpgrade = (typeof STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.upgrades)[number];

function upgradeTransaction(upgrade: ProfileUpgrade) {
  const profile = STARKWARE_INTEGRATION_SEPOLIA_PROFILE;
  return {
    transaction_hash: upgrade.transactionHash,
    type: "INVOKE",
    version: "0x3",
    sender_address: upgrade.senderAddress,
    calldata: [
      "0x1",
      profile.pool.address,
      STARKNET_REPLACE_TO_SELECTOR,
      "0x3",
      upgrade.classHash,
      "0x1",
      "0x0",
    ],
  };
}

function upgradeReceipt(upgrade: ProfileUpgrade) {
  const profile = STARKWARE_INTEGRATION_SEPOLIA_PROFILE;
  return {
    type: "INVOKE",
    transaction_hash: upgrade.transactionHash,
    block_hash: upgrade.blockHash,
    block_number: upgrade.blockNumber,
    finality_status: "ACCEPTED_ON_L1",
    execution_status: "SUCCEEDED",
    events: [
      {
        from_address: profile.pool.address,
        keys: [STARKNET_IMPLEMENTATION_REPLACED_SELECTOR],
        data: [upgrade.classHash, "0x1", "0x0"],
      },
    ],
  };
}

function upgradeBlock(upgrade: ProfileUpgrade) {
  return {
    status: "ACCEPTED_ON_L1",
    block_hash: upgrade.blockHash,
    block_number: upgrade.blockNumber,
    parent_hash: upgrade.parentBlockHash,
    transactions: [upgrade.transactionHash],
  };
}

function upgradeInventoryEvent(upgrade: ProfileUpgrade) {
  return {
    block_hash: upgrade.blockHash,
    block_number: upgrade.blockNumber,
    transaction_hash: upgrade.transactionHash,
    from_address: STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.address,
    keys: [STARKNET_IMPLEMENTATION_REPLACED_SELECTOR],
    data: [upgrade.classHash, "0x1", "0x0"],
  };
}

function deploymentReceipt() {
  const profile = STARKWARE_INTEGRATION_SEPOLIA_PROFILE;
  const deployment = profile.pool.deployment.deployment;
  return {
    type: "INVOKE",
    transaction_hash: deployment.transactionReference,
    block_hash: deployment.acceptedBlockHash,
    block_number: Number(deployment.acceptedBlockNumber),
    finality_status: "ACCEPTED_ON_L1",
    execution_status: "SUCCEEDED",
    events: [
      {
        from_address: STARKNET_UDC_ADDRESS,
        keys: [STARKNET_UDC_CONTRACT_DEPLOYED_SELECTOR],
        data: [
          profile.pool.address,
          deployment.deployer,
          "0x1",
          profile.pool.deployment.classHash,
          `0x${deployment.constructorCalldata.length.toString(16)}`,
          ...deployment.constructorCalldata,
          deployment.salt,
        ],
      },
    ],
  };
}

function deploymentBlock() {
  const deployment = STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.deployment.deployment;
  return {
    status: "ACCEPTED_ON_L1",
    block_hash: deployment.acceptedBlockHash,
    block_number: Number(deployment.acceptedBlockNumber),
    transactions: [deployment.transactionReference],
  };
}

function expectedDeploymentEvidence() {
  const profile = STARKWARE_INTEGRATION_SEPOLIA_PROFILE;
  const deployment = profile.pool.deployment.deployment;
  return {
    network: "SN_SEPOLIA",
    finalityPolicy: STARKNET_TRANSACTION_FINALITY_POLICIES.L1,
    udcAddress: STARKNET_UDC_ADDRESS,
    udcClassHash: STARKNET_UDC_CLASS_HASH,
    deploymentEventSelector: STARKNET_UDC_CONTRACT_DEPLOYED_SELECTOR,
    contract: {
      role: "privacy_pool",
      address: profile.pool.address,
      classHash: profile.pool.deployment.classHash,
      transactionReference: deployment.transactionReference,
      blockHash: deployment.acceptedBlockHash,
      blockNumber: deployment.acceptedBlockNumber,
      deployer: deployment.deployer,
      salt: deployment.salt,
      unique: deployment.unique,
      constructorCalldata: deployment.constructorCalldata,
    },
    providerIds: ["publicnode", "cartridge"],
    verifierVersion: STARKNET_DEPLOYMENT_ORIGIN_VERIFIER_VERSION,
  };
}

function expectedUpgradeLineage() {
  const profile = STARKWARE_INTEGRATION_SEPOLIA_PROFILE;
  return {
    network: "SN_SEPOLIA",
    contractAddress: profile.pool.address,
    initialClassHash: profile.pool.deployment.classHash,
    inventoryFromBlockNumber: Number(profile.pool.deployment.deployment.acceptedBlockNumber),
    inventoryThroughBlockHash: BLOCK_HASH,
    upgrades: profile.pool.upgrades.map((upgrade) => ({
      network: "SN_SEPOLIA",
      contractAddress: profile.pool.address,
      previousClassHash: upgrade.previousClassHash,
      classHash: upgrade.classHash,
      transactionHash: upgrade.transactionHash,
      senderAddress: upgrade.senderAddress,
      blockNumber: upgrade.blockNumber,
      blockHash: upgrade.blockHash,
      parentBlockHash: upgrade.parentBlockHash,
      finalityPolicy: upgrade.finalityPolicy,
      finalityStatus: "ACCEPTED_ON_L1",
      entrypoint: "replace_to",
      entrypointSelector: STARKNET_REPLACE_TO_SELECTOR,
      event: "ImplementationReplaced",
      eventSelector: STARKNET_IMPLEMENTATION_REPLACED_SELECTOR,
      externalInitializerData: "NONE",
      finalImplementation: false,
      providerIds: ["publicnode", "cartridge"],
      verifierVersion: STARKNET_CONTRACT_UPGRADE_VERIFIER_VERSION,
    })),
    eventInventoryComplete: true,
    providerIds: ["publicnode", "cartridge"],
    verifierVersion: STARKNET_CONTRACT_UPGRADE_LINEAGE_VERIFIER_VERSION,
  };
}

function requiredUpgrade(index: number): ProfileUpgrade {
  const upgrade = STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.upgrades.at(index);
  if (upgrade === undefined) throw new Error("Missing profile upgrade fixture");
  return upgrade;
}

function fixedNow(): Date {
  return new Date(NOW_SECONDS * 1_000);
}
