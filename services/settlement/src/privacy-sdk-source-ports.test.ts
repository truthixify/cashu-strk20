import { describe, expect, it } from "vitest";
import {
  createPrivacySdkSourcePortCompatibilityEvidence,
  PrivacySdkSourcePortCompatibilityError,
  STARKNET_PRIVACY_SDK_SOURCE_PORT_COMPATIBILITY_SCHEMA_VERSION,
} from "./privacy-sdk-source-ports.js";

const VERIFIED_AT = "2026-09-10T00:00:00.000Z";
const PORT_DECLARATION_SHA256 = "a".repeat(64);
const COMPATIBILITY_FIXTURE_SHA256 = "b".repeat(64);

describe("Privacy SDK source-port compatibility evidence", () => {
  it("reconstructs a fixed, conservative compatibility record", () => {
    const evidence = createPrivacySdkSourcePortCompatibilityEvidence({
      verifiedAt: VERIFIED_AT,
      portDeclarationSha256: PORT_DECLARATION_SHA256,
      compatibilityFixtureSha256: COMPATIBILITY_FIXTURE_SHA256,
    });

    expect(evidence.schemaVersion).toBe(
      STARKNET_PRIVACY_SDK_SOURCE_PORT_COMPATIBILITY_SCHEMA_VERSION,
    );
    expect(evidence.sourceCheck.portDeclarationSha256).toBe(PORT_DECLARATION_SHA256);
    expect(evidence.sourceCheck.compatibilityFixtureSha256).toBe(COMPATIBILITY_FIXTURE_SHA256);
    expect(evidence.compatibility).toMatchObject({
      publicDeclarationsBuilt: true,
      channelSnapshotAssignable: true,
      discoveryProviderAssignable: true,
      viewingKeyProviderAssignable: true,
      privateTransfersAssignable: true,
      sdkRuntimeExecuted: false,
      authenticatedPackageDeclarationsVerified: false,
      productionInstallApproved: false,
    });
    expect(evidence.blockers).toEqual([
      "authenticated_package_declarations_unverified",
      "starknet_devnet_production_dependency",
    ]);
  });

  it.each([
    ["non-canonical timestamp", "2026-09-10T00:00:00Z", PORT_DECLARATION_SHA256],
    ["invalid declaration hash", VERIFIED_AT, `0x${PORT_DECLARATION_SHA256}`],
    ["uppercase declaration hash", VERIFIED_AT, PORT_DECLARATION_SHA256.toUpperCase()],
  ])("rejects %s", (_name, verifiedAt, portDeclarationSha256) => {
    expect(() =>
      createPrivacySdkSourcePortCompatibilityEvidence({
        verifiedAt,
        portDeclarationSha256,
        compatibilityFixtureSha256: COMPATIBILITY_FIXTURE_SHA256,
      }),
    ).toThrow(PrivacySdkSourcePortCompatibilityError);
  });

  it("rejects hostile input accessors with a value-free error", () => {
    const input = new Proxy(
      {},
      {
        get() {
          throw new Error("sensitive fixture value");
        },
      },
    );

    expect(() =>
      createPrivacySdkSourcePortCompatibilityEvidence(
        input as Parameters<typeof createPrivacySdkSourcePortCompatibilityEvidence>[0],
      ),
    ).toThrow("Privacy SDK source-port compatibility evidence is invalid");
  });
});
