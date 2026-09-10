import type {
  StarknetPreparedPayoutChainStatus,
  StarknetPreparedPayoutStatusSource,
} from "./starknet-privacy-sdk-payout.js";
import {
  type StarknetPayoutTransactionObserver,
  StarknetTransactionObserverError,
} from "./starknet-transaction-observer.js";

export const STARKNET_PAYOUT_STATUS_SOURCE_VERSION =
  "starknet@10.5.0:canonical-transaction-status-reversion-v3";

export interface StarknetPayoutStatusSourceConfig {
  readonly observer: StarknetPayoutTransactionObserver;
}

export class StarknetPayoutStatusSourceConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StarknetPayoutStatusSourceConfigurationError";
  }
}

/** Maps the shared multi-provider transaction observer into the prepared-payout status contract. */
export class StarknetPayoutStatusSource implements StarknetPreparedPayoutStatusSource {
  readonly #observer: StarknetPayoutTransactionObserver;

  readonly statusSourceVersion = STARKNET_PAYOUT_STATUS_SOURCE_VERSION;

  constructor(config: StarknetPayoutStatusSourceConfig) {
    if (
      typeof config !== "object" ||
      config === null ||
      typeof config.observer !== "object" ||
      config.observer === null ||
      typeof config.observer.observePayoutTransactions !== "function"
    ) {
      throw new StarknetPayoutStatusSourceConfigurationError(
        "Configured Starknet transaction observer is invalid",
      );
    }
    this.#observer = config.observer;
  }

  async observePayoutTransaction(
    input: Parameters<StarknetPreparedPayoutStatusSource["observePayoutTransaction"]>[0],
  ): Promise<{
    readonly transactionReference: string;
    readonly status: StarknetPreparedPayoutChainStatus;
    readonly blockHash?: string;
    readonly blockNumber?: bigint;
  }> {
    let observations: Awaited<
      ReturnType<StarknetPayoutTransactionObserver["observePayoutTransactions"]>
    >;
    try {
      observations = await this.#observer.observePayoutTransactions({
        network: input.network,
        transactionReferences: [input.transactionReference],
        finalityPolicy: input.finalityPolicy,
        ...(input.knownInclusion === undefined
          ? {}
          : {
              knownInclusions: [
                {
                  transactionReference: input.transactionReference,
                  ...input.knownInclusion,
                },
              ],
            }),
      });
    } catch (error) {
      if (
        input.knownInclusion === undefined &&
        error instanceof StarknetTransactionObserverError &&
        error.code === "transaction_pending"
      ) {
        return { transactionReference: input.transactionReference, status: "NOT_FOUND" };
      }
      throw error;
    }
    const observation = observations[0];
    if (
      observations.length !== 1 ||
      observation === undefined ||
      observation.transactionReference !== input.transactionReference
    ) {
      throw new StarknetTransactionObserverError(
        "invalid_response",
        "Payout transaction observer returned a mismatched observation",
      );
    }
    return {
      transactionReference: observation.transactionReference,
      status: observation.status,
      blockHash: observation.blockHash,
      blockNumber: observation.blockNumber,
    };
  }
}
