import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { constants, lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { LocalConfig } from "./config.js";
import { nativeLockSchema, prepareNativeLock } from "./native-lock.js";
import { ProfileFormatError } from "./profile-format.js";

const pathSchema = z.string().min(1).max(4096);
const layoutSchema = z.object({ root: pathSchema, gitDir: pathSchema, commonDir: pathSchema, indexPath: pathSchema,
  observations: z.array(z.object({ path: pathSchema, identity: z.string().min(1).max(8192) }).strict()).min(4).max(6) }).strict();
export const gitIndexSchema = z.object({ layout: layoutSchema, lock: nativeLockSchema }).strict();
export type GitIndexParticipant = z.infer<typeof gitIndexSchema>;
type Layout = z.infer<typeof layoutSchema>;
const execute = promisify(execFile), fail = () => new ProfileFormatError("PROFILE_RECOVERY_REQUIRED");

/** Discover from the persisted selected workspace, not caller/journal paths.
 * Admission asks Git for agreement; replay uses the retained stable locator
 * observations and works even while a future HEAD participant is absent. */
export async function prepareGitIndexes(config: LocalConfig, roots: readonly string[]): Promise<GitIndexParticipant[]> {
  try { return await prepareIndexes(config, roots); } catch { throw fail(); }
}
async function prepareIndexes(config: LocalConfig, roots: readonly string[]): Promise<GitIndexParticipant[]> {
  validateWorkspaceSelection(config, roots);
  const layouts: Layout[] = [];
  for (const root of roots) {
    const layout = await observeLayout(root);
    const result = await execute("git", ["-c", "core.fsmonitor=false", "-C", root, "rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir", "--git-path", "index"], {
      timeout: 10000, maxBuffer: 32 * 1024, encoding: "utf8",
      // No ambient GIT_DIR/INDEX_FILE/WORK_TREE/COMMON_DIR/config injection.
      // This local metadata query needs no credential or operator global config.
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", LANG: "C", LC_ALL: "C" } as unknown as NodeJS.ProcessEnv,
    });
    const reported = result.stdout.trimEnd().split("\n"), expected = [root, layout.gitDir, layout.commonDir, layout.indexPath];
    if (reported.length !== expected.length) throw fail();
    for (let index = 0; index < expected.length; index++) {
      if (!canonical(reported[index]) || await physical(reported[index]) !== await physical(expected[index])) throw fail();
    }
    if (JSON.stringify(await observeLayout(root)) !== JSON.stringify(layout)) throw fail();
    const currentIndex = await optionalStat(layout.indexPath);
    if (currentIndex && (!currentIndex.isFile() || currentIndex.nlink !== 1n)) throw fail();
    layouts.push(layout);
  }
  if (new Set(layouts.map(layout => layout.indexPath)).size !== layouts.length) throw fail();
  const grants = layouts.map(layout => ({ root: layout.gitDir, path: `${layout.indexPath}.lock` }));
  const participants: GitIndexParticipant[] = [];
  for (const layout of layouts) participants.push({ layout, lock: await prepareNativeLock(`${layout.indexPath}.lock`, { grants }) });
  return participants;
}

/** A serialized descriptor never grants itself authority. Re-derive all paths
 * from the original profile's selected root and its current native gitfile. */
export async function validateGitIndexes(config: LocalConfig, values: readonly GitIndexParticipant[]): Promise<void> {
  try {
    const participants = z.array(gitIndexSchema).max(32).parse(values);
    validateWorkspaceSelection(config, participants.map(participant => participant.layout.root));
    if (new Set(participants.map(participant => participant.layout.indexPath)).size !== participants.length) throw fail();
    for (const { layout, lock } of participants) {
      if (JSON.stringify(await observeLayout(layout.root)) !== JSON.stringify(layout) ||
          lock.root !== layout.gitDir || lock.path !== `${layout.indexPath}.lock`) throw fail();
    }
  } catch { throw fail(); }
}
export function gitIndexGrants(participants: readonly GitIndexParticipant[]): Array<{ root: string; path: string }> {
  return participants.map(({ layout }) => ({ root: layout.gitDir, path: `${layout.indexPath}.lock` }));
}
export function gitIndexFiles(participants: readonly GitIndexParticipant[]): string[] { return participants.map(({ layout }) => layout.indexPath); }
export function gitMetadataExclusions(config: LocalConfig, participants: readonly GitIndexParticipant[]): string[] {
  return [...new Set([...config.workspaces.map(workspace => join(resolve(workspace.path), ".git")), ...participants.flatMap(({ layout }) => [layout.gitDir, layout.commonDir])])];
}

export function validateWorkspaceSelection(config: LocalConfig, roots: readonly string[]) {
  if (roots.length > 32 || new Set(roots).size !== roots.length || roots.some(root => !canonical(root) ||
      !config.workspaces.some(workspace => workspace.sync !== "identity-only" && resolve(workspace.path) === root))) throw fail();
}
async function observeLayout(root: string): Promise<Layout> {
  if (!canonical(root)) throw fail();
  const observations: Layout["observations"] = [];
  const recordDirectory = async (path: string) => {
    if (!canonical(path)) throw fail();
    const info = await lstat(path, { bigint: true }); if (!info.isDirectory()) throw fail();
    observations.push({ path, identity: `directory:${identity(info)}:${await realpath(path)}` });
  };
  await recordDirectory(root);
  const locator = join(root, ".git"), locatorInfo = await lstat(locator, { bigint: true });
  let gitDir: string;
  if (locatorInfo.isDirectory()) { gitDir = locator; await recordDirectory(locator); }
  else {
    const value = await readPointer(locator, locatorInfo); observations.push({ path: locator, identity: value.identity });
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(value.text); if (!match) throw fail();
    gitDir = resolve(root, match[1]); await recordDirectory(gitDir);
  }
  const commonPath = join(gitDir, "commondir"), commonInfo = await optionalStat(commonPath);
  let commonDir = gitDir;
  if (commonInfo) {
    const value = await readPointer(commonPath, commonInfo); observations.push({ path: commonPath, identity: value.identity });
    const match = /^([^\r\n]+)\r?\n?$/u.exec(value.text); if (!match) throw fail();
    commonDir = resolve(gitDir, match[1]);
  } else observations.push({ path: commonPath, identity: "absent" });
  await recordDirectory(commonDir);
  return layoutSchema.parse({ root, gitDir, commonDir, indexPath: join(gitDir, "index"), observations });
}
async function readPointer(path: string, before: BigIntStats) {
  if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > 4096n) throw fail();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK), bytes = Buffer.alloc(Number(before.size) + 1);
  try {
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== Number(before.size) || stable(await handle.stat({ bigint: true })) !== stable(before) || stable(await lstat(path, { bigint: true })) !== stable(before)) throw fail();
    const content = bytes.subarray(0, bytesRead), text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
    return { text, identity: `file:${stable(before)}:${createHash("sha256").update(content).digest("hex")}` };
  } finally { bytes.fill(0); await handle.close(); }
}
function canonical(path: string) { return isAbsolute(path) && resolve(path) === path && path.length <= 4096 && ![...path].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127); }
function identity(info: BigIntStats) { return [info.dev, info.ino, info.mode, info.uid].map(String).join(":"); }
function stable(info: BigIntStats) { return `${identity(info)}:${info.nlink}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`; }
async function physical(path: string) { return join(await realpath(dirname(path)), path.slice(dirname(path).length + 1)); }
async function optionalStat(path: string) {
  try { return await lstat(path, { bigint: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
