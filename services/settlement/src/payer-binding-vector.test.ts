import { readFileSync } from "node:fs";

import type { TypedData } from "starknet";
import { typedData } from "starknet";
import { describe, expect, it } from "vitest";

import type { PayerBindingChallengeRecord } from "./payer-binding-records.js";
import { buildPayerBindingTypedData, type PayerBindingTypedData } from "./payer-bindings.js";

const ACCOUNT_ADDRESS = "0xaaa";
const EXPECTED_MESSAGE_HASH = "0x555fc57c20c260d2248f47b917fa335d89f110e52d456116ea80608b01fb16e";
const INPUTS = {
  identity: {
    paymentRequestId: "payer_binding_request_000000000001",
    network: "SN_SEPOLIA",
    poolContract: "0x123",
    recipientAddress: "0x789",
    tokenContract: "0x456",
    expectedNoteReference: "0x111",
    amountBaseUnits: "1000000",
    payerAddress: ACCOUNT_ADDRESS,
    fundingExpiresAt: 2_000_000_300,
    challengeExpiresAt: 2_000_000_120,
  },
  challengeId: "challenge_0000000000000000000000000001",
} as const satisfies Pick<PayerBindingChallengeRecord, "identity" | "challengeId">;

const EXPECTED_PUBLIC_INPUTS = {
  paymentRequestId: INPUTS.identity.paymentRequestId,
  network: INPUTS.identity.network,
  poolContract: INPUTS.identity.poolContract,
  recipientAddress: INPUTS.identity.recipientAddress,
  tokenContract: INPUTS.identity.tokenContract,
  expectedNoteReference: INPUTS.identity.expectedNoteReference,
  amountBaseUnits: INPUTS.identity.amountBaseUnits,
  payerAddress: INPUTS.identity.payerAddress,
  fundingExpiresAt: INPUTS.identity.fundingExpiresAt,
  challengeExpiresAt: INPUTS.identity.challengeExpiresAt,
  challengeId: INPUTS.challengeId,
};

describe("signed-payer SNIP-12 vector", () => {
  it("reconstructs the published candidate vector with starknet@10.5.0", () => {
    const candidate = buildPayerBindingTypedData(INPUTS);
    const published: unknown = JSON.parse(
      readFileSync(
        new URL("../../../docs/specs/vectors/signed-payer-snip12-v2.json", import.meta.url),
        "utf8",
      ),
    );

    expect(published).toEqual({
      name: "cashu-strk20-signed-payer-snip12",
      version: 2,
      status: "candidate",
      hashImplementation: "starknet@10.5.0",
      accountAddress: ACCOUNT_ADDRESS,
      inputs: EXPECTED_PUBLIC_INPUTS,
      typedData: candidate,
      expectedMessageHash: EXPECTED_MESSAGE_HASH,
    });
    expect(messageHash(candidate, ACCOUNT_ADDRESS)).toBe(EXPECTED_MESSAGE_HASH);
  });

  it.each([
    ["Payment Request", "payer_binding_request_000000000002"],
    ["Payer", "0xaab"],
    ["Pool", "0x124"],
    ["Recipient", "0x78a"],
    ["Token", "0x457"],
    ["Expected Note", "0x222"],
    ["Amount", "2000000"],
    ["Funding Expires At", "2000000301"],
    ["Challenge Expires At", "2000000121"],
    ["Challenge", "challenge_0000000000000000000000000002"],
  ] as const)("changes the hash when %s changes", (field, value) => {
    const candidate = buildPayerBindingTypedData(INPUTS);
    const mutated = withMessageField(candidate, field, value);

    expect(messageHash(mutated, ACCOUNT_ADDRESS)).not.toBe(EXPECTED_MESSAGE_HASH);
  });

  it("binds the outer Starknet account address independently of the message", () => {
    const candidate = buildPayerBindingTypedData(INPUTS);

    expect(messageHash(candidate, "0xaab")).not.toBe(EXPECTED_MESSAGE_HASH);
  });

  it.each([
    ["name", "CairoCash Funding 2"],
    ["version", "3"],
    ["chainId", "SN_MAIN"],
  ] as const)("changes the hash when domain %s changes", (field, value) => {
    const candidate = toStarknetTypedData(buildPayerBindingTypedData(INPUTS));
    const mutated: TypedData = {
      ...candidate,
      domain: {
        ...candidate.domain,
        [field]: value,
      },
    };

    expect(typedData.getMessageHash(mutated, ACCOUNT_ADDRESS)).not.toBe(EXPECTED_MESSAGE_HASH);
  });

  it("rejects a changed SNIP-12 revision under the revision 1 schema", () => {
    const candidate = toStarknetTypedData(buildPayerBindingTypedData(INPUTS));
    const mutated: TypedData = {
      ...candidate,
      domain: {
        ...candidate.domain,
        revision: 0,
      },
    };

    expect(() => typedData.getMessageHash(mutated, ACCOUNT_ADDRESS)).toThrow();
  });
});

function withMessageField<K extends keyof PayerBindingTypedData["message"]>(
  typedValue: PayerBindingTypedData,
  field: K,
  value: PayerBindingTypedData["message"][K],
): PayerBindingTypedData {
  return {
    ...typedValue,
    message: {
      ...typedValue.message,
      [field]: value,
    },
  };
}

function messageHash(value: PayerBindingTypedData, accountAddress: string): string {
  return typedData.getMessageHash(toStarknetTypedData(value), accountAddress);
}

function toStarknetTypedData(value: PayerBindingTypedData): TypedData {
  return {
    types: Object.fromEntries(
      Object.entries(value.types).map(([name, fields]) => [
        name,
        fields.map((field) => ({ name: field.name, type: field.type })),
      ]),
    ),
    primaryType: value.primaryType,
    domain: { ...value.domain },
    message: { ...value.message },
  };
}
