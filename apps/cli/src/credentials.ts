import { execFile } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { decryptEnvelope, encryptEnvelope, randomKey } from "@statecase/crypto";
import { ProfileLock } from "@statecase/runtime";
import type { LocalSecrets } from "./config.js";

const MAX_BYTES = 8 * 1024 * 1024;
const SERVICE = "statecase-local-credentials-v1";
type Backend = "secret-service";
type ErrorCode = "CREDENTIAL_DOCUMENT_INVALID" | "CREDENTIAL_DOCUMENT_UNSAFE" | "CREDENTIAL_STORE_UNAVAILABLE" |
  "CREDENTIAL_BACKEND_UNSUPPORTED" | "CREDENTIAL_KEY_MISMATCH" | "CREDENTIAL_INTEGRITY_FAILED" |
  "CREDENTIAL_STATE_CHANGED" | "CREDENTIAL_STORE_LOCKED" | "CREDENTIAL_COMMIT_FAILED";

export class CredentialStorageError extends Error {
  constructor(readonly code: ErrorCode) {
    super({ CREDENTIAL_DOCUMENT_INVALID: "local credential document is invalid or exceeds its size limit",
      CREDENTIAL_DOCUMENT_UNSAFE: "local credentials must be an owner-only regular file, not a link",
      CREDENTIAL_STORE_UNAVAILABLE: "native credential store is unavailable, locked, or missing the required key; no plaintext fallback",
      CREDENTIAL_BACKEND_UNSUPPORTED: "native credential protection is not supported on this platform yet",
      CREDENTIAL_KEY_MISMATCH: "native credential key read-back did not match; existing credentials retained",
      CREDENTIAL_INTEGRITY_FAILED: "protected local credentials failed authentication",
      CREDENTIAL_STATE_CHANGED: "local credentials changed independently; reload before retrying",
      CREDENTIAL_STORE_LOCKED: "local credential mutation is locked; retry after the current operation",
      CREDENTIAL_COMMIT_FAILED: "local credential commit failed; any created native key was retained",
    }[code]);
    this.name = "CredentialStorageError";
  }
  toJSON(): { code: ErrorCode; message: string } { return { code: this.code, message: this.message }; }
}

export interface CredentialKeyProtector {
  readonly backend: Backend;
  get(id: string): Promise<Uint8Array>;
  put(id: string, key: Uint8Array): Promise<void>;
}
export interface CredentialFileOptions {
  protector?: CredentialKeyProtector;
  beforeCommit?: () => Promise<void>;
}
interface ProtectedDocument { version: 2; backend: Backend; keyId: string; envelope: string }
interface Snapshot { digest: string | null; document?: LocalSecrets | ProtectedDocument }

export class CredentialFile {
  readonly path: string;
  readonly #home: string;
  readonly #options: CredentialFileOptions;
  #observed: string | null | undefined;

  constructor(home: string, options: CredentialFileOptions = {}) {
    this.#home = resolve(home); this.path = join(this.#home, "credentials.json"); this.#options = options;
  }

  async status(): Promise<{ backend: "file" | Backend; protected: boolean; exists: boolean }> {
    const { document } = await this.#snapshot();
    return { backend: document?.version === 2 ? document.backend : "file", protected: document?.version === 2, exists: !!document };
  }

  async read(): Promise<LocalSecrets> {
    const snapshot = await this.#snapshot();
    const value = await this.#decode(snapshot.document);
    this.#observed = snapshot.digest;
    return value;
  }

  async write(value: LocalSecrets): Promise<void> {
    const plaintext = encodeSecrets(value);
    try {
      await this.#locked(async () => {
        const snapshot = await this.#snapshot();
        if (this.#observed !== undefined && this.#observed !== snapshot.digest) throw new CredentialStorageError("CREDENTIAL_STATE_CHANGED");
        let document: LocalSecrets | ProtectedDocument = value;
        if (snapshot.document?.version === 2) {
          // Authenticate the previous document before overwriting it, even for
          // callers that did not first load secrets through this instance.
          const key = await this.#key(snapshot.document.keyId);
          try {
            await unseal(snapshot.document, key);
            document = await seal(plaintext, key, snapshot.document.keyId);
          }
          finally { key.fill(0); }
        }
        await this.#commit(snapshot, document);
      });
    } finally { plaintext.fill(0); }
  }

  async protect(options: { dryRun?: boolean } = {}): Promise<{ backend: Backend; changed: boolean; dryRun: boolean }> {
    const snapshot = await this.#snapshot();
    const backend = this.#protector().backend;
    if (options.dryRun) return { backend, changed: false, dryRun: true };
    return this.#locked(async () => {
      const current = await this.#snapshot();
      if (current.digest !== snapshot.digest) throw new CredentialStorageError("CREDENTIAL_STATE_CHANGED");
      const value = await this.#decode(current.document);
      if (current.document?.version === 2) return { backend, changed: false, dryRun: false };
      const plaintext = encodeSecrets(value); const key = await randomKey();
      const id = `loc_${randomUUID().replaceAll("-", "")}`;
      try {
        try { await this.#protector().put(id, key); }
        catch { throw new CredentialStorageError("CREDENTIAL_STORE_UNAVAILABLE"); }
        const verified = await this.#key(id);
        try { if (!timingSafeEqual(key, verified)) throw new CredentialStorageError("CREDENTIAL_KEY_MISMATCH"); }
        finally { verified.fill(0); }
        const document = await seal(plaintext, key, id);
        const decrypted = await decryptEnvelope({ envelope: Buffer.from(document.envelope, "base64url"), key, dedupKey: key, expected: context(id) });
        try { if (!timingSafeEqual(plaintext, decrypted)) throw new CredentialStorageError("CREDENTIAL_INTEGRITY_FAILED"); }
        finally { decrypted.fill(0); }
        await this.#commit(current, document);
        return { backend, changed: true, dryRun: false };
      } finally { plaintext.fill(0); key.fill(0); }
    });
  }

  #protector(): CredentialKeyProtector { return this.#options.protector ?? nativeCredentialProtector(); }
  async #key(id: string): Promise<Uint8Array> {
    let key: Uint8Array;
    try { key = await this.#protector().get(id); }
    catch { throw new CredentialStorageError("CREDENTIAL_STORE_UNAVAILABLE"); }
    if (!(key instanceof Uint8Array) || key.length !== 32) { if (key instanceof Uint8Array) key.fill(0); throw new CredentialStorageError("CREDENTIAL_KEY_MISMATCH"); }
    return key;
  }

  async #decode(document: Snapshot["document"]): Promise<LocalSecrets> {
    if (!document) return { version: 1, vaultKeys: {} };
    if (document.version === 1) return document;
    const key = await this.#key(document.keyId);
    try { return await unseal(document, key); }
    finally { key.fill(0); }
  }

  async #snapshot(): Promise<Snapshot> {
    let handle;
    try { handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { digest: null };
      throw new CredentialStorageError("CREDENTIAL_DOCUMENT_UNSAFE");
    }
    const chunks: Buffer[] = [];
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 ||
          (process.getuid && before.uid !== process.getuid())) throw new CredentialStorageError("CREDENTIAL_DOCUMENT_UNSAFE");
      if (before.size > MAX_BYTES) throw new CredentialStorageError("CREDENTIAL_DOCUMENT_INVALID");
      let size = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        size += chunk.length;
        if (size > MAX_BYTES) throw new CredentialStorageError("CREDENTIAL_DOCUMENT_INVALID");
        chunks.push(chunk as Buffer);
      }
      const after = await handle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new CredentialStorageError("CREDENTIAL_STATE_CHANGED");
      const bytes = Buffer.concat(chunks);
      try {
        const value: unknown = parseJson(bytes);
        let document: Snapshot["document"];
        if (isRecord(value) && value.version === 2) {
          if (Object.keys(value).some((field) => !["version", "backend", "keyId", "envelope"].includes(field)) ||
              value.backend !== "secret-service" || typeof value.keyId !== "string" || !/^loc_[a-f0-9]{32}$/u.test(value.keyId) ||
              typeof value.envelope !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value.envelope)) throw new CredentialStorageError("CREDENTIAL_DOCUMENT_INVALID");
          document = value as unknown as ProtectedDocument;
        } else document = requireSecrets(value);
        return { digest: digest(bytes), document };
      } finally { bytes.fill(0); }
    } finally { for (const chunk of chunks) chunk.fill(0); await handle.close(); }
  }

  async #commit(snapshot: Snapshot, document: LocalSecrets | ProtectedDocument): Promise<void> {
    const bytes = Buffer.from(`${JSON.stringify(document)}\n`);
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let created = false;
    try {
      if (bytes.length > MAX_BYTES) throw new CredentialStorageError("CREDENTIAL_DOCUMENT_INVALID");
      await this.#options.beforeCommit?.();
      if ((await this.#snapshot()).digest !== snapshot.digest) throw new CredentialStorageError("CREDENTIAL_STATE_CHANGED");
      const handle = await open(temporary, "wx", 0o600); created = true;
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      if ((await this.#snapshot()).digest !== snapshot.digest) throw new CredentialStorageError("CREDENTIAL_STATE_CHANGED");
      await rename(temporary, this.path); created = false; this.#observed = digest(bytes);
      const directory = await open(this.#home, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      if (error instanceof CredentialStorageError) throw error;
      throw new CredentialStorageError("CREDENTIAL_COMMIT_FAILED");
    } finally {
      bytes.fill(0);
      if (created) {
        // Only a failed commit reaches this branch. Preserve its redacted
        // primary error if cleanup also fails; the owner-only artifact may
        // remain for recovery, but must never leak raw filesystem diagnostics.
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    }
  }

  async #locked<T>(action: () => Promise<T>): Promise<T> {
    try { await mkdir(this.#home, { recursive: true, mode: 0o700 }); }
    catch { throw new CredentialStorageError("CREDENTIAL_DOCUMENT_UNSAFE"); }
    let lock;
    try { lock = await ProfileLock.acquire(join(this.#home, "locks", "credentials.lock")); }
    catch { throw new CredentialStorageError("CREDENTIAL_STORE_LOCKED"); }
    let result: T | undefined; let failure: unknown; let failed = false;
    try { result = await action(); }
    catch (error) { failed = true; failure = error; }
    try { await lock.release(); }
    catch { if (!failed) { failed = true; failure = new CredentialStorageError("CREDENTIAL_COMMIT_FAILED"); } }
    if (failed) throw failure;
    return result as T;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function requireSecrets(value: unknown): LocalSecrets {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.vaultKeys) ||
      Object.values(value.vaultKeys).some((key) => typeof key !== "string") ||
      (value.token !== undefined && typeof value.token !== "string")) throw new CredentialStorageError("CREDENTIAL_DOCUMENT_INVALID");
  return value as unknown as LocalSecrets;
}
function parseJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { throw new CredentialStorageError("CREDENTIAL_DOCUMENT_INVALID"); }
}
function parseSecrets(bytes: Uint8Array): LocalSecrets { return requireSecrets(parseJson(bytes)); }
function encodeSecrets(value: LocalSecrets): Buffer {
  requireSecrets(value);
  try {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > MAX_BYTES) { bytes.fill(0); throw new Error("oversize"); }
    return bytes;
  } catch { throw new CredentialStorageError("CREDENTIAL_DOCUMENT_INVALID"); }
}
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function context(id: string) { return { vaultId: "local-credentials", scopeId: id, compression: "none" as const }; }
async function seal(plaintext: Uint8Array, key: Uint8Array, id: string): Promise<ProtectedDocument> {
  const envelope = await encryptEnvelope({ plaintext, key, dedupKey: key, context: context(id) });
  return { version: 2, backend: "secret-service", keyId: id, envelope: Buffer.from(envelope).toString("base64url") };
}
async function unseal(document: ProtectedDocument, key: Uint8Array): Promise<LocalSecrets> {
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = await decryptEnvelope({ envelope: Buffer.from(document.envelope, "base64url"), key, dedupKey: key, expected: context(document.keyId) });
    return parseSecrets(plaintext);
  } catch { throw new CredentialStorageError("CREDENTIAL_INTEGRITY_FAILED"); }
  finally { plaintext?.fill(0); }
}

export type SecretToolRunner = (args: string[], input?: Buffer) => Promise<Buffer>;
export function nativeCredentialProtector(platform: NodeJS.Platform = process.platform, runner: SecretToolRunner = runSecretTool): CredentialKeyProtector {
  if (platform !== "linux") throw new CredentialStorageError("CREDENTIAL_BACKEND_UNSUPPORTED");
  const attributes = (id: string) => {
    if (!/^loc_[a-f0-9]{32}$/u.test(id)) throw new CredentialStorageError("CREDENTIAL_DOCUMENT_INVALID");
    return ["service", SERVICE, "profile", id];
  };
  return { backend: "secret-service",
    async get(id) {
      let output: Buffer | undefined;
      try {
        output = await runner(["lookup", ...attributes(id)]);
        const encoded = output.toString("utf8");
        if (!/^[A-Za-z0-9_-]{43}$/u.test(encoded)) throw new Error("invalid native key");
        const key = Buffer.from(encoded, "base64url");
        if (key.length !== 32 || key.toString("base64url") !== encoded) { key.fill(0); throw new Error("invalid native key"); }
        return key;
      } catch { throw new CredentialStorageError("CREDENTIAL_STORE_UNAVAILABLE"); }
      finally { output?.fill(0); }
    },
    async put(id, key) {
      if (key.length !== 32) throw new CredentialStorageError("CREDENTIAL_KEY_MISMATCH");
      const input = Buffer.from(Buffer.from(key).toString("base64url"));
      let output: Buffer | undefined;
      try { output = await runner(["store", "--label=Statecase local credentials", ...attributes(id)], input); }
      catch { throw new CredentialStorageError("CREDENTIAL_STORE_UNAVAILABLE"); }
      finally { input.fill(0); output?.fill(0); }
    } };
}

async function runSecretTool(args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((accept, reject) => {
    const child = execFile("/usr/bin/secret-tool", args, { encoding: "buffer", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 4096,
      env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME,
        LANG: "C.UTF-8" } as unknown as NodeJS.ProcessEnv }, (error, stdout, stderr) => {
      stderr.fill(0);
      if (error) { stdout.fill(0); reject(new CredentialStorageError("CREDENTIAL_STORE_UNAVAILABLE")); }
      else accept(stdout);
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
  });
}
