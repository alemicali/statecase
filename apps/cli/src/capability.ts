import { decryptEnvelope, deriveScopeKey, encryptEnvelope, randomKey, type ScopeKeys } from "@statecase/crypto";
import { canonicalJson } from "@statecase/protocol";
import { z } from "zod";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf8", { fatal: true, ignoreBOM: false });
const TOKEN_PREFIX = "stc_boot_";
const identifier = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const encodedKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

const payloadSchema = z.object({
  version: z.literal(1),
  vaultId: identifier,
  namespaces: z.array(identifier).min(1).max(64),
  actions: z.array(z.enum(["read", "append"])).min(1).max(2),
  expiresAt: z.number().int().positive(),
  namespaceKeys: z.record(identifier, z.object({ encryptionKey: encodedKey, dedupKey: encodedKey }).strict()),
}).strict();

export interface ScopedVaultKeys {
  vaultId: string;
  namespaces: string[];
  actions: Array<"read" | "append">;
  expiresAt: number;
  namespaceKeys: Record<string, { encryptionKey: string; dedupKey: string }>;
}

export async function createBootstrapCapability(input: {
  vaultId: string;
  vaultKey: Uint8Array;
  namespaces: string[];
  actions: Array<"read" | "append">;
  expiresAt: number;
}): Promise<{ bootstrapToken: string; tokenHash: string; keyEnvelope: string }> {
  validateGrant(input.namespaces, input.actions);
  const secret = await randomKey();
  const bootstrapToken = `${TOKEN_PREFIX}${Buffer.from(secret).toString("base64url")}`;
  try {
    const namespaceKeys: ScopedVaultKeys["namespaceKeys"] = {};
    for (const namespace of [...input.namespaces].sort((left, right) => left.localeCompare(right, "en"))) {
      const keys = await deriveScopeKey(input.vaultKey, namespace);
      namespaceKeys[namespace] = encodeKeys(keys);
      keys.encryptionKey.fill(0);
      keys.dedupKey.fill(0);
    }
    const payload = payloadSchema.parse({
      version: 1,
      vaultId: input.vaultId,
      namespaces: [...input.namespaces].sort((left, right) => left.localeCompare(right, "en")),
      actions: [...input.actions].sort((left, right) => left.localeCompare(right, "en")),
      expiresAt: input.expiresAt,
      namespaceKeys,
    });
    const bootstrapKeys = await deriveScopeKey(secret, "bootstrap-envelope");
    try {
      const envelope = await encryptEnvelope({
        plaintext: encoder.encode(canonicalJson(payload)),
        key: bootstrapKeys.encryptionKey,
        dedupKey: bootstrapKeys.dedupKey,
        context: { vaultId: input.vaultId, scopeId: "bootstrap", compression: "none" },
      });
      return {
        bootstrapToken,
        tokenHash: await sha256Base64Url(bootstrapToken),
        keyEnvelope: Buffer.from(envelope).toString("base64url"),
      };
    } finally {
      bootstrapKeys.encryptionKey.fill(0);
      bootstrapKeys.dedupKey.fill(0);
    }
  } finally {
    secret.fill(0);
  }
}

export async function openBootstrapCapability(input: {
  bootstrapToken: string;
  keyEnvelope: string;
  vaultId: string;
  namespaces: string[];
  actions: Array<"read" | "append">;
  expiresAt: number;
}): Promise<ScopedVaultKeys> {
  const secret = parseBootstrapToken(input.bootstrapToken);
  try {
    const bootstrapKeys = await deriveScopeKey(secret, "bootstrap-envelope");
    try {
      const plaintext = await decryptEnvelope({
        envelope: Buffer.from(input.keyEnvelope, "base64url"),
        key: bootstrapKeys.encryptionKey,
        dedupKey: bootstrapKeys.dedupKey,
        expected: { vaultId: input.vaultId, scopeId: "bootstrap", compression: "none" },
      });
      const parsed = payloadSchema.parse(JSON.parse(decoder.decode(plaintext)));
      const expectedNamespaces = [...input.namespaces].sort((left, right) => left.localeCompare(right, "en"));
      const expectedActions = [...input.actions].sort((left, right) => left.localeCompare(right, "en"));
      if (canonicalJson(parsed.namespaces) !== canonicalJson(expectedNamespaces) ||
          canonicalJson(parsed.actions) !== canonicalJson(expectedActions) ||
          parsed.vaultId !== input.vaultId || parsed.expiresAt !== input.expiresAt ||
          canonicalJson(Object.keys(parsed.namespaceKeys).sort()) !== canonicalJson(expectedNamespaces)) {
        throw new Error("bootstrap key envelope does not match the authorized capability");
      }
      return parsed;
    } finally {
      bootstrapKeys.encryptionKey.fill(0);
      bootstrapKeys.dedupKey.fill(0);
    }
  } finally {
    secret.fill(0);
  }
}

function parseBootstrapToken(token: string): Uint8Array {
  if (!/^stc_boot_[A-Za-z0-9_-]{43}$/u.test(token)) throw new Error("invalid bootstrap token");
  const bytes = Buffer.from(token.slice(TOKEN_PREFIX.length), "base64url");
  if (bytes.byteLength !== 32) throw new Error("invalid bootstrap token");
  return new Uint8Array(bytes);
}

function validateGrant(namespaces: string[], actions: Array<"read" | "append">): void {
  if (namespaces.length === 0 || new Set(namespaces).size !== namespaces.length) throw new Error("capability namespaces must be unique and non-empty");
  if (actions.length === 0 || new Set(actions).size !== actions.length) throw new Error("capability actions must be unique and non-empty");
  if (!actions.includes("read")) throw new Error("append capabilities must also include read access");
  if (namespaces.some((namespace) => namespace === "secrets" || namespace.startsWith("secrets:"))) {
    throw new Error("ephemeral capabilities cannot access secrets");
  }
  for (const value of namespaces) identifier.parse(value);
}

function encodeKeys(keys: ScopeKeys): { encryptionKey: string; dedupKey: string } {
  return {
    encryptionKey: Buffer.from(keys.encryptionKey).toString("base64url"),
    dedupKey: Buffer.from(keys.dedupKey).toString("base64url"),
  };
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Buffer.from(digest).toString("base64url");
}
