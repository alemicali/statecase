import { ConfigFormatError, projectSettings, type SettingRule, type SettingValue, type SettingsFormat } from "./config.js";

export interface SettingsDocument {
  readonly id: string;
  /** Fixed adapter-owned basename, never supplied by a remote manifest. */
  readonly nativePath: string;
  readonly format: SettingsFormat;
  readonly rules: readonly SettingRule[];
}
export interface SettingsField { document: SettingsDocument; key: string }
export interface SettingsEntry { logicalPath: string; bytes: Uint8Array }
export const MAX_SETTING_BYTES = 128 * 1024;
const PREFIX = "portable-config/";
const encoder = new TextEncoder();

export function projectSettingEntries(bytes: Uint8Array, document: SettingsDocument): SettingsEntry[] {
  assertRegistry([document]);
  return projectSettings(bytes, document.format, document.rules).map((field) => ({
    logicalPath: `${PREFIX}v1/${document.id}/${field.key}.json`,
    bytes: encodeSetting(document, field.key, field.value),
  }));
}

/** Unknown reserved paths fail closed; ordinary harness paths are not fields. */
export function resolveSettingPath(documents: readonly SettingsDocument[], path: string): SettingsField | undefined {
  if (!path.startsWith(PREFIX) && path !== "portable-config") return undefined;
  assertRegistry(documents);
  const match = /^portable-config\/v1\/([a-z][a-z0-9_-]{0,63})\/([A-Za-z][A-Za-z0-9_.]*)\.json$/u.exec(path);
  const document = match && documents.find((candidate) => candidate.id === match[1]);
  const key = match?.[2];
  if (!document || !key || !document.rules.some((rule) => rule.path.join(".") === key)) throw new ConfigFormatError();
  return { document, key };
}

export function encodeSetting(document: SettingsDocument, key: string, value: unknown): Uint8Array {
  try {
    assertRegistry([document]);
    const rule = document.rules.find((candidate) => candidate.path.join(".") === key);
    if (!rule) throw new ConfigFormatError();
    const serialized = JSON.stringify({ value, version: 1 });
    const bytes = encoder.encode(serialized);
    if (bytes.byteLength > MAX_SETTING_BYTES) throw new ConfigFormatError();
    // Reuse primitive/resource validation, never evaluate unknown native fields.
    const projected = projectSettings(bytes, "json", [{ path: ["value"], validate: rule.validate }]);
    if (projected.length !== 1 || JSON.stringify(projected[0]!.value) !== JSON.stringify(value)) throw new ConfigFormatError();
    return bytes;
  } catch { throw new ConfigFormatError(); }
}

export function decodeSetting(bytes: Uint8Array, field: SettingsField): SettingValue {
  try {
    if (bytes.byteLength > MAX_SETTING_BYTES) throw new ConfigFormatError();
    const source = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const payload: unknown = JSON.parse(source);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ConfigFormatError();
    const canonical = encodeSetting(field.document, field.key, (payload as { value?: unknown }).value);
    if (source !== new TextDecoder().decode(canonical)) throw new ConfigFormatError();
    return (payload as { value: SettingValue }).value;
  } catch { throw new ConfigFormatError(); }
}

function assertRegistry(documents: readonly SettingsDocument[]): void {
  const ids = new Set<string>(); const paths = new Set<string>();
  for (const document of documents) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(document.id) || !/^[A-Za-z0-9_-]+\.(?:toml|json)$/u.test(document.nativePath) ||
        ids.has(document.id) || paths.has(document.nativePath)) throw new ConfigFormatError();
    ids.add(document.id); paths.add(document.nativePath);
    // Validates field identity rules independently from the source document.
    projectSettings(encoder.encode(document.format === "json" ? "{}" : ""), document.format, document.rules);
  }
}
