import type { Stats } from "node:fs";
import { constants, lstat, open } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { computeObjectIdStream } from "@statecase/crypto";

export interface FileGuard { readonly digest?: string; assertUnchanged(): Promise<void> }
class FileGuardError extends Error {
  constructor() { super("local file changed or cannot be observed safely"); this.name = "FileGuardError"; }
}
interface Observation { digest?: string; identity: string; parents: Array<string | undefined> }

/** Bind preflight to the selected native target without retaining file content.
 * Revalidate immediately before replacement, including previously absent files.
 * This is a race detector, not an atomic filesystem compare-and-swap. */
export async function captureFileGuard(
  root: string, path: string, dedupKey: Uint8Array,
  options: { maximumBytes?: number; afterRead?: () => Promise<void> } = {},
): Promise<FileGuard> {
  const maximumBytes = options.maximumBytes ?? 20 * 1024 * 1024 * 1024;
  const absoluteRoot = resolve(root), absolutePath = resolve(path), relation = relative(absoluteRoot, absolutePath);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || !relation || isAbsolute(relation) || relation === ".." || relation.startsWith(`..${sep}`) ||
      absolutePath.length > 4096 || [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new FileGuardError();
  const parts = relation.split(sep);
  const directories = [absoluteRoot, ...parts.slice(0, -1).map((_part, index) => join(absoluteRoot, ...parts.slice(0, index + 1)))];
  const observe = async (afterRead?: () => Promise<void>): Promise<Observation> => {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const parents = await parentIdentities(directories);
      try { handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (!sameParents(parents, await parentIdentities(directories))) throw new FileGuardError();
        return { identity: "absent", parents };
      }
      const before = await handle.stat();
      if (!before.isFile() || before.size > maximumBytes) throw new FileGuardError();
      const reader = handle;
      async function* chunks() {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        try {
          while (true) {
            const { bytesRead } = await reader.read(buffer, 0, Math.min(buffer.length, before.size - position + 1), position);
            if (bytesRead === 0) break;
            position += bytesRead;
            if (position > before.size) throw new FileGuardError();
            yield buffer.subarray(0, bytesRead);
          }
          if (position !== before.size) throw new FileGuardError();
        } finally { buffer.fill(0); }
      }
      const digest = await computeObjectIdStream(dedupKey, chunks());
      await afterRead?.();
      const after = await handle.stat(), named = await lstat(absolutePath);
      if (fileIdentity(before) !== fileIdentity(after) || fileIdentity(before) !== fileIdentity(named) ||
          !sameParents(parents, await parentIdentities(directories))) throw new FileGuardError();
      return { digest, identity: fileIdentity(before), parents };
    } catch { throw new FileGuardError(); }
    finally { await handle?.close().catch(() => undefined); }
  };
  const original = await observe(options.afterRead);
  return { digest: original.digest, async assertUnchanged() {
    const current = await observe();
    if (current.digest !== original.digest || current.identity !== original.identity ||
        original.parents.some((identity, index) => identity !== undefined && identity !== current.parents[index])) throw new FileGuardError();
  } };
}
async function parentIdentities(directories: string[]): Promise<Array<string | undefined>> {
  const output: Array<string | undefined> = [];
  for (const path of directories) {
    let info: Stats;
    try { info = await lstat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { output.push(undefined); continue; } throw error; }
    if (!info.isDirectory()) throw new FileGuardError();
    output.push(JSON.stringify([info.dev, info.ino, info.mode, info.uid]));
  }
  return output;
}
function sameParents(a: Array<string | undefined>, b: Array<string | undefined>): boolean { return a.every((value, index) => value === b[index]); }
function fileIdentity(info: Stats): string { return JSON.stringify([info.dev, info.ino, info.mode, info.uid, info.nlink, info.size, info.mtimeMs, info.ctimeMs]); }
