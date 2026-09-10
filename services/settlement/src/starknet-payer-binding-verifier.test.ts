import type { StarknetNetwork } from "@cashu-strk20/strk20-method";
import type { BlockIdentifier, Call } from "starknet";
import { describe, expect, it } from "vitest";

import { InMemoryPayerBindingChallengeStore } from "./payer-binding-records.js";
import {
  buildPayerBindingTypedData,
  PayerBindingCoordinator,
  type PayerBindingTypedData,
} from "./payer-bindings.js";
import {
  type NamedStarknetPayerBindingProvider,
  STARKNET_PAYER_BINDING_VERIFIER_VERSIONS,
  type StarknetPayerBindingRpc,
  StarknetPayerBindingVerifier,
  type StarknetPayerBindingVerifierConfig,
  StarknetPayerBindingVerifierConfigurationError,
} from "./starknet-payer-binding-verifier.js";

const NOW_SECONDS = 2_000_000_000;
const STARKNET_SEPOLIA_CHAIN_ID = "0x534e5f5345504f4c4941";
const EXPECTED_MESSAGE_HASH = "0x555fc57c20c260d2248f47b917fa335d89f110e52d456116ea80608b01fb16e";
const SNIP6_VALID = "0x56414c4944";
const STARK_FIELD_PRIME = (1n << 251n) + (17n << 192n) + 1n;

describe("Starknet payer binding verifier", () => {
  it("hashes SNIP-12 revision 1 locally and requires unanimous block-pinned SNIP-6 validity", async () => {
    const first = new FakeStarknetRpc({ response: [SNIP6_VALID] });
    const second = new FakeStarknetRpc({ response: ["0x1"] });
    const verifier = createVerifier({ providers: namedProviders(first, second) });

    await expect(verifier.verify(verificationInput())).resolves.toEqual({
      valid: true,
      status: "FINAL",
      messageHash: EXPECTED_MESSAGE_HASH,
      blockHash: "0xbeef",
      blockNumber: 42n,
      verifierVersion: STARKNET_PAYER_BINDING_VERIFIER_VERSIONS.L2,
    });
    expect(first.blockIdentifiers).toEqual(["latest"]);
    expect(second.blockIdentifiers).toEqual(["latest"]);
    expect(first.contractCalls).toEqual([
      {
        call: {
          contractAddress: "0xaaa",
          entrypoint: "is_valid_signature",
          calldata: [BigInt(EXPECTED_MESSAGE_HASH).toString(), "4", "1", "2", "3", "4"],
        },
        blockIdentifier: "0xbeef",
      },
    ]);
    expect(second.contractCalls).toEqual(first.contractCalls);
  });

  it("returns invalid only when every provider returns the explicit SNIP-6 false value", async () => {
    const first = new FakeStarknetRpc({ response: ["0x0"] });
    const second = new FakeStarknetRpc({ response: ["0x00"] });

    await expect(
      createVerifier({ providers: namedProviders(first, second) }).verify(verificationInput()),
    ).resolves.toEqual({ valid: false });
  });

  it("fails closed when providers disagree on signature validity", async () => {
    const first = new FakeStarknetRpc({ response: [SNIP6_VALID] });
    const second = new FakeStarknetRpc({ response: ["0x0"] });

    await expect(
      createVerifier({ providers: namedProviders(first, second) }).verify(verificationInput()),
    ).rejects.toMatchObject({ code: "provider_disagreement" });
  });

  it.each([
    { name: "hash", change: { block_hash: "0xbef0" } },
    { name: "number", change: { block_number: 43 } },
    { name: "timestamp", change: { timestamp: NOW_SECONDS - 9 } },
  ])("rejects provider disagreement on the verification block $name", async ({ change }) => {
    const first = new FakeStarknetRpc();
    const second = new FakeStarknetRpc({ block: { ...finalBlock(), ...change } });

    await expect(
      createVerifier({ providers: namedProviders(first, second) }).verify(verificationInput()),
    ).rejects.toMatchObject({ code: "provider_disagreement" });
    expect(first.contractCalls).toHaveLength(0);
    expect(second.contractCalls).toHaveLength(0);
  });

  it("rejects a provider on another chain before account verification", async () => {
    const first = new FakeStarknetRpc();
    const second = new FakeStarknetRpc({ chainId: "0x1" });

    await expect(
      createVerifier({ providers: namedProviders(first, second) }).verify(verificationInput()),
    ).rejects.toMatchObject({ code: "provider_disagreement" });
    expect(first.contractCalls).toHaveLength(0);
    expect(second.contractCalls).toHaveLength(0);
  });

  it.each([
    { name: "non-object", block: null },
    { name: "missing block hash", block: { ...finalBlock(), block_hash: undefined } },
    { name: "zero block hash", block: { ...finalBlock(), block_hash: "0x0" } },
    { name: "fractional block number", block: { ...finalBlock(), block_number: 42.5 } },
    { name: "non-numeric timestamp", block: { ...finalBlock(), timestamp: "2000000000" } },
  ])("rejects a $name accepted-block response", async ({ block }) => {
    const first = new FakeStarknetRpc({ block });
    const second = new FakeStarknetRpc();

    await expect(
      createVerifier({ providers: namedProviders(first, second) }).verify(verificationInput()),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(first.contractCalls).toHaveLength(0);
    expect(second.contractCalls).toHaveLength(0);
  });

  it.each([
    { finality: "L1" as const, status: "ACCEPTED_ON_L2" },
    { finality: "L2" as const, status: "PRE_CONFIRMED" },
  ])("rejects $status for the $finality finality policy", async ({ finality, status }) => {
    const first = new FakeStarknetRpc({ block: { ...finalBlock(), status } });
    const second = new FakeStarknetRpc({ block: { ...finalBlock(), status } });

    await expect(
      createVerifier({ finality, providers: namedProviders(first, second) }).verify(
        verificationInput(),
      ),
    ).rejects.toMatchObject({ code: "finality_not_satisfied" });
  });

  it.each([
    {
      name: "stale",
      timestamp: NOW_SECONDS - 31,
      maximumBlockAgeSeconds: 30,
      maximumFutureBlockTimeSeconds: 5,
    },
    {
      name: "too far in the future",
      timestamp: NOW_SECONDS + 6,
      maximumBlockAgeSeconds: 30,
      maximumFutureBlockTimeSeconds: 5,
    },
  ])("rejects a $name verification block", async (testCase) => {
    const first = new FakeStarknetRpc({
      block: { ...finalBlock(), timestamp: testCase.timestamp },
    });
    const second = new FakeStarknetRpc({
      block: { ...finalBlock(), timestamp: testCase.timestamp },
    });

    await expect(
      createVerifier({
        maximumBlockAgeSeconds: testCase.maximumBlockAgeSeconds,
        maximumFutureBlockTimeSeconds: testCase.maximumFutureBlockTimeSeconds,
        providers: namedProviders(first, second),
      }).verify(verificationInput()),
    ).rejects.toMatchObject({ code: "stale_block" });
    expect(first.contractCalls).toHaveLength(0);
  });

  it.each([
    { name: "empty", response: [] },
    { name: "multiple", response: [SNIP6_VALID, "0x1"] },
    { name: "unknown nonzero", response: ["0x2"] },
    { name: "decimal", response: ["1"] },
    { name: "outside the field", response: [`0x${STARK_FIELD_PRIME.toString(16)}`] },
  ])("rejects a $name SNIP-6 response instead of guessing", async ({ response }) => {
    const first = new FakeStarknetRpc({ response });
    const second = new FakeStarknetRpc({ response: [SNIP6_VALID] });

    await expect(
      createVerifier({ providers: namedProviders(first, second) }).verify(verificationInput()),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("keeps provider failures distinct from invalid signatures and redacts the cause", async () => {
    const first = new FakeStarknetRpc();
    first.callError = new Error("https://secret-rpc.example/signature/0x1234");
    const second = new FakeStarknetRpc();

    const verification = createVerifier({
      providers: namedProviders(first, second),
    }).verify(verificationInput());

    await expect(verification).rejects.toMatchObject({ code: "provider_failure" });
    await expect(verification).rejects.not.toThrow(/secret-rpc|0x1234/);
  });

  it("redacts provider read failures before account verification", async () => {
    const first = new FakeStarknetRpc();
    first.blockError = new Error("https://secret-rpc.example/api-key/value");
    const second = new FakeStarknetRpc();

    const verification = createVerifier({
      providers: namedProviders(first, second),
    }).verify(verificationInput());

    await expect(verification).rejects.toMatchObject({ code: "provider_failure" });
    await expect(verification).rejects.not.toThrow(/secret-rpc|api-key/);
    expect(first.contractCalls).toHaveLength(0);
    expect(second.contractCalls).toHaveLength(0);
  });

  it("bounds a provider that never returns", async () => {
    const first = new FakeStarknetRpc();
    first.blockPromise = new Promise(() => undefined);
    const second = new FakeStarknetRpc();

    await expect(
      createVerifier({
        providers: namedProviders(first, second),
        requestTimeoutMilliseconds: 5,
      }).verify(verificationInput()),
    ).rejects.toMatchObject({ code: "provider_failure" });
    expect(first.contractCalls).toHaveLength(0);
    expect(second.contractCalls).toHaveLength(0);
  });

  it("leaves a coordinator challenge open when providers disagree", async () => {
    const store = new InMemoryPayerBindingChallengeStore();
    const verifier = createVerifier({
      providers: namedProviders(
        new FakeStarknetRpc({ response: [SNIP6_VALID] }),
        new FakeStarknetRpc({ response: ["0x0"] }),
      ),
    });
    const coordinator = new PayerBindingCoordinator(store, verifier, {
      network: "SN_SEPOLIA",
      poolContract: "0x123",
      recipientAddress: "0x789",
      tokenContract: "0x456",
      verifierVersion: verifier.verifierVersion,
      challengeTtlSeconds: 120,
      now: () => new Date(NOW_SECONDS * 1_000),
      generateChallengeId: () => "challenge_0000000000000000000000000001",
    });
    await coordinator.issueChallenge({
      paymentRequestId: "payer_binding_request_000000000001",
      payerAddress: "0xaaa",
      expectedNoteReference: "0x111",
      amountBaseUnits: 1_000_000n,
      fundingExpiresAt: new Date((NOW_SECONDS + 300) * 1_000),
    });

    await expect(
      coordinator.verifySignature({
        paymentRequestId: "payer_binding_request_000000000001",
        challengeId: "challenge_0000000000000000000000000001",
        signature: ["0x1", "0x2", "0x3", "0x4"],
      }),
    ).rejects.toMatchObject({ code: "provider_disagreement" });
    await expect(
      store.getPayerBinding("payer_binding_request_000000000001"),
    ).resolves.toMatchObject({ state: "OPEN" });
  });

  it("uses the L1-accepted tag and records the selected L1 verifier version", async () => {
    const first = new FakeStarknetRpc({
      block: { ...finalBlock(), status: "ACCEPTED_ON_L1" },
    });
    const second = new FakeStarknetRpc({
      block: { ...finalBlock(), status: "ACCEPTED_ON_L1" },
    });
    const verifier = createVerifier({
      finality: "L1",
      providers: namedProviders(first, second),
    });

    await expect(verifier.verify(verificationInput())).resolves.toMatchObject({
      valid: true,
      status: "FINAL",
      verifierVersion: STARKNET_PAYER_BINDING_VERIFIER_VERSIONS.L1,
    });
    expect(first.blockIdentifiers).toEqual(["l1_accepted"]);
    expect(first.contractCalls[0]?.blockIdentifier).toBe("0xbeef");
  });

  it.each([
    {
      name: "wrong input network",
      input: { network: "SN_MAIN" as StarknetNetwork },
    },
    {
      name: "different typed-data payer",
      input: {
        typedData: {
          ...payerBindingTypedData(),
          message: { ...payerBindingTypedData().message, Payer: "0xaab" },
        },
      },
    },
    { name: "empty signature", input: { signature: [] } },
    { name: "malformed signature felt", input: { signature: ["1"] } },
    {
      name: "out-of-field signature felt",
      input: { signature: [`0x${STARK_FIELD_PRIME.toString(16)}`] },
    },
  ])("rejects $name before any provider read", async ({ input }) => {
    const first = new FakeStarknetRpc();
    const second = new FakeStarknetRpc();

    await expect(
      createVerifier({ providers: namedProviders(first, second) }).verify({
        ...verificationInput(),
        ...input,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(first.blockIdentifiers).toHaveLength(0);
    expect(second.blockIdentifiers).toHaveLength(0);
  });

  it("rejects a sparse payer signature before any provider read", async () => {
    const first = new FakeStarknetRpc();
    const second = new FakeStarknetRpc();
    const signature = new Array<string>(4);
    signature[0] = "0x1";

    await expect(
      createVerifier({ providers: namedProviders(first, second) }).verify({
        ...verificationInput(),
        signature,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(first.blockIdentifiers).toHaveLength(0);
    expect(second.blockIdentifiers).toHaveLength(0);
  });

  it.each([
    { name: "one provider", providers: [namedProvider("first", new FakeStarknetRpc())] },
    {
      name: "duplicate provider ID",
      providers: [
        namedProvider("same", new FakeStarknetRpc()),
        namedProvider("same", new FakeStarknetRpc()),
      ],
    },
    {
      name: "duplicate provider instance",
      providers: (() => {
        const provider = new FakeStarknetRpc();
        return [namedProvider("first", provider), namedProvider("second", provider)];
      })(),
    },
    {
      name: "too many providers",
      providers: Array.from({ length: 17 }, (_, index) =>
        namedProvider(`provider-${index}`, new FakeStarknetRpc()),
      ),
    },
  ])("rejects a configuration with $name", ({ providers }) => {
    expect(() => createVerifier({ providers })).toThrow(
      StarknetPayerBindingVerifierConfigurationError,
    );
  });

  it("rejects a sparse payer-binding provider quorum", () => {
    const providers = new Array<NamedStarknetPayerBindingProvider>(2);
    providers[0] = namedProvider("first", new FakeStarknetRpc());

    expect(() => createVerifier({ providers })).toThrow(
      StarknetPayerBindingVerifierConfigurationError,
    );
  });

  it.each([
    { maximumBlockAgeSeconds: 0 },
    { maximumBlockAgeSeconds: 1.5 },
    { maximumFutureBlockTimeSeconds: -1 },
    { maximumFutureBlockTimeSeconds: Number.NaN },
    { requestTimeoutMilliseconds: 0 },
    { requestTimeoutMilliseconds: 1.5 },
  ])("rejects invalid block freshness configuration %#", (change) => {
    expect(() => createVerifier(change)).toThrow(StarknetPayerBindingVerifierConfigurationError);
  });
});

class FakeStarknetRpc implements StarknetPayerBindingRpc {
  readonly chainId: string;
  readonly block: unknown;
  readonly response: unknown;
  readonly blockIdentifiers: BlockIdentifier[] = [];
  readonly contractCalls: { call: Call; blockIdentifier: BlockIdentifier | undefined }[] = [];

  chainError: Error | undefined;
  blockError: Error | undefined;
  callError: Error | undefined;
  blockPromise: Promise<unknown> | undefined;

  constructor(options: { chainId?: string; block?: unknown; response?: unknown } = {}) {
    this.chainId = options.chainId ?? STARKNET_SEPOLIA_CHAIN_ID;
    this.block = Object.hasOwn(options, "block") ? options.block : finalBlock();
    this.response = Object.hasOwn(options, "response") ? options.response : [SNIP6_VALID];
  }

  async getChainId(): Promise<string> {
    if (this.chainError !== undefined) {
      throw this.chainError;
    }
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
    return structuredClone(this.block);
  }

  async callContract(call: Call, blockIdentifier?: BlockIdentifier): Promise<readonly string[]> {
    this.contractCalls.push({ call: structuredClone(call), blockIdentifier });
    if (this.callError !== undefined) {
      throw this.callError;
    }
    return structuredClone(this.response) as readonly string[];
  }
}

function createVerifier(
  change: Partial<StarknetPayerBindingVerifierConfig> = {},
): StarknetPayerBindingVerifier {
  return new StarknetPayerBindingVerifier({
    network: "SN_SEPOLIA",
    finality: "L2",
    providers: namedProviders(new FakeStarknetRpc(), new FakeStarknetRpc()),
    maximumBlockAgeSeconds: 30,
    maximumFutureBlockTimeSeconds: 5,
    requestTimeoutMilliseconds: 1_000,
    now: () => new Date(NOW_SECONDS * 1_000),
    ...change,
  });
}

function namedProviders(
  first: StarknetPayerBindingRpc,
  second: StarknetPayerBindingRpc,
): readonly NamedStarknetPayerBindingProvider[] {
  return [namedProvider("first", first), namedProvider("second", second)];
}

function namedProvider(
  id: string,
  provider: StarknetPayerBindingRpc,
): NamedStarknetPayerBindingProvider {
  return { id, provider };
}

function finalBlock(): Record<string, unknown> {
  return {
    status: "ACCEPTED_ON_L2",
    block_hash: "0xbeef",
    block_number: 42,
    timestamp: NOW_SECONDS - 10,
    transactions: [],
  };
}

function verificationInput(): {
  network: StarknetNetwork;
  payerAddress: string;
  typedData: PayerBindingTypedData;
  signature: readonly string[];
} {
  return {
    network: "SN_SEPOLIA",
    payerAddress: "0xaaa",
    typedData: payerBindingTypedData(),
    signature: ["0x1", "0x2", "0x3", "0x4"],
  };
}

function payerBindingTypedData(): PayerBindingTypedData {
  return buildPayerBindingTypedData({
    identity: {
      paymentRequestId: "payer_binding_request_000000000001",
      network: "SN_SEPOLIA",
      poolContract: "0x123",
      recipientAddress: "0x789",
      tokenContract: "0x456",
      expectedNoteReference: "0x111",
      amountBaseUnits: "1000000",
      payerAddress: "0xaaa",
      fundingExpiresAt: NOW_SECONDS + 300,
      challengeExpiresAt: NOW_SECONDS + 120,
    },
    challengeId: "challenge_0000000000000000000000000001",
  });
}
