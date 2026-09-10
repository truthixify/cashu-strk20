import type { BlockIdentifier, EventFilter, RpcProvider } from "starknet";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  type NamedStarknetContractUpgradeProvider,
  STARKNET_CONTRACT_UPGRADE_LINEAGE_VERIFIER_VERSION,
  STARKNET_CONTRACT_UPGRADE_VERIFIER_VERSION,
  STARKNET_IMPLEMENTATION_REPLACED_SELECTOR,
  STARKNET_REPLACE_TO_SELECTOR,
  type StarknetContractUpgradeClaim,
  type StarknetContractUpgradeLineageRpc,
  StarknetContractUpgradeLineageVerifier,
  type StarknetContractUpgradeRpc,
  StarknetContractUpgradeVerifier,
  StarknetContractUpgradeVerifierConfigurationError,
} from "./starknet-contract-upgrade-verifier.js";
import { STARKNET_TRANSACTION_FINALITY_POLICIES } from "./starknet-transaction-observer.js";

const CONTRACT = "0x254";
const PREVIOUS_CLASS = "0x56a";
const CLASS = "0x7e2";
const TRANSACTION = "0xfe7";
const SENDER = "0x3e6";
const BLOCK_NUMBER = 14_339_893;
const BLOCK_HASH = "0x331";
const PARENT_BLOCK_HASH = "0x3a4";
const SEPOLIA_CHAIN_ID = "0x534e5f5345504f4c4941";
const INITIAL_CLASS = "0x123";
const LINEAGE_HEAD_BLOCK_HASH = "0x999";

const FIRST_CLAIM: StarknetContractUpgradeClaim = Object.freeze({
  network: "SN_SEPOLIA",
  contractAddress: CONTRACT,
  previousClassHash: INITIAL_CLASS,
  classHash: PREVIOUS_CLASS,
  transactionHash: "0xa01",
  senderAddress: SENDER,
  blockNumber: 10_000_000,
  blockHash: "0x101",
  parentBlockHash: "0x100",
  finalityPolicy: STARKNET_TRANSACTION_FINALITY_POLICIES.L1,
});

const CLAIM: StarknetContractUpgradeClaim = Object.freeze({
  network: "SN_SEPOLIA",
  contractAddress: CONTRACT,
  previousClassHash: PREVIOUS_CLASS,
  classHash: CLASS,
  transactionHash: TRANSACTION,
  senderAddress: SENDER,
  blockNumber: BLOCK_NUMBER,
  blockHash: BLOCK_HASH,
  parentBlockHash: PARENT_BLOCK_HASH,
  finalityPolicy: STARKNET_TRANSACTION_FINALITY_POLICIES.L1,
});

describe("Starknet contract upgrade verifier", () => {
  it("verifies the canonical replace_to transaction, event, inclusion, and class transition", async () => {
    const first = new FakeUpgradeRpc();
    const second = new FakeUpgradeRpc();

    const evidence = await verifier(first, second).verify();

    expect(evidence).toEqual({
      network: "SN_SEPOLIA",
      contractAddress: CONTRACT,
      previousClassHash: PREVIOUS_CLASS,
      classHash: CLASS,
      transactionHash: TRANSACTION,
      senderAddress: SENDER,
      blockNumber: BLOCK_NUMBER,
      blockHash: BLOCK_HASH,
      parentBlockHash: PARENT_BLOCK_HASH,
      finalityPolicy: STARKNET_TRANSACTION_FINALITY_POLICIES.L1,
      finalityStatus: "ACCEPTED_ON_L1",
      entrypoint: "replace_to",
      entrypointSelector: STARKNET_REPLACE_TO_SELECTOR,
      event: "ImplementationReplaced",
      eventSelector: STARKNET_IMPLEMENTATION_REPLACED_SELECTOR,
      externalInitializerData: "NONE",
      finalImplementation: false,
      providerIds: ["publicnode", "cartridge"],
      verifierVersion: STARKNET_CONTRACT_UPGRADE_VERIFIER_VERSION,
    });
    expect(first.transactionHashes).toEqual([TRANSACTION, TRANSACTION]);
    expect(first.blockIdentifiers).toEqual([BLOCK_NUMBER]);
    expect(first.classBlockIdentifiers).toEqual([PARENT_BLOCK_HASH, BLOCK_HASH]);
  });

  it("rejects provider disagreement", async () => {
    const second = new FakeUpgradeRpc();
    second.block.parent_hash = "0x999";

    await expect(verifier(new FakeUpgradeRpc(), second).verify()).rejects.toMatchObject({
      code: "provider_disagreement",
    });
  });

  it.each([
    {
      name: "wrong chain",
      change: (rpc: FakeUpgradeRpc) => {
        rpc.chainId = "0x534e5f4d41494e";
      },
    },
    {
      name: "wrong transaction hash",
      change: (rpc: FakeUpgradeRpc) => {
        rpc.transaction.transaction_hash = "0x999";
      },
    },
    {
      name: "wrong transaction version",
      change: (rpc: FakeUpgradeRpc) => {
        rpc.transaction.version = "0x2";
      },
    },
    {
      name: "wrong sender",
      change: (rpc: FakeUpgradeRpc) => {
        rpc.transaction.sender_address = "0x999";
      },
    },
    {
      name: "wrong entrypoint",
      change: (rpc: FakeUpgradeRpc) => {
        rpc.transaction.calldata[2] = "0x999";
      },
    },
    {
      name: "unexpected external initializer",
      change: (rpc: FakeUpgradeRpc) => {
        rpc.transaction.calldata[5] = "0x0";
      },
    },
    {
      name: "final replacement",
      change: (rpc: FakeUpgradeRpc) => {
        rpc.transaction.calldata[6] = "0x1";
      },
    },
    {
      name: "reverted receipt",
      change: (rpc: FakeUpgradeRpc) => {
        rpc.receipt.execution_status = "REVERTED";
      },
    },
    {
      name: "missing upgrade event",
      change: (rpc: FakeUpgradeRpc) => {
        rpc.receipt.events = [];
      },
    },
    {
      name: "duplicate pool event",
      change: (rpc: FakeUpgradeRpc) => {
        rpc.receipt.events.push(upgradeEvent());
      },
    },
    {
      name: "wrong event data",
      change: (rpc: FakeUpgradeRpc) => {
        const event = rpc.receipt.events[0];
        if (event === undefined) throw new Error("missing fixture event");
        event.data[0] = "0x999";
      },
    },
    {
      name: "missing block inclusion",
      change: (rpc: FakeUpgradeRpc) => {
        rpc.block.transactions = ["0x111"];
      },
    },
    {
      name: "wrong parent class",
      change: (rpc: FakeUpgradeRpc) => {
        rpc.classHashes.set(PARENT_BLOCK_HASH, "0x999");
      },
    },
    {
      name: "wrong replacement class",
      change: (rpc: FakeUpgradeRpc) => {
        rpc.classHashes.set(BLOCK_HASH, "0x999");
      },
    },
  ])("rejects an agreed $name", async ({ change }) => {
    const first = new FakeUpgradeRpc();
    const second = new FakeUpgradeRpc();
    change(first);
    change(second);

    await expect(verifier(first, second).verify()).rejects.toMatchObject({
      code: "upgrade_mismatch",
    });
  });

  it("requires the configured finality policy", async () => {
    const first = new FakeUpgradeRpc();
    const second = new FakeUpgradeRpc();
    for (const rpc of [first, second]) {
      rpc.receipt.finality_status = "ACCEPTED_ON_L2";
      rpc.block.status = "ACCEPTED_ON_L2";
    }

    await expect(verifier(first, second).verify()).rejects.toMatchObject({
      code: "finality_not_satisfied",
    });
  });

  it("rejects malformed provider arrays", async () => {
    const first = new FakeUpgradeRpc();
    const second = new FakeUpgradeRpc();
    first.transaction.calldata = Array(1_025).fill("0x1");
    second.transaction.calldata = Array(1_025).fill("0x1");

    await expect(verifier(first, second).verify()).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("bounds and redacts provider failures", async () => {
    const secret = "credential-bearing-rpc-failure";
    const failing = new FakeUpgradeRpc();
    failing.failure = new Error(secret);
    try {
      await verifier(new FakeUpgradeRpc(), failing).verify();
      expect.unreachable("Provider failure was accepted");
    } catch (error) {
      expect(error).toMatchObject({ code: "provider_failure" });
      expect((error as Error).message).not.toContain(secret);
    }

    const hanging = new FakeUpgradeRpc();
    hanging.transactionPromise = new Promise<unknown>(() => undefined);
    await expect(verifier(new FakeUpgradeRpc(), hanging, 5).verify()).rejects.toMatchObject({
      code: "provider_failure",
    });
  });

  it("rejects invalid claims and duplicate providers before RPC access", () => {
    const provider = new FakeUpgradeRpc();
    expect(
      () =>
        new StarknetContractUpgradeVerifier({
          claim: { ...CLAIM, previousClassHash: CLASS },
          providers: namedProviders(provider, provider),
          requestTimeoutMilliseconds: 1_000,
        }),
    ).toThrow(StarknetContractUpgradeVerifierConfigurationError);
    expect(provider.transactionHashes).toEqual([]);
  });

  it("is structurally compatible with the pinned Starknet provider", () => {
    expectTypeOf<RpcProvider>().toMatchTypeOf<StarknetContractUpgradeRpc>();
  });
});

describe("Starknet contract upgrade lineage verifier", () => {
  it("verifies every transition and the complete filtered event inventory", async () => {
    const first = new FakeLineageRpc();
    const second = new FakeLineageRpc();

    const evidence = await lineageVerifier(first, second).verify();

    expect(evidence).toMatchObject({
      network: "SN_SEPOLIA",
      contractAddress: CONTRACT,
      initialClassHash: INITIAL_CLASS,
      inventoryFromBlockNumber: 9_000_000,
      inventoryThroughBlockHash: LINEAGE_HEAD_BLOCK_HASH,
      eventInventoryComplete: true,
      providerIds: ["publicnode", "cartridge"],
      verifierVersion: STARKNET_CONTRACT_UPGRADE_LINEAGE_VERIFIER_VERSION,
    });
    expect(evidence.upgrades.map(({ transactionHash }) => transactionHash)).toEqual([
      FIRST_CLAIM.transactionHash,
      CLAIM.transactionHash,
    ]);
    expect(first.eventFilters).toEqual([
      {
        from_block: { block_number: 9_000_000 },
        to_block: { block_hash: LINEAGE_HEAD_BLOCK_HASH },
        address: CONTRACT,
        keys: [[STARKNET_IMPLEMENTATION_REPLACED_SELECTOR]],
        chunk_size: 100,
      },
    ]);
  });

  it.each([
    {
      name: "missing transition",
      change: (rpc: FakeLineageRpc) => rpc.events.pop(),
    },
    {
      name: "extra transition",
      change: (rpc: FakeLineageRpc) =>
        rpc.events.push({ ...lineageEvent(CLAIM), block_hash: "0x888" }),
    },
    {
      name: "reordered transitions",
      change: (rpc: FakeLineageRpc) => rpc.events.reverse(),
    },
  ])("rejects an agreed $name", async ({ change }) => {
    const first = new FakeLineageRpc();
    const second = new FakeLineageRpc();
    change(first);
    change(second);

    await expect(lineageVerifier(first, second).verify()).rejects.toMatchObject({
      code: "upgrade_mismatch",
    });
  });

  it("collects empty continuation pages before comparing provider inventories", async () => {
    const first = new FakeLineageRpc();
    const second = new FakeLineageRpc();
    second.paginateAfterEmptyPage = true;

    await expect(lineageVerifier(first, second).verify()).resolves.toMatchObject({
      eventInventoryComplete: true,
    });
    expect(second.eventFilters).toHaveLength(2);
    expect(second.eventFilters[1]).toMatchObject({ continuation_token: "next-page" });
  });

  it("rejects a repeated continuation token", async () => {
    const first = new FakeLineageRpc();
    const second = new FakeLineageRpc();
    for (const rpc of [first, second]) rpc.continuationToken = "same-page";

    await expect(lineageVerifier(first, second).verify()).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("rejects provider disagreement on the event inventory", async () => {
    const second = new FakeLineageRpc();
    second.events.pop();

    await expect(lineageVerifier(new FakeLineageRpc(), second).verify()).rejects.toMatchObject({
      code: "provider_disagreement",
    });
  });

  it.each([
    {
      name: "initial class mismatch",
      upgrades: [{ ...FIRST_CLAIM, previousClassHash: "0x456" }, CLAIM],
    },
    {
      name: "broken intermediate continuity",
      upgrades: [FIRST_CLAIM, { ...CLAIM, previousClassHash: "0x456" }],
    },
    {
      name: "reordered block numbers",
      upgrades: [FIRST_CLAIM, { ...CLAIM, blockNumber: FIRST_CLAIM.blockNumber }],
    },
  ])("rejects $name before querying providers", ({ upgrades }) => {
    const provider = new FakeLineageRpc();
    expect(
      () =>
        new StarknetContractUpgradeLineageVerifier({
          network: "SN_SEPOLIA",
          contractAddress: CONTRACT,
          initialClassHash: INITIAL_CLASS,
          inventoryFromBlockNumber: 9_000_000,
          inventoryThroughBlockHash: LINEAGE_HEAD_BLOCK_HASH,
          upgrades,
          providers: [
            { id: "publicnode", provider },
            { id: "cartridge", provider: new FakeLineageRpc() },
          ],
          requestTimeoutMilliseconds: 1_000,
        }),
    ).toThrow(StarknetContractUpgradeVerifierConfigurationError);
    expect(provider.eventFilters).toEqual([]);
  });

  it("bounds and redacts event-inventory failures", async () => {
    const secret = "event-provider-secret";
    const failing = new FakeLineageRpc();
    failing.eventFailure = new Error(secret);
    try {
      await lineageVerifier(new FakeLineageRpc(), failing).verify();
      expect.unreachable("Event inventory failure was accepted");
    } catch (error) {
      expect(error).toMatchObject({ code: "provider_failure" });
      expect((error as Error).message).not.toContain(secret);
    }

    const hanging = new FakeLineageRpc();
    hanging.eventPromise = new Promise<unknown>(() => undefined);
    await expect(lineageVerifier(new FakeLineageRpc(), hanging, 5).verify()).rejects.toMatchObject({
      code: "provider_failure",
    });
  });

  it("is structurally compatible with the pinned Starknet provider", () => {
    expectTypeOf<RpcProvider>().toMatchTypeOf<StarknetContractUpgradeLineageRpc>();
  });
});

class FakeUpgradeRpc implements StarknetContractUpgradeRpc {
  chainId = SEPOLIA_CHAIN_ID;
  transaction = upgradeTransaction();
  receipt = acceptedReceipt();
  block = acceptedBlock();
  failure?: Error;
  transactionPromise?: Promise<unknown>;
  readonly classHashes = new Map<string, string>([
    [PARENT_BLOCK_HASH, PREVIOUS_CLASS],
    [BLOCK_HASH, CLASS],
  ]);
  readonly transactionHashes: string[] = [];
  readonly blockIdentifiers: BlockIdentifier[] = [];
  readonly classBlockIdentifiers: BlockIdentifier[] = [];

  async getChainId(): Promise<string> {
    if (this.failure) throw this.failure;
    return this.chainId;
  }

  async getTransactionByHash(transactionHash: string): Promise<unknown> {
    this.transactionHashes.push(transactionHash);
    if (this.failure) throw this.failure;
    if (this.transactionPromise) return this.transactionPromise;
    return this.transaction;
  }

  async getTransactionReceipt(transactionHash: string): Promise<unknown> {
    this.transactionHashes.push(transactionHash);
    if (this.failure) throw this.failure;
    return this.receipt;
  }

  async getBlockWithTxHashes(blockIdentifier: BlockIdentifier = "latest"): Promise<unknown> {
    this.blockIdentifiers.push(blockIdentifier);
    if (this.failure) throw this.failure;
    return this.block;
  }

  async getClassHashAt(
    _contractAddress: string,
    blockIdentifier?: BlockIdentifier,
  ): Promise<string> {
    if (blockIdentifier === undefined) throw new Error("missing block");
    this.classBlockIdentifiers.push(blockIdentifier);
    if (this.failure) throw this.failure;
    const value = this.classHashes.get(String(blockIdentifier));
    if (!value) throw new Error("unknown block");
    return value;
  }
}

class FakeLineageRpc implements StarknetContractUpgradeLineageRpc {
  readonly claims = [FIRST_CLAIM, CLAIM] as const;
  readonly eventFilters: EventFilter[] = [];
  readonly events = this.claims.map((claim) => lineageEvent(claim));
  continuationToken?: string;
  paginateAfterEmptyPage = false;
  eventFailure?: Error;
  eventPromise?: Promise<unknown>;

  async getChainId(): Promise<string> {
    return SEPOLIA_CHAIN_ID;
  }

  async getTransactionByHash(transactionHash: string): Promise<unknown> {
    return upgradeTransactionFor(this.claim(transactionHash));
  }

  async getTransactionReceipt(transactionHash: string): Promise<unknown> {
    return acceptedReceiptFor(this.claim(transactionHash));
  }

  async getBlockWithTxHashes(blockIdentifier: BlockIdentifier = "latest"): Promise<unknown> {
    const claim = this.claimByBlock(blockIdentifier);
    return acceptedBlockFor(claim);
  }

  async getClassHashAt(
    contractAddress: string,
    blockIdentifier?: BlockIdentifier,
  ): Promise<string> {
    if (contractAddress !== CONTRACT) throw new Error("unexpected contract");
    for (const claim of this.claims) {
      if (blockIdentifier === claim.parentBlockHash) return claim.previousClassHash;
      if (blockIdentifier === claim.blockHash) return claim.classHash;
    }
    throw new Error("unknown block");
  }

  async getEvents(eventFilter: EventFilter): Promise<unknown> {
    this.eventFilters.push(eventFilter);
    if (this.eventFailure) throw this.eventFailure;
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

  private claim(transactionHash: string): StarknetContractUpgradeClaim {
    const claim = this.claims.find((candidate) => candidate.transactionHash === transactionHash);
    if (!claim) throw new Error("unknown transaction");
    return claim;
  }

  private claimByBlock(blockIdentifier: BlockIdentifier): StarknetContractUpgradeClaim {
    const claim = this.claims.find((candidate) => candidate.blockNumber === blockIdentifier);
    if (!claim) throw new Error("unknown block");
    return claim;
  }
}

function verifier(
  first: StarknetContractUpgradeRpc,
  second: StarknetContractUpgradeRpc,
  requestTimeoutMilliseconds = 1_000,
): StarknetContractUpgradeVerifier {
  return new StarknetContractUpgradeVerifier({
    claim: CLAIM,
    providers: namedProviders(first, second),
    requestTimeoutMilliseconds,
  });
}

function lineageVerifier(
  first: StarknetContractUpgradeLineageRpc,
  second: StarknetContractUpgradeLineageRpc,
  requestTimeoutMilliseconds = 1_000,
): StarknetContractUpgradeLineageVerifier {
  return new StarknetContractUpgradeLineageVerifier({
    network: "SN_SEPOLIA",
    contractAddress: CONTRACT,
    initialClassHash: INITIAL_CLASS,
    inventoryFromBlockNumber: 9_000_000,
    inventoryThroughBlockHash: LINEAGE_HEAD_BLOCK_HASH,
    upgrades: [FIRST_CLAIM, CLAIM],
    providers: [
      { id: "publicnode", provider: first },
      { id: "cartridge", provider: second },
    ],
    requestTimeoutMilliseconds,
  });
}

function namedProviders(
  first: StarknetContractUpgradeRpc,
  second: StarknetContractUpgradeRpc,
): readonly NamedStarknetContractUpgradeProvider[] {
  return [
    { id: "publicnode", provider: first },
    { id: "cartridge", provider: second },
  ];
}

function upgradeTransaction() {
  return {
    transaction_hash: TRANSACTION,
    type: "INVOKE",
    version: "0x3",
    sender_address: SENDER,
    calldata: ["0x1", CONTRACT, STARKNET_REPLACE_TO_SELECTOR, "0x3", CLASS, "0x1", "0x0"],
  };
}

function acceptedReceipt() {
  return {
    type: "INVOKE",
    transaction_hash: TRANSACTION,
    block_hash: BLOCK_HASH,
    block_number: BLOCK_NUMBER,
    finality_status: "ACCEPTED_ON_L1",
    execution_status: "SUCCEEDED",
    events: [upgradeEvent()],
  };
}

function upgradeEvent() {
  return {
    from_address: CONTRACT,
    keys: [STARKNET_IMPLEMENTATION_REPLACED_SELECTOR],
    data: [CLASS, "0x1", "0x0"],
  };
}

function acceptedBlock() {
  return {
    status: "ACCEPTED_ON_L1",
    block_hash: BLOCK_HASH,
    block_number: BLOCK_NUMBER,
    parent_hash: PARENT_BLOCK_HASH,
    transactions: ["0x111", TRANSACTION, "0x222"],
  };
}

function upgradeTransactionFor(claim: StarknetContractUpgradeClaim) {
  return {
    transaction_hash: claim.transactionHash,
    type: "INVOKE",
    version: "0x3",
    sender_address: claim.senderAddress,
    calldata: [
      "0x1",
      claim.contractAddress,
      STARKNET_REPLACE_TO_SELECTOR,
      "0x3",
      claim.classHash,
      "0x1",
      "0x0",
    ],
  };
}

function acceptedReceiptFor(claim: StarknetContractUpgradeClaim) {
  return {
    type: "INVOKE",
    transaction_hash: claim.transactionHash,
    block_hash: claim.blockHash,
    block_number: claim.blockNumber,
    finality_status: "ACCEPTED_ON_L1",
    execution_status: "SUCCEEDED",
    events: [
      {
        from_address: claim.contractAddress,
        keys: [STARKNET_IMPLEMENTATION_REPLACED_SELECTOR],
        data: [claim.classHash, "0x1", "0x0"],
      },
    ],
  };
}

function acceptedBlockFor(claim: StarknetContractUpgradeClaim) {
  return {
    status: "ACCEPTED_ON_L1",
    block_hash: claim.blockHash,
    block_number: claim.blockNumber,
    parent_hash: claim.parentBlockHash,
    transactions: [claim.transactionHash],
  };
}

function lineageEvent(claim: StarknetContractUpgradeClaim) {
  return {
    block_hash: claim.blockHash,
    block_number: claim.blockNumber,
    transaction_hash: claim.transactionHash,
    from_address: claim.contractAddress,
    keys: [STARKNET_IMPLEMENTATION_REPLACED_SELECTOR],
    data: [claim.classHash, "0x1", "0x0"],
  };
}
