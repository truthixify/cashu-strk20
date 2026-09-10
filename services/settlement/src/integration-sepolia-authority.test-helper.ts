import type { Call } from "starknet";

import { STARKWARE_INTEGRATION_SEPOLIA_PROFILE } from "./integration-sepolia-observer.js";
import {
  STARKNET_COMMON_ROLES,
  STARKNET_ROLE_ADMIN_CHANGED_SELECTOR,
  STARKNET_ROLE_GRANTED_SELECTOR,
  type StarknetCommonRoleName,
} from "./starknet-common-roles-authority-verifier.js";
import { STARKNET_UDC_ADDRESS } from "./starknet-deployment-origin-verifier.js";

export interface IntegrationSepoliaAuthorityInventoryEvent {
  readonly block_hash: string;
  readonly block_number: number;
  readonly transaction_hash: string;
  readonly from_address: string;
  readonly keys: readonly string[];
  readonly data: readonly string[];
}

export function integrationSepoliaAuthorityInventory(): IntegrationSepoliaAuthorityInventoryEvent[] {
  const profile = STARKWARE_INTEGRATION_SEPOLIA_PROFILE;
  const deployment = profile.pool.deployment.deployment;
  const deployer = deployment.deployer;
  const operationsAccount = "0x3e6c6f41d833ec5e7d38e6007df5b0ab6b48bc4c2d3dbeac1ed665456ae4766";
  const events = [
    authorityEvent(
      STARKNET_ROLE_GRANTED_SELECTOR,
      [roleId("GOVERNANCE_ADMIN"), deployer, STARKNET_UDC_ADDRESS],
      Number(deployment.acceptedBlockNumber),
      deployment.acceptedBlockHash,
      deployment.transactionReference,
    ),
    authorityEvent(
      STARKNET_ROLE_GRANTED_SELECTOR,
      [roleId("SECURITY_ADMIN"), deployer, STARKNET_UDC_ADDRESS],
      Number(deployment.acceptedBlockNumber),
      deployment.acceptedBlockHash,
      deployment.transactionReference,
    ),
  ];
  for (const [role, administrator] of ROLE_ADMINISTRATORS) {
    events.push(
      authorityEvent(
        STARKNET_ROLE_ADMIN_CHANGED_SELECTOR,
        [roleId(role), "0x0", roleId(administrator)],
        Number(deployment.acceptedBlockNumber),
        deployment.acceptedBlockHash,
        deployment.transactionReference,
      ),
    );
  }
  events.push(
    authorityEvent(
      STARKNET_ROLE_GRANTED_SELECTOR,
      [roleId("UPGRADE_GOVERNOR"), deployer, deployer],
      10_829_796,
      "0x2acb0f8d774d77199a1e4bc56e74d5f93f8e25a44a6c6dc0b3890a69a661111",
      "0x7a6888819871c31d00948be3ef14f68c3f8d8b8bb59826fc3a2887ea8c99264",
    ),
    authorityEvent(
      STARKNET_ROLE_GRANTED_SELECTOR,
      [roleId("UPGRADE_GOVERNOR"), operationsAccount, deployer],
      10_829_801,
      "0x1e301434bbbb59b32bb6e2aa9909a97bd382c0744752f6a03b8e9dab10a28c2",
      "0x124af12dc0e49bc290785bee85905953065eff830ed6612901de1bdf7b6e7e3",
    ),
    authorityEvent(
      STARKNET_ROLE_GRANTED_SELECTOR,
      [roleId("GOVERNANCE_ADMIN"), operationsAccount, deployer],
      11_111_909,
      "0x6f5857f72591e088e5fa29e7f625ecdd3106c206f2711108f75ceeaeebe9809",
      "0x60ce211968504cf4b6e495bef15ec1d5e1ebb9d7b2523e344a91a9ab90be322",
    ),
    authorityEvent(
      STARKNET_ROLE_GRANTED_SELECTOR,
      [roleId("APP_ROLE_ADMIN"), operationsAccount, operationsAccount],
      11_111_925,
      "0x3c25886efc503202a0e5b27c718c0c52e77cb95cdce740e20745cb04c0c4031",
      "0x12b6e62d8ae519b5a1630de97f5c9fbd3f6ed3df09a89d067bb084e38b15995",
    ),
    authorityEvent(
      STARKNET_ROLE_GRANTED_SELECTOR,
      [roleId("APP_GOVERNOR"), operationsAccount, operationsAccount],
      11_111_930,
      "0x5ae869844b59abaeec3df8f490c35fb9b0e043faf146ee8fc9a4fb8071c0fd1",
      "0x3b89d3920b94c4c53bb6c76619b2ffba55b06141a9aa4dd2cd8398c7fcd3944",
    ),
    authorityEvent(
      STARKNET_ROLE_GRANTED_SELECTOR,
      [roleId("SECURITY_ADMIN"), operationsAccount, deployer],
      11_112_095,
      "0x176554a3d2b6bad8b1c35cbc64c7b98ea5768b2c53a8bc2a2388d38654d137f",
      "0x67f35f5f04a4e6c2c2267e971d7233fb5229f68edfe5273ac46dd164803a3d7",
    ),
    authorityEvent(
      STARKNET_ROLE_GRANTED_SELECTOR,
      [roleId("SECURITY_GOVERNOR"), operationsAccount, operationsAccount],
      11_112_122,
      "0x1ec8fc5a9f273e83a694d3baa07d2fbdf8b83a84c29e87d3e1216811803964a",
      "0x6b78380db5ec1cf7b44daa8a369f225d5ca4e60b722f62079d8b2fc56103c5b",
    ),
    authorityEvent(
      STARKNET_ROLE_GRANTED_SELECTOR,
      [roleId("APP_ROLE_ADMIN"), deployer, deployer],
      12_875_093,
      "0x3e638aebdc776a0a654d4043d7e44943e8f54fd77e4c281aea05243dc6606e8",
      "0x3ad69797c78347314f51b8c84a6b7b4a703b9d233fec001f8e84330baa02129",
    ),
    authorityEvent(
      STARKNET_ROLE_GRANTED_SELECTOR,
      [roleId("APP_GOVERNOR"), deployer, deployer],
      12_875_102,
      "0x5631fd9ae4fa4de69f6a70b649f63313a43b63d1cd8f92fc26ec01e88b2dd80",
      "0x3bfee06d4c5a3d7b037ec0fdc706fd87c0b94e0c2ca1619b81f79d7b0abecc4",
    ),
  );
  return events;
}

export function integrationSepoliaRoleMembership(call: Call): string[] | undefined {
  if (call.entrypoint !== "has_role") return undefined;
  if (!Array.isArray(call.calldata) || call.calldata.length !== 2) {
    throw new Error("invalid authority fixture call");
  }
  const role = roleName(String(call.calldata[0]));
  const account = String(call.calldata[1]);
  const active = STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.authority.expectedAssignments.some(
    (assignment) => assignment.role === role && assignment.account === account,
  );
  return [active ? "0x1" : "0x0"];
}

const ROLE_ADMINISTRATORS = Object.freeze([
  ["APP_GOVERNOR", "APP_ROLE_ADMIN"],
  ["APP_ROLE_ADMIN", "GOVERNANCE_ADMIN"],
  ["GOVERNANCE_ADMIN", "GOVERNANCE_ADMIN"],
  ["OPERATOR", "APP_ROLE_ADMIN"],
  ["TOKEN_ADMIN", "APP_ROLE_ADMIN"],
  ["UPGRADE_AGENT", "APP_ROLE_ADMIN"],
  ["UPGRADE_GOVERNOR", "GOVERNANCE_ADMIN"],
  ["SECURITY_ADMIN", "SECURITY_ADMIN"],
  ["SECURITY_AGENT", "SECURITY_ADMIN"],
  ["SECURITY_GOVERNOR", "SECURITY_ADMIN"],
] as const satisfies readonly (readonly [StarknetCommonRoleName, StarknetCommonRoleName])[]);

function authorityEvent(
  selector: string,
  data: readonly string[],
  blockNumber: number,
  blockHash: string,
  transactionHash: string,
): IntegrationSepoliaAuthorityInventoryEvent {
  return {
    block_hash: blockHash,
    block_number: blockNumber,
    transaction_hash: transactionHash,
    from_address: STARKWARE_INTEGRATION_SEPOLIA_PROFILE.pool.address,
    keys: [selector],
    data,
  };
}

function roleId(roleName: StarknetCommonRoleName): string {
  const role = STARKNET_COMMON_ROLES.find(({ name }) => name === roleName);
  if (role === undefined) throw new Error("unknown authority fixture role");
  return role.id;
}

function roleName(roleIdValue: string): StarknetCommonRoleName {
  const role = STARKNET_COMMON_ROLES.find(({ id }) => id === roleIdValue);
  if (role === undefined) throw new Error("unknown authority fixture role");
  return role.name;
}
