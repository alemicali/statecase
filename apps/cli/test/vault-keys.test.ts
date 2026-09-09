import { describe, expect, it } from "vitest";
import { createDeviceExchangeKeyPair, randomKey, sealVaultKeyForDevice } from "@statecase/crypto";

import { decodeVaultKeyring, encodeVaultKeyring, refreshVaultKeyring, wipeVaultKeyring, withVaultKeyring } from "../src/vault-keys.js";

describe("vault key ownership and history ingestion (CR-007, CR-009, CR-010)", () => {
  it.each([false, true])("releases command key ownership after success or early failure (%s)", async (fails) => {
    let captured: Parameters<typeof encodeVaultKeyring>[0] | undefined;
    const promise = withVaultKeyring({ version: 1, vaultKeys: { vault: Buffer.alloc(32, 7).toString("base64url") } }, "vault", async (keyring) => {
      captured = keyring;
      expect(keyring.keys[1]!.some((byte) => byte !== 0)).toBe(true);
      if (fails) throw new Error("early failure");
      return 42;
    });
    if (fails) await expect(promise).rejects.toThrow("early failure");
    else await expect(promise).resolves.toBe(42);
    expect(captured!.keys[1]!.every((byte) => byte === 0)).toBe(true);
  });
  it("loads canonical legacy and historical keyrings and wipes caller-owned buffers", () => {
    const root = Buffer.alloc(32, 1).toString("base64url");
    const current = Buffer.alloc(32, 2).toString("base64url");
    const legacy = decodeVaultKeyring({ version: 1, vaultKeys: { vault: root } }, "vault");
    expect(encodeVaultKeyring(legacy)).toEqual({ currentEpoch: 1, keys: { 1: root } });
    const full = decodeVaultKeyring({ version: 1, vaultKeys: {}, vaultKeyrings: { vault: { currentEpoch: 2, keys: { 1: root, 2: current } } } }, "vault");
    expect(encodeVaultKeyring(full)).toEqual({ currentEpoch: 2, keys: { 1: root, 2: current } });
    wipeVaultKeyring(full);
    expect(Object.values(full.keys).every((key) => key.every((byte) => byte === 0))).toBe(true);
    expect(() => decodeVaultKeyring({ version: 1, vaultKeys: {} }, "vault")).toThrow("unavailable");
    const invalidKeys: Record<string, string>[] = [{ 1: "bad" }, { 1: root, "02": current }, { 1: root, 3: current }];
    for (const keys of invalidKeys) {
      expect(() => decodeVaultKeyring({ version: 1, vaultKeys: {}, vaultKeyrings: { vault: { currentEpoch: 2, keys } } }, "vault")).toThrow("invalid");
    }
    expect(() => decodeVaultKeyring({ version: 1, vaultKeys: { vault: "bad" } }, "vault")).toThrow("invalid");
    expect(() => decodeVaultKeyring({ version: 1, vaultKeys: { vault: `${root}=` } }, "vault")).toThrow("invalid");
    expect(() => decodeVaultKeyring({ version: 1, vaultKeys: {}, vaultKeyrings: { vault: { currentEpoch: 0, keys: {} } } }, "vault")).toThrow("invalid");
  });

  it("ingests several offline epochs and persists exactly one complete keyring", async () => {
    const deviceExchange = await createDeviceExchangeKeyPair();
    const roots = [await randomKey(), await randomKey(), await randomKey()];
    const keyring = { currentEpoch: 1, keys: { 1: roots[0]! } };
    const envelopes = await Promise.all([2, 3].map(async (keyEpoch) => ({ keyEpoch, envelope: await sealVaultKeyForDevice({
      vaultId: "vlt_test", deviceId: "dev_test", keyEpoch, vaultKey: roots[keyEpoch - 1]!, recipientPublicKey: deviceExchange.publicKey,
    }) })));
    const persisted: unknown[] = [];
    const refreshed = await refreshVaultKeyring({ keyring, vaultId: "vlt_test", deviceId: "dev_test", deviceExchange,
      readHistory: async () => ({ keyEpoch: 3, envelopes }), persist: async (value) => { persisted.push(encodeVaultKeyring(value)); } });
    expect(refreshed.currentEpoch).toBe(3);
    expect(refreshed.keys[2]).toEqual(roots[1]);
    expect(refreshed.keys[3]).toEqual(roots[2]);
    expect(persisted).toEqual([encodeVaultKeyring(refreshed)]);
    expect(keyring.currentEpoch).toBe(1);
    expect(await refreshVaultKeyring({ keyring: refreshed, vaultId: "vlt_test", deviceId: "dev_test", deviceExchange,
      readHistory: async () => ({ keyEpoch: 3, envelopes: [] }), persist: async () => { throw new Error("no-op must not persist"); } })).toBe(refreshed);
    wipeVaultKeyring(refreshed);
  });

  it.each(["gap", "truncated", "forged", "regression", "malformed", "network", "persistence"])("fails atomically and wipes owned keys after %s failure", async (failure) => {
    const deviceExchange = await createDeviceExchangeKeyPair();
    const keyring = { currentEpoch: 1, keys: { 1: await randomKey() } };
    const second = await randomKey();
    const envelope = await sealVaultKeyForDevice({ vaultId: "vlt_test", deviceId: "dev_test", keyEpoch: 2,
      vaultKey: second, recipientPublicKey: deviceExchange.publicKey });
    let persisted: Parameters<typeof encodeVaultKeyring>[0] | undefined;
    await expect(refreshVaultKeyring({ keyring, vaultId: "vlt_test", deviceId: "dev_test", deviceExchange,
      readHistory: async () => {
        if (failure === "network") throw new Error("network fixture failure");
        if (failure === "malformed") return null;
        if (failure === "regression") return { keyEpoch: 0, envelopes: [] };
        if (failure === "gap") return { keyEpoch: 3, envelopes: [{ keyEpoch: 3, envelope }] };
        if (failure === "truncated") return { keyEpoch: 3, envelopes: [{ keyEpoch: 2, envelope }] };
        if (failure === "forged") return { keyEpoch: 3, envelopes: [{ keyEpoch: 2, envelope }, { keyEpoch: 3, envelope }] };
        return { keyEpoch: 2, envelopes: [{ keyEpoch: 2, envelope }] };
      },
      persist: async (value) => { persisted = value; throw new Error("persistence fixture failure"); },
    })).rejects.toThrow();
    expect(keyring.currentEpoch).toBe(1);
    expect(Object.keys(keyring.keys)).toEqual(["1"]);
    expect(keyring.keys[1].every((byte) => byte === 0)).toBe(true);
    if (failure === "persistence") {
      expect(persisted?.currentEpoch).toBe(2);
      expect(Object.values(persisted!.keys).every((key) => key.every((byte) => byte === 0))).toBe(true);
    } else expect(persisted).toBeUndefined();
  });
});
