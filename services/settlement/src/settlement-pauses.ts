import { STARKNET_NETWORKS, type StarknetNetwork } from "@cashu-strk20/strk20-method";

import type { PreparedPayoutInclusion } from "./prepared-payouts.js";

export const SETTLEMENT_METHOD = "strk20" as const;

export type SettlementPauseReason = "PAYOUT_FINALITY_CONFLICTED" | "PAYOUT_FINALITY_REORGED";

export interface SettlementProfile {
  readonly method: typeof SETTLEMENT_METHOD;
  readonly network: StarknetNetwork;
  readonly tokenContract: string;
}

export interface SettlementPayoutReference {
  readonly intentId: string;
  readonly submissionId: string;
  readonly transactionReference: string;
  readonly originalInclusion: PreparedPayoutInclusion;
}

export interface SettlementPauseRecord extends SettlementPayoutReference {
  readonly profile: SettlementProfile;
  readonly reason: SettlementPauseReason;
  readonly detectedAt: string;
  readonly observerVersion: string;
}

export type SettlementPauseCandidate = SettlementPauseRecord;

export interface SettlementPauseStore {
  getPause(profile: SettlementProfile): Promise<SettlementPauseRecord | null>;
  /** Atomically retain the first pause for one method, network, and token profile. */
  pause(candidate: SettlementPauseCandidate): Promise<SettlementPauseRecord>;
}

export class SettlementPauseIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementPauseIntegrityError";
  }
}

export class InMemorySettlementPauseStore implements SettlementPauseStore {
  readonly #byProfile = new Map<string, SettlementPauseRecord>();

  async getPause(profile: SettlementProfile): Promise<SettlementPauseRecord | null> {
    const ownedProfile = cloneSettlementProfile(profile);
    const existing = this.#byProfile.get(profileKey(ownedProfile));
    return existing === undefined ? null : cloneSettlementPauseRecord(existing);
  }

  async pause(candidate: SettlementPauseCandidate): Promise<SettlementPauseRecord> {
    const record = cloneSettlementPauseRecord(candidate);
    const key = profileKey(record.profile);
    const existing = this.#byProfile.get(key);
    if (existing !== undefined) {
      return cloneSettlementPauseRecord(existing);
    }
    this.#byProfile.set(key, record);
    return cloneSettlementPauseRecord(record);
  }
}

export function assertSettlementProfile(value: unknown): asserts value is SettlementProfile {
  if (typeof value !== "object" || value === null) {
    throw new SettlementPauseIntegrityError("Settlement profile is invalid");
  }
  let method: unknown;
  let network: unknown;
  let tokenContract: unknown;
  try {
    method = (value as { readonly method?: unknown }).method;
    network = (value as { readonly network?: unknown }).network;
    tokenContract = (value as { readonly tokenContract?: unknown }).tokenContract;
  } catch {
    throw new SettlementPauseIntegrityError("Settlement profile is invalid");
  }
  if (method !== SETTLEMENT_METHOD || !STARKNET_NETWORKS.includes(network as StarknetNetwork)) {
    throw new SettlementPauseIntegrityError("Settlement profile is invalid");
  }
  assertCanonicalAddress(tokenContract, "Settlement token contract");
}

export function assertSettlementPauseRecord(
  value: unknown,
): asserts value is SettlementPauseRecord {
  if (typeof value !== "object" || value === null) {
    throw new SettlementPauseIntegrityError("Settlement pause record is invalid");
  }
  let profile: unknown;
  let reason: unknown;
  let intentId: unknown;
  let submissionId: unknown;
  let transactionReference: unknown;
  let originalInclusion: unknown;
  let detectedAt: unknown;
  let observerVersion: unknown;
  try {
    const record = value as Partial<SettlementPauseRecord>;
    profile = record.profile;
    reason = record.reason;
    intentId = record.intentId;
    submissionId = record.submissionId;
    transactionReference = record.transactionReference;
    originalInclusion = record.originalInclusion;
    detectedAt = record.detectedAt;
    observerVersion = record.observerVersion;
  } catch {
    throw new SettlementPauseIntegrityError("Settlement pause record is invalid");
  }
  assertSettlementProfile(profile);
  if (!SETTLEMENT_PAUSE_REASONS.has(reason as SettlementPauseReason)) {
    throw new SettlementPauseIntegrityError("Settlement pause reason is invalid");
  }
  assertSettlementPayoutReference({
    intentId,
    submissionId,
    transactionReference,
    originalInclusion,
  });
  if (!isCanonicalTimestamp(detectedAt)) {
    throw new SettlementPauseIntegrityError("Settlement pause detection time is invalid");
  }
  assertOpaqueIdentifier(
    observerVersion,
    "Settlement pause observer version",
    MAXIMUM_OBSERVER_VERSION_LENGTH,
  );
}

export function assertSettlementPayoutReference(
  value: unknown,
): asserts value is SettlementPayoutReference {
  if (typeof value !== "object" || value === null) {
    throw new SettlementPauseIntegrityError("Settlement payout reference is invalid");
  }
  let intentId: unknown;
  let submissionId: unknown;
  let transactionReference: unknown;
  let originalInclusion: unknown;
  try {
    const reference = value as Partial<SettlementPayoutReference>;
    intentId = reference.intentId;
    submissionId = reference.submissionId;
    transactionReference = reference.transactionReference;
    originalInclusion = reference.originalInclusion;
  } catch {
    throw new SettlementPauseIntegrityError("Settlement payout reference is invalid");
  }
  assertOpaqueIdentifier(intentId, "Settlement pause intent ID", MAXIMUM_IDENTIFIER_LENGTH);
  assertOpaqueIdentifier(submissionId, "Settlement pause submission ID", MAXIMUM_IDENTIFIER_LENGTH);
  assertCanonicalFelt(transactionReference, "Settlement pause transaction reference");
  assertInclusion(originalInclusion);
}

export function cloneSettlementPauseRecord(record: SettlementPauseRecord): SettlementPauseRecord {
  assertSettlementPauseRecord(record);
  let clone: SettlementPauseRecord;
  try {
    clone = {
      profile: cloneSettlementProfile(record.profile),
      reason: record.reason,
      intentId: record.intentId,
      submissionId: record.submissionId,
      transactionReference: record.transactionReference,
      originalInclusion: {
        blockHash: record.originalInclusion.blockHash,
        blockNumber: record.originalInclusion.blockNumber,
      },
      detectedAt: record.detectedAt,
      observerVersion: record.observerVersion,
    };
  } catch (error) {
    if (error instanceof SettlementPauseIntegrityError) {
      throw error;
    }
    throw new SettlementPauseIntegrityError("Settlement pause record is invalid");
  }
  assertSettlementPauseRecord(clone);
  return clone;
}

export function cloneSettlementProfile(profile: SettlementProfile): SettlementProfile {
  assertSettlementProfile(profile);
  let clone: SettlementProfile;
  try {
    clone = {
      method: profile.method,
      network: profile.network,
      tokenContract: profile.tokenContract,
    };
  } catch {
    throw new SettlementPauseIntegrityError("Settlement profile is invalid");
  }
  assertSettlementProfile(clone);
  return clone;
}

function assertInclusion(value: unknown): asserts value is PreparedPayoutInclusion {
  if (typeof value !== "object" || value === null) {
    throw new SettlementPauseIntegrityError("Settlement pause inclusion is invalid");
  }
  let blockHash: unknown;
  let blockNumber: unknown;
  try {
    blockHash = (value as { readonly blockHash?: unknown }).blockHash;
    blockNumber = (value as { readonly blockNumber?: unknown }).blockNumber;
  } catch {
    throw new SettlementPauseIntegrityError("Settlement pause inclusion is invalid");
  }
  assertCanonicalFelt(blockHash, "Settlement pause block hash");
  if (typeof blockNumber !== "bigint" || blockNumber < 0n || blockNumber > MAXIMUM_BLOCK_NUMBER) {
    throw new SettlementPauseIntegrityError("Settlement pause block number is invalid");
  }
}

function assertCanonicalAddress(value: unknown, label: string): asserts value is string {
  const parsed = canonicalHex(value, label);
  if (parsed === 0n || parsed >= STARKNET_ADDRESS_BOUND) {
    throw new SettlementPauseIntegrityError(`${label} is invalid`);
  }
}

function assertCanonicalFelt(value: unknown, label: string): asserts value is string {
  const parsed = canonicalHex(value, label);
  if (parsed === 0n || parsed >= STARK_FIELD_PRIME) {
    throw new SettlementPauseIntegrityError(`${label} is invalid`);
  }
}

function canonicalHex(value: unknown, label: string): bigint {
  if (
    typeof value !== "string" ||
    value.length > MAXIMUM_STARKNET_HEX_LENGTH ||
    !/^0x[0-9a-f]+$/.test(value)
  ) {
    throw new SettlementPauseIntegrityError(`${label} is invalid`);
  }
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new SettlementPauseIntegrityError(`${label} is invalid`);
  }
  if (value !== `0x${parsed.toString(16)}`) {
    throw new SettlementPauseIntegrityError(`${label} is invalid`);
  }
  return parsed;
}

function assertOpaqueIdentifier(value: unknown, label: string, maximum: number): void {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    value.trim().length === 0 ||
    containsControlCharacter(value)
  ) {
    throw new SettlementPauseIntegrityError(`${label} is invalid`);
  }
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== CANONICAL_TIMESTAMP_LENGTH) {
    return false;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

function profileKey(profile: SettlementProfile): string {
  return JSON.stringify([profile.method, profile.network, profile.tokenContract]);
}

const SETTLEMENT_PAUSE_REASONS: ReadonlySet<SettlementPauseReason> = new Set([
  "PAYOUT_FINALITY_CONFLICTED",
  "PAYOUT_FINALITY_REORGED",
]);
const STARKNET_ADDRESS_BOUND = (1n << 251n) - 256n;
const STARK_FIELD_PRIME = (1n << 251n) + (17n << 192n) + 1n;
const MAXIMUM_BLOCK_NUMBER = (1n << 64n) - 1n;
const MAXIMUM_IDENTIFIER_LENGTH = 512;
const MAXIMUM_OBSERVER_VERSION_LENGTH = 256;
const MAXIMUM_STARKNET_HEX_LENGTH = 66;
const CANONICAL_TIMESTAMP_LENGTH = 24;
