import { openVaultKeyEnvelope } from "@statecase/crypto";
import { z } from "zod";

import type { LocalSecrets } from "./config.js";
import { StatecaseUsageError } from "./runtime.js";
import type { VaultKeyring } from "./sync.js";

const epoch = z.number().int().positive().max(1_000);
const storedKeyring = z.object({ currentEpoch: epoch, keys: z.record(z.string(), z.string()) }).strict();
const historySchema = z.object({
  keyEpoch: epoch,
  envelopes: z.array(z.object({ keyEpoch: epoch, envelope: z.string().min(1).max(128 * 1024) }).strict()).max(1_000),
}).strict();

/** Returns owned key buffers. A failed decode wipes every buffer it allocated. */
export function decodeVaultKeyring(secrets: LocalSecrets, vaultId: string): VaultKeyring {
  const stored = secrets.vaultKeyrings?.[vaultId];
  const legacy = secrets.vaultKeys[vaultId];
  if (!stored && !legacy) throw new StatecaseUsageError("selected vault key is unavailable", 2);
  const parsed = storedKeyring.safeParse(stored ?? { currentEpoch: 1, keys: { 1: legacy } });
  if (!parsed.success) throw new StatecaseUsageError("stored vault keyring is invalid", 6);
  const result: VaultKeyring = { currentEpoch: parsed.data.currentEpoch, keys: {} };
  try {
    const entries = Object.entries(parsed.data.keys);
    if (entries.length !== result.currentEpoch) throw new StatecaseUsageError("stored vault keyring is invalid or incomplete", 6);
    for (const [label, encoded] of entries) {
      const keyEpoch = Number(label);
      if (!/^[1-9]\d*$/u.test(label) || !Number.isSafeInteger(keyEpoch) || keyEpoch > result.currentEpoch) {
        throw new StatecaseUsageError("stored vault keyring is invalid", 6);
      }
      const key = Buffer.from(encoded, "base64url");
      result.keys[keyEpoch] = key;
      if (key.byteLength !== 32 || key.toString("base64url") !== encoded) throw new StatecaseUsageError("stored vault key is invalid", 6);
    }
    return result;
  } catch (error) {
    wipeVaultKeyring(result);
    throw error;
  }
}

export function encodeVaultKeyring(keyring: VaultKeyring): { currentEpoch: number; keys: Record<string, string> } {
  return { currentEpoch: keyring.currentEpoch,
    keys: Object.fromEntries(Object.entries(keyring.keys).map(([keyEpoch, key]) => [keyEpoch, Buffer.from(key).toString("base64url")])),
  };
}

export function wipeVaultKeyring(keyring: VaultKeyring): void {
  for (const key of Object.values(keyring.keys)) key.fill(0);
}

export async function withVaultKeyring<T>(secrets: LocalSecrets, vaultId: string, operation: (keyring: VaultKeyring) => Promise<T>): Promise<T> {
  const keyring = decodeVaultKeyring(secrets, vaultId);
  try {
    return await operation(keyring);
  } finally {
    wipeVaultKeyring(keyring);
  }
}

/** Takes ownership of keyring buffers. Persists once, after authenticating the
 * entire contiguous history. On any failure, all old and newly opened buffers
 * are wiped; the input epoch and key map are never partially advanced. */
export async function refreshVaultKeyring(input: {
  keyring: VaultKeyring;
  vaultId: string;
  deviceId: string;
  deviceExchange: { publicKey: string; privateKey: string };
  readHistory(): Promise<unknown>;
  persist(keyring: VaultKeyring): Promise<void>;
}): Promise<VaultKeyring> {
  const candidate = { currentEpoch: input.keyring.currentEpoch, keys: { ...input.keyring.keys } };
  try {
    const parsed = historySchema.safeParse(await input.readHistory());
    if (!parsed.success) throw new StatecaseUsageError("vault key history is invalid", 6);
    const history = parsed.data;
    let expectedEpoch = input.keyring.currentEpoch + 1;
    for (const item of history.envelopes) {
      if (item.keyEpoch !== expectedEpoch) throw new StatecaseUsageError("vault key history is incomplete on this device", 6);
      candidate.keys[item.keyEpoch] = await openVaultKeyEnvelope({
        envelope: item.envelope, expectedVaultId: input.vaultId, expectedKeyEpoch: item.keyEpoch,
        expectedDeviceId: input.deviceId, recipientPublicKey: input.deviceExchange.publicKey,
        recipientPrivateKey: input.deviceExchange.privateKey,
      });
      candidate.currentEpoch = item.keyEpoch;
      expectedEpoch += 1;
    }
    if (candidate.currentEpoch !== history.keyEpoch) throw new StatecaseUsageError("vault key history is incomplete on this device", 6);
    if (history.envelopes.length === 0) return input.keyring;
    await input.persist(candidate);
    return candidate;
  } catch (error) {
    wipeVaultKeyring(candidate);
    throw error;
  }
}
