import type { BlockIdentifier, Call } from "starknet";
import { describe, expect, it } from "vitest";

import {
  type NamedStarknetProvingBlockProvider,
  STARKNET_PROVING_BLOCK_SELECTOR_VERSION,
  type StarknetProvingBlockRpc,
  StarknetProvingBlockSelector,
  type StarknetProvingBlockSelectorConfig,
  StarknetProvingBlockSelectorConfigurationError,
} from "./starknet-proving-block-selector.js";

const NOW_SECONDS = 2_000_000_000;
const POOL = "0x123";
const SEPOLIA_CHAIN_ID = "0x534e5f5345504f4c4941";

describe("Starknet proving-block selector", () => {
  it("selects one agreed historical block with an onchain validity margin", async () => {
    const first = new FakeProvingBlockRpc({ head: acceptedBlock(100n, "0xa1") });
    const second = new FakeProvingBlockRpc({ head: acceptedBlock(102n, "0xa2") });
    const selector = createSelector({ providers: namedProviders(first, second) });

    await expect(selector.select()).resolves.toEqual({
      blockHash: "0xbeef",
      blockNumber: 95n,
      proofValidityBlocks: 450n,
      remainingValidityBlocks: 443n,
      selectorVersion: STARKNET_PROVING_BLOCK_SELECTOR_VERSION,
    });
    const selectProvingBlock = selector.selectProvingBlock;
    await expect(selectProvingBlock()).resolves.toMatchObject({
      blockHash: "0xbeef",
      blockNumber: 95n,
    });
    expect(first.blockIdentifiers).toEqual(["latest", "95", "latest", "95"]);
    expect(second.blockIdentifiers).toEqual(["latest", "95", "latest", "95"]);
    expect(first.contractCalls).toEqual([
      {
        call: {
          contractAddress: POOL,
          entrypoint: "get_proof_validity_blocks",
          calldata: [],
        },
        blockIdentifier: "0xbeef",
      },
      {
        call: {
          contractAddress: POOL,
          entrypoint: "get_proof_validity_blocks",
          calldata: [],
        },
        blockIdentifier: "0xbeef",
      },
    ]);
  });

  it("rejects provider heads outside the configured lag policy", async () => {
    const first = new FakeProvingBlockRpc({ head: acceptedBlock(100n, "0xa1") });
    const second = new FakeProvingBlockRpc({ head: acceptedBlock(103n, "0xa2") });

    await expect(
      createSelector({ providers: namedProviders(first, second) }).select(),
    ).rejects.toMatchObject({ code: "provider_disagreement" });
    expect(first.blockIdentifiers).toEqual(["latest"]);
  });

  it.each([
    {
      name: "different target block hash",
      configure: (provider: FakeProvingBlockRpc) => {
        provider.target = acceptedBlock(95n, "0x999");
      },
      code: "provider_disagreement",
    },
    {
      name: "wrong target block number",
      configure: (provider: FakeProvingBlockRpc) => {
        provider.target = acceptedBlock(94n, "0xbeef");
      },
      code: "invalid_response",
    },
    {
      name: "pre-confirmed target block",
      configure: (provider: FakeProvingBlockRpc) => {
        provider.target = { ...acceptedBlock(95n, "0xbeef"), status: "PRE_CONFIRMED" };
      },
      code: "finality_not_satisfied",
    },
    {
      name: "target timestamp after its head",
      configure: (provider: FakeProvingBlockRpc) => {
        provider.target = acceptedBlock(95n, "0xbeef", NOW_SECONDS + 1);
      },
      code: "invalid_response",
    },
    {
      name: "target reusing its head hash",
      configure: (provider: FakeProvingBlockRpc) => {
        provider.target = acceptedBlock(95n, "0xa1", NOW_SECONDS - 10);
      },
      code: "invalid_response",
    },
  ])("rejects a $name", async ({ configure, code }) => {
    const first = new FakeProvingBlockRpc();
    const second = new FakeProvingBlockRpc();
    configure(second);

    await expect(
      createSelector({ providers: namedProviders(first, second) }).select(),
    ).rejects.toMatchObject({ code });
  });

  it("requires providers to agree on the pool proof-validity window", async () => {
    const first = new FakeProvingBlockRpc({ proofValidity: ["0x1c2"] });
    const second = new FakeProvingBlockRpc({ proofValidity: ["0x1c3"] });

    await expect(
      createSelector({ providers: namedProviders(first, second) }).select(),
    ).rejects.toMatchObject({ code: "provider_disagreement" });
  });

  it("rejects a selected block without the configured remaining validity", async () => {
    const first = new FakeProvingBlockRpc({ proofValidity: ["0x9"] });
    const second = new FakeProvingBlockRpc({ proofValidity: ["0x9"] });

    await expect(
      createSelector({ providers: namedProviders(first, second) }).select(),
    ).rejects.toMatchObject({ code: "insufficient_validity" });
  });

  it.each([
    { name: "zero", proofValidity: ["0x0"] },
    { name: "multiple values", proofValidity: ["0x1", "0x2"] },
    { name: "malformed felt", proofValidity: ["450"] },
  ])("rejects a $name pool validity response", async ({ proofValidity }) => {
    const first = new FakeProvingBlockRpc({ proofValidity });
    const second = new FakeProvingBlockRpc({ proofValidity });

    await expect(
      createSelector({ providers: namedProviders(first, second) }).select(),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    { name: "wrong chain", change: { chainId: "0x534e5f4d41494e" }, code: "provider_disagreement" },
    {
      name: "stale head",
      change: { head: acceptedBlock(100n, "0xa1", NOW_SECONDS - 121) },
      code: "stale_block",
    },
    {
      name: "future head",
      change: { head: acceptedBlock(100n, "0xa1", NOW_SECONDS + 6) },
      code: "stale_block",
    },
    {
      name: "unaccepted head",
      change: { head: { ...acceptedBlock(100n, "0xa1"), status: "PRE_CONFIRMED" } },
      code: "finality_not_satisfied",
    },
    {
      name: "oversized block number",
      change: { head: { ...acceptedBlock(100n, "0xa1"), block_number: "9".repeat(1_000) } },
      code: "invalid_response",
    },
  ])("rejects a $name provider", async ({ change, code }) => {
    const first = new FakeProvingBlockRpc(change);
    const second = new FakeProvingBlockRpc();

    await expect(
      createSelector({ providers: namedProviders(first, second) }).select(),
    ).rejects.toMatchObject({ code });
  });

  it("maps provider failures to a redacted provider error", async () => {
    const first = new FakeProvingBlockRpc();
    const second = new FakeProvingBlockRpc();
    second.blockError = new Error("credential-bearing upstream detail");

    await expect(
      createSelector({ providers: namedProviders(first, second) }).select(),
    ).rejects.toMatchObject({
      code: "provider_failure",
      message: "Starknet provider second could not read its accepted head",
    });
  });

  it("bounds a provider that never returns a block", async () => {
    const first = new FakeProvingBlockRpc();
    const second = new FakeProvingBlockRpc();
    second.blockPromise = new Promise(() => undefined);

    await expect(
      createSelector({
        providers: namedProviders(first, second),
        requestTimeoutMilliseconds: 5,
      }).select(),
    ).rejects.toMatchObject({ code: "provider_failure" });
  });

  it.each([
    { name: "one provider", providers: [namedProvider("first", new FakeProvingBlockRpc())] },
    {
      name: "duplicate provider ID",
      providers: [
        namedProvider("same", new FakeProvingBlockRpc()),
        namedProvider("same", new FakeProvingBlockRpc()),
      ],
    },
    {
      name: "duplicate provider instance",
      providers: (() => {
        const provider = new FakeProvingBlockRpc();
        return [namedProvider("first", provider), namedProvider("second", provider)];
      })(),
    },
  ])("rejects a configuration with $name", ({ providers }) => {
    expect(() => createSelector({ providers })).toThrow(
      StarknetProvingBlockSelectorConfigurationError,
    );
  });

  it("rejects a sparse proving-provider quorum", () => {
    const providers = new Array<NamedStarknetProvingBlockProvider>(2);
    providers[0] = namedProvider("first", new FakeProvingBlockRpc());

    expect(() => createSelector({ providers })).toThrow(
      StarknetProvingBlockSelectorConfigurationError,
    );
  });

  it.each([
    { blocksBehind: 0 },
    { minimumRemainingValidityBlocks: 0 },
    { maximumHeadLagBlocks: -1 },
    { maximumBlockAgeSeconds: 0 },
    { maximumFutureBlockTimeSeconds: -1 },
    { requestTimeoutMilliseconds: 0 },
  ])("rejects invalid numeric configuration %#", (change) => {
    expect(() => createSelector(change)).toThrow(StarknetProvingBlockSelectorConfigurationError);
  });
});

class FakeProvingBlockRpc implements StarknetProvingBlockRpc {
  readonly chainId: string;
  readonly proofValidity: unknown;
  readonly head: unknown;
  target: unknown;
  blockError: Error | undefined;
  blockPromise: Promise<unknown> | undefined;
  callError: Error | undefined;
  readonly blockIdentifiers: BlockIdentifier[] = [];
  readonly contractCalls: { call: Call; blockIdentifier: BlockIdentifier | undefined }[] = [];

  constructor(
    options: {
      chainId?: string;
      head?: unknown;
      target?: unknown;
      proofValidity?: unknown;
    } = {},
  ) {
    this.chainId = options.chainId ?? SEPOLIA_CHAIN_ID;
    this.head = Object.hasOwn(options, "head") ? options.head : acceptedBlock(100n, "0xa1");
    this.target = Object.hasOwn(options, "target")
      ? options.target
      : acceptedBlock(95n, "0xbeef", NOW_SECONDS - 10);
    this.proofValidity = Object.hasOwn(options, "proofValidity")
      ? options.proofValidity
      : ["0x1c2"];
  }

  async getChainId(): Promise<string> {
    return this.chainId;
  }

  async getBlockWithTxHashes(blockIdentifier?: BlockIdentifier): Promise<unknown> {
    if (this.blockError !== undefined) {
      throw this.blockError;
    }
    this.blockIdentifiers.push(blockIdentifier ?? "latest");
    if (this.blockPromise !== undefined) {
      return this.blockPromise;
    }
    return structuredClone(blockIdentifier === "latest" ? this.head : this.target);
  }

  async callContract(call: Call, blockIdentifier?: BlockIdentifier): Promise<readonly string[]> {
    this.contractCalls.push({ call: structuredClone(call), blockIdentifier });
    if (this.callError !== undefined) {
      throw this.callError;
    }
    return structuredClone(this.proofValidity) as readonly string[];
  }
}

function createSelector(
  change: Partial<StarknetProvingBlockSelectorConfig> = {},
): StarknetProvingBlockSelector {
  return new StarknetProvingBlockSelector({
    network: "SN_SEPOLIA",
    poolContract: POOL,
    providers: namedProviders(new FakeProvingBlockRpc(), new FakeProvingBlockRpc()),
    blocksBehind: 5,
    minimumRemainingValidityBlocks: 5,
    maximumHeadLagBlocks: 2,
    maximumBlockAgeSeconds: 120,
    maximumFutureBlockTimeSeconds: 5,
    requestTimeoutMilliseconds: 1_000,
    now: () => new Date(NOW_SECONDS * 1_000),
    ...change,
  });
}

function namedProviders(
  first: StarknetProvingBlockRpc,
  second: StarknetProvingBlockRpc,
): readonly NamedStarknetProvingBlockProvider[] {
  return [namedProvider("first", first), namedProvider("second", second)];
}

function namedProvider(
  id: string,
  provider: StarknetProvingBlockRpc,
): NamedStarknetProvingBlockProvider {
  return { id, provider };
}

function acceptedBlock(
  blockNumber: bigint,
  blockHash: string,
  timestamp = NOW_SECONDS,
): Record<string, unknown> {
  return {
    status: "ACCEPTED_ON_L2",
    block_hash: blockHash,
    block_number: blockNumber,
    timestamp,
    transactions: [],
  };
}
