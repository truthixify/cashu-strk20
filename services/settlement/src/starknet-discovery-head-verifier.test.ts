import type { BlockIdentifier } from "starknet";
import { describe, expect, it } from "vitest";

import {
  type NamedStarknetDiscoveryHeadProvider,
  STARKNET_DISCOVERY_HEAD_VERIFIER_VERSION,
  type StarknetDiscoveryHeadRpc,
  StarknetDiscoveryHeadVerifier,
  StarknetDiscoveryHeadVerifierConfigurationError,
} from "./starknet-discovery-head-verifier.js";

const SEPOLIA_CHAIN_ID = "0x534e5f5345504f4c4941";
const SECRET = "private-rpc-token";
const HEAD = {
  blockNumber: 1_234,
  blockHash: "0xabc",
  blockTimestamp: 2_000_000_000,
} as const;

describe("Starknet discovery-head verifier", () => {
  it("confirms one discovery block against every Sepolia provider", async () => {
    const first = new FakeDiscoveryHeadRpc({
      block: acceptedBlock("ACCEPTED_ON_L1"),
    });
    const second = new FakeDiscoveryHeadRpc();

    await expect(createVerifier([first, second]).verify(HEAD)).resolves.toEqual({
      ...HEAD,
      minimumAcceptedStatus: "ACCEPTED_ON_L2",
      providerIds: ["first", "second"],
      verifierVersion: STARKNET_DISCOVERY_HEAD_VERIFIER_VERSION,
    });
    expect(first.chainIdCalls).toBe(1);
    expect(second.chainIdCalls).toBe(1);
    expect(first.blockIdentifiers).toEqual([1_234]);
    expect(second.blockIdentifiers).toEqual([1_234]);
  });

  it("reports L1 acceptance only when every provider sees L1 acceptance", async () => {
    const providers = [
      new FakeDiscoveryHeadRpc({ block: acceptedBlock("ACCEPTED_ON_L1") }),
      new FakeDiscoveryHeadRpc({ block: acceptedBlock("ACCEPTED_ON_L1") }),
    ];

    await expect(createVerifier(providers).verify(HEAD)).resolves.toMatchObject({
      minimumAcceptedStatus: "ACCEPTED_ON_L1",
    });
  });

  it("rejects a provider on another chain", async () => {
    const second = new FakeDiscoveryHeadRpc({ chainId: "0x534e5f4d41494e" });

    await expect(
      createVerifier([new FakeDiscoveryHeadRpc(), second]).verify(HEAD),
    ).rejects.toMatchObject({
      code: "provider_disagreement",
      message: "Starknet provider second returned the wrong chain ID",
    });
  });

  it.each([
    { name: "hash", block: acceptedBlock("ACCEPTED_ON_L2", { block_hash: "0xdef" }) },
    { name: "number", block: acceptedBlock("ACCEPTED_ON_L2", { block_number: 1_235 }) },
    { name: "timestamp", block: acceptedBlock("ACCEPTED_ON_L2", { timestamp: 2_000_000_001 }) },
  ])("rejects a valid but different discovery $name", async ({ block }) => {
    await expect(
      createVerifier([new FakeDiscoveryHeadRpc(), new FakeDiscoveryHeadRpc({ block })]).verify(
        HEAD,
      ),
    ).rejects.toMatchObject({
      code: "discovery_mismatch",
      message: "Starknet provider second did not confirm the discovery head",
    });
  });

  it.each([
    {
      name: "pre-confirmed status",
      block: acceptedBlock("PRE_CONFIRMED"),
      code: "finality_not_satisfied",
    },
    {
      name: "zero block hash",
      block: acceptedBlock("ACCEPTED_ON_L2", { block_hash: "0x0" }),
      code: "invalid_response",
    },
    {
      name: "unsafe block number",
      block: acceptedBlock("ACCEPTED_ON_L2", {
        block_number: Number.MAX_SAFE_INTEGER + 1,
      }),
      code: "invalid_response",
    },
    {
      name: "zero timestamp",
      block: acceptedBlock("ACCEPTED_ON_L2", { timestamp: 0 }),
      code: "invalid_response",
    },
  ])("rejects a $name", async ({ block, code }) => {
    await expect(
      createVerifier([new FakeDiscoveryHeadRpc(), new FakeDiscoveryHeadRpc({ block })]).verify(
        HEAD,
      ),
    ).rejects.toMatchObject({ code });
  });

  it("waits for all providers and gives the configured order deterministic priority", async () => {
    const first = new FakeDiscoveryHeadRpc({
      chainError: async () => {
        await Promise.resolve();
        throw new Error(SECRET);
      },
    });
    const second = new FakeDiscoveryHeadRpc({
      chainError: async () => {
        throw new Error(SECRET);
      },
    });

    try {
      await createVerifier([first, second]).verify(HEAD);
      expect.unreachable("Provider failures were accepted");
    } catch (error) {
      expect(error).toMatchObject({
        code: "provider_failure",
        message: "Starknet provider first could not verify the discovery head",
      });
      expect((error as Error).message).not.toContain(SECRET);
    }
    expect(first.chainIdCalls).toBe(1);
    expect(second.chainIdCalls).toBe(1);
  });

  it("bounds provider calls and redacts timeout failures", async () => {
    const pending = new Promise<string>(() => undefined);
    const first = new FakeDiscoveryHeadRpc({ chainError: () => pending });
    const verifier = createVerifier([first, new FakeDiscoveryHeadRpc()], 5);

    await expect(verifier.verify(HEAD)).rejects.toMatchObject({
      code: "provider_failure",
      message: "Starknet provider first could not verify the discovery head",
    });
  });

  it("maps hostile response accessors to a provider-only error", async () => {
    const hostileBlock = {
      get status() {
        throw new Error(SECRET);
      },
    };

    try {
      await createVerifier([
        new FakeDiscoveryHeadRpc({ block: hostileBlock }),
        new FakeDiscoveryHeadRpc(),
      ]).verify(HEAD);
      expect.unreachable("Hostile response was accepted");
    } catch (error) {
      expect(error).toMatchObject({
        code: "invalid_response",
        message: "Starknet provider first returned an invalid discovery block",
      });
      expect((error as Error).message).not.toContain(SECRET);
    }
  });

  it.each([
    { name: "a wrong network", change: { network: "SN_MAIN" } },
    { name: "one provider", change: { providers: namedProviders(new FakeDiscoveryHeadRpc()) } },
    { name: "an excessive timeout", change: { requestTimeoutMilliseconds: 60_001 } },
  ])("rejects $name during construction", ({ change }) => {
    expect(
      () =>
        new StarknetDiscoveryHeadVerifier({
          network: "SN_SEPOLIA",
          providers: namedProviders(new FakeDiscoveryHeadRpc(), new FakeDiscoveryHeadRpc()),
          requestTimeoutMilliseconds: 10_000,
          ...change,
        } as ConstructorParameters<typeof StarknetDiscoveryHeadVerifier>[0]),
    ).toThrow(StarknetDiscoveryHeadVerifierConfigurationError);
  });

  it("rejects duplicate provider IDs and instances", () => {
    const shared = new FakeDiscoveryHeadRpc();
    expect(
      () =>
        new StarknetDiscoveryHeadVerifier({
          network: "SN_SEPOLIA",
          providers: [
            { id: "first", provider: shared },
            { id: "second", provider: shared },
          ],
          requestTimeoutMilliseconds: 10_000,
        }),
    ).toThrow(StarknetDiscoveryHeadVerifierConfigurationError);
    expect(
      () =>
        new StarknetDiscoveryHeadVerifier({
          network: "SN_SEPOLIA",
          providers: [
            { id: "same", provider: new FakeDiscoveryHeadRpc() },
            { id: "same", provider: new FakeDiscoveryHeadRpc() },
          ],
          requestTimeoutMilliseconds: 10_000,
        }),
    ).toThrow(StarknetDiscoveryHeadVerifierConfigurationError);
  });

  it("rejects a sparse discovery-provider quorum", () => {
    const providers = new Array<NamedStarknetDiscoveryHeadProvider>(2);
    providers[0] = { id: "first", provider: new FakeDiscoveryHeadRpc() };

    expect(
      () =>
        new StarknetDiscoveryHeadVerifier({
          network: "SN_SEPOLIA",
          providers,
          requestTimeoutMilliseconds: 10_000,
        }),
    ).toThrow(StarknetDiscoveryHeadVerifierConfigurationError);
  });

  it.each([
    { name: "a negative block", head: { ...HEAD, blockNumber: -1 } },
    { name: "a fractional block", head: { ...HEAD, blockNumber: 1.5 } },
    { name: "a zero hash", head: { ...HEAD, blockHash: "0x0" } },
    { name: "a zero timestamp", head: { ...HEAD, blockTimestamp: 0 } },
  ])("rejects $name before provider access", async ({ head }) => {
    const providers = [new FakeDiscoveryHeadRpc(), new FakeDiscoveryHeadRpc()];
    await expect(createVerifier(providers).verify(head)).rejects.toBeInstanceOf(
      StarknetDiscoveryHeadVerifierConfigurationError,
    );
    expect(providers.every((provider) => provider.chainIdCalls === 0)).toBe(true);
  });
});

interface FakeDiscoveryHeadRpcOptions {
  readonly chainId?: string;
  readonly block?: unknown;
  readonly chainError?: () => Promise<string>;
}

class FakeDiscoveryHeadRpc implements StarknetDiscoveryHeadRpc {
  readonly #chainId: string;
  readonly #block: unknown;
  readonly #chainError: (() => Promise<string>) | undefined;
  chainIdCalls = 0;
  readonly blockIdentifiers: BlockIdentifier[] = [];

  constructor(options: FakeDiscoveryHeadRpcOptions = {}) {
    this.#chainId = options.chainId ?? SEPOLIA_CHAIN_ID;
    this.#block = options.block ?? acceptedBlock("ACCEPTED_ON_L2");
    this.#chainError = options.chainError;
  }

  async getChainId(): Promise<string> {
    this.chainIdCalls += 1;
    return this.#chainError ? this.#chainError() : this.#chainId;
  }

  async getBlockWithTxHashes(blockIdentifier: BlockIdentifier = "latest"): Promise<unknown> {
    this.blockIdentifiers.push(blockIdentifier);
    return this.#block;
  }
}

function createVerifier(
  providers: readonly FakeDiscoveryHeadRpc[],
  requestTimeoutMilliseconds = 10_000,
): StarknetDiscoveryHeadVerifier {
  return new StarknetDiscoveryHeadVerifier({
    network: "SN_SEPOLIA",
    providers: namedProviders(...providers),
    requestTimeoutMilliseconds,
  });
}

function namedProviders(
  ...providers: readonly StarknetDiscoveryHeadRpc[]
): readonly NamedStarknetDiscoveryHeadProvider[] {
  return providers.map((provider, index) => ({
    id: index === 0 ? "first" : index === 1 ? "second" : `provider-${index + 1}`,
    provider,
  }));
}

function acceptedBlock(
  status: string,
  change: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    status,
    block_hash: HEAD.blockHash,
    block_number: HEAD.blockNumber,
    timestamp: HEAD.blockTimestamp,
    transactions: [],
    ...change,
  };
}
