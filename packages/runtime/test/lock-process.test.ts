import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = []; const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) await kill(child);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "statecase-lock-process-")); roots.push(root);
  const executable = join(root, "peer.cjs");
  const sqlite = createRequire(import.meta.url).resolve("better-sqlite3");
  await build({ entryPoints: [resolve(import.meta.dirname, "fixtures", "lock-peer.ts")], outfile: executable, bundle: true,
    platform: "node", format: "cjs", target: "node22", logLevel: "silent",
    plugins: [{ name: "native-sqlite", setup(builder) { builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: sqlite, external: true })); } }] });
  const spawn = async () => {
    const child = fork(executable, [], { cwd: root, execArgv: ["--expose-gc"], env: { PATH: process.env.PATH, HOME: root } as unknown as NodeJS.ProcessEnv, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    children.push(child); expect((await response(child)).result).toBe("ready"); return child;
  };
  return { root, path: join(root, "daemon.lock"), spawn };
}
function response(child: ChildProcess): Promise<{ result: string; point?: string }> {
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => { clean(); reject(new Error("fixture IPC timed out")); }, 5000);
    const ended = () => { clean(); reject(new Error("fixture exited before IPC response")); };
    const receive = (value: { result: string; point?: string }) => { clean(); accept(value); };
    const clean = () => { clearTimeout(timer); child.off("exit", ended); child.off("message", receive); };
    child.once("exit", ended); child.once("message", receive);
  });
}
function command(child: ChildProcess, action: "acquire" | "release" | "collect", path: string, checkpoint?: string) {
  const pending = response(child); child.send({ action, path, checkpoint }); return pending;
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise<void>((accept) => child.once("exit", () => accept()));
  child.kill("SIGKILL"); await exit;
}

describe("real process mutex crash boundaries (RT-016, AU-013)", () => {
  it("admits only one of eight simultaneous restart contenders after SIGKILL", async () => {
    const f = await fixture(); const owner = await f.spawn();
    expect((await command(owner, "acquire", f.path)).result).toBe("acquired");
    expect((await command(owner, "collect", f.path)).result).toBe("collected");
    const guard = await stat(`${f.path}.statecase-lock.sqlite`);
    await kill(owner);
    const peers = await Promise.all(Array.from({ length: 8 }, () => f.spawn()));
    const results = await Promise.all(peers.map((peer) => command(peer, "acquire", f.path)));
    expect(results.filter((result) => result.result === "acquired")).toHaveLength(1);
    expect(results.filter((result) => result.result === "denied")).toHaveLength(7);
    expect((await stat(`${f.path}.statecase-lock.sqlite`)).ino).toBe(guard.ino);
    const winner = peers[results.findIndex((result) => result.result === "acquired")];
    expect(JSON.parse(await readFile(f.path, "utf8")).pid).toBe(winner.pid);
    expect((await command(winner, "release", f.path)).result).toBe("released");
    expect((await command(winner, "collect", f.path)).result).toBe("collected");
    await expect(stat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
    const loser = peers.find((peer) => peer !== winner)!;
    expect((await command(loser, "acquire", f.path)).result).toBe("acquired");
  });

  it.each(["recovery", "publish"])("recovers after a process dies at the %s boundary without stealing another owner", async (checkpoint) => {
    const f = await fixture(); const initial = await f.spawn();
    expect((await command(initial, "acquire", f.path)).result).toBe("acquired"); await kill(initial);
    const paused = await f.spawn();
    expect(await command(paused, "acquire", f.path, checkpoint)).toEqual({ result: "checkpoint", point: checkpoint });
    expect((await command(paused, "collect", f.path)).result).toBe("collected");
    const contender = await f.spawn();
    expect((await command(contender, "acquire", f.path)).result).toBe("denied");
    await kill(paused);
    expect((await command(contender, "acquire", f.path)).result).toBe("acquired");
    expect(JSON.parse(await readFile(f.path, "utf8")).pid).toBe(contender.pid);
  });
});
