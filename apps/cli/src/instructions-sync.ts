import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { codexInstructionPolicy } from "@statecase/adapter-codex/instructions";
import { claudeInstructionPolicy } from "@statecase/adapter-claude/instructions";
import { InstructionError, instructionLogicalPath, instructionNativePath, validateInstructionSet, MAX_INSTRUCTION_FILES, MAX_INSTRUCTION_SET_BYTES } from "@statecase/adapter-common/instructions";
import type { LocalConfig, RootMapping } from "./config.js";
import { prepareNativeTextPlan, type IncomingNativeText, type NativeTextPlan } from "./native-text-plan.js";
import { NativeFileError, readNativeFileSnapshot, type NativeFileSnapshot } from "./native-file.js";

const policyFor = (kind: RootMapping["kind"]) => kind === "codex" ? codexInstructionPolicy : claudeInstructionPolicy;
export function instructionPath(kind: RootMapping["kind"], logicalPath: string): string | undefined {
  return kind === "drop" ? undefined : instructionNativePath(policyFor(kind), logicalPath);
}
export interface ScannedInstruction { namespace: string; logicalPath: string; bytes: Uint8Array; dispose(): Promise<void> }

export async function scanInstructions(mapping: RootMapping): Promise<ScannedInstruction[]> {
  if (mapping.kind === "drop") return [];
  const policy = policyFor(mapping.kind), snapshots = new Map<string, NativeFileSnapshot>();
  const directoryGuards: Array<() => Promise<void>> = [];
  let total = 0, inspected = 0;
  const guardAbsent = (path: string) => directoryGuards.push(async () => {
    if (await optionalStat(path)) throw new NativeFileError("NATIVE_FILE_CHANGED");
  });
  const capture = async (path: string) => {
    const absolute = join(mapping.path, path), present = await optionalStat(absolute);
    if (!present) { guardAbsent(absolute); return; }
    const snapshot = await readNativeFileSnapshot(mapping.path, path); snapshots.set(path, snapshot);
    if (snapshot.bytes === undefined) throw new NativeFileError("NATIVE_FILE_CHANGED");
    total += snapshot.bytes.byteLength;
    if (snapshots.size > MAX_INSTRUCTION_FILES || total > MAX_INSTRUCTION_SET_BYTES) throw new InstructionError("INSTRUCTION_FORMAT_INVALID");
  };
  const walk = async (directory: string): Promise<void> => {
    // Validate tree components before even enumerating their names.
    try { instructionLogicalPath(policy, `${directory}/context-probe.md`); } catch { return; }
    const path = join(mapping.path, directory), before = await optionalStat(path);
    if (!before) { guardAbsent(path); return; }
    if (!before.isDirectory() || (before.mode & 0o022) !== 0 || (process.getuid && process.getuid() !== before.uid)) throw new NativeFileError("NATIVE_FILE_UNSAFE");
    const identity = (info: typeof before) => JSON.stringify([info.dev, info.ino, info.mode, info.uid, info.mtimeMs, info.ctimeMs]);
    const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"));
    const names = entries.map((entry) => entry.name).sort().join("\0");
    directoryGuards.push(async () => {
      const after = await optionalStat(path);
      if (!after || identity(before) !== identity(after) || (await readdir(path)).sort().join("\0") !== names) throw new NativeFileError("NATIVE_FILE_CHANGED");
    });
    for (const entry of entries) {
      if (++inspected > 4096) throw new InstructionError("INSTRUCTION_FORMAT_INVALID");
      const relative = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new NativeFileError("NATIVE_FILE_UNSAFE");
      if (entry.isDirectory()) { await walk(relative); continue; }
      try { instructionLogicalPath(policy, relative); } catch { continue; }
      await capture(relative);
    }
  };
  try {
    for (const path of policy.files) await capture(path);
    for (const tree of policy.trees) await walk(tree);
    validateInstructionSet(policy, new Map([...snapshots].map(([path, snapshot]) => [path, snapshot.bytes!])));
    for (const snapshot of snapshots.values()) await snapshot.assertUnchanged();
    for (const guard of directoryGuards) await guard();
    return [...snapshots].sort(([a], [b]) => a.localeCompare(b, "en")).map(([path, snapshot]) => ({
      namespace: mapping.namespace, logicalPath: instructionLogicalPath(policy, path), bytes: snapshot.bytes!,
      async dispose() { snapshot.dispose(); },
    }));
  } catch (error) {
    for (const snapshot of snapshots.values()) snapshot.dispose();
    if (error instanceof InstructionError || error instanceof NativeFileError) throw error;
    throw new NativeFileError("NATIVE_FILE_UNSAFE");
  }
}

export type IncomingInstruction = IncomingNativeText;
export type InstructionPlan = NativeTextPlan;
export async function prepareInstructionPlan(
  incoming: readonly IncomingInstruction[], config: LocalConfig,
  epoch: (namespace: string) => number,
  digest: (namespace: string, epoch: number, bytes: Uint8Array) => Promise<string>,
): Promise<InstructionPlan> {
  return prepareNativeTextPlan(incoming, config, epoch, digest, {
    nativePath: (mapping, path) => instructionPath(mapping.kind, path),
    validate: (mapping, files) => validateInstructionSet(policyFor(mapping.kind), files),
    invalid: () => new InstructionError("INSTRUCTION_FORMAT_INVALID"),
  });
}
async function optionalStat(path: string) {
  try { return await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new NativeFileError("NATIVE_FILE_UNSAFE");
  }
}
