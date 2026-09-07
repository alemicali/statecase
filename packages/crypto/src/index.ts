import sodium from "libsodium-wrappers-sumo";

import { canonicalJson } from "@statecase/protocol";

const MAGIC = Uint8Array.of(0x53, 0x54, 0x43, 0x01);
const HEADER_PREFIX_LENGTH = 8;
const KEY_LENGTH = 32;
const NONCE_LENGTH = 24;
const TAG_LENGTH = 16;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export type Compression = "none" | "zstd";

export interface EnvelopeContext {
  vaultId: string;
  scopeId: string;
  compression: Compression;
}

interface EnvelopeHeaderV1 extends EnvelopeContext {
  version: 1;
  algorithm: "xchacha20-poly1305-ietf";
  objectId: string;
  plaintextLength: number;
}

export type CryptoFailureCode =
  | "MALFORMED_ENVELOPE"
  | "CONTEXT_MISMATCH"
  | "AUTHENTICATION_FAILED"
  | "NONCE_REUSE";

export class CryptoFailure extends Error {
  readonly code: CryptoFailureCode;

  constructor(code: CryptoFailureCode, message: string) {
    super(message);
    this.name = "CryptoFailure";
    this.code = code;
  }

  toJSON(): { code: CryptoFailureCode; message: string } {
    return { code: this.code, message: this.message };
  }
}

export class NonceRegistry {
  readonly #seen = new Set<string>();

  claim(token: string): void {
    if (this.#seen.has(token)) throw new CryptoFailure("NONCE_REUSE", "encryption nonce was already used");
    this.#seen.add(token);
  }
}

export interface ScopeKeys {
  encryptionKey: Uint8Array;
  dedupKey: Uint8Array;
}

export async function randomKey(): Promise<Uint8Array> {
  await sodium.ready;
  return sodium.randombytes_buf(KEY_LENGTH);
}

export async function deriveScopeKey(rootKey: Uint8Array, scope: string): Promise<ScopeKeys> {
  await sodium.ready;
  requireKey(rootKey, "root key");
  if (scope.length === 0) throw new TypeError("scope is required");
  return {
    encryptionKey: derive(rootKey, `statecase:v1:scope:encryption:${scope}`),
    dedupKey: derive(rootKey, `statecase:v1:scope:dedup:${scope}`),
  };
}

export async function deriveRecoveryKey(
  passphrase: string,
  salt: Uint8Array,
  limits: { operations?: number; memory?: number } = {},
): Promise<Uint8Array> {
  await sodium.ready;
  if (passphrase.length === 0) throw new TypeError("recovery passphrase is required");
  if (salt.byteLength !== sodium.crypto_pwhash_SALTBYTES) throw new TypeError("invalid recovery salt length");
  return sodium.crypto_pwhash(
    KEY_LENGTH,
    passphrase,
    salt,
    limits.operations ?? sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    limits.memory ?? sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}

export async function computeObjectId(dedupKey: Uint8Array, plaintext: Uint8Array): Promise<string> {
  await sodium.ready;
  requireKey(dedupKey, "dedup key");
  const domain = encoder.encode("statecase:object:v1\0");
  const input = concat(domain, plaintext);
  const digest = sodium.crypto_generichash(32, input, dedupKey);
  return `obj_${sodium.to_base64(digest, sodium.base64_variants.URLSAFE_NO_PADDING)}`;
}

export async function computeObjectIdStream(
  dedupKey: Uint8Array,
  plaintext: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
): Promise<string> {
  await sodium.ready;
  requireKey(dedupKey, "dedup key");
  const state = sodium.crypto_generichash_init(dedupKey, 32);
  sodium.crypto_generichash_update(state, encoder.encode("statecase:object:v1\0"));
  for await (const chunk of plaintext) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError("plaintext stream must yield Uint8Array chunks");
    if (chunk.byteLength > 0) sodium.crypto_generichash_update(state, chunk);
  }
  const digest = sodium.crypto_generichash_final(state, 32);
  return `obj_${sodium.to_base64(digest, sodium.base64_variants.URLSAFE_NO_PADDING)}`;
}

export async function encryptEnvelope(input: {
  plaintext: Uint8Array;
  key: Uint8Array;
  dedupKey: Uint8Array;
  context: EnvelopeContext;
  nonceSource?: () => Uint8Array;
  nonceRegistry?: NonceRegistry;
}): Promise<Uint8Array> {
  await sodium.ready;
  requireKey(input.key, "encryption key");
  validateContext(input.context);
  const objectId = await computeObjectId(input.dedupKey, input.plaintext);
  const header: EnvelopeHeaderV1 = {
    algorithm: "xchacha20-poly1305-ietf",
    compression: input.context.compression,
    objectId,
    plaintextLength: input.plaintext.byteLength,
    scopeId: input.context.scopeId,
    vaultId: input.context.vaultId,
    version: 1,
  };
  const headerBytes = encoder.encode(canonicalJson(header));
  const nonce = (input.nonceSource ?? (() => sodium.randombytes_buf(NONCE_LENGTH)))();
  if (nonce.byteLength !== NONCE_LENGTH) throw new TypeError("nonce source returned an invalid length");
  if (input.nonceRegistry) input.nonceRegistry.claim(nonceToken(input.key, nonce));
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    input.plaintext,
    headerBytes,
    null,
    nonce,
    input.key,
  );

  const output = new Uint8Array(HEADER_PREFIX_LENGTH + headerBytes.byteLength + nonce.byteLength + ciphertext.byteLength);
  output.set(MAGIC, 0);
  new DataView(output.buffer, output.byteOffset, output.byteLength).setUint32(4, headerBytes.byteLength, false);
  output.set(headerBytes, HEADER_PREFIX_LENGTH);
  output.set(nonce, HEADER_PREFIX_LENGTH + headerBytes.byteLength);
  output.set(ciphertext, HEADER_PREFIX_LENGTH + headerBytes.byteLength + nonce.byteLength);
  return output;
}

export async function decryptEnvelope(input: {
  envelope: Uint8Array;
  key: Uint8Array;
  dedupKey: Uint8Array;
  expected: EnvelopeContext;
}): Promise<Uint8Array> {
  await sodium.ready;
  requireKey(input.key, "encryption key");
  validateContext(input.expected);
  const parsed = parseEnvelope(input.envelope);
  if (
    parsed.header.vaultId !== input.expected.vaultId ||
    parsed.header.scopeId !== input.expected.scopeId ||
    parsed.header.compression !== input.expected.compression
  ) {
    throw new CryptoFailure("CONTEXT_MISMATCH", "encrypted object context does not match the requested scope");
  }

  let plaintext: Uint8Array;
  try {
    plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      parsed.ciphertext,
      parsed.headerBytes,
      parsed.nonce,
      input.key,
    );
  } catch {
    throw new CryptoFailure("AUTHENTICATION_FAILED", "encrypted object authentication failed");
  }
  if (plaintext.byteLength !== parsed.header.plaintextLength) {
    throw new CryptoFailure("AUTHENTICATION_FAILED", "encrypted object authentication failed");
  }
  const objectId = await computeObjectId(input.dedupKey, plaintext);
  if (objectId !== parsed.header.objectId) {
    throw new CryptoFailure("AUTHENTICATION_FAILED", "encrypted object authentication failed");
  }
  return plaintext;
}

function derive(rootKey: Uint8Array, context: string): Uint8Array {
  return sodium.crypto_generichash(KEY_LENGTH, encoder.encode(context), rootKey);
}

function nonceToken(key: Uint8Array, nonce: Uint8Array): string {
  const digest = sodium.crypto_generichash(16, nonce, key);
  return sodium.to_base64(digest, sodium.base64_variants.URLSAFE_NO_PADDING);
}

function parseEnvelope(envelope: Uint8Array): {
  header: EnvelopeHeaderV1;
  headerBytes: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
} {
  if (envelope.byteLength < HEADER_PREFIX_LENGTH + NONCE_LENGTH + TAG_LENGTH) malformed();
  if (!MAGIC.every((byte, index) => envelope[index] === byte)) malformed();
  const headerLength = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength).getUint32(4, false);
  const nonceOffset = HEADER_PREFIX_LENGTH + headerLength;
  const ciphertextOffset = nonceOffset + NONCE_LENGTH;
  if (headerLength === 0 || headerLength > 64 * 1024 || ciphertextOffset + TAG_LENGTH > envelope.byteLength) malformed();

  const headerBytes = envelope.slice(HEADER_PREFIX_LENGTH, nonceOffset);
  let unknown: unknown;
  try {
    unknown = JSON.parse(decoder.decode(headerBytes)) as unknown;
  } catch {
    malformed();
  }
  const header = requireHeader(unknown);
  if (canonicalJson(header) !== decoder.decode(headerBytes)) malformed();
  return {
    header,
    headerBytes,
    nonce: envelope.slice(nonceOffset, ciphertextOffset),
    ciphertext: envelope.slice(ciphertextOffset),
  };
}

function requireHeader(value: unknown): EnvelopeHeaderV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) malformed();
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "algorithm",
    "compression",
    "objectId",
    "plaintextLength",
    "scopeId",
    "vaultId",
    "version",
  ];
  if (Object.keys(record).sort().join("\0") !== expectedKeys.join("\0")) malformed();
  if (
    record.version !== 1 ||
    record.algorithm !== "xchacha20-poly1305-ietf" ||
    (record.compression !== "none" && record.compression !== "zstd") ||
    typeof record.objectId !== "string" ||
    !record.objectId.startsWith("obj_") ||
    typeof record.plaintextLength !== "number" ||
    !Number.isSafeInteger(record.plaintextLength) ||
    record.plaintextLength < 0 ||
    typeof record.scopeId !== "string" ||
    typeof record.vaultId !== "string"
  ) malformed();
  return record as unknown as EnvelopeHeaderV1;
}

function validateContext(context: EnvelopeContext): void {
  if (context.vaultId.length === 0 || context.scopeId.length === 0) throw new TypeError("vault and scope IDs are required");
  if (context.compression !== "none" && context.compression !== "zstd") throw new TypeError("unsupported compression");
}

function requireKey(key: Uint8Array, name: string): void {
  if (key.byteLength !== KEY_LENGTH) throw new TypeError(`${name} must be 32 bytes`);
}

function malformed(): never {
  throw new CryptoFailure("MALFORMED_ENVELOPE", "encrypted object envelope is malformed or unsupported");
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left, 0);
  output.set(right, left.byteLength);
  return output;
}
