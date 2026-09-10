import type { BlockIdentifier, Call, EventFilter } from "starknet";
import { describe, expect, it, vi } from "vitest";

import {
  integrationSepoliaAuthorityInventory,
  integrationSepoliaRoleMembership,
} from "./integration-sepolia-authority.test-helper.js";
import { runIntegrationSepoliaObservationCommand } from "./integration-sepolia-command.js";
import {
  type IntegrationSepoliaRpc,
  STARKWARE_INTEGRATION_SEPOLIA_PROFILE,
} from "./integration-sepolia-observer.js";
import {
  STARKNET_ROLE_ADMIN_CHANGED_SELECTOR,
  STARKNET_ROLE_GRANTED_SELECTOR,
  STARKNET_ROLE_GRANTED_WITH_DELAY_SELECTOR,
  STARKNET_ROLE_REVOKED_SELECTOR,
} from "./starknet-common-roles-authority-verifier.js";
import {
  STARKNET_IMPLEMENTATION_REPLACED_SELECTOR,
  STARKNET_REPLACE_TO_SELECTOR,
} from "./starknet-contract-upgrade-verifier.js";
import {
  STARKNET_UDC_ADDRESS,
  STARKNET_UDC_CLASS_HASH,
  STARKNET_UDC_CONTRACT_DEPLOYED_SELECTOR,
} from "./starknet-deployment-origin-verifier.js";

const NOW_SECONDS = 2_000_000_000;
const BLOCK_NUMBER = 15_000_000;
const BLOCK_HASH = "0xabc";
const SEPOLIA_CHAIN_ID = "0x534e5f5345504f4c4941";

describe("Integration Sepolia observation command", () => {
  it("writes one sanitized observation for the fixed public profile", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const providerUrls: string[] = [];

    const exitCode = await runIntegrationSepoliaObservationCommand({
      createProvider: (url) => {
        providerUrls.push(url);
        return new FakeIntegrationRpc();
      },
      fetchImplementation: serviceFetch(),
      now: fixedNow,
      writeOutput: (value) => output.push(value),
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(providerUrls).toEqual(
      STARKWARE_INTEGRATION_SEPOLIA_PROFILE.rpcProviders.map(({ url }) => url),
    );
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0] ?? "")).toMatchObject({
      profile: { id: "starkware-integration-sepolia", network: "SN_SEPOLIA" },
      pool: { classHash: STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.classHash },
      token: { symbol: "USDC", decimals: 6 },
      verification: {
        noTransactionSubmitted: true,
        poolDeploymentOriginVerified: true,
        poolReplaceToLineageVerified: true,
        poolCommonRolesAuthorityStateVerified: true,
        screeningActivityVerified: false,
        fundedExecutionApproved: false,
      },
    });
    const serialized = output.join("");
    for (const url of [
      STARKWARE_INTEGRATION_SEPOLIA_PROFILE.services.discovery.url,
      STARKWARE_INTEGRATION_SEPOLIA_PROFILE.services.prover.url,
      ...STARKWARE_INTEGRATION_SEPOLIA_PROFILE.rpcProviders.map(({ url }) => url),
    ]) {
      expect(serialized).not.toContain(url);
    }
  });

  it("returns a stable known compatibility failure", async () => {
    const errors: string[] = [];

    const exitCode = await runIntegrationSepoliaObservationCommand({
      createProvider: () => new FakeIntegrationRpc(),
      fetchImplementation: serviceFetch("0.10.4"),
      now: fixedNow,
      writeOutput: () => undefined,
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(errors).toEqual([
      "Integration Sepolia prover API does not match the pinned compatibility profile\n",
    ]);
  });

  it("redacts an unexpected provider-construction failure", async () => {
    const secret = "rpc-token-in-error";
    const errors: string[] = [];

    const exitCode = await runIntegrationSepoliaObservationCommand({
      createProvider: () => {
        throw new Error(secret);
      },
      fetchImplementation: serviceFetch(),
      now: fixedNow,
      writeOutput: () => undefined,
      writeError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(errors).toEqual(["Integration Sepolia observation failed unexpectedly\n"]);
    expect(errors.join("")).not.toContain(secret);
  });
});

class FakeIntegrationRpc implements IntegrationSepoliaRpc {
  async getChainId(): Promise<string> {
    return SEPOLIA_CHAIN_ID;
  }

  async getBlockWithTxHashes(blockIdentifier: BlockIdentifier = "latest"): Promise<unknown> {
    const profile = STARKWARE_INTEGRATION_SEPOLIA_PROFILE;
    if (String(blockIdentifier) === profile.pool.deployment.deployment.acceptedBlockNumber) {
      return deploymentBlock();
    }
    const upgrade = profile.pool.upgrades.find(
      ({ blockNumber }) => blockNumber === blockIdentifier,
    );
    if (upgrade !== undefined) return upgradeBlock(upgrade);
    if (blockIdentifier !== BLOCK_NUMBER) throw new Error("unexpected block");
    return {
      status: "ACCEPTED_ON_L1",
      block_hash: BLOCK_HASH,
      block_number: BLOCK_NUMBER,
      timestamp: NOW_SECONDS - 5,
      transactions: [],
    };
  }

  async getTransactionByHash(transactionHash: string): Promise<unknown> {
    const profile = STARKWARE_INTEGRATION_SEPOLIA_PROFILE;
    const upgrade = profile.pool.upgrades.find(
      ({ transactionHash: expected }) => expected === transactionHash,
    );
    if (upgrade === undefined) throw new Error("unexpected transaction");
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

  async getTransactionReceipt(transactionHash: string): Promise<unknown> {
    const profile = STARKWARE_INTEGRATION_SEPOLIA_PROFILE;
    if (transactionHash === profile.pool.deployment.deployment.transactionReference) {
      return deploymentReceipt();
    }
    const upgrade = profile.pool.upgrades.find(
      ({ transactionHash: expected }) => expected === transactionHash,
    );
    if (upgrade === undefined) throw new Error("unexpected transaction");
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

  async getClassHashAt(
    contractAddress: string,
    blockIdentifier?: BlockIdentifier,
  ): Promise<string> {
    const profile = STARKWARE_INTEGRATION_SEPOLIA_PROFILE;
    if (
      contractAddress === profile.pool.address &&
      blockIdentifier === profile.pool.deployment.deployment.acceptedBlockHash
    ) {
      return profile.pool.deployment.classHash;
    }
    if (
      contractAddress === STARKNET_UDC_ADDRESS &&
      blockIdentifier === profile.pool.deployment.deployment.acceptedBlockHash
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
    if (contractAddress === STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.address) {
      return STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.classHash;
    }
    if (contractAddress === STARKWARE_INTEGRATION_SEPOLIA_PROFILE.token.address) {
      return STARKWARE_INTEGRATION_SEPOLIA_PROFILE.token.classHash;
    }
    throw new Error("unexpected contract");
  }

  async callContract(call: Call): Promise<string[]> {
    const membership = integrationSepoliaRoleMembership(call);
    if (membership !== undefined) return membership;
    const values = new Map<string, string[]>([
      ["get_version", [STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.versionFelt]],
      ["get_auditor_public_key", ["0x111"]],
      ["get_screener_public_key", ["0x222"]],
      ["get_proof_validity_blocks", ["0x1c2"]],
      ["get_fee_amount", ["0x1bc16d674ec80000"]],
      ["get_fee_collector", ["0x333"]],
      ["decimals", ["0x6"]],
    ]);
    const value = values.get(call.entrypoint);
    if (!value) throw new Error("unexpected view");
    return value;
  }

  async getEvents(eventFilter: EventFilter): Promise<unknown> {
    expect(eventFilter.keys?.[0]).toEqual([
      STARKNET_IMPLEMENTATION_REPLACED_SELECTOR,
      STARKNET_ROLE_GRANTED_SELECTOR,
      STARKNET_ROLE_GRANTED_WITH_DELAY_SELECTOR,
      STARKNET_ROLE_REVOKED_SELECTOR,
      STARKNET_ROLE_ADMIN_CHANGED_SELECTOR,
    ]);
    return {
      events: [
        ...STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.upgrades.map((upgrade) => ({
          block_hash: upgrade.blockHash,
          block_number: upgrade.blockNumber,
          transaction_hash: upgrade.transactionHash,
          from_address: STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.address,
          keys: [STARKNET_IMPLEMENTATION_REPLACED_SELECTOR],
          data: [upgrade.classHash, "0x1", "0x0"],
        })),
        ...integrationSepoliaAuthorityInventory(),
      ].sort((left, right) => left.block_number - right.block_number),
    };
  }
}

type ProfileUpgrade = (typeof STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.upgrades)[number];

function upgradeBlock(upgrade: ProfileUpgrade) {
  return {
    status: "ACCEPTED_ON_L1",
    block_hash: upgrade.blockHash,
    block_number: upgrade.blockNumber,
    parent_hash: upgrade.parentBlockHash,
    transactions: [upgrade.transactionHash],
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

function serviceFetch(proverVersion = "0.10.3-rc.2"): typeof fetch {
  return vi.fn(async (input) => {
    if (String(input).endsWith("/health")) {
      return jsonResponse({
        status: "OK",
        chain_head: {
          block_number: BLOCK_NUMBER,
          block_hash: BLOCK_HASH,
          timestamp: NOW_SECONDS - 5,
        },
        lag_secs: 5,
      });
    }
    return jsonResponse({ jsonrpc: "2.0", id: 1, result: proverVersion });
  }) as typeof fetch;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fixedNow(): Date {
  return new Date(NOW_SECONDS * 1_000);
}
