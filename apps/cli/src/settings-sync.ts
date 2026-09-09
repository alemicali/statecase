import { codexSettingsDocument } from "@statecase/adapter-codex/config";
import { claudeSettingsDocument } from "@statecase/adapter-claude/config";
import { decodeSetting, resolveSettingPath, type SettingsDocument, type SettingsField } from "@statecase/adapter-common/settings-transport";
import type { SettingPatch } from "@statecase/adapter-common/config";
import type { LocalConfig, RootMapping } from "./config.js";
import type { MaterializedWrite } from "./materialize.js";
import { readSettingsSnapshot, type SettingsSnapshot } from "./settings-file.js";

export function settingsDocuments(kind: RootMapping["kind"]): readonly SettingsDocument[] {
  return kind === "drop" ? [] : [kind === "codex" ? codexSettingsDocument : claudeSettingsDocument];
}
export function settingsField(kind: RootMapping["kind"], path: string): SettingsField | undefined {
  return kind === "drop" ? undefined : resolveSettingPath(settingsDocuments(kind), path);
}
export interface IncomingSetting {
  mapping: RootMapping;
  logicalPath: string;
  field: SettingsField;
  /** Absence is a field tombstone, never a native-file deletion. */
  bytes?: Uint8Array;
}
export interface SettingsPlan {
  writes: MaterializedWrite[];
  targets: Array<{ mapping: RootMapping; logicalPath: string; path: string }>;
  digests: Array<{ namespace: string; logicalPath: string; digest: string }>;
  conflicts: string[];
  guard(path?: string): Promise<void>;
  dispose(): void;
}

/** Group field edits into one guarded native-file replacement per document. */
export async function prepareSettingsPlan(
  incoming: readonly IncomingSetting[],
  config: LocalConfig,
  appliedEpoch: (namespace: string) => number,
  digest: (namespace: string, epoch: number, bytes: Uint8Array) => Promise<string>,
): Promise<SettingsPlan> {
  const snapshots = new Map<string, SettingsSnapshot>();
  const groups = new Map<string, IncomingSetting[]>();
  const writes: MaterializedWrite[] = [];
  const targets: SettingsPlan["targets"] = [];
  const digests: SettingsPlan["digests"] = [];
  const conflicts: string[] = [];
  const dispose = () => { for (const snapshot of snapshots.values()) snapshot.dispose(); for (const write of writes) write.bytes?.fill(0); };
  try {
    for (const item of incoming) {
      const id = `${item.mapping.namespace}\0${item.field.document.id}`;
      const group = groups.get(id) ?? [];
      if (group.some((candidate) => candidate.logicalPath === item.logicalPath)) throw new Error("duplicate portable setting mutation");
      group.push(item); groups.set(id, group);
    }
    for (const [id, group] of groups) {
      const { mapping, field } = group[0]!;
      const snapshot = await readSettingsSnapshot(mapping.path, field.document); snapshots.set(id, snapshot);
      targets.push({ mapping, logicalPath: `portable-config/v1/${field.document.id}`, path: snapshot.path });
      const local = new Map(snapshot.entries.map((entry) => [entry.logicalPath, entry.bytes]));
      const patches: SettingPatch[] = [];
      for (const item of group) {
        const value = item.bytes ? decodeSetting(item.bytes, item.field) : undefined;
        if (item.bytes) digests.push({ namespace: mapping.namespace, logicalPath: item.logicalPath, digest: await digest(mapping.namespace, appliedEpoch(mapping.namespace), item.bytes) });
        const current = local.get(item.logicalPath);
        if (equal(current, item.bytes)) continue;
        const prior = config.applied[mapping.namespace]?.digests[item.logicalPath];
        const currentDigest = current ? await digest(mapping.namespace, config.applied[mapping.namespace]?.keyEpoch ?? 1, current) : undefined;
        if (currentDigest !== prior) conflicts.push(`${mapping.namespace}:${item.logicalPath}`);
        patches.push({ key: item.field.key, ...(value !== undefined ? { value } : {}) });
      }
      if (patches.length) writes.push({ path: snapshot.path, bytes: snapshot.patch(patches), mode: 0o600 });
    }
    return {
      writes, targets, digests, conflicts,
      async guard(path) { for (const snapshot of snapshots.values()) if (path === undefined || snapshot.path === path) await snapshot.assertUnchanged(); },
      dispose,
    };
  } catch (error) { dispose(); throw error; }
}
function equal(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  return a === undefined || b === undefined ? a === b : a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);
}
