import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { constants, lstat, open } from "node:fs/promises";
import { join, resolve } from "node:path";

export const MAX_NATIVE_TEXT_BYTES = 1024 * 1024;
export class NativeFileError extends Error {
  constructor(readonly code: "NATIVE_FILE_UNSAFE" | "NATIVE_FILE_CHANGED") {
    super(code === "NATIVE_FILE_CHANGED" ? "native context changed; retry when stable" : "native context cannot be observed safely");
    this.name = "NativeFileError";
  }
}
export interface NativeFileSnapshot {
  readonly path: string;
  readonly bytes?: Uint8Array;
  assertUnchanged(): Promise<void>;
  dispose(): void;
}
interface Observation { bytes?: Buffer; fingerprint: string; parents: Array<string | undefined> }

/** Explicit selected roots only. Parent identities and descriptor bytes are
 * guarded; missing roots remain absent during preview. No directory traversal,
 * links, unbounded stream reads or raw OS diagnostics are accepted.
 */
export async function readNativeFileSnapshot(
  root: string, relativePath: string, options: { afterRead?: () => Promise<void> } = {},
): Promise<NativeFileSnapshot> {
  const parts = relativePath.split("/");
  if (!relativePath || Buffer.byteLength(relativePath) > 1024 || parts.length > 16 || relativePath.includes("\\") || [...relativePath].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      parts.some((part) => !part || part === "." || part === "..")) throw new NativeFileError("NATIVE_FILE_UNSAFE");
  const absoluteRoot = resolve(root), path = join(absoluteRoot, ...parts);
  const directories = [absoluteRoot, ...parts.slice(0, -1).map((_part, index) => join(absoluteRoot, ...parts.slice(0, index + 1)))];
  const original = await observe(path, directories, options.afterRead);
  let disposed = false;
  return {
    path, bytes: original.bytes,
    async assertUnchanged() {
      if (disposed) throw new NativeFileError("NATIVE_FILE_CHANGED");
      let current: Observation | undefined;
      try {
        current = await observe(path, directories);
        if (original.fingerprint !== current.fingerprint || original.parents.some((identity, index) => identity !== undefined && identity !== current!.parents[index])) {
          throw new NativeFileError("NATIVE_FILE_CHANGED");
        }
      } catch { throw new NativeFileError("NATIVE_FILE_CHANGED"); }
      finally { current?.bytes?.fill(0); }
    },
    dispose() { disposed = true; original.bytes?.fill(0); },
  };
}

async function observe(path: string, directories: string[], afterRead?: () => Promise<void>): Promise<Observation> {
  let handle: Awaited<ReturnType<typeof open>> | undefined, bytes: Buffer | undefined;
  let verification: Buffer | undefined;
  try {
    const beforeParents = await parentIdentities(directories);
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!sameParents(beforeParents, await parentIdentities(directories))) throw new NativeFileError("NATIVE_FILE_CHANGED");
      return { fingerprint: "absent", parents: beforeParents };
    }
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || !safeOwner(before) || before.size > MAX_NATIVE_TEXT_BYTES) throw new NativeFileError("NATIVE_FILE_UNSAFE");
    const buffer = Buffer.alloc(before.size + 1); bytes = buffer;
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    await afterRead?.();
    // Timestamps can collide on same-size in-place writes. Re-read through the
    // same bounded descriptor before accepting bytes; metadata alone is not a
    // content-stability proof.
    verification = Buffer.alloc(before.size + 1);
    let verified = 0;
    while (verified < verification.length) {
      const result = await handle.read(verification, verified, verification.length - verified, verified);
      if (!result.bytesRead) break;
      verified += result.bytesRead;
    }
    const after = await handle.stat(), named = await lstat(path);
    if (size !== before.size || verified !== size || !buffer.subarray(0, size).equals(verification.subarray(0, verified)) ||
        fileIdentity(before) !== fileIdentity(after) || fileIdentity(before) !== fileIdentity(named) ||
        !sameParents(beforeParents, await parentIdentities(directories))) throw new NativeFileError("NATIVE_FILE_CHANGED");
    bytes = buffer.subarray(0, size);
    await handle.close(); handle = undefined;
    return { bytes, parents: beforeParents, fingerprint: `${fileIdentity(before)}:${createHash("sha256").update(bytes).digest("hex")}` };
  } catch (error) {
    bytes?.fill(0);
    if (error instanceof NativeFileError) throw error;
    throw new NativeFileError("NATIVE_FILE_UNSAFE");
  } finally { verification?.fill(0); await handle?.close().catch(() => undefined); }
}
async function parentIdentities(directories: string[]): Promise<Array<string | undefined>> {
  const identities: Array<string | undefined> = [];
  for (const directory of directories) {
    let info: Stats;
    try { info = await lstat(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { identities.push(undefined); continue; } throw error; }
    if (!info.isDirectory() || !safeOwner(info)) throw new NativeFileError("NATIVE_FILE_UNSAFE");
    identities.push(JSON.stringify([info.dev, info.ino, info.mode, info.uid]));
  }
  return identities;
}
function sameParents(a: Array<string | undefined>, b: Array<string | undefined>): boolean { return a.every((identity, index) => identity === b[index]); }
function safeOwner(info: Stats): boolean { return (info.mode & 0o022) === 0 && (!process.getuid || process.getuid() === info.uid); }
function fileIdentity(info: Stats): string { return JSON.stringify([info.dev, info.ino, info.mode, info.uid, info.nlink, info.size, info.mtimeMs, info.ctimeMs]); }
