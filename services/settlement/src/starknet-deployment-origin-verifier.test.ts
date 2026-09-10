import type { BlockIdentifier } from "starknet";
import { describe, expect, it } from "vitest";

import {
  calculateStarknetUdcDeploymentAddress,
  type NamedStarknetDeploymentOriginProvider,
  STARKNET_DEPLOYMENT_ORIGIN_VERIFIER_VERSION,
  STARKNET_UDC_ADDRESS,
  STARKNET_UDC_CLASS_HASH,
  STARKNET_UDC_CONTRACT_DEPLOYED_SELECTOR,
  type StarknetDeploymentOriginClaim,
  type StarknetDeploymentOriginRpc,
  StarknetDeploymentOriginVerifier,
  StarknetDeploymentOriginVerifierConfigurationError,
  StarknetUdcDeploymentOriginVerifier,
} from "./starknet-deployment-origin-verifier.js";
import {
  STARKNET_TRANSACTION_FINALITY_POLICIES,
  type StarknetTransactionFinalityPolicy,
} from "./starknet-transaction-observer.js";

const SEPOLIA_CHAIN_ID = "0x534e5f5345504f4c4941";
const POOL_CLASS_HASH = "0x7e2bbd7ccc1e68b2695caef70aeb2a3be6cd017b5d5159278ba08f2d8de33f";
const POOL_TRANSACTION = "0xaaa";
const TOKEN_TRANSACTION = "0xbbb";
const POOL_BLOCK_HASH = "0xabc";
const TOKEN_BLOCK_HASH = "0xdef";

const POOL = claimWithDerivedAddress({
  role: "privacy_pool",
  classHash: POOL_CLASS_HASH,
  deployment: {
    transactionReference: POOL_TRANSACTION,
    acceptedBlockHash: POOL_BLOCK_HASH,
    acceptedBlockNumber: "99",
    deployer: "0x777",
    salt: "0x1",
    unique: false,
    constructorCalldata: ["0x777", "0x111", "0x222", "0x1c2"],
  },
});
const TOKEN = claimWithDerivedAddress({
  role: "usdc_token",
  classHash: "0x222",
  deployment: {
    transactionReference: TOKEN_TRANSACTION,
    acceptedBlockHash: TOKEN_BLOCK_HASH,
    acceptedBlockNumber: "100",
    deployer: "0x777",
    salt: "0x2",
    unique: true,
    constructorCalldata: [],
  },
});
const CLAIMS = [POOL, TOKEN] as const;

describe("Starknet deployment-origin verifier", () => {
  it("pins address derivation for both UDC uniqueness modes", () => {
    expect(calculateStarknetUdcDeploymentAddress(POOL)).toBe(
      "0x52a6aa9d50631626d80b8e6acc9a9918ed8879cc24e793832dcb562e22255dd",
    );
    expect(calculateStarknetUdcDeploymentAddress(TOKEN)).toBe(
      "0x6a8d4f1ed931cf91bf5a81d0d1f4101f6fe8584d9d857f1226a128cc6529cb6",
    );
  });

  it("verifies exact UDC events, canonical inclusion, and deployed classes", async () => {
    const first = new FakeOriginRpc();
    const second = new FakeOriginRpc();

    await expect(
      createVerifier({ providers: namedProviders(first, second) }).verify(),
    ).resolves.toEqual({
      network: "SN_SEPOLIA",
      finalityPolicy: STARKNET_TRANSACTION_FINALITY_POLICIES.L1,
      udcAddress: STARKNET_UDC_ADDRESS,
      udcClassHash: STARKNET_UDC_CLASS_HASH,
      deploymentEventSelector: STARKNET_UDC_CONTRACT_DEPLOYED_SELECTOR,
      contracts: [
        {
          role: "privacy_pool",
          address: POOL.address,
          classHash: POOL.classHash,
          transactionReference: POOL_TRANSACTION,
          blockHash: POOL_BLOCK_HASH,
          blockNumber: 99n,
          deployer: POOL.deployment.deployer,
          salt: POOL.deployment.salt,
          unique: false,
          constructorCalldata: POOL.deployment.constructorCalldata,
        },
        {
          role: "usdc_token",
          address: TOKEN.address,
          classHash: TOKEN.classHash,
          transactionReference: TOKEN_TRANSACTION,
          blockHash: TOKEN_BLOCK_HASH,
          blockNumber: 100n,
          deployer: TOKEN.deployment.deployer,
          salt: TOKEN.deployment.salt,
          unique: true,
          constructorCalldata: [],
        },
      ],
      providerIds: ["first", "second"],
      verifierVersion: STARKNET_DEPLOYMENT_ORIGIN_VERIFIER_VERSION,
    });
    expect(first.receiptCalls.sort()).toEqual([POOL_TRANSACTION, TOKEN_TRANSACTION]);
    expect(first.blockCalls.sort()).toEqual(["100", "99"]);
    expect(first.classCalls).toEqual([
      { address: POOL.address, blockIdentifier: POOL_BLOCK_HASH },
      { address: STARKNET_UDC_ADDRESS, blockIdentifier: POOL_BLOCK_HASH },
      { address: TOKEN.address, blockIdentifier: TOKEN_BLOCK_HASH },
      { address: STARKNET_UDC_ADDRESS, blockIdentifier: TOKEN_BLOCK_HASH },
    ]);
  });

  it("accepts L2-final deployment evidence only under the explicit L2 policy", async () => {
    const providers = [new FakeOriginRpc(), new FakeOriginRpc()];
    for (const provider of providers) {
      provider.receipts.set(
        POOL_TRANSACTION,
        acceptedReceipt(POOL, { finality_status: "ACCEPTED_ON_L2" }),
      );
      provider.receipts.set(
        TOKEN_TRANSACTION,
        acceptedReceipt(TOKEN, { finality_status: "ACCEPTED_ON_L2" }),
      );
      provider.blocks.set("99", acceptedBlock(POOL, { status: "ACCEPTED_ON_L2" }));
      provider.blocks.set("100", acceptedBlock(TOKEN, { status: "ACCEPTED_ON_L2" }));
    }

    await expect(
      createVerifier({
        finalityPolicy: STARKNET_TRANSACTION_FINALITY_POLICIES.L2,
        providers: namedProviders(providers[0], providers[1]),
      }).verify(),
    ).resolves.toMatchObject({ finalityPolicy: STARKNET_TRANSACTION_FINALITY_POLICIES.L2 });
    await expect(
      createVerifier({ providers: namedProviders(providers[0], providers[1]) }).verify(),
    ).rejects.toMatchObject({ code: "finality_not_satisfied" });
  });

  it("rejects an underived address before contacting providers", async () => {
    const first = new FakeOriginRpc();
    const second = new FakeOriginRpc();

    await expect(
      createVerifier({
        contracts: [{ ...POOL, address: "0x123" }, TOKEN],
        providers: namedProviders(first, second),
      }).verify(),
    ).rejects.toMatchObject({ code: "deployment_mismatch" });
    expect(first.totalCalls).toBe(0);
    expect(second.totalCalls).toBe(0);
  });

  it.each([
    {
      name: "receipt block hash",
      change(provider: FakeOriginRpc) {
        provider.receipts.set(POOL_TRANSACTION, acceptedReceipt(POOL, { block_hash: "0x999" }));
      },
    },
    {
      name: "receipt finality",
      change(provider: FakeOriginRpc) {
        provider.receipts.set(
          POOL_TRANSACTION,
          acceptedReceipt(POOL, { finality_status: "ACCEPTED_ON_L2" }),
        );
      },
    },
    {
      name: "deployment event",
      change(provider: FakeOriginRpc) {
        provider.receipts.set(
          POOL_TRANSACTION,
          acceptedReceipt(POOL, { events: [deploymentEvent(POOL, { data: ["0x999"] })] }),
        );
      },
    },
    {
      name: "canonical block",
      change(provider: FakeOriginRpc) {
        provider.blocks.set("99", acceptedBlock(POOL, { block_hash: "0x999" }));
      },
    },
    {
      name: "deployed class",
      change(provider: FakeOriginRpc) {
        provider.classHashes.set(classKey(POOL), "0x999");
      },
    },
    {
      name: "UDC class",
      change(provider: FakeOriginRpc) {
        provider.classHashes.set(udcClassKey(POOL), "0x999");
      },
    },
  ])("rejects provider disagreement on the $name", async ({ change }) => {
    const first = new FakeOriginRpc();
    const second = new FakeOriginRpc();
    change(second);

    await expect(
      createVerifier({ providers: namedProviders(first, second) }).verify(),
    ).rejects.toMatchObject({ code: "provider_disagreement" });
  });

  it.each([
    {
      name: "reverted execution",
      receipt: acceptedReceipt(POOL, { execution_status: "REVERTED" }),
    },
    {
      name: "missing deployment event",
      receipt: acceptedReceipt(POOL, { events: [] }),
    },
    {
      name: "duplicate deployment event",
      receipt: acceptedReceipt(POOL, { events: [deploymentEvent(POOL), deploymentEvent(POOL)] }),
    },
    {
      name: "wrong UDC address",
      receipt: acceptedReceipt(POOL, {
        events: [deploymentEvent(POOL, { from_address: "0x123" })],
      }),
    },
    {
      name: "wrong event selector",
      receipt: acceptedReceipt(POOL, { events: [deploymentEvent(POOL, { keys: ["0x123"] })] }),
    },
    {
      name: "flipped uniqueness field",
      receipt: acceptedReceipt(POOL, {
        events: [deploymentEvent(POOL, { data: deploymentEventData(POOL, { unique: true }) })],
      }),
    },
    {
      name: "changed constructor calldata",
      receipt: acceptedReceipt(POOL, {
        events: [
          deploymentEvent(POOL, {
            data: deploymentEventData(POOL, { constructorCalldata: ["0x999"] }),
          }),
        ],
      }),
    },
  ])("rejects agreed $name", async ({ receipt }) => {
    const providers = [new FakeOriginRpc(), new FakeOriginRpc()];
    for (const provider of providers) {
      provider.receipts.set(POOL_TRANSACTION, receipt);
    }

    await expect(
      createVerifier({ providers: namedProviders(providers[0], providers[1]) }).verify(),
    ).rejects.toMatchObject({ code: "deployment_mismatch" });
  });

  it.each([
    {
      name: "transaction omitted from its declared block",
      change(provider: FakeOriginRpc) {
        provider.blocks.set("99", acceptedBlock(POOL, { transactions: [] }));
      },
    },
    {
      name: "different class at the deployment block",
      change(provider: FakeOriginRpc) {
        provider.classHashes.set(classKey(POOL), "0x999");
      },
    },
    {
      name: "different UDC class at the deployment block",
      change(provider: FakeOriginRpc) {
        provider.classHashes.set(udcClassKey(POOL), "0x999");
      },
    },
    {
      name: "different receipt transaction",
      change(provider: FakeOriginRpc) {
        provider.receipts.set(
          POOL_TRANSACTION,
          acceptedReceipt(POOL, { transaction_hash: "0x999" }),
        );
      },
    },
    {
      name: "different canonical block",
      change(provider: FakeOriginRpc) {
        provider.blocks.set("99", acceptedBlock(POOL, { block_hash: "0x999" }));
        provider.receipts.set(POOL_TRANSACTION, acceptedReceipt(POOL, { block_hash: "0x999" }));
      },
    },
  ])("rejects an agreed $name", async ({ change }) => {
    const providers = [new FakeOriginRpc(), new FakeOriginRpc()];
    for (const provider of providers) {
      change(provider);
    }

    await expect(
      createVerifier({ providers: namedProviders(providers[0], providers[1]) }).verify(),
    ).rejects.toMatchObject({ code: "deployment_mismatch" });
  });

  it.each([
    {
      name: "non-invoke receipt",
      change(provider: FakeOriginRpc) {
        provider.receipts.set(POOL_TRANSACTION, acceptedReceipt(POOL, { type: "DECLARE" }));
      },
    },
    {
      name: "malformed event",
      change(provider: FakeOriginRpc) {
        provider.receipts.set(
          POOL_TRANSACTION,
          acceptedReceipt(POOL, { events: [{ from_address: STARKNET_UDC_ADDRESS, keys: null }] }),
        );
      },
    },
    {
      name: "sparse event data",
      change(provider: FakeOriginRpc) {
        const data = new Array<string>(1);
        provider.receipts.set(
          POOL_TRANSACTION,
          acceptedReceipt(POOL, { events: [deploymentEvent(POOL, { data })] }),
        );
      },
    },
    {
      name: "duplicate block transaction",
      change(provider: FakeOriginRpc) {
        provider.blocks.set(
          "99",
          acceptedBlock(POOL, { transactions: [POOL_TRANSACTION, POOL_TRANSACTION] }),
        );
      },
    },
    {
      name: "invalid class hash",
      change(provider: FakeOriginRpc) {
        provider.classHashes.set(classKey(POOL), "private-class-response");
      },
    },
  ])("rejects a provider's $name as an invalid response", async ({ change }) => {
    const first = new FakeOriginRpc();
    const second = new FakeOriginRpc();
    change(first);

    await expect(
      createVerifier({ providers: namedProviders(first, second) }).verify(),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("redacts provider failures and bounds requests", async () => {
    const secret = "rpc-secret-value";
    const first = new FakeOriginRpc();
    const second = new FakeOriginRpc();
    second.receipts.set(POOL_TRANSACTION, new Error(secret));

    try {
      await createVerifier({ providers: namedProviders(first, second) }).verify();
      expect.unreachable("Provider failure was accepted");
    } catch (error) {
      expect(error).toEqual(expect.objectContaining({ code: "provider_failure" }));
      expect((error as Error).message).not.toContain(secret);
    }

    const pending = new FakeOriginRpc();
    pending.chainId = new Promise<string>(() => undefined);
    await expect(
      createVerifier({
        providers: namedProviders(new FakeOriginRpc(), pending),
        requestTimeoutMilliseconds: 5,
      }).verify(),
    ).rejects.toMatchObject({ code: "provider_failure" });
  });

  it.each([
    { name: "wrong network", change: { network: "SN_MAIN" } },
    { name: "unknown finality", change: { finalityPolicy: "latest" } },
    { name: "zero timeout", change: { requestTimeoutMilliseconds: 0 } },
    {
      name: "one provider",
      change: { providers: [{ id: "first", provider: new FakeOriginRpc() }] },
    },
    { name: "reversed roles", change: { contracts: [TOKEN, POOL] } },
    {
      name: "duplicate address",
      change: { contracts: [POOL, { ...TOKEN, address: POOL.address }] },
    },
    {
      name: "sparse calldata",
      change: {
        contracts: [
          {
            ...POOL,
            deployment: { ...POOL.deployment, constructorCalldata: new Array<string>(1) },
          },
          TOKEN,
        ],
      },
    },
  ])("rejects configuration with $name", ({ change }) => {
    expect(
      () =>
        new StarknetDeploymentOriginVerifier({
          network: "SN_SEPOLIA",
          finalityPolicy: STARKNET_TRANSACTION_FINALITY_POLICIES.L1,
          contracts: CLAIMS,
          providers: namedProviders(new FakeOriginRpc(), new FakeOriginRpc()),
          requestTimeoutMilliseconds: 1_000,
          ...change,
        } as ConstructorParameters<typeof StarknetDeploymentOriginVerifier>[0]),
    ).toThrow(StarknetDeploymentOriginVerifierConfigurationError);
  });

  it("rejects duplicate provider IDs and instances", () => {
    const shared = new FakeOriginRpc();
    for (const providers of [
      [
        { id: "same", provider: new FakeOriginRpc() },
        { id: "same", provider: new FakeOriginRpc() },
      ],
      [
        { id: "first", provider: shared },
        { id: "second", provider: shared },
      ],
    ]) {
      expect(() => createVerifier({ providers })).toThrow(
        StarknetDeploymentOriginVerifierConfigurationError,
      );
    }
  });
});

describe("single-contract Starknet UDC deployment-origin verifier", () => {
  it("verifies one exact UDC deployment without requiring an unrelated contract claim", async () => {
    const first = new FakeOriginRpc();
    const second = new FakeOriginRpc();

    await expect(
      createSingleVerifier({ providers: namedProviders(first, second) }).verify(),
    ).resolves.toEqual({
      network: "SN_SEPOLIA",
      finalityPolicy: STARKNET_TRANSACTION_FINALITY_POLICIES.L1,
      udcAddress: STARKNET_UDC_ADDRESS,
      udcClassHash: STARKNET_UDC_CLASS_HASH,
      deploymentEventSelector: STARKNET_UDC_CONTRACT_DEPLOYED_SELECTOR,
      contract: {
        role: "privacy_pool",
        address: POOL.address,
        classHash: POOL.classHash,
        transactionReference: POOL_TRANSACTION,
        blockHash: POOL_BLOCK_HASH,
        blockNumber: 99n,
        deployer: POOL.deployment.deployer,
        salt: POOL.deployment.salt,
        unique: false,
        constructorCalldata: POOL.deployment.constructorCalldata,
      },
      providerIds: ["first", "second"],
      verifierVersion: STARKNET_DEPLOYMENT_ORIGIN_VERIFIER_VERSION,
    });
    expect(first.receiptCalls).toEqual([POOL_TRANSACTION]);
    expect(first.blockCalls).toEqual(["99"]);
  });

  it("rejects an underived single-contract address before contacting providers", async () => {
    const first = new FakeOriginRpc();
    const second = new FakeOriginRpc();

    await expect(
      createSingleVerifier({
        contract: { ...POOL, address: "0x123" },
        providers: namedProviders(first, second),
      }).verify(),
    ).rejects.toMatchObject({ code: "deployment_mismatch" });
    expect(first.totalCalls).toBe(0);
    expect(second.totalCalls).toBe(0);
  });

  it("preserves provider consensus and finality checks for a single claim", async () => {
    const first = new FakeOriginRpc();
    const second = new FakeOriginRpc();
    second.classHashes.set(classKey(POOL), "0x999");

    await expect(
      createSingleVerifier({ providers: namedProviders(first, second) }).verify(),
    ).rejects.toMatchObject({ code: "provider_disagreement" });
  });
});

class FakeOriginRpc implements StarknetDeploymentOriginRpc {
  chainId: string | Error | Promise<string> = SEPOLIA_CHAIN_ID;
  readonly receipts = new Map<string, unknown>();
  readonly blocks = new Map<string, unknown>();
  readonly classHashes = new Map<string, string | Error>();
  readonly receiptCalls: string[] = [];
  readonly blockCalls: string[] = [];
  readonly classCalls: { readonly address: string; readonly blockIdentifier: BlockIdentifier }[] =
    [];
  chainCalls = 0;

  constructor() {
    for (const claim of CLAIMS) {
      this.receipts.set(claim.deployment.transactionReference, acceptedReceipt(claim));
      this.blocks.set(claim.deployment.acceptedBlockNumber, acceptedBlock(claim));
      this.classHashes.set(classKey(claim), claim.classHash);
      this.classHashes.set(udcClassKey(claim), STARKNET_UDC_CLASS_HASH);
    }
  }

  get totalCalls(): number {
    return (
      this.chainCalls + this.receiptCalls.length + this.blockCalls.length + this.classCalls.length
    );
  }

  async getChainId(): Promise<string> {
    this.chainCalls += 1;
    return resolved(this.chainId);
  }

  async getTransactionReceipt(transactionHash: string): Promise<unknown> {
    this.receiptCalls.push(transactionHash);
    return resolved(this.receipts.get(transactionHash));
  }

  async getBlockWithTxHashes(blockIdentifier: BlockIdentifier = "latest"): Promise<unknown> {
    const key = String(blockIdentifier);
    this.blockCalls.push(key);
    return resolved(this.blocks.get(key));
  }

  async getClassHashAt(
    contractAddress: string,
    blockIdentifier: BlockIdentifier = "latest",
  ): Promise<string> {
    this.classCalls.push({ address: contractAddress, blockIdentifier });
    return resolved(this.classHashes.get(`${contractAddress}:${String(blockIdentifier)}`));
  }
}

function createVerifier(
  change: Partial<{
    readonly network: "SN_SEPOLIA";
    readonly finalityPolicy: StarknetTransactionFinalityPolicy;
    readonly contracts: readonly StarknetDeploymentOriginClaim[];
    readonly providers: readonly NamedStarknetDeploymentOriginProvider[];
    readonly requestTimeoutMilliseconds: number;
  }> = {},
): StarknetDeploymentOriginVerifier {
  return new StarknetDeploymentOriginVerifier({
    network: "SN_SEPOLIA",
    finalityPolicy: STARKNET_TRANSACTION_FINALITY_POLICIES.L1,
    contracts: CLAIMS,
    providers: namedProviders(new FakeOriginRpc(), new FakeOriginRpc()),
    requestTimeoutMilliseconds: 1_000,
    ...change,
  });
}

function createSingleVerifier(
  change: Partial<ConstructorParameters<typeof StarknetUdcDeploymentOriginVerifier>[0]> = {},
): StarknetUdcDeploymentOriginVerifier {
  return new StarknetUdcDeploymentOriginVerifier({
    network: "SN_SEPOLIA",
    finalityPolicy: STARKNET_TRANSACTION_FINALITY_POLICIES.L1,
    contract: POOL,
    providers: namedProviders(new FakeOriginRpc(), new FakeOriginRpc()),
    requestTimeoutMilliseconds: 1_000,
    ...change,
  });
}

function namedProviders(
  first: StarknetDeploymentOriginRpc | undefined,
  second: StarknetDeploymentOriginRpc | undefined,
): readonly NamedStarknetDeploymentOriginProvider[] {
  if (first === undefined || second === undefined) {
    throw new Error("Test provider fixture is missing");
  }
  return [
    { id: "first", provider: first },
    { id: "second", provider: second },
  ];
}

function claimWithDerivedAddress(
  value: Omit<StarknetDeploymentOriginClaim, "address">,
): StarknetDeploymentOriginClaim {
  const candidate = { ...value, address: "0x1" };
  return { ...candidate, address: calculateStarknetUdcDeploymentAddress(candidate) };
}

function acceptedReceipt(
  claim: StarknetDeploymentOriginClaim,
  change: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    type: "INVOKE",
    transaction_hash: claim.deployment.transactionReference,
    block_hash: claim.deployment.acceptedBlockHash,
    block_number: Number(claim.deployment.acceptedBlockNumber),
    finality_status: "ACCEPTED_ON_L1",
    execution_status: "SUCCEEDED",
    events: [deploymentEvent(claim)],
    ...change,
  };
}

function deploymentEvent(
  claim: StarknetDeploymentOriginClaim,
  change: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    from_address: STARKNET_UDC_ADDRESS,
    keys: [STARKNET_UDC_CONTRACT_DEPLOYED_SELECTOR],
    data: deploymentEventData(claim),
    ...change,
  };
}

function deploymentEventData(
  claim: StarknetDeploymentOriginClaim,
  change: Partial<
    Pick<StarknetDeploymentOriginClaim["deployment"], "constructorCalldata" | "unique">
  > = {},
): readonly string[] {
  const constructorCalldata = change.constructorCalldata ?? claim.deployment.constructorCalldata;
  const unique = change.unique ?? claim.deployment.unique;
  return [
    claim.address,
    claim.deployment.deployer,
    unique ? "0x1" : "0x0",
    claim.classHash,
    `0x${constructorCalldata.length.toString(16)}`,
    ...constructorCalldata,
    claim.deployment.salt,
  ];
}

function acceptedBlock(
  claim: StarknetDeploymentOriginClaim,
  change: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    status: "ACCEPTED_ON_L1",
    block_hash: claim.deployment.acceptedBlockHash,
    block_number: Number(claim.deployment.acceptedBlockNumber),
    transactions: [claim.deployment.transactionReference],
    ...change,
  };
}

function classKey(claim: StarknetDeploymentOriginClaim): string {
  return `${claim.address}:${claim.deployment.acceptedBlockHash}`;
}

function udcClassKey(claim: StarknetDeploymentOriginClaim): string {
  return `${STARKNET_UDC_ADDRESS}:${claim.deployment.acceptedBlockHash}`;
}

async function resolved<Value>(value: Value | Error | Promise<Value> | undefined): Promise<Value> {
  if (value instanceof Error) {
    throw value;
  }
  if (value === undefined) {
    throw new Error("Missing test RPC response");
  }
  return value;
}
