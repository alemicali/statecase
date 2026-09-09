export const MAX_MEMORY_FILE_BYTES = 1024 * 1024;
export const MAX_MEMORY_FILES = 256;
export const MAX_MEMORY_SET_BYTES = 8 * 1024 * 1024;
const PREFIX = "portable-memory/v1/";

export class MemoryFormatError extends Error {
  readonly code = "MEMORY_FORMAT_UNSUPPORTED";
  constructor() { super("native memory format is unsupported or exceeds its limits"); this.name = "MemoryFormatError"; }
}
function allowed(path: string): boolean {
  const parts = path.split("/");
  return path.endsWith(".md") && new TextEncoder().encode(path).byteLength <= 1024 && parts.length <= 16 &&
    parts.every((part) => /^[\p{L}\p{N}_-][\p{L}\p{N}._ -]*$/u.test(part) && !/(?:^|[._-])(?:credentials?|auth)(?:[._-]|$)/iu.test(part));
}
export function memoryLogicalPath(nativePath: string): string {
  if (!allowed(nativePath)) throw new MemoryFormatError();
  return PREFIX + nativePath;
}
export function memoryNativePath(logicalPath: string): string | undefined {
  const nativePath = logicalPath.startsWith(PREFIX) ? logicalPath.slice(PREFIX.length) : "";
  return allowed(nativePath) ? nativePath : undefined;
}
export function validateMemorySet(files: ReadonlyMap<string, Uint8Array>): void {
  if (files.size > MAX_MEMORY_FILES) throw new MemoryFormatError();
  let total = 0;
  for (const [path, bytes] of files) {
    total += bytes.byteLength;
    if (!allowed(path) || bytes.byteLength > MAX_MEMORY_FILE_BYTES || total > MAX_MEMORY_SET_BYTES) throw new MemoryFormatError();
    try { if (new TextDecoder("utf8", { fatal: true, ignoreBOM: false }).decode(bytes).includes("\0")) throw new MemoryFormatError(); }
    catch { throw new MemoryFormatError(); }
  }
}
