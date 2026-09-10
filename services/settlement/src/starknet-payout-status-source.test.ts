import { describe, expect, it } from "vitest";

import {
  STARKNET_PAYOUT_STATUS_SOURCE_VERSION,
  StarknetPayoutStatusSource,
} from "./starknet-payout-status-source.js";
import {
  type StarknetPayoutTransactionObservation,
  type StarknetPayoutTransactionObserver,
  StarknetTransactionObserverError,
} from "./starknet-transaction-observer.js";

const TRANSACTION = "0xabc";

describe("Starknet payout status source", () => {
  it.each(["PENDING", "FINAL", "CONFLICTED", "REORGED", "REVERTED"] as const)(
    "maps a canonical %s observation without changing its identity",
    async (status) => {
      const observer = new FakeObserver();
      observer.observations = [observation(status)];
      const source = new StarknetPayoutStatusSource({ observer });

      await expect(source.observePayoutTransaction(input())).resolves.toEqual({
        transactionReference: TRANSACTION,
        status,
        blockHash: "0x123",
        blockNumber: 42n,
      });
      expect(source.statusSourceVersion).toBe(STARKNET_PAYOUT_STATUS_SOURCE_VERSION);
      expect(observer.calls).toEqual([
        {
          network: "SN_SEPOLIA",
          transactionReferences: [TRANSACTION],
          finalityPolicy: "L2_ACCEPTED",
        },
      ]);
    },
  );

  it("classifies a transaction without accepted inclusion as safe for exact rebroadcast", async () => {
    const observer = new FakeObserver();
    observer.error = new StarknetTransactionObserverError(
      "transaction_pending",
      "No accepted receipt",
    );

    await expect(
      new StarknetPayoutStatusSource({ observer }).observePayoutTransaction(input()),
    ).resolves.toEqual({ transactionReference: TRANSACTION, status: "NOT_FOUND" });
  });

  it.each(["provider_failure", "provider_disagreement", "invalid_response"] as const)(
    "does not turn %s into a proven failure",
    async (code) => {
      const observer = new FakeObserver();
      observer.error = new StarknetTransactionObserverError(code, "Observer unavailable");

      await expect(
        new StarknetPayoutStatusSource({ observer }).observePayoutTransaction(input()),
      ).rejects.toMatchObject({ code });
    },
  );

  it("passes a persisted original inclusion to restart-time observation", async () => {
    const observer = new FakeObserver();
    const source = new StarknetPayoutStatusSource({ observer });

    await source.observePayoutTransaction(
      input({ knownInclusion: { blockHash: "0x123", blockNumber: 42n } }),
    );

    expect(observer.calls).toEqual([
      {
        network: "SN_SEPOLIA",
        transactionReferences: [TRANSACTION],
        finalityPolicy: "L2_ACCEPTED",
        knownInclusions: [
          { transactionReference: TRANSACTION, blockHash: "0x123", blockNumber: 42n },
        ],
      },
    ]);
  });

  it("does not classify a missing known inclusion as safe for rebroadcast", async () => {
    const observer = new FakeObserver();
    observer.error = new StarknetTransactionObserverError(
      "transaction_pending",
      "Known receipt disappeared",
    );

    await expect(
      new StarknetPayoutStatusSource({ observer }).observePayoutTransaction(
        input({ knownInclusion: { blockHash: "0x123", blockNumber: 42n } }),
      ),
    ).rejects.toMatchObject({ code: "transaction_pending" });
  });

  it("rejects a mismatched observer response", async () => {
    const observer = new FakeObserver();
    observer.observations = [observation("FINAL", { transactionReference: "0xdef" })];

    await expect(
      new StarknetPayoutStatusSource({ observer }).observePayoutTransaction(input()),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});

class FakeObserver implements StarknetPayoutTransactionObserver {
  observations: readonly StarknetPayoutTransactionObservation[] = [observation("PENDING")];
  error: Error | undefined;
  readonly calls: unknown[] = [];

  async observePayoutTransactions(
    inputValue: Parameters<StarknetPayoutTransactionObserver["observePayoutTransactions"]>[0],
  ): Promise<readonly StarknetPayoutTransactionObservation[]> {
    this.calls.push(structuredClone(inputValue));
    if (this.error !== undefined) {
      throw this.error;
    }
    return structuredClone(this.observations);
  }
}

function input(
  change: Partial<Parameters<StarknetPayoutStatusSource["observePayoutTransaction"]>[0]> = {},
) {
  return {
    network: "SN_SEPOLIA" as const,
    transactionReference: TRANSACTION,
    finalityPolicy: "L2_ACCEPTED",
    ...change,
  };
}

function observation(
  status: StarknetPayoutTransactionObservation["status"],
  change: Partial<StarknetPayoutTransactionObservation> = {},
): StarknetPayoutTransactionObservation {
  return {
    transactionReference: TRANSACTION,
    blockHash: "0x123",
    blockNumber: 42n,
    status,
    ...change,
  };
}
