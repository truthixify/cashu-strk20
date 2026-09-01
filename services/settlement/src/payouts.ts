import { randomUUID } from "node:crypto";

import {
  assertCashuAmount,
  cashuUsdcToBaseUnits,
  type MeltPaymentEnvelope,
  type StarknetNetwork,
} from "@cashu-strk20/strk20-method";

import type {
  PayoutAttempt,
  PayoutAttemptStatus,
  PayoutPreparationInput,
  PrivateSettlementGateway,
} from "./gateway.js";
import {
  assertSameIntent,
  intentIdentity,
  type SettlementIntentRecord,
  type SettlementIntentStore,
} from "./intents.js";

export type PayoutValidationErrorCode =
  | "invalid_quote_id"
  | "invalid_payment_request"
  | "unsupported_network"
  | "unsupported_token"
  | "amount_out_of_range"
  | "quote_expired";

export class PayoutValidationError extends Error {
  readonly code: PayoutValidationErrorCode;

  constructor(code: PayoutValidationErrorCode, message: string) {
    super(message);
    this.name = "PayoutValidationError";
    this.code = code;
  }
}

export class GatewayProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayProtocolError";
  }
}

export class PayoutConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayoutConfigurationError";
  }
}

export interface PayoutIntentInput {
  readonly quoteId: string;
  readonly request: MeltPaymentEnvelope;
}

export interface PayoutProgress {
  readonly intentId: string;
  readonly state: SettlementIntentRecord["state"];
  readonly transactionReferences: readonly string[];
}

export interface PayoutCoordinatorConfig {
  readonly network: StarknetNetwork;
  readonly tokenContract: string;
  readonly minimumAmount: bigint;
  readonly maximumAmount: bigint;
  readonly now?: () => Date;
  readonly createIntentId?: () => string;
}

export class PayoutCoordinator {
  readonly #network: StarknetNetwork;
  readonly #tokenContract: string;
  readonly #minimumAmount: bigint;
  readonly #maximumAmount: bigint;
  readonly #now: () => Date;
  readonly #createIntentId: () => string;

  constructor(
    readonly store: SettlementIntentStore,
    readonly gateway: PrivateSettlementGateway,
    config: PayoutCoordinatorConfig,
  ) {
    if (config.network !== "SN_SEPOLIA") {
      throw new PayoutConfigurationError("Only Starknet Sepolia is enabled for settlement");
    }
    try {
      assertCashuAmount(config.minimumAmount);
      assertCashuAmount(config.maximumAmount);
    } catch {
      throw new PayoutConfigurationError("Payout amount policy is outside the Cashu u64 range");
    }
    if (config.minimumAmount > config.maximumAmount) {
      throw new PayoutConfigurationError("Minimum payout amount exceeds the maximum");
    }
    this.#network = config.network;
    this.#tokenContract = normalizeHexAddress(config.tokenContract, "Configured token contract");
    this.#minimumAmount = config.minimumAmount;
    this.#maximumAmount = config.maximumAmount;
    this.#now = config.now ?? (() => new Date());
    this.#createIntentId = config.createIntentId ?? randomUUID;
  }

  async ensurePayout(input: PayoutIntentInput): Promise<PayoutProgress> {
    this.#validate(input);

    const identity = intentIdentity(input.quoteId, input.request);
    let intent = await this.store.getByQuoteId(input.quoteId);
    if (intent === null) {
      this.#assertUnexpired(input.request);
      const intentId = this.#createIntentId();
      assertOpaqueIdentifier(intentId, "Generated intent ID");
      if (intentId === input.quoteId) {
        throw new GatewayProtocolError("Intent IDs must be independent from Cashu quote IDs");
      }
      intent = await this.store.createOrGet({ intentId, identity });
    } else {
      assertSameIntent(intent.identity, identity);
    }

    if (isTerminal(intent.state) || intent.state === "OPERATOR_REQUIRED") {
      return progress(intent);
    }

    if (intent.submissionId === undefined) {
      const prepared = await this.#prepare(intent, input.request);
      if (prepared === null) {
        return progress(intent);
      }

      const attached = await this.store.attachSubmission(intent.intentId, prepared.submissionId);
      if (attached.submissionId === prepared.submissionId) {
        intent = await this.#acceptAttempt(attached, prepared);
      } else {
        intent = attached;
      }
    }

    if (isTerminal(intent.state) || intent.state === "OPERATOR_REQUIRED") {
      return progress(intent);
    }

    const submissionId = requiredSubmissionId(intent);
    let observed: PayoutAttempt;
    try {
      observed = await this.gateway.getPayoutStatus(submissionId);
      this.#assertAttempt(observed, intent.intentId, submissionId);
    } catch (error) {
      if (error instanceof GatewayProtocolError) {
        throw error;
      }
      intent = await this.#recordUnknown(intent);
      return progress(intent);
    }

    if (observed.status !== "PREPARED") {
      intent = await this.#acceptAttempt(intent, observed);
      return progress(intent);
    }

    try {
      const submitted = await this.gateway.submitPayout(submissionId);
      this.#assertAttempt(submitted, intent.intentId, submissionId);
      intent = await this.#acceptAttempt(intent, submitted);
    } catch (error) {
      if (error instanceof GatewayProtocolError) {
        throw error;
      }
      intent = await this.#recordUnknown(intent);
    }

    return progress(intent);
  }

  async #prepare(
    intent: SettlementIntentRecord,
    request: MeltPaymentEnvelope,
  ): Promise<PayoutAttempt | null> {
    const input: PayoutPreparationInput = { intentId: intent.intentId, request };
    try {
      const prepared = await this.gateway.preparePayout(input);
      this.#assertAttempt(prepared, intent.intentId);
      if (prepared.status !== "PREPARED" && prepared.status !== "FAILED") {
        throw new GatewayProtocolError("Payout preparation returned an invalid status");
      }
      return prepared;
    } catch (error) {
      if (error instanceof GatewayProtocolError) {
        throw error;
      }
      return null;
    }
  }

  async #acceptAttempt(
    intent: SettlementIntentRecord,
    attempt: PayoutAttempt,
  ): Promise<SettlementIntentRecord> {
    if (attempt.status === "PAID" && intent.state === "INTENT_RECORDED") {
      intent = await this.store.recordAttempt({ ...attempt, status: "PENDING" });
    }
    return this.store.recordAttempt(attempt);
  }

  async #recordUnknown(intent: SettlementIntentRecord): Promise<SettlementIntentRecord> {
    const submissionId = requiredSubmissionId(intent);
    if (intent.state === "UNKNOWN") {
      return intent;
    }
    return this.store.recordAttempt({
      intentId: intent.intentId,
      submissionId,
      status: "UNKNOWN",
    });
  }

  #assertAttempt(
    attempt: unknown,
    intentId: string,
    submissionId?: string,
  ): asserts attempt is PayoutAttempt {
    if (typeof attempt !== "object" || attempt === null) {
      throw new GatewayProtocolError("Gateway returned a malformed payout attempt");
    }
    const candidate = attempt as Partial<PayoutAttempt>;
    assertOpaqueIdentifier(candidate.intentId, "Gateway intent ID");
    assertOpaqueIdentifier(candidate.submissionId, "Gateway submission ID");
    if (candidate.intentId !== intentId) {
      throw new GatewayProtocolError("Gateway returned an attempt for a different payout");
    }
    if (submissionId !== undefined && candidate.submissionId !== submissionId) {
      throw new GatewayProtocolError("Gateway returned an attempt for a different payout");
    }
    if (!PAYOUT_ATTEMPT_STATUSES.has(candidate.status as PayoutAttemptStatus)) {
      throw new GatewayProtocolError("Gateway returned an unknown payout status");
    }
    if (
      candidate.transactionReference !== undefined &&
      (typeof candidate.transactionReference !== "string" ||
        candidate.transactionReference.trim().length === 0 ||
        candidate.transactionReference.length > MAX_OPAQUE_IDENTIFIER_LENGTH)
    ) {
      throw new GatewayProtocolError("Gateway returned an invalid transaction reference");
    }
  }

  #validate(input: PayoutIntentInput): void {
    if (
      typeof input.quoteId !== "string" ||
      input.quoteId.trim().length === 0 ||
      input.quoteId.length > MAX_OPAQUE_IDENTIFIER_LENGTH
    ) {
      throw new PayoutValidationError("invalid_quote_id", "Cashu quote ID is invalid");
    }

    const request = input.request as MeltPaymentEnvelope & { version?: unknown; kind?: unknown };
    if (request.version !== 1 || request.kind !== "melt") {
      throw new PayoutValidationError(
        "invalid_payment_request",
        "Payout request version or kind is invalid",
      );
    }
    if (request.network !== this.#network) {
      throw new PayoutValidationError("unsupported_network", "Payout network is not enabled");
    }

    const tokenContract = normalizeHexAddress(request.token_contract, "Payout token contract");
    if (tokenContract !== this.#tokenContract) {
      throw new PayoutValidationError("unsupported_token", "Payout token is not enabled");
    }

    if (!Number.isSafeInteger(request.amount) || request.amount <= 0) {
      throw new PayoutValidationError(
        "amount_out_of_range",
        "Payout amount must be a positive safe integer",
      );
    }
    if (
      typeof request.amount_base_units !== "string" ||
      request.amount_base_units.length > MAX_DECIMAL_AMOUNT_LENGTH ||
      !/^[1-9][0-9]*$/.test(request.amount_base_units)
    ) {
      throw new PayoutValidationError(
        "amount_out_of_range",
        "Payout base-unit amount must be a positive decimal integer",
      );
    }

    const cashuAmount = BigInt(request.amount);
    if (cashuAmount < this.#minimumAmount || cashuAmount > this.#maximumAmount) {
      throw new PayoutValidationError(
        "amount_out_of_range",
        "Payout amount is outside the configured policy",
      );
    }

    const expectedBaseUnits = cashuUsdcToBaseUnits(cashuAmount);
    if (BigInt(request.amount_base_units) !== expectedBaseUnits) {
      throw new PayoutValidationError(
        "amount_out_of_range",
        "Payout amount does not match its exact USDC base-unit value",
      );
    }

    if (!Number.isSafeInteger(request.expires_at) || request.expires_at <= 0) {
      throw new PayoutValidationError(
        "invalid_payment_request",
        "Payout expiry must be a positive integer timestamp",
      );
    }

    if (
      typeof request.destination !== "object" ||
      request.destination === null ||
      Array.isArray(request.destination) ||
      Object.keys(request.destination).length === 0
    ) {
      throw new PayoutValidationError("invalid_payment_request", "Payout destination is invalid");
    }
  }

  #assertUnexpired(request: MeltPaymentEnvelope): void {
    const nowMilliseconds = this.#now().getTime();
    if (!Number.isFinite(nowMilliseconds)) {
      throw new GatewayProtocolError("Settlement clock returned an invalid time");
    }
    if (request.expires_at <= Math.floor(nowMilliseconds / 1_000)) {
      throw new PayoutValidationError("quote_expired", "Payout request has expired");
    }
  }
}

const PAYOUT_ATTEMPT_STATUSES: ReadonlySet<PayoutAttemptStatus> = new Set([
  "PREPARED",
  "PENDING",
  "UNKNOWN",
  "PAID",
  "FAILED",
]);

function normalizeHexAddress(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_STARKNET_ADDRESS_LENGTH ||
    !/^0x[0-9a-fA-F]+$/.test(value)
  ) {
    throw new PayoutValidationError("invalid_payment_request", `${label} is invalid`);
  }
  const address = BigInt(value);
  if (address === 0n || address >= STARKNET_ADDRESS_BOUND) {
    throw new PayoutValidationError("invalid_payment_request", `${label} is out of range`);
  }
  return `0x${address.toString(16)}`;
}

function assertOpaqueIdentifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_OPAQUE_IDENTIFIER_LENGTH
  ) {
    throw new GatewayProtocolError(`${label} is invalid`);
  }
}

function requiredSubmissionId(intent: SettlementIntentRecord): string {
  if (intent.submissionId === undefined) {
    throw new GatewayProtocolError("Settlement intent has no prepared submission");
  }
  return intent.submissionId;
}

function isTerminal(state: SettlementIntentRecord["state"]): boolean {
  return state === "PAID" || state === "FAILED";
}

function progress(intent: SettlementIntentRecord): PayoutProgress {
  return {
    intentId: intent.intentId,
    state: intent.state,
    transactionReferences: [...intent.transactionReferences],
  };
}

const STARKNET_ADDRESS_BOUND = (1n << 251n) - 256n;
const MAX_STARKNET_ADDRESS_LENGTH = 66;
const MAX_DECIMAL_AMOUNT_LENGTH = 32;
const MAX_OPAQUE_IDENTIFIER_LENGTH = 512;
