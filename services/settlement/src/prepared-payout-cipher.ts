import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type {
  EncryptedPreparedPayoutPayload,
  PreparedPayoutPayloadContext,
} from "./prepared-payouts.js";
import { preparedPayoutPayloadContext } from "./prepared-payouts.js";

export interface PreparedPayoutEncryptionKey {
  readonly keyId: string;
  readonly key: Uint8Array;
}

export interface PreparedPayoutKeyring {
  getActiveKey(): Promise<PreparedPayoutEncryptionKey>;
  getKey(keyId: string): Promise<Uint8Array | null>;
}

export interface PreparedPayoutCipher {
  seal(
    transaction: unknown,
    context: PreparedPayoutPayloadContext,
  ): Promise<EncryptedPreparedPayoutPayload>;
  open(
    encrypted: EncryptedPreparedPayoutPayload,
    context: PreparedPayoutPayloadContext,
  ): Promise<unknown>;
}

export type PreparedPayoutCipherErrorCode =
  | "decryption_failure"
  | "encryption_failure"
  | "invalid_key"
  | "payload_too_large";

export class PreparedPayoutCipherError extends Error {
  readonly code: PreparedPayoutCipherErrorCode;

  constructor(code: PreparedPayoutCipherErrorCode, message: string) {
    super(message);
    this.name = "PreparedPayoutCipherError";
    this.code = code;
  }
}

export interface AesGcmPreparedPayoutCipherConfig {
  readonly keyring: PreparedPayoutKeyring;
  readonly maximumPlaintextBytes: number;
  readonly randomInitializationVector?: () => Uint8Array;
}

export class AesGcmPreparedPayoutCipher implements PreparedPayoutCipher {
  readonly #keyring: PreparedPayoutKeyring;
  readonly #maximumPlaintextBytes: number;
  readonly #randomInitializationVector: () => Uint8Array;

  constructor(config: AesGcmPreparedPayoutCipherConfig) {
    if (
      typeof config !== "object" ||
      config === null ||
      typeof config.keyring !== "object" ||
      config.keyring === null ||
      typeof config.keyring.getActiveKey !== "function" ||
      typeof config.keyring.getKey !== "function"
    ) {
      throw new PreparedPayoutCipherError("invalid_key", "Prepared payout keyring is invalid");
    }
    if (
      !Number.isSafeInteger(config.maximumPlaintextBytes) ||
      config.maximumPlaintextBytes <= 0 ||
      config.maximumPlaintextBytes > MAXIMUM_PLAINTEXT_BYTES
    ) {
      throw new PreparedPayoutCipherError(
        "payload_too_large",
        "Prepared payout plaintext limit is invalid",
      );
    }
    if (
      config.randomInitializationVector !== undefined &&
      typeof config.randomInitializationVector !== "function"
    ) {
      throw new PreparedPayoutCipherError(
        "encryption_failure",
        "Prepared payout initialization-vector source is invalid",
      );
    }
    this.#keyring = config.keyring;
    this.#maximumPlaintextBytes = config.maximumPlaintextBytes;
    this.#randomInitializationVector =
      config.randomInitializationVector ?? (() => randomBytes(INITIALIZATION_VECTOR_BYTES));
  }

  async seal(
    transaction: unknown,
    context: PreparedPayoutPayloadContext,
  ): Promise<EncryptedPreparedPayoutPayload> {
    const normalizedContext = preparedPayoutPayloadContext(context);
    const plaintext = serializeTransaction(transaction);
    let key: Buffer | undefined;
    try {
      if (plaintext.byteLength > this.#maximumPlaintextBytes) {
        throw new PreparedPayoutCipherError(
          "payload_too_large",
          "Prepared payout transaction exceeds its encrypted-payload limit",
        );
      }
      let activeKey: PreparedPayoutEncryptionKey;
      try {
        activeKey = await this.#keyring.getActiveKey();
      } catch {
        throw invalidKey();
      }
      const keyId = encryptionKeyId(activeKey?.keyId);
      key = encryptionKey(activeKey?.key);
      const initializationVector = validatedInitializationVector(
        this.#randomInitializationVector(),
      );
      const cipher = createCipheriv(ALGORITHM, key, initializationVector, {
        authTagLength: AUTHENTICATION_TAG_BYTES,
      });
      cipher.setAAD(associatedData(normalizedContext), { plaintextLength: plaintext.byteLength });
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return {
        algorithm: "A256GCM",
        keyId,
        initializationVector: initializationVector.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        authenticationTag: cipher.getAuthTag().toString("base64url"),
      };
    } catch (error) {
      if (
        error instanceof PreparedPayoutCipherError &&
        (error.code === "invalid_key" || error.code === "payload_too_large")
      ) {
        throw error;
      }
      throw new PreparedPayoutCipherError(
        "encryption_failure",
        "Prepared payout transaction could not be encrypted",
      );
    } finally {
      key?.fill(0);
      plaintext.fill(0);
    }
  }

  async open(
    encrypted: EncryptedPreparedPayoutPayload,
    context: PreparedPayoutPayloadContext,
  ): Promise<unknown> {
    const normalizedContext = preparedPayoutPayloadContext(context);
    const envelope = encryptedPayload(encrypted, this.#maximumPlaintextBytes);
    let resolvedKey: Uint8Array | null;
    try {
      resolvedKey = await this.#keyring.getKey(envelope.keyId);
    } catch {
      throw invalidKey();
    }
    if (resolvedKey === null) {
      throw invalidKey();
    }
    const key = encryptionKey(resolvedKey);
    let plaintext: Buffer | undefined;
    try {
      const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
      const decipher = createDecipheriv(
        ALGORITHM,
        key,
        Buffer.from(envelope.initializationVector, "base64url"),
        { authTagLength: AUTHENTICATION_TAG_BYTES },
      );
      decipher.setAAD(associatedData(normalizedContext), {
        plaintextLength: ciphertext.byteLength,
      });
      decipher.setAuthTag(Buffer.from(envelope.authenticationTag, "base64url"));
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      if (plaintext.byteLength > this.#maximumPlaintextBytes) {
        throw new PreparedPayoutCipherError(
          "payload_too_large",
          "Prepared payout transaction exceeds its encrypted-payload limit",
        );
      }
      return JSON.parse(plaintext.toString("utf8")) as unknown;
    } catch (error) {
      if (error instanceof PreparedPayoutCipherError && error.code === "payload_too_large") {
        throw error;
      }
      throw new PreparedPayoutCipherError(
        "decryption_failure",
        "Prepared payout transaction could not be authenticated and decrypted",
      );
    } finally {
      key.fill(0);
      plaintext?.fill(0);
    }
  }
}

function serializeTransaction(transaction: unknown): Buffer {
  try {
    const serialized = JSON.stringify(transaction);
    if (serialized === undefined) {
      throw new TypeError("Transaction is not serializable");
    }
    return Buffer.from(serialized, "utf8");
  } catch {
    throw new PreparedPayoutCipherError(
      "encryption_failure",
      "Prepared payout transaction is not structurally serializable",
    );
  }
}

function associatedData(context: PreparedPayoutPayloadContext): Buffer {
  return Buffer.from(
    JSON.stringify({
      domain: ASSOCIATED_DATA_DOMAIN,
      payloadVersion: context.payloadVersion,
      submissionId: context.submissionId,
      intentId: context.intentId,
      requestDigest: context.requestDigest,
      adapterVersion: context.adapterVersion,
      senderAddress: context.senderAddress,
      nonce: context.nonce,
      transactionReference: context.transactionReference,
    }),
    "utf8",
  );
}

function encryptedPayload(
  value: EncryptedPreparedPayoutPayload,
  maximumPlaintextBytes: number,
): EncryptedPreparedPayoutPayload {
  if (
    typeof value !== "object" ||
    value === null ||
    value.algorithm !== "A256GCM" ||
    typeof value.keyId !== "string" ||
    typeof value.initializationVector !== "string" ||
    typeof value.ciphertext !== "string" ||
    typeof value.authenticationTag !== "string" ||
    !KEY_ID_PATTERN.test(value.keyId) ||
    !BASE64URL_PATTERN.test(value.initializationVector) ||
    !BASE64URL_PATTERN.test(value.ciphertext) ||
    !BASE64URL_PATTERN.test(value.authenticationTag) ||
    Buffer.byteLength(value.ciphertext, "base64url") > maximumPlaintextBytes + 32 ||
    Buffer.byteLength(value.initializationVector, "base64url") !== INITIALIZATION_VECTOR_BYTES ||
    Buffer.byteLength(value.authenticationTag, "base64url") !== AUTHENTICATION_TAG_BYTES
  ) {
    throw new PreparedPayoutCipherError(
      "decryption_failure",
      "Prepared payout encryption envelope is invalid",
    );
  }
  return { ...value };
}

function encryptionKeyId(value: unknown): string {
  if (typeof value !== "string" || !KEY_ID_PATTERN.test(value)) {
    throw invalidKey();
  }
  return value;
}

function encryptionKey(value: unknown): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== ENCRYPTION_KEY_BYTES) {
    throw invalidKey();
  }
  return Buffer.from(value);
}

function validatedInitializationVector(value: unknown): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== INITIALIZATION_VECTOR_BYTES) {
    throw new PreparedPayoutCipherError(
      "encryption_failure",
      "Prepared payout initialization vector is invalid",
    );
  }
  return Buffer.from(value);
}

function invalidKey(): PreparedPayoutCipherError {
  return new PreparedPayoutCipherError(
    "invalid_key",
    "Prepared payout encryption key is unavailable or invalid",
  );
}

const ALGORITHM = "aes-256-gcm";
const ASSOCIATED_DATA_DOMAIN = "cashu-strk20/prepared-payout/a256gcm/v1";
const ENCRYPTION_KEY_BYTES = 32;
const INITIALIZATION_VECTOR_BYTES = 12;
const AUTHENTICATION_TAG_BYTES = 16;
const MAXIMUM_PLAINTEXT_BYTES = 3 * 1024 * 1024;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
