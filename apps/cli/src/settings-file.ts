import { createHash } from "node:crypto";
import { constants, lstat, open } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join, resolve } from "node:path";
import { patchSettings, type SettingPatch } from "@statecase/adapter-common/config";
import { projectSettingEntries, type SettingsDocument, type SettingsEntry } from "@statecase/adapter-common/settings-transport";

const MAX_BYTES = 1024 * 1024;
export class SettingsFileError extends Error {
  constructor(readonly code: "CONFIG_FILE_UNSAFE" | "CONFIG_FILE_CHANGED") {
    super(code === "CONFIG_FILE_CHANGED" ? "native configuration changed; retry after it is stable" : "native configuration cannot be read safely");
    this.name = "SettingsFileError";
  }
}
export interface SettingsSnapshot {
  readonly path: string;
  readonly entries: readonly SettingsEntry[];
  patch(patches: readonly SettingPatch[]): Uint8Array;
  assertUnchanged(): Promise<void>;
  dispose(): void;
}
interface RawSnapshot { bytes?: Buffer; fingerprint: string; rootIdentity?: string }

/** Raw native bytes stay inside this closure; only filtered entries may upload. */
export async function readSettingsSnapshot(
  root: string,
  document: SettingsDocument,
  options: { afterRead?: () => Promise<void> } = {},
): Promise<SettingsSnapshot> {
  // Validate adapter-owned identities before constructing any filesystem path.
  projectSettingEntries(new TextEncoder().encode(document.format === "json" ? "{}" : ""), document);
  const absoluteRoot = resolve(root), path = join(absoluteRoot, document.nativePath);
  const raw = await readRaw(absoluteRoot, path, options.afterRead);
  let disposed = false;
  try {
    const entries = raw.bytes ? projectSettingEntries(raw.bytes, document) : [];
    return {
      path, entries,
      patch(patches) {
        if (disposed) throw new SettingsFileError("CONFIG_FILE_CHANGED");
        return patchSettings(raw.bytes, document.format, document.rules, patches);
      },
      async assertUnchanged() {
        if (disposed) throw new SettingsFileError("CONFIG_FILE_CHANGED");
        let current: RawSnapshot | undefined;
        try {
          current = await readRaw(absoluteRoot, path);
          // A transaction may have created a previously absent root for its
          // owner-only staging file. Existing roots must retain their identity.
          if ((raw.rootIdentity !== undefined && raw.rootIdentity !== current.rootIdentity) || raw.fingerprint !== current.fingerprint) {
            throw new SettingsFileError("CONFIG_FILE_CHANGED");
          }
        } catch { throw new SettingsFileError("CONFIG_FILE_CHANGED"); }
        finally { current?.bytes?.fill(0); }
      },
      dispose() { disposed = true; raw.bytes?.fill(0); },
    };
  } catch (error) { raw.bytes?.fill(0); throw error; }
}

async function readRaw(root: string, path: string, afterRead?: () => Promise<void>): Promise<RawSnapshot> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let buffer: Buffer | undefined;
  try {
    const beforeRoot = await rootIdentity(root);
    if (beforeRoot === undefined) return { fingerprint: "absent" };
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (await rootIdentity(root) !== beforeRoot) throw new SettingsFileError("CONFIG_FILE_CHANGED");
      return { fingerprint: "absent", rootIdentity: beforeRoot };
    }
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || !ownedSafeMode(before) || before.size > MAX_BYTES) throw new SettingsFileError("CONFIG_FILE_UNSAFE");
    // One extra byte detects growth without allowing a writer to grow memory.
    buffer = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    await afterRead?.();
    const after = await handle.stat(), named = await lstat(path);
    if (size !== before.size || fileIdentity(before) !== fileIdentity(after) || fileIdentity(before) !== fileIdentity(named) || await rootIdentity(root) !== beforeRoot) {
      throw new SettingsFileError("CONFIG_FILE_CHANGED");
    }
    const bytes = buffer.subarray(0, size);
    await handle.close(); handle = undefined;
    return { bytes, rootIdentity: beforeRoot, fingerprint: `${fileIdentity(after)}:${createHash("sha256").update(bytes).digest("hex")}` };
  } catch (error) {
    buffer?.fill(0);
    if (error instanceof SettingsFileError) throw error;
    throw new SettingsFileError("CONFIG_FILE_UNSAFE");
  } finally {
    // Successful reads close above; cleanup must not replace a redacted failure.
    await handle?.close().catch(() => undefined);
  }
}

function ownedSafeMode(info: Stats): boolean {
  return (info.mode & 0o022) === 0 && (!process.getuid || info.uid === process.getuid());
}
async function rootIdentity(root: string): Promise<string | undefined> {
  let info: Stats;
  try { info = await lstat(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!info.isDirectory() || !ownedSafeMode(info)) throw new SettingsFileError("CONFIG_FILE_UNSAFE");
  return JSON.stringify([info.dev, info.ino, info.uid, info.mode]);
}
function fileIdentity(info: Stats): string {
  return JSON.stringify([info.dev, info.ino, info.mode, info.uid, info.nlink, info.size, info.mtimeMs, info.ctimeMs]);
}
