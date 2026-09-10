import { createHash } from "node:crypto";

import {
  PAYMENT_OBSERVATION_STATUSES,
  type PaymentObservation,
  type PaymentObservationStatus,
  type StarknetNetwork,
} from "@cashu-strk20/strk20-method";
import type { FundingEvidenceReference } from "./gateway.js";

export const STARKNET_PRIVACY_SDK_VERSION = "0.14.3-rc.6";
export const STARKNET_PRIVACY_SDK_COMMIT = "4db755b9512f00b540126737b605472ea2275e15";
export const STARKNET_PRIVACY_POOL_VERSION = "PRIVACY-0.14.3-RC.6";
export const STARKNET_PRIVACY_POOL_CLASS_HASH =
  "0x7e2bbd7ccc1e68b2695caef70aeb2a3be6cd017b5d5159278ba08f2d8de33f";
export const STARKNET_PRIVACY_EVIDENCE_VERIFIER =
  "starknet-privacy-sdk@0.14.3-rc.6:note-history-receipt-value-sender-v1";

export interface PrivacyIncomingNote {
  readonly poolContract: string;
  readonly recipientAddress: string;
  readonly senderAddress: string;
  readonly tokenContract: string;
  readonly amountBaseUnits: bigint;
  readonly noteReference: string;
  /** Public `EncNoteCreated.packed_value` derived from the decrypted SDK note witness. */
  readonly eventValue: string;
  readonly blockNumber: bigint;
}

export interface PrivacyNoteSnapshot {
  readonly blockReference: string;
  readonly notes: readonly PrivacyIncomingNote[];
}

export interface PrivacyNoteTransaction {
  readonly noteReference: string;
  readonly transactionReference: string;
  readonly blockNumber: bigint;
}

export interface PrivacyHistorySnapshot {
  readonly blockReference: string;
  readonly transactions: readonly PrivacyNoteTransaction[];
}

export interface PrivacyTransactionObservation {
  readonly transactionReference: string;
  readonly blockHash: string;
  readonly blockNumber: bigint;
  readonly status: PaymentObservationStatus;
}

export interface PrivacyTransactionInclusion {
  readonly transactionReference: string;
  readonly blockHash: string;
  readonly blockNumber: bigint;
}

export interface PrivacyTransactionNoteExpectation {
  readonly transactionReference: string;
  readonly poolContract: string;
  readonly noteReferences: readonly string[];
  /** Required during first observation to bind decrypted values to public receipt data. */
  readonly noteEventValues?: readonly {
    readonly noteReference: string;
    readonly eventValue: string;
  }[];
  /** Required during first observation to bind indexer attribution to the invoke sender. */
  readonly senderAddress?: string;
}

export interface PrivacyNoteSource {
  discoverIncomingNotes(input: {
    readonly network: StarknetNetwork;
    readonly poolContract: string;
    readonly recipientAddress: string;
    readonly tokenContract: string;
    readonly blockIdentifier: "latest";
  }): Promise<PrivacyNoteSnapshot>;
  findNoteTransactions(input: {
    readonly network: StarknetNetwork;
    readonly poolContract: string;
    readonly recipientAddress: string;
    readonly blockReference: string;
    readonly noteReferences: readonly string[];
  }): Promise<PrivacyHistorySnapshot>;
}

export interface PrivacyTransactionObserver {
  observeTransactions(input: {
    readonly network: StarknetNetwork;
    readonly transactionReferences: readonly string[];
    readonly finalityPolicy: string;
    /** Original inclusions to classify when a previously observed transaction disappears. */
    readonly knownInclusions?: readonly PrivacyTransactionInclusion[];
    /** Public pool events that must bind indexer history to each transaction receipt. */
    readonly expectedNoteEvents?: readonly PrivacyTransactionNoteExpectation[];
  }): Promise<readonly PrivacyTransactionObservation[]>;
}

export interface PrivacyEvidenceSource extends PrivacyNoteSource, PrivacyTransactionObserver {}

export class CompositePrivacyEvidenceSource implements PrivacyEvidenceSource {
  constructor(
    readonly notes: PrivacyNoteSource,
    readonly transactions: PrivacyTransactionObserver,
  ) {}

  discoverIncomingNotes(
    input: Parameters<PrivacyNoteSource["discoverIncomingNotes"]>[0],
  ): Promise<PrivacyNoteSnapshot> {
    return this.notes.discoverIncomingNotes(input);
  }

  findNoteTransactions(
    input: Parameters<PrivacyNoteSource["findNoteTransactions"]>[0],
  ): Promise<PrivacyHistorySnapshot> {
    return this.notes.findNoteTransactions(input);
  }

  observeTransactions(
    input: Parameters<PrivacyTransactionObserver["observeTransactions"]>[0],
  ): Promise<readonly PrivacyTransactionObservation[]> {
    return this.transactions.observeTransactions(input);
  }
}

export interface IncomingPrivacyEvidenceCollectorConfig {
  readonly network: StarknetNetwork;
  readonly poolContract: string;
  readonly recipientAddress: string;
  readonly tokenContract: string;
  readonly finalityPolicy: string;
}

export interface CollectedIncomingPrivacyEvidence {
  readonly network: StarknetNetwork;
  readonly poolContract: string;
  readonly recipientAddress: string;
  readonly senderAddress: string;
  readonly tokenContract: string;
  readonly amountBaseUnits: bigint;
  readonly evidenceId: string;
  readonly noteReference: string;
  readonly transactionReference: string;
  readonly blockHash: string;
  readonly blockNumber: bigint;
  readonly status: PaymentObservationStatus;
  readonly finalityPolicy: string;
  readonly verifierVersion: string;
  readonly discoveryBlockHash: string;
}

export interface SignedPayerObservationInput {
  readonly paymentRequestId: string;
  /** Address recovered from a separately verified, replay-resistant payer challenge. */
  readonly expectedPayerAddress: string;
  readonly expectedRecipientAddress: string;
  /** Note ID signed by the payer for this request. */
  readonly expectedNoteReference: string;
  /** Accepted block used to verify the binding; matching payment evidence must be newer. */
  readonly payerBindingBlockNumber: bigint;
  readonly destination: Readonly<Record<string, unknown>>;
  readonly evidence: CollectedIncomingPrivacyEvidence;
  /** Untrusted wallet-supplied lookup filter; never an attribution proof. */
  readonly transactionHint?: string;
}

export interface ReobservedPrivacyEvidence extends FundingEvidenceReference {
  readonly status: PaymentObservationStatus;
}

export class PrivacyEvidenceConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivacyEvidenceConfigurationError";
  }
}

export class PrivacyEvidenceProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivacyEvidenceProtocolError";
  }
}

export class IncomingPrivacyEvidenceCollector {
  readonly #network: StarknetNetwork;
  readonly #poolContract: string;
  readonly #recipientAddress: string;
  readonly #tokenContract: string;
  readonly #finalityPolicy: string;

  constructor(
    readonly source: PrivacyEvidenceSource,
    config: IncomingPrivacyEvidenceCollectorConfig,
  ) {
    if (config.network !== "SN_SEPOLIA") {
      throw new PrivacyEvidenceConfigurationError(
        "Only Starknet Sepolia is enabled for privacy evidence",
      );
    }
    this.#network = config.network;
    this.#poolContract = normalizeConfiguredAddress(config.poolContract, "pool contract");
    this.#recipientAddress = normalizeConfiguredAddress(
      config.recipientAddress,
      "recipient address",
    );
    this.#tokenContract = normalizeConfiguredAddress(config.tokenContract, "token contract");
    this.#finalityPolicy = configuredIdentifier(config.finalityPolicy, "finality policy");
  }

  async collect(): Promise<readonly CollectedIncomingPrivacyEvidence[]> {
    const snapshot = validateNoteSnapshot(
      await this.source.discoverIncomingNotes({
        network: this.#network,
        poolContract: this.#poolContract,
        recipientAddress: this.#recipientAddress,
        tokenContract: this.#tokenContract,
        blockIdentifier: "latest",
      }),
      {
        poolContract: this.#poolContract,
        recipientAddress: this.#recipientAddress,
        tokenContract: this.#tokenContract,
      },
    );
    if (snapshot.notes.length === 0) {
      return [];
    }

    const noteReferences = snapshot.notes.map((note) => note.noteReference);
    const history = validateHistorySnapshot(
      await this.source.findNoteTransactions({
        network: this.#network,
        poolContract: this.#poolContract,
        recipientAddress: this.#recipientAddress,
        blockReference: snapshot.blockReference,
        noteReferences,
      }),
      snapshot,
    );
    const historyByNote = new Map(
      history.transactions.map((transaction) => [transaction.noteReference, transaction]),
    );
    const notesByReference = new Map(snapshot.notes.map((note) => [note.noteReference, note]));
    const transactionReferences = [
      ...new Set(history.transactions.map((transaction) => transaction.transactionReference)),
    ].sort();
    const expectedNoteEvents = transactionNoteExpectations(
      this.#poolContract,
      history.transactions,
      notesByReference,
    );
    const finality = validateFinalityObservations(
      await this.source.observeTransactions({
        network: this.#network,
        transactionReferences,
        finalityPolicy: this.#finalityPolicy,
        expectedNoteEvents,
      }),
      transactionReferences,
      history.transactions,
    );
    const finalityByTransaction = new Map(
      finality.map((observation) => [observation.transactionReference, observation]),
    );

    return snapshot.notes.map((note) => {
      const transaction = historyByNote.get(note.noteReference);
      if (transaction === undefined) {
        throw new PrivacyEvidenceProtocolError("Privacy history omitted a discovered note");
      }
      const observation = finalityByTransaction.get(transaction.transactionReference);
      if (observation === undefined) {
        throw new PrivacyEvidenceProtocolError("Finality source omitted a privacy transaction");
      }
      return {
        network: this.#network,
        poolContract: note.poolContract,
        recipientAddress: note.recipientAddress,
        senderAddress: note.senderAddress,
        tokenContract: note.tokenContract,
        amountBaseUnits: note.amountBaseUnits,
        evidenceId: derivePrivacyEvidenceId(this.#network, note.poolContract, note.noteReference),
        noteReference: note.noteReference,
        transactionReference: transaction.transactionReference,
        blockHash: observation.blockHash,
        blockNumber: observation.blockNumber,
        status: observation.status,
        finalityPolicy: this.#finalityPolicy,
        verifierVersion: STARKNET_PRIVACY_EVIDENCE_VERIFIER,
        discoveryBlockHash: snapshot.blockReference,
      };
    });
  }

  async reobserve(
    knownEvidence: readonly FundingEvidenceReference[],
  ): Promise<readonly ReobservedPrivacyEvidence[]> {
    const references = validateKnownEvidenceReferences(
      knownEvidence,
      this.#network,
      this.#poolContract,
    );
    if (references.length === 0) {
      return [];
    }

    const inclusionsByTransaction = new Map<string, PrivacyTransactionInclusion>();
    for (const reference of references) {
      inclusionsByTransaction.set(reference.transactionReference, {
        transactionReference: reference.transactionReference,
        blockHash: reference.blockHash,
        blockNumber: reference.blockNumber,
      });
    }
    const knownInclusions = [...inclusionsByTransaction.values()].sort((left, right) =>
      left.transactionReference.localeCompare(right.transactionReference),
    );
    const transactionReferences = knownInclusions.map(
      (inclusion) => inclusion.transactionReference,
    );
    const expectedNoteEvents = transactionNoteExpectations(this.#poolContract, references);
    const observations = validateFinalityObservations(
      await this.source.observeTransactions({
        network: this.#network,
        transactionReferences,
        finalityPolicy: this.#finalityPolicy,
        knownInclusions,
        expectedNoteEvents,
      }),
      transactionReferences,
      references.map((reference) => ({
        noteReference: reference.noteReference,
        transactionReference: reference.transactionReference,
        blockNumber: reference.blockNumber,
      })),
    );
    const observationByTransaction = new Map(
      observations.map((observation) => [observation.transactionReference, observation]),
    );
    for (const inclusion of knownInclusions) {
      const observation = observationByTransaction.get(inclusion.transactionReference);
      if (observation?.blockHash !== inclusion.blockHash) {
        throw new PrivacyEvidenceProtocolError(
          "Reobserved privacy transaction changed its original block hash",
        );
      }
    }

    return references.map((reference) => {
      const observation = observationByTransaction.get(reference.transactionReference);
      if (observation === undefined) {
        throw new PrivacyEvidenceProtocolError("Finality source omitted a privacy transaction");
      }
      return { ...reference, status: observation.status };
    });
  }
}

function transactionNoteExpectations(
  poolContract: string,
  transactions: readonly {
    readonly noteReference: string;
    readonly transactionReference: string;
  }[],
  notesByReference?: ReadonlyMap<string, PrivacyIncomingNote>,
): readonly PrivacyTransactionNoteExpectation[] {
  const notesByTransaction = new Map<
    string,
    {
      readonly noteReferences: string[];
      readonly noteEventValues: { readonly noteReference: string; readonly eventValue: string }[];
      senderAddress?: string;
    }
  >();
  for (const transaction of transactions) {
    const grouped = notesByTransaction.get(transaction.transactionReference) ?? {
      noteReferences: [],
      noteEventValues: [],
    };
    grouped.noteReferences.push(transaction.noteReference);
    if (notesByReference !== undefined) {
      const note = notesByReference.get(transaction.noteReference);
      if (note === undefined) {
        throw new PrivacyEvidenceProtocolError(
          "Privacy history cannot be bound to its discovered note",
        );
      }
      if (grouped.senderAddress !== undefined && grouped.senderAddress !== note.senderAddress) {
        throw new PrivacyEvidenceProtocolError(
          "One privacy transaction was attributed to multiple senders",
        );
      }
      grouped.senderAddress = note.senderAddress;
      grouped.noteEventValues.push({
        noteReference: transaction.noteReference,
        eventValue: note.eventValue,
      });
    }
    notesByTransaction.set(transaction.transactionReference, grouped);
  }
  return [...notesByTransaction]
    .map(([transactionReference, grouped]) => {
      grouped.noteReferences.sort();
      grouped.noteEventValues.sort((left, right) =>
        left.noteReference.localeCompare(right.noteReference),
      );
      return {
        transactionReference,
        poolContract,
        noteReferences: grouped.noteReferences,
        ...(grouped.senderAddress === undefined
          ? {}
          : {
              senderAddress: grouped.senderAddress,
              noteEventValues: grouped.noteEventValues,
            }),
      };
    })
    .sort((left, right) => left.transactionReference.localeCompare(right.transactionReference));
}

export function derivePrivacyEvidenceId(
  network: StarknetNetwork,
  poolContract: string,
  noteReference: string,
): string {
  const pool = normalizeProtocolAddress(poolContract, "pool contract");
  const note = normalizeFelt(noteReference, "note reference");
  const digest = createHash("sha256")
    .update(`${network}\0${pool}\0${note}`, "utf8")
    .digest("base64url");
  return `strk20-note-${digest}`;
}

export function toSignedPayerPaymentObservation(
  input: SignedPayerObservationInput,
): PaymentObservation | null {
  const paymentRequestId = configuredPaymentRequestId(input.paymentRequestId);
  const expectedPayerAddress = normalizeConfiguredAddress(
    input.expectedPayerAddress,
    "expected payer address",
  );
  const expectedRecipientAddress = normalizeConfiguredAddress(
    input.expectedRecipientAddress,
    "expected recipient address",
  );
  const expectedNoteReference = normalizeConfiguredNonzeroFelt(
    input.expectedNoteReference,
    "expected note reference",
  );
  const payerBindingBlockNumber = configuredBlockNumber(
    input.payerBindingBlockNumber,
    "payer-binding block number",
  );
  const evidence = validateCollectedEvidence(input.evidence);

  if (
    evidence.senderAddress !== expectedPayerAddress ||
    evidence.recipientAddress !== expectedRecipientAddress ||
    evidence.noteReference !== expectedNoteReference ||
    evidence.blockNumber <= payerBindingBlockNumber
  ) {
    return null;
  }
  if (input.transactionHint !== undefined) {
    let transactionHint: string;
    try {
      transactionHint = normalizeFelt(input.transactionHint, "transaction hint");
    } catch {
      return null;
    }
    if (transactionHint !== evidence.transactionReference) {
      return null;
    }
  }

  return {
    network: evidence.network,
    pool_contract: evidence.poolContract,
    sender_address: evidence.senderAddress,
    recipient_address: evidence.recipientAddress,
    token_contract: evidence.tokenContract,
    amount_base_units: evidence.amountBaseUnits,
    payment_request_id: paymentRequestId,
    attribution_profile: "signed_payer",
    destination: cloneJsonRecord(input.destination),
    evidence_id: evidence.evidenceId,
    note_reference: evidence.noteReference,
    transaction_reference: evidence.transactionReference,
    block_hash: evidence.blockHash,
    block_number: evidence.blockNumber,
    status: evidence.status,
    finality_policy: evidence.finalityPolicy,
    verifier_version: evidence.verifierVersion,
  };
}

function validateCollectedEvidence(
  value: CollectedIncomingPrivacyEvidence,
): CollectedIncomingPrivacyEvidence {
  if (typeof value !== "object" || value === null || value.network !== "SN_SEPOLIA") {
    throw new PrivacyEvidenceProtocolError("Collected privacy evidence is malformed");
  }
  const poolContract = normalizeProtocolAddress(value.poolContract, "evidence pool contract");
  const recipientAddress = normalizeProtocolAddress(
    value.recipientAddress,
    "evidence recipient address",
  );
  const senderAddress = normalizeProtocolAddress(value.senderAddress, "evidence sender address");
  const tokenContract = normalizeProtocolAddress(value.tokenContract, "evidence token contract");
  const amountBaseUnits = positiveBigInt(value.amountBaseUnits, "evidence amount");
  const noteReference = normalizeFelt(value.noteReference, "evidence note reference");
  const transactionReference = normalizeFelt(
    value.transactionReference,
    "evidence transaction reference",
  );
  const blockHash = normalizeFelt(value.blockHash, "evidence block hash");
  const blockNumber = nonNegativeBigInt(value.blockNumber, "evidence block number");
  const discoveryBlockHash = normalizeFelt(
    value.discoveryBlockHash,
    "evidence discovery block hash",
  );
  if (!PAYMENT_OBSERVATION_STATUSES.includes(value.status)) {
    throw new PrivacyEvidenceProtocolError("Collected privacy evidence has an unknown status");
  }
  const finalityPolicy = protocolIdentifier(value.finalityPolicy, "evidence finality policy");
  if (value.verifierVersion !== STARKNET_PRIVACY_EVIDENCE_VERIFIER) {
    throw new PrivacyEvidenceProtocolError("Collected privacy evidence has an unknown verifier");
  }
  const evidenceId = derivePrivacyEvidenceId(value.network, poolContract, noteReference);
  if (value.evidenceId !== evidenceId) {
    throw new PrivacyEvidenceProtocolError("Collected privacy evidence ID does not match its note");
  }
  return {
    network: value.network,
    poolContract,
    recipientAddress,
    senderAddress,
    tokenContract,
    amountBaseUnits,
    evidenceId,
    noteReference,
    transactionReference,
    blockHash,
    blockNumber,
    status: value.status,
    finalityPolicy,
    verifierVersion: value.verifierVersion,
    discoveryBlockHash,
  };
}

function validateKnownEvidenceReferences(
  value: readonly FundingEvidenceReference[],
  network: StarknetNetwork,
  poolContract: string,
): readonly FundingEvidenceReference[] {
  if (!Array.isArray(value) || value.length > MAX_DISCOVERED_NOTES) {
    throw new PrivacyEvidenceProtocolError("Known privacy evidence is malformed");
  }
  const evidenceIds = new Set<string>();
  const noteReferences = new Set<string>();
  const inclusionByTransaction = new Map<string, { blockHash: string; blockNumber: bigint }>();
  const references = Array.from(value, (candidate) => {
    if (typeof candidate !== "object" || candidate === null) {
      throw new PrivacyEvidenceProtocolError("Known privacy evidence is malformed");
    }
    const noteReference = normalizeFelt(candidate.noteReference, "known note reference");
    const evidenceId = derivePrivacyEvidenceId(network, poolContract, noteReference);
    if (candidate.evidenceId !== evidenceId) {
      throw new PrivacyEvidenceProtocolError("Known evidence ID does not match its note");
    }
    const transactionReference = normalizeFelt(
      candidate.transactionReference,
      "known transaction reference",
    );
    const blockHash = normalizeFelt(candidate.blockHash, "known block hash");
    const blockNumber = nonNegativeBigInt(candidate.blockNumber, "known block number");
    if (evidenceIds.has(evidenceId) || noteReferences.has(noteReference)) {
      throw new PrivacyEvidenceProtocolError("Known privacy evidence contains a duplicate note");
    }
    const priorInclusion = inclusionByTransaction.get(transactionReference);
    if (
      priorInclusion !== undefined &&
      (priorInclusion.blockHash !== blockHash || priorInclusion.blockNumber !== blockNumber)
    ) {
      throw new PrivacyEvidenceProtocolError(
        "Known privacy evidence disagrees about a transaction inclusion",
      );
    }
    evidenceIds.add(evidenceId);
    noteReferences.add(noteReference);
    inclusionByTransaction.set(transactionReference, { blockHash, blockNumber });
    return { evidenceId, noteReference, transactionReference, blockHash, blockNumber };
  });
  references.sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  return references;
}

function validateNoteSnapshot(
  value: PrivacyNoteSnapshot,
  expected: {
    readonly poolContract: string;
    readonly recipientAddress: string;
    readonly tokenContract: string;
  },
): PrivacyNoteSnapshot {
  if (typeof value !== "object" || value === null || !Array.isArray(value.notes)) {
    throw new PrivacyEvidenceProtocolError("Privacy discovery returned a malformed snapshot");
  }
  if (value.notes.length > MAX_DISCOVERED_NOTES) {
    throw new PrivacyEvidenceProtocolError("Privacy discovery returned too many notes");
  }
  const blockReference = normalizeFelt(value.blockReference, "discovery block reference");
  const seen = new Set<string>();
  const notes = Array.from(value.notes, (candidate) => {
    if (typeof candidate !== "object" || candidate === null) {
      throw new PrivacyEvidenceProtocolError("Privacy discovery returned a malformed note");
    }
    const note: PrivacyIncomingNote = {
      poolContract: normalizeProtocolAddress(candidate.poolContract, "note pool contract"),
      recipientAddress: normalizeProtocolAddress(
        candidate.recipientAddress,
        "note recipient address",
      ),
      senderAddress: normalizeProtocolAddress(candidate.senderAddress, "note sender address"),
      tokenContract: normalizeProtocolAddress(candidate.tokenContract, "note token contract"),
      amountBaseUnits: positiveBigInt(candidate.amountBaseUnits, "note amount"),
      noteReference: normalizeFelt(candidate.noteReference, "note reference"),
      eventValue: normalizeNonzeroFelt(candidate.eventValue, "note event value"),
      blockNumber: nonNegativeBigInt(candidate.blockNumber, "note block number"),
    };
    if (
      note.poolContract !== expected.poolContract ||
      note.recipientAddress !== expected.recipientAddress ||
      note.tokenContract !== expected.tokenContract
    ) {
      throw new PrivacyEvidenceProtocolError("Privacy discovery escaped its configured scope");
    }
    if (seen.has(note.noteReference)) {
      throw new PrivacyEvidenceProtocolError("Privacy discovery returned a duplicate note");
    }
    seen.add(note.noteReference);
    return note;
  });
  notes.sort((left, right) => left.noteReference.localeCompare(right.noteReference));
  return { blockReference, notes };
}

function validateHistorySnapshot(
  value: PrivacyHistorySnapshot,
  notes: PrivacyNoteSnapshot,
): PrivacyHistorySnapshot {
  if (typeof value !== "object" || value === null || !Array.isArray(value.transactions)) {
    throw new PrivacyEvidenceProtocolError("Privacy history returned a malformed snapshot");
  }
  if (value.transactions.length > MAX_DISCOVERED_NOTES) {
    throw new PrivacyEvidenceProtocolError("Privacy history returned too many transactions");
  }
  const blockReference = normalizeFelt(value.blockReference, "history block reference");
  if (blockReference !== notes.blockReference) {
    throw new PrivacyEvidenceProtocolError("Privacy discovery and history snapshots disagree");
  }
  const noteByReference = new Map(notes.notes.map((note) => [note.noteReference, note]));
  const blockByTransaction = new Map<string, bigint>();
  const seen = new Set<string>();
  const transactions = Array.from(value.transactions, (candidate) => {
    if (typeof candidate !== "object" || candidate === null) {
      throw new PrivacyEvidenceProtocolError("Privacy history returned a malformed transaction");
    }
    const transaction: PrivacyNoteTransaction = {
      noteReference: normalizeFelt(candidate.noteReference, "history note reference"),
      transactionReference: normalizeFelt(
        candidate.transactionReference,
        "history transaction reference",
      ),
      blockNumber: nonNegativeBigInt(candidate.blockNumber, "history block number"),
    };
    const note = noteByReference.get(transaction.noteReference);
    if (note === undefined) {
      throw new PrivacyEvidenceProtocolError("Privacy history returned an unrelated note");
    }
    if (note.blockNumber !== transaction.blockNumber) {
      throw new PrivacyEvidenceProtocolError("Privacy note and history block numbers disagree");
    }
    if (seen.has(transaction.noteReference)) {
      throw new PrivacyEvidenceProtocolError("Privacy history returned a duplicate note");
    }
    const existingBlock = blockByTransaction.get(transaction.transactionReference);
    if (existingBlock !== undefined && existingBlock !== transaction.blockNumber) {
      throw new PrivacyEvidenceProtocolError(
        "One privacy transaction is mapped to inconsistent history blocks",
      );
    }
    blockByTransaction.set(transaction.transactionReference, transaction.blockNumber);
    seen.add(transaction.noteReference);
    return transaction;
  });
  if (seen.size !== noteByReference.size) {
    throw new PrivacyEvidenceProtocolError("Privacy history omitted a discovered note");
  }
  return { blockReference, transactions };
}

function validateFinalityObservations(
  value: readonly PrivacyTransactionObservation[],
  expectedReferences: readonly string[],
  history: readonly PrivacyNoteTransaction[],
): readonly PrivacyTransactionObservation[] {
  if (!Array.isArray(value)) {
    throw new PrivacyEvidenceProtocolError("Finality source returned a malformed collection");
  }
  if (value.length > expectedReferences.length) {
    throw new PrivacyEvidenceProtocolError("Finality source returned too many observations");
  }
  const expected = new Set(expectedReferences);
  const blockByTransaction = new Map(
    history.map((transaction) => [transaction.transactionReference, transaction.blockNumber]),
  );
  const seen = new Set<string>();
  const observations = Array.from(value, (candidate) => {
    if (typeof candidate !== "object" || candidate === null) {
      throw new PrivacyEvidenceProtocolError("Finality source returned a malformed observation");
    }
    const transactionReference = normalizeFelt(
      candidate.transactionReference,
      "finality transaction reference",
    );
    if (!expected.has(transactionReference)) {
      throw new PrivacyEvidenceProtocolError("Finality source returned an unrelated transaction");
    }
    if (seen.has(transactionReference)) {
      throw new PrivacyEvidenceProtocolError("Finality source returned a duplicate transaction");
    }
    seen.add(transactionReference);
    if (!PAYMENT_OBSERVATION_STATUSES.includes(candidate.status)) {
      throw new PrivacyEvidenceProtocolError("Finality source returned an unknown status");
    }
    const blockNumber = nonNegativeBigInt(candidate.blockNumber, "finality block number");
    if (blockByTransaction.get(transactionReference) !== blockNumber) {
      throw new PrivacyEvidenceProtocolError("Privacy history and finality block numbers disagree");
    }
    return {
      transactionReference,
      blockHash: normalizeFelt(candidate.blockHash, "finality block hash"),
      blockNumber,
      status: candidate.status,
    };
  });
  if (seen.size !== expected.size) {
    throw new PrivacyEvidenceProtocolError("Finality source omitted a privacy transaction");
  }
  return observations;
}

function normalizeConfiguredAddress(value: string, label: string): string {
  try {
    return normalizeAddress(value);
  } catch {
    throw new PrivacyEvidenceConfigurationError(`Configured ${label} is invalid`);
  }
}

function normalizeConfiguredNonzeroFelt(value: string, label: string): string {
  try {
    const felt = parseHex(value);
    if (felt === 0n || felt >= STARK_FIELD_PRIME) {
      throw new Error("felt is outside the supported range");
    }
    return `0x${felt.toString(16)}`;
  } catch {
    throw new PrivacyEvidenceConfigurationError(`Configured ${label} is invalid`);
  }
}

function normalizeProtocolAddress(value: string, label: string): string {
  try {
    return normalizeAddress(value);
  } catch {
    throw new PrivacyEvidenceProtocolError(`Privacy source returned an invalid ${label}`);
  }
}

function normalizeAddress(value: string): string {
  const address = parseHex(value);
  if (address === 0n || address >= STARKNET_ADDRESS_BOUND) {
    throw new Error("Starknet address is outside the supported range");
  }
  return `0x${address.toString(16)}`;
}

function normalizeFelt(value: string, label: string): string {
  try {
    const felt = parseHex(value);
    if (felt >= STARK_FIELD_PRIME) {
      throw new Error("felt is outside the field");
    }
    return `0x${felt.toString(16)}`;
  } catch {
    throw new PrivacyEvidenceProtocolError(`Privacy source returned an invalid ${label}`);
  }
}

function normalizeNonzeroFelt(value: string, label: string): string {
  const felt = normalizeFelt(value, label);
  if (felt === "0x0") {
    throw new PrivacyEvidenceProtocolError(`Privacy source returned an invalid ${label}`);
  }
  return felt;
}

function parseHex(value: string): bigint {
  if (
    typeof value !== "string" ||
    value.length > MAX_FELT_TEXT_LENGTH ||
    !/^0x[0-9a-fA-F]+$/.test(value)
  ) {
    throw new Error("value is not hexadecimal");
  }
  return BigInt(value);
}

function positiveBigInt(value: bigint, label: string): bigint {
  if (typeof value !== "bigint" || value <= 0n || value > MAX_U128) {
    throw new PrivacyEvidenceProtocolError(`Privacy source returned an invalid ${label}`);
  }
  return value;
}

function nonNegativeBigInt(value: bigint, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_BLOCK_NUMBER) {
    throw new PrivacyEvidenceProtocolError(`Privacy source returned an invalid ${label}`);
  }
  return value;
}

function configuredIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 128) {
    throw new PrivacyEvidenceConfigurationError(`Configured ${label} is invalid`);
  }
  return value;
}

function configuredPaymentRequestId(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < PAYMENT_REQUEST_ID_MINIMUM_LENGTH ||
    value.length > MAX_OPAQUE_IDENTIFIER_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new PrivacyEvidenceConfigurationError("Configured payment request ID is invalid");
  }
  return value;
}

function configuredBlockNumber(value: bigint, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_BLOCK_NUMBER) {
    throw new PrivacyEvidenceConfigurationError(`Configured ${label} is invalid`);
  }
  return value;
}

function protocolIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 128) {
    throw new PrivacyEvidenceProtocolError(`Privacy source returned an invalid ${label}`);
  }
  return value;
}

function cloneJsonRecord(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!isJsonRecord(value, new Set(), 0) || Object.keys(value).length === 0) {
    throw new PrivacyEvidenceConfigurationError("Configured funding destination is invalid");
  }
  return structuredClone(value);
}

function isJsonRecord(
  value: unknown,
  ancestors: Set<object>,
  depth: number,
): value is Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    depth > MAX_JSON_DEPTH ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    ancestors.has(value)
  ) {
    return false;
  }
  ancestors.add(value);
  const entries = Object.entries(value);
  const valid =
    entries.length <= MAX_JSON_ENTRIES &&
    entries.every(([, entry]) => isJsonValue(entry, ancestors, depth + 1));
  ancestors.delete(value);
  return valid;
}

function isJsonValue(value: unknown, ancestors: Set<object>, depth: number): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value);
  }
  if (depth > MAX_JSON_DEPTH || typeof value !== "object" || value === null) {
    return false;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ENTRIES || ancestors.has(value)) {
      return false;
    }
    ancestors.add(value);
    const valid = Array.from(value).every((entry) => isJsonValue(entry, ancestors, depth + 1));
    ancestors.delete(value);
    return valid;
  }
  return isJsonRecord(value, ancestors, depth);
}

const MAX_DISCOVERED_NOTES = 10_000;
const MAX_FELT_TEXT_LENGTH = 66;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_ENTRIES = 256;
const MAX_OPAQUE_IDENTIFIER_LENGTH = 512;
const PAYMENT_REQUEST_ID_MINIMUM_LENGTH = 22;
const MAX_U128 = (1n << 128n) - 1n;
const MAX_BLOCK_NUMBER = (1n << 64n) - 1n;
const STARKNET_ADDRESS_BOUND = (1n << 251n) - 256n;
const STARK_FIELD_PRIME = (1n << 251n) + (17n << 192n) + 1n;
