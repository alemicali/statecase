import { describe, expect, it } from "vitest";
import sodium from "libsodium-wrappers-sumo";

import { canonicalJson } from "@statecase/protocol";

import {
  CryptoFailure,
  NonceRegistry,
  computeObjectId,
  computeObjectIdStream,
  createDeviceExchangeKeyPair,
  decryptEnvelope,
  deriveScopeKey,
  deriveRecoveryKey,
  encryptEnvelope,
  openVaultKeyEnvelope,
  randomKey,
  sealVaultKeyForDevice,
} from "../src/index.js";

const context = {
  vaultId: "vlt_test",
  scopeId: "workspace_test",
  compression: "none" as const,
};

describe("object identity (CR-005)", () => {
  it("is deterministic in a scope and unlinkable across keys", async () => {
    const root = new Uint8Array(32).fill(7);
    const firstScope = await deriveScopeKey(root, "scope:a");
    const secondScope = await deriveScopeKey(root, "scope:b");
    const plaintext = new TextEncoder().encode("portable state");

    expect(await computeObjectId(firstScope.dedupKey, plaintext)).toBe(
      await computeObjectId(firstScope.dedupKey, plaintext),
    );
    expect(await computeObjectId(firstScope.dedupKey, plaintext)).not.toBe(
      await computeObjectId(secondScope.dedupKey, plaintext),
    );
  });

  it("validates root/dedup keys and scope labels", async () => {
    await expect(deriveScopeKey(new Uint8Array(31), "scope")).rejects.toThrow("32 bytes");
    await expect(deriveScopeKey(new Uint8Array(32), "")).rejects.toThrow("scope");
    await expect(computeObjectId(new Uint8Array(31), new Uint8Array())).rejects.toThrow("32 bytes");
  });

  it("computes the existing object identity incrementally across arbitrary stream boundaries", async () => {
    const dedupKey = new Uint8Array(32).fill(19);
    const plaintext = Uint8Array.from({ length: 16_419 }, (_, index) => (index * 37) % 251);
    const chunks = [
      plaintext.subarray(0, 1),
      plaintext.subarray(1, 4_097),
      new Uint8Array(),
      plaintext.subarray(4_097, 12_000),
      plaintext.subarray(12_000),
    ];

    expect(await computeObjectIdStream(dedupKey, chunks)).toBe(await computeObjectId(dedupKey, plaintext));
    expect(await computeObjectIdStream(dedupKey, asAsync(chunks))).toBe(await computeObjectId(dedupKey, plaintext));
    await expect(computeObjectIdStream(new Uint8Array(31), chunks)).rejects.toThrow("32 bytes");
  });
});

async function* asAsync(chunks: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}

describe("recovery derivation (CR-009)", () => {
  it("derives deterministic Argon2id keys with explicit test limits", async () => {
    await sodium.ready;
    const salt = new Uint8Array(sodium.crypto_pwhash_SALTBYTES).fill(3);
    const limits = {
      operations: sodium.crypto_pwhash_OPSLIMIT_MIN,
      memory: sodium.crypto_pwhash_MEMLIMIT_MIN,
    };
    expect(await deriveRecoveryKey("correct horse", salt, limits)).toEqual(
      await deriveRecoveryKey("correct horse", salt, limits),
    );
    await expect(deriveRecoveryKey("", salt, limits)).rejects.toThrow("passphrase");
    await expect(deriveRecoveryKey("valid", new Uint8Array(1), limits)).rejects.toThrow("salt");
  });
});

describe("device key exchange (CR-009, CR-010)", () => {
  it("rejects authenticated but malformed sealed payloads (CR-010)", async () => {
    const device = await createDeviceExchangeKeyPair();
    const publicKey = sodium.from_base64(device.publicKey.split(".")[1]!, sodium.base64_variants.URLSAFE_NO_PADDING);
    const valid = { version: 1, vaultId: "vlt_test", deviceId: "dev_test", keyEpoch: 2, vaultKey: "AA" };
    for (const payload of ["not-json", "null", JSON.stringify({ ...valid, version: 3 }), JSON.stringify(valid), JSON.stringify({ ...valid, vaultKey: "%%%" })]) {
      const ciphertext = sodium.crypto_box_seal(new TextEncoder().encode(payload), publicKey);
      const envelope = `stc_vault_key_v1.${sodium.to_base64(ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING)}`;
      await expect(openVaultKeyEnvelope({
        envelope,
        expectedVaultId: "vlt_test", expectedDeviceId: "dev_test", expectedKeyEpoch: 2,
        recipientPublicKey: device.publicKey, recipientPrivateKey: device.privateKey,
      })).rejects.toMatchObject({ code: "MALFORMED_KEY_ENVELOPE" });
    }
  });

  it("seals a vault-key epoch to exactly one device exchange identity", async () => {
    const intended = await createDeviceExchangeKeyPair();
    const revoked = await createDeviceExchangeKeyPair();
    const vaultKey = new Uint8Array(32).fill(41);
    const envelope = await sealVaultKeyForDevice({
      vaultId: "vlt_test",
      keyEpoch: 2,
      deviceId: "dev_active",
      vaultKey,
      recipientPublicKey: intended.publicKey,
    });

    expect(envelope).toMatch(/^stc_vault_key_v1\.[A-Za-z0-9_-]+$/u);
    expect(envelope).not.toContain(Buffer.from(vaultKey).toString("base64url"));
    await expect(openVaultKeyEnvelope({
      envelope,
      expectedVaultId: "vlt_test",
      expectedKeyEpoch: 2,
      expectedDeviceId: "dev_active",
      recipientPublicKey: intended.publicKey,
      recipientPrivateKey: intended.privateKey,
    })).resolves.toEqual(vaultKey);
    await expect(openVaultKeyEnvelope({
      envelope,
      expectedVaultId: "vlt_test",
      expectedKeyEpoch: 2,
      expectedDeviceId: "dev_revoked",
      recipientPublicKey: revoked.publicKey,
      recipientPrivateKey: revoked.privateKey,
    })).rejects.toMatchObject({ code: "KEY_ENVELOPE_AUTHENTICATION_FAILED" });
  });

  it("binds vault, epoch, and device context and rejects malformed key material", async () => {
    const device = await createDeviceExchangeKeyPair();
    const envelope = await sealVaultKeyForDevice({
      vaultId: "vlt_test",
      keyEpoch: 7,
      deviceId: "dev_active",
      vaultKey: new Uint8Array(32).fill(7),
      recipientPublicKey: device.publicKey,
    });
    const common = {
      envelope,
      expectedVaultId: "vlt_test",
      expectedKeyEpoch: 7,
      expectedDeviceId: "dev_active",
      recipientPublicKey: device.publicKey,
      recipientPrivateKey: device.privateKey,
    };

    await expect(openVaultKeyEnvelope({ ...common, expectedVaultId: "vlt_other" })).rejects.toMatchObject({ code: "KEY_ENVELOPE_CONTEXT_MISMATCH" });
    await expect(openVaultKeyEnvelope({ ...common, expectedKeyEpoch: 8 })).rejects.toMatchObject({ code: "KEY_ENVELOPE_CONTEXT_MISMATCH" });
    await expect(openVaultKeyEnvelope({ ...common, expectedDeviceId: "dev_other" })).rejects.toMatchObject({ code: "KEY_ENVELOPE_CONTEXT_MISMATCH" });
    await expect(openVaultKeyEnvelope({ ...common, envelope: "not-an-envelope" })).rejects.toMatchObject({ code: "MALFORMED_KEY_ENVELOPE" });
    await expect(sealVaultKeyForDevice({
      vaultId: "vlt_test",
      keyEpoch: 1,
      deviceId: "dev_active",
      vaultKey: new Uint8Array(31),
      recipientPublicKey: device.publicKey,
    })).rejects.toThrow("32 bytes");
    await expect(openVaultKeyEnvelope({ ...common, recipientPrivateKey: "stc_x25519_private_v1.invalid" })).rejects.toMatchObject({ code: "MALFORMED_KEY_ENVELOPE" });
    await expect(sealVaultKeyForDevice({
      vaultId: "",
      keyEpoch: 1,
      deviceId: "dev_active",
      vaultKey: new Uint8Array(32),
      recipientPublicKey: device.publicKey,
    })).rejects.toThrow("vault and device IDs");
    await expect(sealVaultKeyForDevice({
      vaultId: "vlt_test",
      keyEpoch: 0,
      deviceId: "dev_active",
      vaultKey: new Uint8Array(32),
      recipientPublicKey: device.publicKey,
    })).rejects.toThrow("positive safe integer");
    await expect(sealVaultKeyForDevice({
      vaultId: "vlt_test",
      keyEpoch: Number.MAX_SAFE_INTEGER + 1,
      deviceId: "dev_active",
      vaultKey: new Uint8Array(32),
      recipientPublicKey: device.publicKey,
    })).rejects.toThrow("positive safe integer");
    await expect(sealVaultKeyForDevice({
      vaultId: "vlt_test",
      keyEpoch: 1,
      deviceId: "dev_active",
      vaultKey: new Uint8Array(32),
      recipientPublicKey: "stc_x25519_public_v1.invalid",
    })).rejects.toMatchObject({ code: "MALFORMED_KEY_ENVELOPE" });
  });
});

describe("v1 object envelope (CR-001..CR-008)", () => {
  it.each([new Uint8Array(), new Uint8Array([0]), new Uint8Array(4096).fill(123)])(
    "round-trips %s bytes",
    async (plaintext) => {
      const key = await randomKey();
      const dedupKey = await randomKey();
      const envelope = await encryptEnvelope({ plaintext, key, dedupKey, context });
      expect(await decryptEnvelope({ envelope, key, dedupKey, expected: context })).toEqual(plaintext);
    },
  );

  it("rejects ciphertext mutation and wrong scope without leaking content", async () => {
    const key = await randomKey();
    const dedupKey = await randomKey();
    const plaintext = new TextEncoder().encode("super-secret-canary");
    const envelope = await encryptEnvelope({ plaintext, key, dedupKey, context });
    const mutated = envelope.slice();
    mutated[mutated.length - 1] ^= 1;

    await expect(decryptEnvelope({ envelope: mutated, key, dedupKey, expected: context })).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
    await expect(
      decryptEnvelope({ envelope, key, dedupKey, expected: { ...context, scopeId: "other" } }),
    ).rejects.toBeInstanceOf(CryptoFailure);
    await expect(
      decryptEnvelope({ envelope, key, dedupKey, expected: { ...context, vaultId: "other" } }),
    ).rejects.toMatchObject({ code: "CONTEXT_MISMATCH" });
    await expect(
      decryptEnvelope({ envelope, key, dedupKey, expected: { ...context, compression: "zstd" } }),
    ).rejects.toMatchObject({ code: "CONTEXT_MISMATCH" });

    try {
      await decryptEnvelope({ envelope: mutated, key, dedupKey, expected: context });
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain("super-secret-canary");
      expect(String(error)).not.toContain(Buffer.from(key).toString("hex"));
    }
  });

  it("round-trips the recorded zstd classification", async () => {
    const key = await randomKey();
    const dedupKey = await randomKey();
    const compressedContext = { ...context, compression: "zstd" as const };
    const plaintext = Uint8Array.of(1, 2, 3);
    const envelope = await encryptEnvelope({ plaintext, key, dedupKey, context: compressedContext });
    expect(await decryptEnvelope({ envelope, key, dedupKey, expected: compressedContext })).toEqual(plaintext);
  });

  it("detects nonce reuse before encryption", async () => {
    const nonce = new Uint8Array(24).fill(9);
    const registry = new NonceRegistry();
    const key = await randomKey();
    const dedupKey = await randomKey();
    const plaintext = new Uint8Array([1]);
    const nonceSource = () => nonce;

    await encryptEnvelope({ plaintext, key, dedupKey, context, nonceSource, nonceRegistry: registry });
    await expect(
      encryptEnvelope({ plaintext, key, dedupKey, context, nonceSource, nonceRegistry: registry }),
    ).rejects.toMatchObject({ code: "NONCE_REUSE" });
  });

  it("rejects invalid keys, contexts, and nonce sources", async () => {
    const key = await randomKey();
    const plaintext = new Uint8Array();
    await expect(encryptEnvelope({ plaintext, key: new Uint8Array(1), dedupKey: key, context })).rejects.toThrow("32 bytes");
    await expect(encryptEnvelope({ plaintext, key, dedupKey: key, context: { ...context, vaultId: "" } })).rejects.toThrow(
      "required",
    );
    await expect(
      encryptEnvelope({ plaintext, key, dedupKey: key, context: { ...context, scopeId: "" } }),
    ).rejects.toThrow("required");
    await expect(
      encryptEnvelope({
        plaintext,
        key,
        dedupKey: key,
        context: { ...context, compression: "invalid" as "none" },
      }),
    ).rejects.toThrow("compression");
    await expect(
      encryptEnvelope({ plaintext, key, dedupKey: key, context, nonceSource: () => new Uint8Array(2) }),
    ).rejects.toThrow("nonce");
    await expect(decryptEnvelope({ envelope: new Uint8Array(), key: new Uint8Array(1), dedupKey: key, expected: context })).rejects.toThrow(
      "32 bytes",
    );
  });

  it.each([
    new Uint8Array(),
    Uint8Array.of(0x00, 0x54, 0x43, 0x01, 0, 0, 0, 1, 0, ...new Uint8Array(40)),
    Uint8Array.of(0x53, 0x54, 0x43, 0x01, 0, 0, 0, 0, ...new Uint8Array(40)),
    Uint8Array.of(0x53, 0x54, 0x43, 0x01, 0, 1, 0, 1, ...new Uint8Array(40)),
    rawEnvelope(new TextEncoder().encode("not-json")),
    rawEnvelope(Uint8Array.of(0xff)),
    rawEnvelope(new TextEncoder().encode("null")),
    rawEnvelope(new TextEncoder().encode("[]")),
    rawEnvelope(new TextEncoder().encode('{ "version": 1 }')),
  ])("rejects malformed envelope fixture %#", async (envelope) => {
    const key = await randomKey();
    await expect(decryptEnvelope({ envelope, key, dedupKey: key, expected: context })).rejects.toMatchObject({
      code: "MALFORMED_ENVELOPE",
    });
  });

  it.each([
    { version: 2 },
    { algorithm: "other" },
    { compression: "other" },
    { objectId: 1 },
    { objectId: "wrong" },
    { plaintextLength: "1" },
    { plaintextLength: 1.5 },
    { plaintextLength: -1 },
    { scopeId: 1 },
    { vaultId: 1 },
  ])("rejects invalid authenticated-header shape $version$algorithm$compression", async (change) => {
    const header = {
      algorithm: "xchacha20-poly1305-ietf",
      compression: "none",
      objectId: "obj_valid",
      plaintextLength: 0,
      scopeId: context.scopeId,
      vaultId: context.vaultId,
      version: 1,
      ...change,
    };
    const key = await randomKey();
    await expect(
      decryptEnvelope({
        envelope: rawEnvelope(new TextEncoder().encode(canonicalJson(header))),
        key,
        dedupKey: key,
        expected: context,
      }),
    ).rejects.toMatchObject({ code: "MALFORMED_ENVELOPE" });
  });

  it("detects a forged authenticated length and object ID", async () => {
    await sodium.ready;
    const key = await randomKey();
    const dedupKey = await randomKey();
    const plaintext = Uint8Array.of(4, 5, 6);
    for (const change of [{ plaintextLength: 99 }, { objectId: "obj_forged" }]) {
      const envelope = await forgedEnvelope({ key, dedupKey, plaintext, change });
      await expect(decryptEnvelope({ envelope, key, dedupKey, expected: context })).rejects.toMatchObject({
        code: "AUTHENTICATION_FAILED",
      });
    }
  });

  it("has a redacted JSON error representation", () => {
    const error = new CryptoFailure("AUTHENTICATION_FAILED", "safe");
    expect(error.toJSON()).toEqual({ code: "AUTHENTICATION_FAILED", message: "safe" });
  });
});

function rawEnvelope(headerBytes: Uint8Array): Uint8Array {
  const output = new Uint8Array(8 + headerBytes.byteLength + 24 + 16);
  output.set([0x53, 0x54, 0x43, 0x01]);
  new DataView(output.buffer).setUint32(4, headerBytes.byteLength, false);
  output.set(headerBytes, 8);
  return output;
}

async function forgedEnvelope(input: {
  key: Uint8Array;
  dedupKey: Uint8Array;
  plaintext: Uint8Array;
  change: Record<string, unknown>;
}): Promise<Uint8Array> {
  const header = {
    algorithm: "xchacha20-poly1305-ietf",
    compression: "none",
    objectId: await computeObjectId(input.dedupKey, input.plaintext),
    plaintextLength: input.plaintext.byteLength,
    scopeId: context.scopeId,
    vaultId: context.vaultId,
    version: 1,
    ...input.change,
  };
  const headerBytes = new TextEncoder().encode(canonicalJson(header));
  const nonce = new Uint8Array(24).fill(11);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    input.plaintext,
    headerBytes,
    null,
    nonce,
    input.key,
  );
  const output = new Uint8Array(8 + headerBytes.byteLength + nonce.byteLength + ciphertext.byteLength);
  output.set([0x53, 0x54, 0x43, 0x01]);
  new DataView(output.buffer).setUint32(4, headerBytes.byteLength, false);
  output.set(headerBytes, 8);
  output.set(nonce, 8 + headerBytes.byteLength);
  output.set(ciphertext, 8 + headerBytes.byteLength + nonce.byteLength);
  return output;
}
