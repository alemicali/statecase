import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { decryptEnvelope, deriveRecoveryKey, encryptEnvelope } from "@statecase/crypto";
import { canonicalJson } from "@statecase/protocol";

interface RecoveryKitV1 {
  version: 1;
  vaultId: string;
  salt: string;
  envelope: string;
}

interface RecoveryKitV2 {
  version: 2;
  vaultId: string;
  salt: string;
  envelope: string;
}

export interface RecoveryKeyring {
  currentEpoch: number;
  keys: Record<number, Uint8Array>;
}

export async function writeRecoveryKit(path: string, vaultId: string, vaultKey: Uint8Array, passphrase: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const salt = randomBytes(16);
  const recoveryKey = await deriveRecoveryKey(passphrase, salt);
  try {
    const envelope = await encryptEnvelope({
      plaintext: vaultKey,
      key: recoveryKey,
      dedupKey: recoveryKey,
      context: { vaultId, scopeId: "recovery-kit", compression: "none" },
    });
    const kit: RecoveryKitV1 = {
      version: 1,
      vaultId,
      salt: Buffer.from(salt).toString("base64url"),
      envelope: Buffer.from(envelope).toString("base64url"),
    };
    await writeFile(path, `${JSON.stringify(kit, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(path, 0o600);
  } finally {
    recoveryKey.fill(0);
  }
}

export async function readRecoveryKit(path: string, expectedVaultId: string, passphrase: string): Promise<Uint8Array> {
  const raw = JSON.parse(await readFile(path, "utf8")) as Partial<RecoveryKitV1 | RecoveryKitV2>;
  if (raw.version === 2) {
    const keyring = await readRecoveryKeyringKit(path, expectedVaultId, passphrase);
    const current = keyring.keys[keyring.currentEpoch]!;
    for (const [epoch, key] of Object.entries(keyring.keys)) if (Number(epoch) !== keyring.currentEpoch) key.fill(0);
    return current;
  }
  const parsed = raw as Partial<RecoveryKitV1>;
  if (parsed.version !== 1 || parsed.vaultId !== expectedVaultId || !parsed.salt || !parsed.envelope) {
    throw new Error("recovery kit does not match the selected vault");
  }
  const recoveryKey = await deriveRecoveryKey(passphrase, Buffer.from(parsed.salt, "base64url"));
  try {
    return await decryptEnvelope({
      envelope: Buffer.from(parsed.envelope, "base64url"),
      key: recoveryKey,
      dedupKey: recoveryKey,
      expected: { vaultId: expectedVaultId, scopeId: "recovery-kit", compression: "none" },
    });
  } finally {
    recoveryKey.fill(0);
  }
}

export async function writeRecoveryKeyringKit(
  path: string,
  vaultId: string,
  keyring: RecoveryKeyring,
  passphrase: string,
): Promise<void> {
  const encoded = encodeKeyring(keyring);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const salt = randomBytes(16);
  const recoveryKey = await deriveRecoveryKey(passphrase, salt);
  const plaintext = new TextEncoder().encode(canonicalJson(encoded));
  try {
    const envelope = await encryptEnvelope({
      plaintext,
      key: recoveryKey,
      dedupKey: recoveryKey,
      context: { vaultId, scopeId: "recovery-keyring", compression: "none" },
    });
    const kit: RecoveryKitV2 = {
      version: 2,
      vaultId,
      salt: Buffer.from(salt).toString("base64url"),
      envelope: Buffer.from(envelope).toString("base64url"),
    };
    await writeFile(path, `${JSON.stringify(kit, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(path, 0o600);
  } finally {
    plaintext.fill(0);
    recoveryKey.fill(0);
  }
}

export async function readRecoveryKeyringKit(path: string, expectedVaultId: string, passphrase: string): Promise<RecoveryKeyring> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<RecoveryKitV1 | RecoveryKitV2>;
  if (parsed.vaultId !== expectedVaultId || !parsed.salt || !parsed.envelope || (parsed.version !== 1 && parsed.version !== 2)) {
    throw new Error("recovery kit does not match the selected vault");
  }
  if (parsed.version === 1) {
    const key = await readRecoveryKitV1(parsed, expectedVaultId, passphrase);
    return { currentEpoch: 1, keys: { 1: key } };
  }
  const recoveryKey = await deriveRecoveryKey(passphrase, Buffer.from(parsed.salt, "base64url"));
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = await decryptEnvelope({
      envelope: Buffer.from(parsed.envelope, "base64url"),
      key: recoveryKey,
      dedupKey: recoveryKey,
      expected: { vaultId: expectedVaultId, scopeId: "recovery-keyring", compression: "none" },
    });
    return decodeKeyring(JSON.parse(new TextDecoder("utf8", { fatal: true, ignoreBOM: false }).decode(plaintext)) as unknown);
  } finally {
    plaintext?.fill(0);
    recoveryKey.fill(0);
  }
}

async function readRecoveryKitV1(parsed: Partial<RecoveryKitV1>, expectedVaultId: string, passphrase: string): Promise<Uint8Array> {
  const recoveryKey = await deriveRecoveryKey(passphrase, Buffer.from(parsed.salt!, "base64url"));
  try {
    return await decryptEnvelope({
      envelope: Buffer.from(parsed.envelope!, "base64url"),
      key: recoveryKey,
      dedupKey: recoveryKey,
      expected: { vaultId: expectedVaultId, scopeId: "recovery-kit", compression: "none" },
    });
  } finally {
    recoveryKey.fill(0);
  }
}

function encodeKeyring(keyring: RecoveryKeyring): { version: 1; currentEpoch: number; keys: Record<string, string> } {
  if (!Number.isSafeInteger(keyring.currentEpoch) || keyring.currentEpoch < 1 || keyring.keys[keyring.currentEpoch]?.byteLength !== 32) {
    throw new TypeError("recovery keyring current epoch is invalid or unavailable");
  }
  const entries = Object.entries(keyring.keys);
  if (entries.length === 0 || entries.length > 1_000) throw new TypeError("recovery keyring size is invalid");
  const keys: Record<string, string> = {};
  for (const [epoch, key] of entries.sort(([left], [right]) => Number(left) - Number(right))) {
    if (!/^\d+$/u.test(epoch) || Number(epoch) < 1 || key.byteLength !== 32) throw new TypeError("recovery keyring contains an invalid epoch");
    keys[epoch] = Buffer.from(key).toString("base64url");
  }
  return { version: 1, currentEpoch: keyring.currentEpoch, keys };
}

function decodeKeyring(value: unknown): RecoveryKeyring {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("recovery keyring is malformed");
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Number.isSafeInteger(record.currentEpoch) || (record.currentEpoch as number) < 1 ||
      !record.keys || typeof record.keys !== "object" || Array.isArray(record.keys) ||
      Object.keys(record).sort().join("\0") !== "currentEpoch\0keys\0version") throw new Error("recovery keyring is malformed");
  const encoded = record.keys as Record<string, unknown>;
  if (Object.keys(encoded).length === 0 || Object.keys(encoded).length > 1_000) throw new Error("recovery keyring is malformed");
  const keys: Record<number, Uint8Array> = {};
  for (const [epoch, key] of Object.entries(encoded)) {
    if (!/^\d+$/u.test(epoch) || Number(epoch) < 1 || typeof key !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(key)) {
      throw new Error("recovery keyring is malformed");
    }
    const decoded = Buffer.from(key, "base64url");
    if (decoded.byteLength !== 32) throw new Error("recovery keyring is malformed");
    keys[Number(epoch)] = new Uint8Array(decoded);
  }
  const currentEpoch = record.currentEpoch as number;
  if (!keys[currentEpoch]) throw new Error("recovery keyring current epoch is unavailable");
  return { currentEpoch, keys };
}
