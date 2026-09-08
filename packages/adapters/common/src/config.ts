// The pinned package's default UMD build hides require() from static bundlers.
// Its ESM entry keeps the standalone CLI independent of parser runtime files.
import { applyEdits, findNodeAtLocation, modify, parseTree, type Node as JsonNode, type ParseError } from "jsonc-parser/lib/esm/main.js";
import { parseTOML, type AST } from "toml-eslint-parser";

export type SettingsFormat = "json" | "toml";
export type SettingValue = string | number | boolean | string[];
export interface SettingRule { path: readonly string[]; validate(value: unknown): boolean }
export interface SettingPatch { key: string; value?: unknown }
export interface PortableSetting { key: string; value: SettingValue }
const MAX_BYTES = 1024 * 1024;
const MAX_NODES = 20_000;

export class ConfigFormatError extends Error {
  readonly code = "CONFIG_FORMAT_INVALID";
  constructor() { super("portable configuration is invalid, unsupported, or exceeds its safety limits"); this.name = "ConfigFormatError"; }
}

/** Pure projection: unknown fields and their values never leave this function. */
export function projectSettings(bytes: Uint8Array, format: SettingsFormat, rules: readonly SettingRule[]): PortableSetting[] {
  return safely(() => project(decode(bytes), format, policy(rules)));
}

/** Pure syntax-range edits; callers must guard and transact the actual file. */
export function patchSettings(bytes: Uint8Array | undefined, format: SettingsFormat, rules: readonly SettingRule[], patches: readonly SettingPatch[]): Uint8Array {
  return safely(() => {
    const fields = policy(rules);
    let source = bytes === undefined ? (format === "json" ? "{}\n" : "") : decode(bytes);
    const before = new Map(project(source, format, fields).map((field) => [field.key, field.value]));
    const seen = new Set<string>();
    if (patches.length > fields.size) throw new ConfigFormatError();
    for (const patch of patches) {
      const rule = fields.get(patch.key);
      if (!rule || seen.has(patch.key) || Object.keys(patch).some((key) => key !== "key" && key !== "value")) throw new ConfigFormatError();
      seen.add(patch.key);
      if (patch.value !== undefined) validate(patch.value, rule);
    }
    for (const patch of patches) {
      if (JSON.stringify(before.get(patch.key)) === JSON.stringify(patch.value)) continue;
      const path = fields.get(patch.key)!.path;
      source = format === "json"
        ? applyEdits(source, modify(source, [...path], patch.value, {}))
        : patchToml(source, path, patch.value as SettingValue | undefined);
      if (Buffer.byteLength(source) > MAX_BYTES) throw new ConfigFormatError();
    }
    const after = new Map(project(source, format, fields).map((field) => [field.key, field.value]));
    for (const patch of patches) {
      if (JSON.stringify(after.get(patch.key)) !== JSON.stringify(patch.value)) throw new ConfigFormatError();
    }
    const bom = bytes?.[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const output = new TextEncoder().encode((bom ? "\uFEFF" : "") + source);
    if (output.byteLength > MAX_BYTES) throw new ConfigFormatError();
    return output;
  });
}

function safely<T>(action: () => T): T {
  try { return action(); } catch { throw new ConfigFormatError(); }
}
function decode(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_BYTES) throw new ConfigFormatError();
  return new TextDecoder("utf8", { fatal: true, ignoreBOM: false }).decode(bytes);
}
function policy(rules: readonly SettingRule[]): Map<string, SettingRule> {
  if (rules.length > 128) throw new ConfigFormatError();
  const fields = new Map<string, SettingRule>();
  for (const rule of rules) {
    if (!rule.path.length || rule.path.length > 8 || rule.path.some((part) => !/^[A-Za-z][A-Za-z0-9_]*$/u.test(part) || ["__proto__", "prototype", "constructor"].includes(part))) throw new ConfigFormatError();
    const key = rule.path.join(".");
    if ([...fields.keys()].some((existing) => existing === key || existing.startsWith(`${key}.`) || key.startsWith(`${existing}.`))) throw new ConfigFormatError();
    fields.set(key, rule);
  }
  return fields;
}
function isValue(value: unknown): value is SettingValue {
  return typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) ||
    (typeof value === "string" && Buffer.byteLength(value) <= 64 * 1024) ||
    (Array.isArray(value) && value.length <= 256 && value.every((item) => typeof item === "string" && Buffer.byteLength(item) <= 1024));
}
function validate(value: unknown, rule: SettingRule): asserts value is SettingValue {
  if (!isValue(value) || !rule.validate(value)) throw new ConfigFormatError();
}

function project(source: string, format: SettingsFormat, fields: ReadonlyMap<string, SettingRule>): PortableSetting[] {
  const json = format === "json" ? parseJson(source) : undefined;
  const toml = format === "toml" ? parseToml(source) : undefined;
  if (!json && !toml) throw new ConfigFormatError();
  const output: PortableSetting[] = [];
  for (const [key, rule] of fields) {
    let value: unknown;
    if (json) {
      for (let depth = 1; depth < rule.path.length; depth++) {
        const parent = findNodeAtLocation(json, rule.path.slice(0, depth));
        if (parent && parent.type !== "object") throw new ConfigFormatError();
      }
      const node = findNodeAtLocation(json, [...rule.path]);
      if (!node) continue;
      value = JSON.parse(source.slice(node.offset, node.offset + node.length));
    } else {
      for (let depth = 1; depth <= rule.path.length; depth++) {
        const prefix = rule.path.slice(0, depth);
        const parent = toml!.pairs.get(JSON.stringify(prefix));
        if (depth < rule.path.length && parent && parent.value.type !== "TOMLInlineTable") throw new ConfigFormatError();
        if (toml!.containers.some((container) => container.node.type === "TOMLTable" && container.node.kind === "array" &&
            samePath(container.path.filter((part) => typeof part === "string"), prefix))) throw new ConfigFormatError();
      }
      const pair = toml!.pairs.get(JSON.stringify(rule.path));
      if (!pair) {
        // A table at an expected scalar/array field is invalid, not absent.
        if (toml!.containers.some((container) => samePath(container.path, rule.path))) throw new ConfigFormatError();
        continue;
      }
      value = tomlValue(pair.value);
    }
    validate(value, rule);
    output.push({ key, value });
  }
  return output.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

function parseJson(source: string): JsonNode {
  const errors: ParseError[] = [];
  const root = parseTree(source, errors, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  if (errors.length || !root || root.type !== "object") throw new ConfigFormatError();
  const pending = [{ node: root, depth: 0 }]; let count = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++count > MAX_NODES || depth > 64) throw new ConfigFormatError();
    if (node.type === "object") {
      const keys = new Set<string>();
      for (const property of node.children ?? []) {
        const key = property.children![0]!.value as string;
        if (keys.has(key)) throw new ConfigFormatError(); keys.add(key);
      }
    }
    for (const child of node.children ?? []) pending.push({ node: child, depth: depth + 1 });
  }
  return root;
}

type TomlContainer = AST.TOMLTopLevelTable | AST.TOMLTable | AST.TOMLInlineTable;
interface TomlIndex {
  pairs: Map<string, AST.TOMLKeyValue>;
  containers: Array<{ path: readonly (string | number)[]; node: TomlContainer }>;
}
function parseToml(source: string): TomlIndex {
  const ast = parseTOML(source, { tomlVersion: "1.0" });
  const pairs = new Map<string, AST.TOMLKeyValue>();
  const containers: TomlIndex["containers"] = [];
  let count = 0;
  const visit = (node: AST.TOMLNode, path: readonly (string | number)[], depth: number): void => {
    if (++count > MAX_NODES || depth > 64) throw new ConfigFormatError();
    if (node.type === "TOMLTopLevelTable" || node.type === "TOMLTable" || node.type === "TOMLInlineTable") {
      const resolved = node.type === "TOMLTable" ? node.resolvedKey : path;
      containers.push({ path: resolved, node });
      for (const child of node.body) visit(child, resolved, depth + 1);
    } else if (node.type === "TOMLKeyValue") {
      const resolved = [...path, ...node.key.keys.map((key) => key.type === "TOMLBare" ? key.name : key.value)];
      pairs.set(JSON.stringify(resolved), node);
      visit(node.value, resolved, depth + 1);
    } else if (node.type === "TOMLArray") {
      for (let i = 0; i < node.elements.length; i++) visit(node.elements[i]!, [...path, i], depth + 1);
    }
  };
  visit(ast.body[0], [], 0);
  return { pairs, containers };
}
function tomlValue(node: AST.TOMLContentNode): unknown {
  if (node.type === "TOMLArray") return node.elements.map(tomlValue);
  if (node.type === "TOMLValue") return node.value;
  throw new ConfigFormatError();
}
function samePath(left: readonly (string | number)[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, i) => part === right[i]);
}
function patchToml(source: string, path: readonly string[], value: SettingValue | undefined): string {
  const parsed = parseToml(source);
  const pair = parsed.pairs.get(JSON.stringify(path));
  if (pair) {
    if (value !== undefined) return replace(source, pair.value.range, tomlLiteral(value));
    if (pair.parent.type !== "TOMLInlineTable") return replace(source, pair.range, "");
    const siblings = pair.parent.body;
    const index = siblings.indexOf(pair);
    const next = siblings[index + 1]; const prior = siblings[index - 1];
    return replace(source, next ? [pair.range[0], next.range[0]] : prior ? [prior.range[1], pair.range[1]] : pair.range, "");
  }
  if (value === undefined) return source;
  const owner = parsed.containers.filter((container) => container.path.length < path.length && container.path.every((part, i) => part === path[i]))
    .sort((a, b) => b.path.length - a.path.length)[0]!;
  const assignment = `${path.slice(owner.path.length).map((part) => JSON.stringify(part)).join(".")} = ${tomlLiteral(value)}`;
  if (owner.node.type === "TOMLInlineTable") {
    const offset = owner.node.range[1] - 1;
    return replace(source, [offset, offset], `${owner.node.body.length ? ", " : ""}${assignment}`);
  }
  if (owner.node.type === "TOMLTopLevelTable") return `${assignment}\n${source}`;
  const lineEnd = source.indexOf("\n", owner.node.key.range[1]);
  const offset = lineEnd === -1 ? source.length : lineEnd + 1;
  return replace(source, [offset, offset], `${lineEnd === -1 ? "\n" : ""}${assignment}\n`);
}
function tomlLiteral(value: SettingValue): string {
  if (typeof value === "string") return JSON.stringify(value).replaceAll("\u007f", "\\u007f");
  if (Array.isArray(value)) return `[${value.map((item) => tomlLiteral(item)).join(", ")}]`;
  return String(value);
}
function replace(source: string, range: readonly [number, number], value: string): string {
  return source.slice(0, range[0]) + value + source.slice(range[1]);
}
