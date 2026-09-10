import type { BlockIdentifier, Call, EventFilter } from "starknet";

import {
  STARKNET_DISCOVERY_SERVICE_COMPONENT_VERSION,
  STARKNET_TRANSACTION_PROVER_API_VERSION,
  STARKNET_TRANSACTION_PROVER_COMPONENT_VERSION,
} from "./privacy-service-compatibility.js";
import {
  STARKNET_ROLE_ADMIN_CHANGED_SELECTOR,
  STARKNET_ROLE_GRANTED_SELECTOR,
  STARKNET_ROLE_GRANTED_WITH_DELAY_SELECTOR,
  STARKNET_ROLE_REVOKED_SELECTOR,
  type StarknetCommonRoleAdministratorClaim,
  type StarknetCommonRoleAssignmentClaim,
  type StarknetCommonRolesAuthorityRpc,
  type StarknetCommonRolesAuthorityVerification,
  StarknetCommonRolesAuthorityVerifier,
} from "./starknet-common-roles-authority-verifier.js";
import {
  STARKNET_IMPLEMENTATION_REPLACED_SELECTOR,
  type StarknetContractUpgradeClaim,
  type StarknetContractUpgradeLineageRpc,
  type StarknetContractUpgradeLineageVerification,
  StarknetContractUpgradeLineageVerifier,
} from "./starknet-contract-upgrade-verifier.js";
import {
  type StarknetDeploymentOriginClaim,
  type StarknetDeploymentOriginContractVerification,
  type StarknetDeploymentOriginRpc,
  type StarknetUdcDeploymentOriginVerification,
  StarknetUdcDeploymentOriginVerifier,
} from "./starknet-deployment-origin-verifier.js";
import {
  type NamedStarknetDiscoveryHeadProvider,
  type StarknetDiscoveryHeadRpc,
  type StarknetDiscoveryHeadVerification,
  StarknetDiscoveryHeadVerifier,
} from "./starknet-discovery-head-verifier.js";
import { StarknetEventInventoryCache } from "./starknet-event-inventory-cache.js";
import { STARKNET_TRANSACTION_FINALITY_POLICIES } from "./starknet-transaction-observer.js";

export const INTEGRATION_SEPOLIA_OBSERVATION_SCHEMA_VERSION =
  "cashu-strk20-integration-sepolia-observation-v4";
export const INTEGRATION_SEPOLIA_OBSERVER_VERSION =
  "starknet@10.5.0:shared-pool-usdc-unified-event-consensus-v5";

export interface IntegrationSepoliaProfile {
  readonly id: "starkware-integration-sepolia";
  readonly network: "SN_SEPOLIA";
  readonly sources: {
    readonly privacyRelease: "PRIVACY-0.14.3-RC.6";
    readonly privacyCommit: string;
    readonly demoCommit: string;
    readonly tokenRegistryCommit: string;
    readonly commonRolesCommit: string;
  };
  readonly pool: {
    readonly address: string;
    readonly classHash: string;
    readonly versionFelt: string;
    readonly version: "2.1";
    readonly proofValidityBlocks: 450;
    readonly deployment: Omit<StarknetDeploymentOriginClaim, "address" | "role">;
    readonly upgrades: readonly Omit<StarknetContractUpgradeClaim, "contractAddress" | "network">[];
    readonly authority: {
      readonly expectedEventCount: 21;
      readonly expectedInventorySha256: string;
      readonly expectedAssignments: readonly StarknetCommonRoleAssignmentClaim[];
      readonly expectedRoleAdministrators: readonly StarknetCommonRoleAdministratorClaim[];
    };
  };
  readonly token: {
    readonly address: string;
    readonly classHash: string;
    readonly symbol: "USDC";
    readonly decimals: 6;
  };
  readonly services: {
    readonly discovery: {
      readonly operator: "starkware-integration";
      readonly componentVersion: typeof STARKNET_DISCOVERY_SERVICE_COMPONENT_VERSION;
      readonly url: string;
    };
    readonly prover: {
      readonly operator: "starkware-integration";
      readonly componentVersion: typeof STARKNET_TRANSACTION_PROVER_COMPONENT_VERSION;
      readonly apiVersion: typeof STARKNET_TRANSACTION_PROVER_API_VERSION;
      readonly url: string;
    };
  };
  readonly rpcProviders: readonly [
    { readonly id: "publicnode"; readonly operator: "publicnode"; readonly url: string },
    { readonly id: "cartridge"; readonly operator: "cartridge"; readonly url: string },
  ];
  readonly freshness: {
    readonly maximumBlockAgeSeconds: number;
    readonly maximumFutureBlockTimeSeconds: number;
  };
}

export const STARKWARE_INTEGRATION_SEPOLIA_PROFILE: IntegrationSepoliaProfile = Object.freeze({
  id: "starkware-integration-sepolia",
  network: "SN_SEPOLIA",
  sources: Object.freeze({
    privacyRelease: "PRIVACY-0.14.3-RC.6",
    privacyCommit: "4db755b9512f00b540126737b605472ea2275e15",
    demoCommit: "42bc24b18166f8a685ec2c0c0f8d9cd6dfb585f6",
    tokenRegistryCommit: "e46241a806dd2d85cdf89dfb5c076855ff1e512e",
    commonRolesCommit: "3e2fd53d99e16c87f6cf2ced53b8c842a2d54a18",
  }),
  pool: Object.freeze({
    address: "0x254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91",
    classHash: "0x7e2bbd7ccc1e68b2695caef70aeb2a3be6cd017b5d5159278ba08f2d8de33f",
    versionFelt: "0x322e31",
    version: "2.1",
    proofValidityBlocks: 450,
    deployment: Object.freeze({
      classHash: "0x715b22abfb60815623f4127ba64bd2f93613d8a5c1e519841eaab444659d2af",
      deployment: Object.freeze({
        transactionReference: "0x76faebc727e97725d5dc7b8aa1d058ce412249e36b4f922923411cf9edffbab",
        acceptedBlockHash: "0x70082b584837fd545e74902e27a78d56bbfcbd4aae097a366fb39d426e9af60",
        acceptedBlockNumber: "8271125",
        deployer: "0x48baf3ed1f0a03840186bd95063f63824d93bafd456439bfe667533437d9c91",
        salt: "0x19d44d8c15b",
        unique: true,
        constructorCalldata: Object.freeze([
          "0x48baf3ed1f0a03840186bd95063f63824d93bafd456439bfe667533437d9c91",
          "0x1d17f98be07e99713265714699a5c40ccbf7b50c950fb7a2abd81846fcdfbb2",
          "0x1c2",
        ]),
      }),
    }),
    upgrades: Object.freeze([
      Object.freeze({
        previousClassHash: "0x715b22abfb60815623f4127ba64bd2f93613d8a5c1e519841eaab444659d2af",
        classHash: "0x30b8c540cf04d8ef0f4db2a9098d9cc0e35e83af1cb3325f5a4f40144b4b30b",
        transactionHash: "0x4762b69680119e186dd3f9e1666c2e9b540ea17d39334ae6870c691ed2dab18",
        senderAddress: "0x48baf3ed1f0a03840186bd95063f63824d93bafd456439bfe667533437d9c91",
        blockNumber: 10_829_820,
        blockHash: "0xc0ef48e3f854c33f97206b02a0c9a4854b9f4905c6b72fa89dfe0380af7a95",
        parentBlockHash: "0x51a3d51214b11e9ccc71f905312c416427879bcdf49e8ec93b2177a61d9c449",
        finalityPolicy: STARKNET_TRANSACTION_FINALITY_POLICIES.L1,
      }),
      Object.freeze({
        previousClassHash: "0x30b8c540cf04d8ef0f4db2a9098d9cc0e35e83af1cb3325f5a4f40144b4b30b",
        classHash: "0x1a78d2daee64d1da6e7903b32676c92fcc301d4c03f688cd64e731f46033d18",
        transactionHash: "0x5bb9632c45ae060ab33ab10871d5f3d1ff65fdf4d611962ef169cf29500675d",
        senderAddress: "0x3e6c6f41d833ec5e7d38e6007df5b0ab6b48bc4c2d3dbeac1ed665456ae4766",
        blockNumber: 11_111_946,
        blockHash: "0x2647ecc285265009ea476ff2c577774753dc8a4d846ee55f85f65d2afde3fcb",
        parentBlockHash: "0x64dcabb25976512a7ab3f0fedcd545607de360cd31f317fb4eb2a0b7817d81e",
        finalityPolicy: STARKNET_TRANSACTION_FINALITY_POLICIES.L1,
      }),
      Object.freeze({
        previousClassHash: "0x1a78d2daee64d1da6e7903b32676c92fcc301d4c03f688cd64e731f46033d18",
        classHash: "0x67dddd89d80fedadc06b6f160798f94800a4a70164e5a24301cd0d6076b554d",
        transactionHash: "0x284a3bf9aa86e8487dd485f9325b45bbe32b6c06bac0749cc5d7ae2767e01e1",
        senderAddress: "0x3e6c6f41d833ec5e7d38e6007df5b0ab6b48bc4c2d3dbeac1ed665456ae4766",
        blockNumber: 11_612_079,
        blockHash: "0x5de657efd5622a48cbfc0ddeb1ed8546da08ec772da555c24f74f2b2a9b0163",
        parentBlockHash: "0x79cf36389031e1346436a084d5dbe0c9f801c19f464d37613040c9ce1c4ff23",
        finalityPolicy: STARKNET_TRANSACTION_FINALITY_POLICIES.L1,
      }),
      Object.freeze({
        previousClassHash: "0x67dddd89d80fedadc06b6f160798f94800a4a70164e5a24301cd0d6076b554d",
        classHash: "0x56ab118a8a6e38efc93ad758cefe909fee421fa931ce3cf72df624d345623b2",
        transactionHash: "0x59f76fec2b924279e475d94c3b0d01f56cff857dfd730e25e05f1fcfe4344f2",
        senderAddress: "0x48baf3ed1f0a03840186bd95063f63824d93bafd456439bfe667533437d9c91",
        blockNumber: 12_932_675,
        blockHash: "0xb00195a1860180a685bb53726cb9eff9e2a13d0c29ad761c5e38f3c20bc4fb",
        parentBlockHash: "0x7963fd8e3dfe93c5d211eb5ae4574cac3669af8378d631f9c78839e37a0ed70",
        finalityPolicy: STARKNET_TRANSACTION_FINALITY_POLICIES.L1,
      }),
      Object.freeze({
        previousClassHash: "0x56ab118a8a6e38efc93ad758cefe909fee421fa931ce3cf72df624d345623b2",
        classHash: "0x7e2bbd7ccc1e68b2695caef70aeb2a3be6cd017b5d5159278ba08f2d8de33f",
        transactionHash: "0xfe78bf11c285dd2b0110ad96f79b9d4693c7e39179f83e965e022e414e57f8",
        senderAddress: "0x3e6c6f41d833ec5e7d38e6007df5b0ab6b48bc4c2d3dbeac1ed665456ae4766",
        blockNumber: 14_339_893,
        blockHash: "0x331fb8ba73eaf6e24d2565b6b03091e34cf6a9840f165c9b3f7852cd5b985f1",
        parentBlockHash: "0x3a4db54fcc3c4d374db39a6ee487d7945aade550a9f0defa583a9a3637a3a4c",
        finalityPolicy: STARKNET_TRANSACTION_FINALITY_POLICIES.L1,
      }),
    ]),
    authority: Object.freeze({
      expectedEventCount: 21,
      expectedInventorySha256: "c3f2bc120b4debbd20a01d75f9726a52f042591d93ab51b9cd67aef2d51678eb",
      expectedAssignments: Object.freeze([
        Object.freeze({
          role: "APP_GOVERNOR",
          account: "0x48baf3ed1f0a03840186bd95063f63824d93bafd456439bfe667533437d9c91",
        }),
        Object.freeze({
          role: "APP_ROLE_ADMIN",
          account: "0x48baf3ed1f0a03840186bd95063f63824d93bafd456439bfe667533437d9c91",
        }),
        Object.freeze({
          role: "GOVERNANCE_ADMIN",
          account: "0x48baf3ed1f0a03840186bd95063f63824d93bafd456439bfe667533437d9c91",
        }),
        Object.freeze({
          role: "UPGRADE_GOVERNOR",
          account: "0x48baf3ed1f0a03840186bd95063f63824d93bafd456439bfe667533437d9c91",
        }),
        Object.freeze({
          role: "SECURITY_ADMIN",
          account: "0x48baf3ed1f0a03840186bd95063f63824d93bafd456439bfe667533437d9c91",
        }),
        Object.freeze({
          role: "APP_GOVERNOR",
          account: "0x3e6c6f41d833ec5e7d38e6007df5b0ab6b48bc4c2d3dbeac1ed665456ae4766",
        }),
        Object.freeze({
          role: "APP_ROLE_ADMIN",
          account: "0x3e6c6f41d833ec5e7d38e6007df5b0ab6b48bc4c2d3dbeac1ed665456ae4766",
        }),
        Object.freeze({
          role: "GOVERNANCE_ADMIN",
          account: "0x3e6c6f41d833ec5e7d38e6007df5b0ab6b48bc4c2d3dbeac1ed665456ae4766",
        }),
        Object.freeze({
          role: "UPGRADE_GOVERNOR",
          account: "0x3e6c6f41d833ec5e7d38e6007df5b0ab6b48bc4c2d3dbeac1ed665456ae4766",
        }),
        Object.freeze({
          role: "SECURITY_ADMIN",
          account: "0x3e6c6f41d833ec5e7d38e6007df5b0ab6b48bc4c2d3dbeac1ed665456ae4766",
        }),
        Object.freeze({
          role: "SECURITY_GOVERNOR",
          account: "0x3e6c6f41d833ec5e7d38e6007df5b0ab6b48bc4c2d3dbeac1ed665456ae4766",
        }),
      ]),
      expectedRoleAdministrators: Object.freeze([
        Object.freeze({ role: "APP_GOVERNOR", administrator: "APP_ROLE_ADMIN" }),
        Object.freeze({ role: "APP_ROLE_ADMIN", administrator: "GOVERNANCE_ADMIN" }),
        Object.freeze({ role: "GOVERNANCE_ADMIN", administrator: "GOVERNANCE_ADMIN" }),
        Object.freeze({ role: "OPERATOR", administrator: "APP_ROLE_ADMIN" }),
        Object.freeze({ role: "TOKEN_ADMIN", administrator: "APP_ROLE_ADMIN" }),
        Object.freeze({ role: "UPGRADE_AGENT", administrator: "APP_ROLE_ADMIN" }),
        Object.freeze({ role: "UPGRADE_GOVERNOR", administrator: "GOVERNANCE_ADMIN" }),
        Object.freeze({ role: "SECURITY_ADMIN", administrator: "SECURITY_ADMIN" }),
        Object.freeze({ role: "SECURITY_AGENT", administrator: "SECURITY_ADMIN" }),
        Object.freeze({ role: "SECURITY_GOVERNOR", administrator: "SECURITY_ADMIN" }),
      ]),
    }),
  }),
  token: Object.freeze({
    address: "0x53b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080",
    classHash: "0xb45dbc3714180381c5680e41931172d67194d77d504413465390e0bef194ec",
    symbol: "USDC",
    decimals: 6,
  }),
  services: Object.freeze({
    discovery: Object.freeze({
      operator: "starkware-integration",
      componentVersion: STARKNET_DISCOVERY_SERVICE_COMPONENT_VERSION,
      url: "https://discovery-service.alpha-sepolia.sw-dev.io",
    }),
    prover: Object.freeze({
      operator: "starkware-integration",
      componentVersion: STARKNET_TRANSACTION_PROVER_COMPONENT_VERSION,
      apiVersion: STARKNET_TRANSACTION_PROVER_API_VERSION,
      url: "https://transaction-prover.alpha-sepolia.sw-dev.io",
    }),
  }),
  rpcProviders: Object.freeze([
    Object.freeze({
      id: "publicnode",
      operator: "publicnode",
      url: "https://starknet-sepolia-rpc.publicnode.com",
    }),
    Object.freeze({
      id: "cartridge",
      operator: "cartridge",
      url: "https://api.cartridge.gg/x/starknet/sepolia",
    }),
  ] as const),
  freshness: Object.freeze({
    maximumBlockAgeSeconds: 180,
    maximumFutureBlockTimeSeconds: 15,
  }),
});

export interface IntegrationSepoliaRpc
  extends StarknetDiscoveryHeadRpc,
    StarknetContractUpgradeLineageRpc,
    StarknetDeploymentOriginRpc,
    StarknetCommonRolesAuthorityRpc {
  getClassHashAt(contractAddress: string, blockIdentifier?: BlockIdentifier): Promise<string>;
  callContract(call: Call, blockIdentifier?: BlockIdentifier): Promise<string[]>;
}

type IntegrationSepoliaDeploymentEvidence = Omit<
  StarknetUdcDeploymentOriginVerification,
  "contract"
> & {
  readonly contract: Omit<StarknetDeploymentOriginContractVerification, "blockNumber"> & {
    readonly blockNumber: string;
  };
};

export interface NamedIntegrationSepoliaProvider {
  readonly id: string;
  readonly provider: IntegrationSepoliaRpc;
}

export interface IntegrationSepoliaObservationEvidence {
  readonly schemaVersion: typeof INTEGRATION_SEPOLIA_OBSERVATION_SCHEMA_VERSION;
  readonly observerVersion: typeof INTEGRATION_SEPOLIA_OBSERVER_VERSION;
  readonly observedAt: string;
  readonly profile: {
    readonly id: typeof STARKWARE_INTEGRATION_SEPOLIA_PROFILE.id;
    readonly network: "SN_SEPOLIA";
    readonly sources: IntegrationSepoliaProfile["sources"];
    readonly rpcProviders: readonly [
      { readonly id: "publicnode"; readonly operator: "publicnode" },
      { readonly id: "cartridge"; readonly operator: "cartridge" },
    ];
  };
  readonly chain: StarknetDiscoveryHeadVerification;
  readonly deployment: IntegrationSepoliaDeploymentEvidence;
  readonly replaceToLineage: StarknetContractUpgradeLineageVerification;
  readonly commonRolesAuthority: StarknetCommonRolesAuthorityVerification;
  readonly pool: {
    readonly address: string;
    readonly classHash: string;
    readonly version: "2.1";
    readonly auditorPublicKey: string;
    readonly screenerPublicKey: string;
    readonly proofValidityBlocks: 450;
    readonly feeAmountFri: string;
    readonly feeCollector: string;
  };
  readonly token: {
    readonly address: string;
    readonly classHash: string;
    readonly symbol: "USDC";
    readonly decimals: 6;
  };
  readonly services: {
    readonly discovery: {
      readonly operator: "starkware-integration";
      readonly configuredComponentVersion: typeof STARKNET_DISCOVERY_SERVICE_COMPONENT_VERSION;
      readonly status: "OK";
      readonly reportedLagSeconds: number;
    };
    readonly prover: {
      readonly operator: "starkware-integration";
      readonly configuredComponentVersion: typeof STARKNET_TRANSACTION_PROVER_COMPONENT_VERSION;
      readonly apiVersion: typeof STARKNET_TRANSACTION_PROVER_API_VERSION;
    };
  };
  readonly verification: {
    readonly poolClassCompatible: true;
    readonly poolConfigurationCompatible: true;
    readonly usdcClassPinned: true;
    readonly usdcDecimalsCompatible: true;
    readonly discoveryChainStateVerified: true;
    readonly proverApiCompatible: true;
    readonly noTransactionSubmitted: true;
    readonly noCashuOrPrivateTransactionDataSent: true;
    readonly deploymentOwnerManifestVerified: false;
    readonly poolDeploymentOriginVerified: true;
    readonly poolReplaceToLineageVerified: true;
    readonly poolCommonRolesAuthorityStateVerified: true;
    readonly remoteRuntimeVersionsVerified: false;
    readonly screeningRuntimeConfigurationVerified: false;
    readonly screeningActivityVerified: false;
    readonly fundedExecutionApproved: false;
  };
  readonly blockers: readonly [
    "deployment_owner_manifest_unverified",
    "remote_runtime_versions_unverified",
    "screening_runtime_configuration_unverified",
    "screening_activity_unverified",
    "settlement_account_unconfigured",
    "funded_execution_not_run",
  ];
}

export type IntegrationSepoliaObserverErrorCode =
  | "discovery_response_invalid"
  | "discovery_stale"
  | "discovery_unavailable"
  | "profile_mismatch"
  | "provider_disagreement"
  | "provider_failure"
  | "prover_response_invalid"
  | "prover_unavailable"
  | "prover_version_mismatch";

export class IntegrationSepoliaObserverError extends Error {
  readonly code: IntegrationSepoliaObserverErrorCode;

  constructor(code: IntegrationSepoliaObserverErrorCode, message: string) {
    super(message);
    this.name = "IntegrationSepoliaObserverError";
    this.code = code;
  }
}

export async function observeStarkwareIntegrationSepolia(input: {
  readonly providers: readonly NamedIntegrationSepoliaProvider[];
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => Date;
  readonly requestTimeoutMilliseconds?: number;
}): Promise<IntegrationSepoliaObservationEvidence> {
  if (typeof input !== "object" || input === null) {
    throw profileMismatch();
  }
  const providers = configuredProviders(input.providers);
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const now = input.now ?? (() => new Date());
  const requestTimeoutMilliseconds = configuredTimeout(
    input.requestTimeoutMilliseconds ?? DEFAULT_REQUEST_TIMEOUT_MILLISECONDS,
  );
  if (typeof fetchImplementation !== "function" || typeof now !== "function") {
    throw profileMismatch();
  }

  const [discovery, proverApiVersion] = await Promise.all([
    probeDiscovery(fetchImplementation, requestTimeoutMilliseconds),
    probeProver(fetchImplementation, requestTimeoutMilliseconds),
  ]);
  if (proverApiVersion !== STARKWARE_INTEGRATION_SEPOLIA_PROFILE.services.prover.apiVersion) {
    throw new IntegrationSepoliaObserverError(
      "prover_version_mismatch",
      "Integration Sepolia prover API does not match the pinned compatibility profile",
    );
  }

  const observedAt = timestamp(now);
  assertFreshDiscovery(discovery, observedAt);
  const discoveryProviders: readonly NamedStarknetDiscoveryHeadProvider[] = providers.map(
    ({ id, provider }) => ({ id, provider }),
  );
  const chain = await new StarknetDiscoveryHeadVerifier({
    network: STARKWARE_INTEGRATION_SEPOLIA_PROFILE.network,
    providers: discoveryProviders,
    requestTimeoutMilliseconds,
  }).verify({
    blockNumber: discovery.blockNumber,
    blockHash: discovery.blockHash,
    blockTimestamp: discovery.blockTimestamp,
  });

  const results = await Promise.allSettled(
    providers.map(({ id, provider }) =>
      readProfileState(id, provider, chain.blockHash, requestTimeoutMilliseconds),
    ),
  );
  const observations = results.map((result, index) => {
    const provider = requiredProvider(providers, index);
    if (result.status === "fulfilled") {
      return result.value;
    }
    if (result.reason instanceof IntegrationSepoliaObserverError) {
      throw result.reason;
    }
    throw providerFailure(provider.id);
  });
  const state = agreedState(observations);
  assertExpectedState(state);
  const profile = STARKWARE_INTEGRATION_SEPOLIA_PROFILE;
  const deploymentClaim: StarknetDeploymentOriginClaim = {
    role: "privacy_pool",
    address: profile.pool.address,
    ...profile.pool.deployment,
  };
  const upgradeClaims = profile.pool.upgrades.map(
    (upgrade): StarknetContractUpgradeClaim => ({
      network: profile.network,
      contractAddress: profile.pool.address,
      ...upgrade,
    }),
  );
  const finalUpgrade = upgradeClaims.at(-1);
  if (finalUpgrade === undefined || chain.blockNumber < finalUpgrade.blockNumber) {
    throw profileMismatch();
  }
  const deploymentProviders = providers.map(({ id, provider }) => ({ id, provider }));
  const lineageProviders = providers.map(({ id, provider }) => ({
    id,
    provider: providerWithSharedEventInventory(provider, chain.blockHash),
  }));
  const [deploymentVerification, replaceToLineage] = await Promise.all([
    new StarknetUdcDeploymentOriginVerifier({
      network: profile.network,
      finalityPolicy: STARKNET_TRANSACTION_FINALITY_POLICIES.L1,
      contract: deploymentClaim,
      providers: deploymentProviders,
      requestTimeoutMilliseconds,
    }).verify(),
    new StarknetContractUpgradeLineageVerifier({
      network: profile.network,
      contractAddress: profile.pool.address,
      initialClassHash: profile.pool.deployment.classHash,
      inventoryFromBlockNumber: Number(profile.pool.deployment.deployment.acceptedBlockNumber),
      inventoryThroughBlockHash: chain.blockHash,
      upgrades: upgradeClaims,
      providers: lineageProviders,
      requestTimeoutMilliseconds,
    }).verify(),
  ]);
  const deployment = serializableDeployment(deploymentVerification);
  const commonRolesAuthority = await new StarknetCommonRolesAuthorityVerifier({
    network: profile.network,
    contractAddress: profile.pool.address,
    inventoryFromBlockNumber: Number(profile.pool.deployment.deployment.acceptedBlockNumber),
    inventoryThroughBlockHash: chain.blockHash,
    expectedEventCount: profile.pool.authority.expectedEventCount,
    expectedInventorySha256: profile.pool.authority.expectedInventorySha256,
    expectedAssignments: profile.pool.authority.expectedAssignments,
    expectedRoleAdministrators: profile.pool.authority.expectedRoleAdministrators,
    providers: lineageProviders,
    requestTimeoutMilliseconds,
  }).verify();

  return {
    schemaVersion: INTEGRATION_SEPOLIA_OBSERVATION_SCHEMA_VERSION,
    observerVersion: INTEGRATION_SEPOLIA_OBSERVER_VERSION,
    observedAt,
    profile: {
      id: profile.id,
      network: profile.network,
      sources: profile.sources,
      rpcProviders: [
        { id: "publicnode", operator: "publicnode" },
        { id: "cartridge", operator: "cartridge" },
      ],
    },
    chain,
    deployment,
    replaceToLineage,
    commonRolesAuthority,
    pool: {
      address: profile.pool.address,
      classHash: state.poolClassHash,
      version: profile.pool.version,
      auditorPublicKey: state.auditorPublicKey,
      screenerPublicKey: state.screenerPublicKey,
      proofValidityBlocks: profile.pool.proofValidityBlocks,
      feeAmountFri: state.feeAmount.toString(10),
      feeCollector: state.feeCollector,
    },
    token: {
      address: profile.token.address,
      classHash: state.tokenClassHash,
      symbol: profile.token.symbol,
      decimals: profile.token.decimals,
    },
    services: {
      discovery: {
        operator: profile.services.discovery.operator,
        configuredComponentVersion: profile.services.discovery.componentVersion,
        status: "OK",
        reportedLagSeconds: discovery.reportedLagSeconds,
      },
      prover: {
        operator: profile.services.prover.operator,
        configuredComponentVersion: profile.services.prover.componentVersion,
        apiVersion: profile.services.prover.apiVersion,
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
  };
}

function providerWithSharedEventInventory(
  provider: IntegrationSepoliaRpc,
  throughBlockHash: string,
): IntegrationSepoliaRpc {
  const profile = STARKWARE_INTEGRATION_SEPOLIA_PROFILE;
  const eventInventory = new StarknetEventInventoryCache({
    provider,
    contractAddress: profile.pool.address,
    fromBlockNumber: Number(profile.pool.deployment.deployment.acceptedBlockNumber),
    throughBlockHash,
    selectors: [
      STARKNET_IMPLEMENTATION_REPLACED_SELECTOR,
      STARKNET_ROLE_GRANTED_SELECTOR,
      STARKNET_ROLE_GRANTED_WITH_DELAY_SELECTOR,
      STARKNET_ROLE_REVOKED_SELECTOR,
      STARKNET_ROLE_ADMIN_CHANGED_SELECTOR,
    ],
  });
  return {
    getChainId: () => provider.getChainId(),
    getTransactionByHash: (transactionHash: string) =>
      provider.getTransactionByHash(transactionHash),
    getTransactionReceipt: (transactionHash: string) =>
      provider.getTransactionReceipt(transactionHash),
    getBlockWithTxHashes: (blockIdentifier?: BlockIdentifier) =>
      provider.getBlockWithTxHashes(blockIdentifier),
    getClassHashAt: (contractAddress: string, blockIdentifier?: BlockIdentifier) =>
      provider.getClassHashAt(contractAddress, blockIdentifier),
    callContract: (call: Call, blockIdentifier?: BlockIdentifier) =>
      provider.callContract(call, blockIdentifier),
    getEvents: (eventFilter: EventFilter) => eventInventory.getEvents(eventFilter),
  };
}

function serializableDeployment(
  value: StarknetUdcDeploymentOriginVerification,
): IntegrationSepoliaDeploymentEvidence {
  return {
    network: value.network,
    finalityPolicy: value.finalityPolicy,
    udcAddress: value.udcAddress,
    udcClassHash: value.udcClassHash,
    deploymentEventSelector: value.deploymentEventSelector,
    contract: {
      ...value.contract,
      blockNumber: value.contract.blockNumber.toString(10),
    },
    providerIds: value.providerIds,
    verifierVersion: value.verifierVersion,
  };
}

interface DiscoveryObservation {
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly blockTimestamp: number;
  readonly reportedLagSeconds: number;
}

interface ProviderState {
  readonly poolClassHash: string;
  readonly tokenClassHash: string;
  readonly poolVersionFelt: string;
  readonly auditorPublicKey: string;
  readonly screenerPublicKey: string;
  readonly proofValidityBlocks: number;
  readonly feeAmount: bigint;
  readonly feeCollector: string;
  readonly tokenDecimals: number;
}

async function probeDiscovery(
  fetchImplementation: typeof fetch,
  timeoutMilliseconds: number,
): Promise<DiscoveryObservation> {
  const value = await requestJson(
    "discovery",
    fetchImplementation,
    `${STARKWARE_INTEGRATION_SEPOLIA_PROFILE.services.discovery.url}/health`,
    {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "cashu-strk20-observer/1" },
    },
    timeoutMilliseconds,
  );
  const record = plainRecord(value, "discovery");
  const { chain_head: chainHead, lag_secs: lagSeconds, status } = record;
  const head = plainRecord(chainHead, "discovery");
  const { block_hash: blockHash, block_number: blockNumber, timestamp: blockTimestamp } = head;
  if (status !== "OK") {
    throw invalidResponse("discovery");
  }
  return {
    blockNumber: responseSafeInteger(blockNumber, "discovery", false),
    blockHash: responseFelt(blockHash, "discovery", false),
    blockTimestamp: responseSafeInteger(blockTimestamp, "discovery", true),
    reportedLagSeconds: responseSafeInteger(lagSeconds, "discovery", false),
  };
}

async function probeProver(
  fetchImplementation: typeof fetch,
  timeoutMilliseconds: number,
): Promise<string> {
  const value = await requestJson(
    "prover",
    fetchImplementation,
    STARKWARE_INTEGRATION_SEPOLIA_PROFILE.services.prover.url,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "cashu-strk20-observer/1",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "starknet_specVersion",
        params: [],
      }),
    },
    timeoutMilliseconds,
  );
  const record = plainRecord(value, "prover");
  const { id, jsonrpc, result } = record;
  if (
    jsonrpc !== "2.0" ||
    id !== 1 ||
    typeof result !== "string" ||
    Object.hasOwn(record, "error")
  ) {
    throw invalidResponse("prover");
  }
  return result;
}

async function readProfileState(
  providerId: string,
  provider: IntegrationSepoliaRpc,
  blockHash: string,
  timeoutMilliseconds: number,
): Promise<ProviderState> {
  const pool = STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.address;
  const token = STARKWARE_INTEGRATION_SEPOLIA_PROFILE.token.address;
  const poolClassHash = responseFelt(
    await providerValue(providerId, timeoutMilliseconds, () =>
      provider.getClassHashAt(pool, blockHash),
    ),
    providerId,
    false,
  );
  const tokenClassHash = responseFelt(
    await providerValue(providerId, timeoutMilliseconds, () =>
      provider.getClassHashAt(token, blockHash),
    ),
    providerId,
    false,
  );
  const poolVersionFelt = singleCallFelt(
    await callView(providerId, provider, pool, "get_version", blockHash, timeoutMilliseconds),
    providerId,
    false,
  );
  const auditorPublicKey = singleCallFelt(
    await callView(
      providerId,
      provider,
      pool,
      "get_auditor_public_key",
      blockHash,
      timeoutMilliseconds,
    ),
    providerId,
    true,
  );
  const screenerPublicKey = singleCallFelt(
    await callView(
      providerId,
      provider,
      pool,
      "get_screener_public_key",
      blockHash,
      timeoutMilliseconds,
    ),
    providerId,
    true,
  );
  const proofValidityBlocks = safeInteger(
    singleCallUnsignedInteger(
      await callView(
        providerId,
        provider,
        pool,
        "get_proof_validity_blocks",
        blockHash,
        timeoutMilliseconds,
      ),
      providerId,
    ),
    providerId,
  );
  const feeAmount = singleCallUnsignedInteger(
    await callView(providerId, provider, pool, "get_fee_amount", blockHash, timeoutMilliseconds),
    providerId,
  );
  const feeCollector = singleCallFelt(
    await callView(providerId, provider, pool, "get_fee_collector", blockHash, timeoutMilliseconds),
    providerId,
    true,
  );
  const tokenDecimals = safeInteger(
    singleCallUnsignedInteger(
      await callView(providerId, provider, token, "decimals", blockHash, timeoutMilliseconds),
      providerId,
    ),
    providerId,
  );
  return {
    poolClassHash,
    tokenClassHash,
    poolVersionFelt,
    auditorPublicKey,
    screenerPublicKey,
    proofValidityBlocks,
    feeAmount,
    feeCollector,
    tokenDecimals,
  };
}

async function callView(
  providerId: string,
  provider: IntegrationSepoliaRpc,
  contractAddress: string,
  entrypoint: string,
  blockHash: string,
  timeoutMilliseconds: number,
): Promise<string[]> {
  return providerValue(providerId, timeoutMilliseconds, () =>
    provider.callContract({ contractAddress, entrypoint, calldata: [] }, blockHash),
  );
}

async function providerValue<Value>(
  providerId: string,
  timeoutMilliseconds: number,
  operation: () => Promise<Value>,
): Promise<Value> {
  try {
    return await withTimeout(Promise.resolve().then(operation), timeoutMilliseconds);
  } catch {
    throw providerFailure(providerId);
  }
}

function configuredProviders(
  value: readonly NamedIntegrationSepoliaProvider[],
): readonly NamedIntegrationSepoliaProvider[] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw profileMismatch();
  }
  const expected = STARKWARE_INTEGRATION_SEPOLIA_PROFILE.rpcProviders;
  const instances = new Set<IntegrationSepoliaRpc>();
  return Object.freeze(
    Array.from(value, (named, index) => {
      if (
        typeof named !== "object" ||
        named === null ||
        named.id !== expected[index]?.id ||
        typeof named.provider !== "object" ||
        named.provider === null ||
        typeof named.provider.getChainId !== "function" ||
        typeof named.provider.getTransactionByHash !== "function" ||
        typeof named.provider.getTransactionReceipt !== "function" ||
        typeof named.provider.getBlockWithTxHashes !== "function" ||
        typeof named.provider.getClassHashAt !== "function" ||
        typeof named.provider.getEvents !== "function" ||
        typeof named.provider.callContract !== "function" ||
        instances.has(named.provider)
      ) {
        throw profileMismatch();
      }
      instances.add(named.provider);
      return { id: named.id, provider: named.provider };
    }),
  );
}

function agreedState(values: readonly ProviderState[]): ProviderState {
  const first = values[0];
  if (first === undefined || values.length !== 2) {
    throw profileMismatch();
  }
  for (const value of values.slice(1)) {
    if (
      value.poolClassHash !== first.poolClassHash ||
      value.tokenClassHash !== first.tokenClassHash ||
      value.poolVersionFelt !== first.poolVersionFelt ||
      value.auditorPublicKey !== first.auditorPublicKey ||
      value.screenerPublicKey !== first.screenerPublicKey ||
      value.proofValidityBlocks !== first.proofValidityBlocks ||
      value.feeAmount !== first.feeAmount ||
      value.feeCollector !== first.feeCollector ||
      value.tokenDecimals !== first.tokenDecimals
    ) {
      throw new IntegrationSepoliaObserverError(
        "provider_disagreement",
        "Integration Sepolia providers disagree on the shared settlement profile",
      );
    }
  }
  return first;
}

function assertExpectedState(value: ProviderState): void {
  const profile = STARKWARE_INTEGRATION_SEPOLIA_PROFILE;
  if (
    value.poolClassHash !== profile.pool.classHash ||
    value.tokenClassHash !== profile.token.classHash ||
    value.poolVersionFelt !== profile.pool.versionFelt ||
    value.proofValidityBlocks !== profile.pool.proofValidityBlocks ||
    value.tokenDecimals !== profile.token.decimals ||
    value.auditorPublicKey === "0x0" ||
    value.screenerPublicKey === "0x0" ||
    (value.feeAmount > 0n && value.feeCollector === "0x0")
  ) {
    throw profileMismatch();
  }
}

function assertFreshDiscovery(value: DiscoveryObservation, observedAt: string): void {
  const observedAtSeconds = Math.floor(Date.parse(observedAt) / 1_000);
  const policy = STARKWARE_INTEGRATION_SEPOLIA_PROFILE.freshness;
  if (
    value.blockTimestamp < observedAtSeconds - policy.maximumBlockAgeSeconds ||
    value.blockTimestamp > observedAtSeconds + policy.maximumFutureBlockTimeSeconds ||
    value.reportedLagSeconds > policy.maximumBlockAgeSeconds
  ) {
    throw new IntegrationSepoliaObserverError(
      "discovery_stale",
      "Integration Sepolia discovery head is outside the pinned freshness policy",
    );
  }
}

async function requestJson(
  role: ServiceRole,
  fetchImplementation: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMilliseconds: number,
): Promise<unknown> {
  let response: Response;
  try {
    response = await withTimeout(
      Promise.resolve().then(() =>
        fetchImplementation(url, {
          ...init,
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: AbortSignal.timeout(timeoutMilliseconds),
        }),
      ),
      timeoutMilliseconds,
    );
  } catch {
    throw unavailable(role);
  }
  if (!response.ok) {
    cancelResponseBody(response);
    throw unavailable(role);
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    cancelResponseBody(response);
    throw invalidResponse(role);
  }
  let bytes: Uint8Array;
  try {
    bytes = await withTimeout(boundedBody(response, role), timeoutMilliseconds);
  } catch (error) {
    if (error instanceof IntegrationSepoliaObserverError) {
      throw error;
    }
    cancelResponseBody(response);
    throw unavailable(role);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw invalidResponse(role);
  }
}

async function boundedBody(response: Response, role: ServiceRole): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(length) || Number(length) > MAXIMUM_RESPONSE_BYTES)
  ) {
    throw invalidResponse(role);
  }
  if (response.body === null) {
    throw invalidResponse(role);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let releaseFailed = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      if (!(result.value instanceof Uint8Array)) {
        throw invalidResponse(role);
      }
      total += result.value.byteLength;
      if (!Number.isSafeInteger(total) || total > MAXIMUM_RESPONSE_BYTES) {
        throw invalidResponse(role);
      }
      chunks.push(Uint8Array.from(result.value));
    }
  } catch (error) {
    if (error instanceof IntegrationSepoliaObserverError) {
      throw error;
    }
    throw invalidResponse(role);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      releaseFailed = true;
    }
  }
  if (releaseFailed || total === 0) {
    throw invalidResponse(role);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function cancelResponseBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    cancellation?.catch(() => undefined);
  } catch {
    // The classified response error is sufficient and upstream details remain redacted.
  }
}

function plainRecord(value: unknown, role: ServiceRole): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidResponse(role);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidResponse(role);
  }
  return value as Record<string, unknown>;
}

function singleCallFelt(value: unknown, providerId: string, allowZero: boolean): string {
  if (!Array.isArray(value) || value.length !== 1 || !Object.hasOwn(value, 0)) {
    throw invalidProviderResponse(providerId);
  }
  return responseFelt(value[0], providerId, allowZero);
}

function singleCallUnsignedInteger(value: unknown, providerId: string): bigint {
  const felt = singleCallFelt(value, providerId, true);
  return BigInt(felt);
}

function safeInteger(value: bigint, providerId: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw invalidProviderResponse(providerId);
  }
  return Number(value);
}

function responseFelt(value: unknown, source: string, allowZero: boolean): string {
  if (
    typeof value !== "string" ||
    value.length > MAXIMUM_FELT_TEXT_LENGTH ||
    !/^0x[0-9a-fA-F]+$/u.test(value)
  ) {
    throw invalidSourceResponse(source);
  }
  const parsed = BigInt(value);
  if ((!allowZero && parsed === 0n) || parsed >= STARKNET_FIELD_PRIME) {
    throw invalidSourceResponse(source);
  }
  return `0x${parsed.toString(16)}`;
}

function responseSafeInteger(value: unknown, role: ServiceRole, positive: boolean): number {
  if (!Number.isSafeInteger(value) || (value as number) < (positive ? 1 : 0)) {
    throw invalidResponse(role);
  }
  return value as number;
}

function configuredTimeout(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAXIMUM_REQUEST_TIMEOUT_MILLISECONDS
  ) {
    throw profileMismatch();
  }
  return value as number;
}

function timestamp(now: () => Date): string {
  let value: unknown;
  try {
    value = now();
  } catch {
    throw profileMismatch();
  }
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw profileMismatch();
  }
  return value.toISOString();
}

function requiredProvider(
  providers: readonly NamedIntegrationSepoliaProvider[],
  index: number,
): NamedIntegrationSepoliaProvider {
  const provider = providers[index];
  if (provider === undefined) {
    throw profileMismatch();
  }
  return provider;
}

function providerFailure(providerId: string): IntegrationSepoliaObserverError {
  return new IntegrationSepoliaObserverError(
    "provider_failure",
    `Integration Sepolia provider ${providerId} could not read the shared settlement profile`,
  );
}

function invalidProviderResponse(providerId: string): IntegrationSepoliaObserverError {
  return new IntegrationSepoliaObserverError(
    "provider_failure",
    `Integration Sepolia provider ${providerId} returned invalid shared settlement state`,
  );
}

function invalidSourceResponse(source: string): IntegrationSepoliaObserverError {
  if (source === "discovery" || source === "prover") {
    return invalidResponse(source);
  }
  return invalidProviderResponse(source);
}

function profileMismatch(): IntegrationSepoliaObserverError {
  return new IntegrationSepoliaObserverError(
    "profile_mismatch",
    "Integration Sepolia state does not match the reviewed shared profile",
  );
}

function unavailable(role: ServiceRole): IntegrationSepoliaObserverError {
  return new IntegrationSepoliaObserverError(
    role === "prover" ? "prover_unavailable" : "discovery_unavailable",
    role === "prover"
      ? "Integration Sepolia prover is unavailable"
      : "Integration Sepolia discovery service is unavailable",
  );
}

function invalidResponse(role: ServiceRole): IntegrationSepoliaObserverError {
  return new IntegrationSepoliaObserverError(
    role === "prover" ? "prover_response_invalid" : "discovery_response_invalid",
    role === "prover"
      ? "Integration Sepolia prover returned an invalid response"
      : "Integration Sepolia discovery service returned an invalid response",
  );
}

function withTimeout<Value>(
  operation: Promise<Value>,
  timeoutMilliseconds: number,
): Promise<Value> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("request timed out")), timeoutMilliseconds);
    timeout.unref?.();
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

type ServiceRole = "discovery" | "prover";

const DEFAULT_REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const MAXIMUM_REQUEST_TIMEOUT_MILLISECONDS = 60_000;
const MAXIMUM_RESPONSE_BYTES = 64 * 1024;
const MAXIMUM_FELT_TEXT_LENGTH = 66;
const STARKNET_FIELD_PRIME = 2n ** 251n + 17n * 2n ** 192n + 1n;
