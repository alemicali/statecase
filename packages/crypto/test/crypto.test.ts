import { describe, expect, it } from "vitest";
import sodium from "libsodium-wrappers-sumo";

import { canonicalJson } from "@statecase/protocol";

import {
  CryptoFailure,
  NonceRegistry,
  computeObjectId,
  decryptEnvelope,
  deriveScopeKey,
  deriveRecoveryKey,
  encryptEnvelope,
  randomKey,
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
});

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
