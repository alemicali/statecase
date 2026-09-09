import type { LocalConfig, RootMapping } from "./config.js";
import type { MaterializedWrite } from "./materialize.js";
import { readNativeFileSnapshot, type NativeFileSnapshot } from "./native-file.js";

export interface IncomingNativeText { mapping: RootMapping; logicalPath: string; bytes?: Uint8Array }
export interface NativeTextPlan {
  writes: MaterializedWrite[]; deletes: string[];
  targets: Array<{ mapping: RootMapping; logicalPath: string; path: string }>;
  digests: Array<{ namespace: string; logicalPath: string; digest: string }>;
  conflicts: string[];
  guard(path?: string): Promise<void>;
  dispose(): void;
}
export interface NativeTextPolicy {
  nativePath(mapping: RootMapping, logicalPath: string): string | undefined;
  validate(mapping: RootMapping, files: ReadonlyMap<string, Uint8Array>): void;
  invalid(): Error;
}

/** Common native-text transaction preparation, with explicit per-context path
 * and content policy. Callers must authenticate collection metadata first. */
export async function prepareNativeTextPlan(
  incoming: readonly IncomingNativeText[], config: LocalConfig,
  epoch: (namespace: string) => number,
  digest: (namespace: string, epoch: number, bytes: Uint8Array) => Promise<string>,
  policy: NativeTextPolicy,
): Promise<NativeTextPlan> {
  const groups = new Map<string, IncomingNativeText[]>(), snapshots = new Map<string, NativeFileSnapshot>();
  const writes: MaterializedWrite[] = [], deletes: string[] = [], targets: NativeTextPlan["targets"] = [], digests: NativeTextPlan["digests"] = [], conflicts: string[] = [];
  const dispose = () => { for (const snapshot of snapshots.values()) snapshot.dispose(); for (const item of incoming) item.bytes?.fill(0); };
  try {
    for (const item of incoming) { const group = groups.get(item.mapping.namespace) ?? []; group.push(item); groups.set(item.mapping.namespace, group); }
    for (const group of groups.values()) {
      const mapping = group[0]!.mapping, files = new Map<string, Uint8Array>(), seen = new Set<string>();
      for (const item of group) {
        const path = policy.nativePath(mapping, item.logicalPath);
        if (!path || seen.has(path) || item.mapping.path !== mapping.path || item.mapping.kind !== mapping.kind) throw policy.invalid();
        seen.add(path); if (item.bytes !== undefined) files.set(path, item.bytes);
      }
      policy.validate(mapping, files);
      for (const item of group) {
        const path = policy.nativePath(mapping, item.logicalPath)!;
        const snapshot = await readNativeFileSnapshot(mapping.path, path);
        if (snapshots.has(snapshot.path)) { snapshot.dispose(); throw policy.invalid(); }
        snapshots.set(snapshot.path, snapshot);
        targets.push({ mapping, logicalPath: item.logicalPath, path: snapshot.path });
        if (item.bytes !== undefined) digests.push({ namespace: mapping.namespace, logicalPath: item.logicalPath, digest: await digest(mapping.namespace, epoch(mapping.namespace), item.bytes) });
        const current = snapshot.bytes;
        if (current === undefined ? item.bytes === undefined : item.bytes !== undefined && Buffer.from(current).equals(item.bytes)) continue;
        const prior = config.applied[mapping.namespace]?.digests[item.logicalPath];
        const actual = current === undefined ? undefined : await digest(mapping.namespace, config.applied[mapping.namespace]?.keyEpoch ?? 1, current);
        if (prior !== actual) conflicts.push(`${mapping.namespace}:${item.logicalPath}`);
        if (item.bytes === undefined) deletes.push(snapshot.path); else writes.push({ path: snapshot.path, bytes: item.bytes, mode: 0o600 });
      }
    }
    return { writes, deletes, targets, digests, conflicts,
      async guard(path) { for (const snapshot of snapshots.values()) if (path === undefined || snapshot.path === path) await snapshot.assertUnchanged(); }, dispose };
  } catch (error) { dispose(); throw error; }
}
