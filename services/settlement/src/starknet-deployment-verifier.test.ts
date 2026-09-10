import type { BlockIdentifier, RpcProvider } from "starknet";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type NamedStarknetDeploymentProvider,
  STARKNET_DEPLOYMENT_VERIFIER_VERSION,
  type StarknetDeploymentRpc,
  StarknetDeploymentVerifier,
  type StarknetDeploymentVerifierConfig,
  StarknetDeploymentVerifierConfigurationError,
} from "./starknet-deployment-verifier.js";
import { STARKNET_TRANSACTION_FINALITY_POLICIES } from "./starknet-transaction-observer.js";

const NOW_SECONDS = 2_000_000_000;
const POOL = "0x123";
const TOKEN = "0x456";
const ACCOUNT = "0x789";
const ACCOUNT_CLASS = "0xabc";
const SEPOLIA_CHAIN_ID = "0x534e5f5345504f4c4941";

describe("Starknet deployment verifier", () => {
  it("pins deployment classes to one block agreed by every provider", async () => {
    const first = new FakeDeploymentRpc({ head: acceptedBlock(102n, "0xa2") });
    const second = new FakeDeploymentRpc({ head: acceptedBlock(100n, "0xbeef") });
    const verifier = createVerifier({ providers: namedProviders(first, second) });

    await expect(verifier.verify()).resolves.toEqual({
      blockHash: "0xbeef",
      blockNumber: 100n,
      blockTimestamp: NOW_SECONDS - 10,
      poolClassHash: "0x111",
      tokenClassHash: "0x222",
      accountClassHash: ACCOUNT_CLASS,
      providerIds: ["first", "second"],
      verifierVersion: STARKNET_DEPLOYMENT_VERIFIER_VERSION,
    });
    expect(first.blockIdentifiers).toEqual(["l1_accepted", "100"]);
    expect(second.blockIdentifiers).toEqual(["l1_accepted", "100"]);
    expect(first.classHashReads).toEqual([
      { contractAddress: POOL, blockIdentifier: "0xbeef" },
      { contractAddress: TOKEN, blockIdentifier: "0xbeef" },
      { contractAddress: ACCOUNT, blockIdentifier: "0xbeef" },
    ]);
  });

  it("supports the explicit L2-final policy", async () => {
    const first = new FakeDeploymentRpc({
      head: acceptedBlock(102n, "0xa2", NOW_SECONDS - 1, "ACCEPTED_ON_L2"),
      target: acceptedBlock(100n, "0xbeef", NOW_SECONDS - 10, "ACCEPTED_ON_L2"),
    });
    const second = new FakeDeploymentRpc({
      head: acceptedBlock(100n, "0xbeef", NOW_SECONDS - 10, "ACCEPTED_ON_L2"),
      target: acceptedBlock(100n, "0xbeef", NOW_SECONDS - 10, "ACCEPTED_ON_L2"),
    });

    await expect(
      createVerifier({
        finalityPolicy: STARKNET_TRANSACTION_FINALITY_POLICIES.L2,
        providers: namedProviders(first, second),
      }).verify(),
    ).resolves.toMatchObject({ blockHash: "0xbeef" });
    expect(first.blockIdentifiers[0]).toBe("latest");
  });

  it("rejects provider heads outside the configured lag policy", async () => {
    const first = new FakeDeploymentRpc({ head: acceptedBlock(104n, "0xa4") });
    const second = new FakeDeploymentRpc({ head: acceptedBlock(100n, "0xbeef") });

    await expect(
      createVerifier({ providers: namedProviders(first, second) }).verify(),
    ).rejects.toMatchObject({ code: "provider_disagreement" });
    expect(first.blockIdentifiers).toEqual(["l1_accepted"]);
  });

  it.each([
    {
      name: "block hash",
      configure: (rpc: FakeDeploymentRpc) => {
        rpc.target = acceptedBlock(100n, "0x999");
      },
    },
    {
      name: "block timestamp",
      configure: (rpc: FakeDeploymentRpc) => {
        rpc.target = acceptedBlock(100n, "0xbeef", NOW_SECONDS - 9);
      },
    },
  ])("rejects provider disagreement on the target $name", async ({ configure }) => {
    const first = new FakeDeploymentRpc({
      head: acceptedBlock(102n, "0xa2", NOW_SECONDS - 1),
    });
    const second = new FakeDeploymentRpc();
    configure(first);

    await expect(
      createVerifier({ providers: namedProviders(first, second) }).verify(),
    ).rejects.toMatchObject({ code: "provider_disagreement" });
  });

  it.each([
    { name: "pool", address: POOL },
    { name: "token", address: TOKEN },
    { name: "account", address: ACCOUNT },
  ])("rejects provider disagreement on the $name class", async ({ address }) => {
    const first = new FakeDeploymentRpc();
    const second = new FakeDeploymentRpc();
    second.classHashes.set(address, "0x999");

    await expect(
      createVerifier({ providers: namedProviders(first, second) }).verify(),
    ).rejects.toMatchObject({ code: "provider_disagreement" });
  });

  it.each([
    { name: "pool", address: POOL },
    { name: "token", address: TOKEN },
    { name: "account", address: ACCOUNT },
  ])("rejects an agreed $name class that differs from its deployment pin", async ({ address }) => {
    const first = new FakeDeploymentRpc();
    const second = new FakeDeploymentRpc();
    first.classHashes.set(address, "0x999");
    second.classHashes.set(address, "0x999");

    await expect(
      createVerifier({ providers: namedProviders(first, second) }).verify(),
    ).rejects.toMatchObject({ code: "deployment_mismatch" });
  });

  it.each([
    { name: "wrong chain", change: { chainId: "0x534e5f4d41494e" }, code: "provider_disagreement" },
    {
      name: "stale head",
      change: { head: acceptedBlock(102n, "0xa2", NOW_SECONDS - 121) },
      code: "stale_block",
    },
    {
      name: "future head",
      change: { head: acceptedBlock(102n, "0xa2", NOW_SECONDS + 6) },
      code: "stale_block",
    },
    {
      name: "unaccepted head",
      change: { head: acceptedBlock(102n, "0xa2", NOW_SECONDS - 1, "PRE_CONFIRMED") },
      code: "finality_not_satisfied",
    },
    {
      name: "malformed block number",
      change: { head: { ...acceptedBlock(102n, "0xa2"), block_number: "9".repeat(1_000) } },
      code: "invalid_response",
    },
  ])("rejects a $name response", async ({ change, code }) => {
    const first = new FakeDeploymentRpc(change);
    const second = new FakeDeploymentRpc();

    await expect(
      createVerifier({ providers: namedProviders(first, second) }).verify(),
    ).rejects.toMatchObject({ code });
  });

  it("rejects a target block inconsistent with the provider head", async () => {
    const first = new FakeDeploymentRpc();
    const second = new FakeDeploymentRpc({
      head: acceptedBlock(100n, "0xbeef"),
      target: acceptedBlock(99n, "0xbeef"),
    });

    await expect(
      createVerifier({ providers: namedProviders(first, second) }).verify(),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects malformed class hashes without echoing them", async () => {
    const secret = "credential-bearing-class-response";
    const first = new FakeDeploymentRpc();
    const second = new FakeDeploymentRpc();
    second.classHashes.set(POOL, secret);

    try {
      await createVerifier({ providers: namedProviders(first, second) }).verify();
      expect.unreachable("Malformed class hash was accepted");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_response" });
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it("redacts provider failures", async () => {
    const secret = "credential-bearing upstream detail";
    const first = new FakeDeploymentRpc();
    const second = new FakeDeploymentRpc();
    second.classHashError = new Error(secret);

    await expect(
      createVerifier({ providers: namedProviders(first, second) }).verify(),
    ).rejects.toMatchObject({
      code: "provider_failure",
      message: "Starknet provider second could not read the deployed contract classes",
    });
  });

  it.each([
    {
      name: "accepted head",
      configure: (provider: FakeDeploymentRpc, secret: string) => {
        provider.headError = new Error(secret);
      },
      message: "Starknet provider second could not read its accepted deployment head",
    },
    {
      name: "agreed block",
      configure: (provider: FakeDeploymentRpc, secret: string) => {
        provider.targetError = new Error(secret);
      },
      message: "Starknet provider second could not read the agreed deployment block",
    },
  ])("redacts a provider failure while reading the $name", async ({ configure, message }) => {
    const secret = "credential-bearing block failure";
    const first = new FakeDeploymentRpc();
    const second = new FakeDeploymentRpc();
    configure(second, secret);

    try {
      await createVerifier({ providers: namedProviders(first, second) }).verify();
      expect.unreachable("Provider failure was accepted");
    } catch (error) {
      expect(error).toMatchObject({ code: "provider_failure", message });
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it("bounds a provider that never returns a class hash", async () => {
    const first = new FakeDeploymentRpc();
    const second = new FakeDeploymentRpc();
    second.classHashPromise = new Promise(() => undefined);

    await expect(
      createVerifier({
        providers: namedProviders(first, second),
        requestTimeoutMilliseconds: 5,
      }).verify(),
    ).rejects.toMatchObject({ code: "provider_failure" });
  });

  it.each([
    { name: "one provider", providers: [namedProvider("first", new FakeDeploymentRpc())] },
    {
      name: "duplicate provider ID",
      providers: [
        namedProvider("same", new FakeDeploymentRpc()),
        namedProvider("same", new FakeDeploymentRpc()),
      ],
    },
    {
      name: "duplicate provider instance",
      providers: (() => {
        const provider = new FakeDeploymentRpc();
        return [namedProvider("first", provider), namedProvider("second", provider)];
      })(),
    },
  ])("rejects a configuration with $name", ({ providers }) => {
    expect(() => createVerifier({ providers })).toThrow(
      StarknetDeploymentVerifierConfigurationError,
    );
  });

  it("rejects a sparse deployment-provider quorum", () => {
    const providers = new Array<NamedStarknetDeploymentProvider>(2);
    providers[0] = namedProvider("first", new FakeDeploymentRpc());

    expect(() => createVerifier({ providers })).toThrow(
      StarknetDeploymentVerifierConfigurationError,
    );
  });

  it.each([
    { name: "mainnet", change: { network: "SN_MAIN" } },
    { name: "unknown finality", change: { finalityPolicy: "latest" } },
    { name: "zero pool", change: { poolContract: "0x0" } },
    { name: "duplicate address", change: { tokenContract: POOL } },
    { name: "malformed pool class", change: { expectedPoolClassHash: "pool-class" } },
    { name: "malformed token class", change: { expectedTokenClassHash: "token-class" } },
    { name: "malformed account class", change: { expectedAccountClassHash: "abc" } },
    { name: "negative head lag", change: { maximumHeadLagBlocks: -1 } },
    { name: "zero block age", change: { maximumBlockAgeSeconds: 0 } },
    { name: "zero timeout", change: { requestTimeoutMilliseconds: 0 } },
  ])("rejects a $name configuration", ({ change }) => {
    expect(() => createVerifier(change as Partial<StarknetDeploymentVerifierConfig>)).toThrow(
      StarknetDeploymentVerifierConfigurationError,
    );
  });

  it("is structurally compatible with the pinned Starknet.js provider", () => {
    expectTypeOf<RpcProvider>().toMatchTypeOf<StarknetDeploymentRpc>();
  });
});

class FakeDeploymentRpc implements StarknetDeploymentRpc {
  chainId: string;
  head: unknown;
  target: unknown;
  headError?: Error;
  targetError?: Error;
  classHashError?: Error;
  classHashPromise?: Promise<string>;
  readonly classHashes = new Map<string, string>([
    [POOL, "0x111"],
    [TOKEN, "0x222"],
    [ACCOUNT, ACCOUNT_CLASS],
  ]);
  readonly blockIdentifiers: BlockIdentifier[] = [];
  readonly classHashReads: {
    readonly contractAddress: string;
    readonly blockIdentifier?: BlockIdentifier;
  }[] = [];

  constructor(
    change: {
      readonly chainId?: string;
      readonly head?: unknown;
      readonly target?: unknown;
    } = {},
  ) {
    this.chainId = change.chainId ?? SEPOLIA_CHAIN_ID;
    this.head = change.head ?? acceptedBlock(100n, "0xbeef");
    this.target = change.target ?? acceptedBlock(100n, "0xbeef");
  }

  async getChainId(): Promise<string> {
    return this.chainId;
  }

  async getBlockWithTxHashes(blockIdentifier: BlockIdentifier = "latest"): Promise<unknown> {
    this.blockIdentifiers.push(blockIdentifier);
    if (blockIdentifier === "latest" || blockIdentifier === "l1_accepted") {
      if (this.headError !== undefined) {
        throw this.headError;
      }
      return this.head;
    }
    if (this.targetError !== undefined) {
      throw this.targetError;
    }
    return this.target;
  }

  async getClassHashAt(
    contractAddress: string,
    blockIdentifier?: BlockIdentifier,
  ): Promise<string> {
    this.classHashReads.push(
      blockIdentifier === undefined ? { contractAddress } : { contractAddress, blockIdentifier },
    );
    if (this.classHashError !== undefined) {
      throw this.classHashError;
    }
    if (this.classHashPromise !== undefined) {
      return this.classHashPromise;
    }
    const value = this.classHashes.get(contractAddress);
    if (value === undefined) {
      throw new Error("Unknown test contract");
    }
    return value;
  }
}

function createVerifier(
  change: Partial<StarknetDeploymentVerifierConfig> = {},
): StarknetDeploymentVerifier {
  const first = new FakeDeploymentRpc();
  const second = new FakeDeploymentRpc({ head: acceptedBlock(100n, "0xbeef") });
  return new StarknetDeploymentVerifier({
    network: "SN_SEPOLIA",
    finalityPolicy: STARKNET_TRANSACTION_FINALITY_POLICIES.L1,
    poolContract: POOL,
    expectedPoolClassHash: "0x111",
    tokenContract: TOKEN,
    expectedTokenClassHash: "0x222",
    settlementAccount: ACCOUNT,
    expectedAccountClassHash: ACCOUNT_CLASS,
    providers: namedProviders(first, second),
    maximumHeadLagBlocks: 3,
    maximumBlockAgeSeconds: 120,
    maximumFutureBlockTimeSeconds: 5,
    requestTimeoutMilliseconds: 100,
    now: () => new Date(NOW_SECONDS * 1_000),
    ...change,
  });
}

function namedProviders(
  first: StarknetDeploymentRpc,
  second: StarknetDeploymentRpc,
): readonly NamedStarknetDeploymentProvider[] {
  return [namedProvider("first", first), namedProvider("second", second)];
}

function namedProvider(
  id: string,
  provider: StarknetDeploymentRpc,
): NamedStarknetDeploymentProvider {
  return { id, provider };
}

function acceptedBlock(
  number: bigint,
  hash: string,
  timestamp = NOW_SECONDS - 10,
  status = "ACCEPTED_ON_L1",
): {
  readonly status: string;
  readonly block_hash: string;
  readonly block_number: number;
  readonly timestamp: number;
  readonly transactions: readonly string[];
} {
  return {
    status,
    block_hash: hash,
    block_number: Number(number),
    timestamp,
    transactions: [],
  };
}
