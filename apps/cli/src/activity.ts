import { lstat, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

import { ProfileLock } from "@statecase/runtime";

export type ActivityHarness = "codex" | "claude";

export interface ActivityHandle {
  release(): Promise<void>;
}

interface ActivityMarker {
  version: 1;
  pid: number;
  token: string;
}

interface ActivityDependencies {
  pid?: number;
  isAlive?: (pid: number) => boolean;
}

const runFile = promisify(execFile);

/** Coordinates multiple harness readers with an exclusive in-place-restore barrier. */
export class HarnessActivityRegistry {
  readonly #root: string;
  readonly #pid: number;
  readonly #isAlive: (pid: number) => boolean;

  constructor(root: string, dependencies: ActivityDependencies = {}) {
    this.#root = resolve(root);
    this.#pid = dependencies.pid ?? process.pid;
    this.#isAlive = dependencies.isAlive ?? processIsAlive;
    if (!Number.isSafeInteger(this.#pid) || this.#pid <= 0) throw new TypeError("harness activity PID is invalid");
  }

  async enter(harness: ActivityHarness): Promise<ActivityHandle> {
    const directory = join(this.#root, "active", harness);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (await exists(this.#barrierPath(harness))) throw new Error(`${harness} restore is in progress`);
    const marker: ActivityMarker = { version: 1, pid: this.#pid, token: crypto.randomUUID() };
    const path = join(directory, `${this.#pid}-${marker.token}.json`);
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (await exists(this.#barrierPath(harness))) {
      await rm(path, { force: true });
      throw new Error(`${harness} restore is in progress`);
    }
    let released = false;
    return {
      release: async () => {
        if (released) return;
        const current = await readMarker(path);
        if (current.pid !== marker.pid || current.token !== marker.token) {
          throw new Error("harness activity marker ownership changed");
        }
        await rm(path);
        released = true;
      },
    };
  }

  async beginRestore(harness: ActivityHarness): Promise<ActivityHandle> {
    const barrier = await ProfileLock.acquire(this.#barrierPath(harness), { pid: this.#pid, isAlive: this.#isAlive });
    try {
      const directory = join(this.#root, "active", harness);
      const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const name of entries.sort((left, right) => left.localeCompare(right, "en"))) {
        const path = join(directory, name);
        const marker = await readMarker(path);
        if (this.#isAlive(marker.pid)) throw new Error(`${harness} harness is active with PID ${marker.pid}`);
        await rm(path, { force: true });
      }
      return { release: () => barrier.release() };
    } catch (error) {
      await barrier.release();
      throw error;
    }
  }

  #barrierPath(harness: ActivityHarness): string {
    return join(this.#root, `restore-${harness}.lock`);
  }
}

export async function assertNoHarnessProcess(
  harness: ActivityHarness,
  options: { currentPid?: number; processTable?: () => Promise<string> } = {},
): Promise<void> {
  const currentPid = options.currentPid ?? process.pid;
  const table = options.processTable ? await options.processTable() : await systemProcessTable();
  const active: number[] = [];
  for (const line of table.split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)\s*(.*)$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === currentPid) continue;
    const command = basename(match[2]!).toLowerCase();
    const firstArguments = match[3]!.trim().split(/\s+/u).slice(0, 2);
    if (commandMatchesHarness(command, harness) || firstArguments.some((argument) => argumentMatchesHarness(argument, harness))) {
      active.push(pid);
    }
  }
  if (active.length > 0) throw new Error(`${harness} harness is active with PID ${active.sort((left, right) => left - right).join(", ")}`);
}

async function readMarker(path: string): Promise<ActivityMarker> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ActivityMarker>;
    if (parsed.version !== 1 || !Number.isSafeInteger(parsed.pid) || parsed.pid! <= 0 ||
        typeof parsed.token !== "string" || !/^[0-9a-f-]{36}$/u.test(parsed.token)) {
      throw new Error("invalid");
    }
    return parsed as ActivityMarker;
  } catch {
    throw new Error("invalid harness activity marker");
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function systemProcessTable(): Promise<string> {
  try {
    return (await runFile("ps", ["-A", "-o", "pid=", "-o", "comm=", "-o", "args="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })).stdout;
  } catch {
    throw new Error("could not verify that the harness is stopped");
  }
}

function commandMatchesHarness(command: string, harness: ActivityHarness): boolean {
  return command === harness || command.startsWith(`${harness}-`);
}

function argumentMatchesHarness(argument: string, harness: ActivityHarness): boolean {
  const normalized = argument.replaceAll("\\", "/").toLowerCase();
  const name = basename(normalized);
  if (commandMatchesHarness(name, harness)) return true;
  return harness === "claude" ? normalized.includes("/claude-code/") : normalized.includes("/@openai/codex/");
}
