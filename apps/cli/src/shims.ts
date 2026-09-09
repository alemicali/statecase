import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { HarnessName } from "./supervisor.js";

const MARKER = "# statecase-shim-v1";

export interface ShimInstallOptions {
  harness: HarnessName;
  shimPath: string;
  statecaseExecutable: string;
  realExecutable: string;
}

export interface ShimInstallResult {
  created: boolean;
  shimPath: string;
  realExecutable: string;
}

export async function installHarnessShim(options: ShimInstallOptions): Promise<ShimInstallResult> {
  const shimPath = resolve(options.shimPath);
  const realExecutable = resolve(options.realExecutable);
  if (shimPath === realExecutable) throw new Error("real harness executable resolves to the shim destination");
  const contents = renderShim(options.harness, resolve(options.statecaseExecutable), realExecutable);
  const existing = await optionalContents(shimPath);
  if (existing !== undefined) {
    if (!isStatecaseShim(existing)) throw new Error(`refusing to replace non-Statecase executable: ${shimPath}`);
    if (existing === contents) return { created: false, shimPath, realExecutable };
  }
  await mkdir(dirname(shimPath), { recursive: true, mode: 0o700 });
  const temporary = `${shimPath}.statecase-${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o700);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, 0o700);
  await rename(temporary, shimPath).catch(async (error) => {
    await rm(temporary, { force: true });
    throw error;
  });
  await chmod(shimPath, 0o700);
  return { created: true, shimPath, realExecutable };
}

export async function verifyHarnessShim(path: string): Promise<boolean> {
  const contents = await optionalContents(resolve(path));
  return contents !== undefined && isStatecaseShim(contents);
}

export async function removeHarnessShim(path: string): Promise<boolean> {
  const shimPath = resolve(path);
  const contents = await optionalContents(shimPath);
  if (contents === undefined) return false;
  if (!isStatecaseShim(contents)) throw new Error(`refusing to remove non-Statecase executable: ${shimPath}`);
  await rm(shimPath);
  return true;
}

function renderShim(harness: HarnessName, statecaseExecutable: string, realExecutable: string): string {
  return [
    "#!/bin/sh",
    `${MARKER} harness=${harness}`,
    `exec ${shellQuote(statecaseExecutable)} run ${shellQuote(harness)} --executable ${shellQuote(realExecutable)} -- "$@"`,
    "",
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isStatecaseShim(contents: string): boolean {
  return contents.startsWith("#!/bin/sh\n") && contents.split("\n", 3)[1]?.startsWith(MARKER) === true;
}

async function optionalContents(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`refusing unsafe shim path: ${path}`);
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
