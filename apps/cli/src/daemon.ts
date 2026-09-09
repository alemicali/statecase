import { watch, type FSWatcher } from "node:fs";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { dirname, resolve } from "node:path";

import { ProfileLock, ReconcileScheduler, type ReconcileTrigger, type SchedulerOptions } from "@statecase/runtime";

export type DaemonTrigger = "startup" | ReconcileTrigger;

export interface PersistentRuntimeOptions {
  lockPath: string;
  socketPath: string;
  roots: readonly string[];
  reconcile(trigger: DaemonTrigger): Promise<void>;
  scheduler?: SchedulerOptions;
  warn?: (message: string) => void;
}

export interface RuntimeStatus {
  version: 1;
  running: boolean;
  pid: number;
  roots: number;
  startedAt: string;
  lastTrigger: DaemonTrigger | null;
  lastSuccessAt: string | null;
  queued: boolean;
}

/** Persistent local runtime for IDE and non-shim harness launches. */
export class PersistentRuntime {
  readonly #options: PersistentRuntimeOptions;
  #lock?: ProfileLock;
  #server?: Server;
  #scheduler?: ReconcileScheduler;
  #watchers: FSWatcher[] = [];
  #startedAt?: string;
  #lastTrigger: DaemonTrigger | null = null;
  #lastSuccessAt: string | null = null;
  #queued = false;
  #mayOwnSocket = false;

  constructor(options: PersistentRuntimeOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    if (this.#lock) return;
    this.#lock = await ProfileLock.acquire(this.#options.lockPath);
    try {
      await this.#prepareSocket();
      this.#startedAt = new Date().toISOString();
      const reconcile = async (trigger: DaemonTrigger): Promise<void> => {
        this.#lastTrigger = trigger;
        try {
          await this.#options.reconcile(trigger);
          this.#lastSuccessAt = new Date().toISOString();
          this.#queued = false;
        } catch (error) {
          this.#queued = true;
          throw error;
        }
      };
      this.#scheduler = new ReconcileScheduler((trigger) => reconcile(trigger), this.#options.scheduler);
      await reconcile("startup").catch(() => this.#warn("Statecase startup reconciliation is queued."));
      this.#server = createServer((socket) => socket.end(`${JSON.stringify(this.status())}\n`));
      this.#mayOwnSocket = true;
      await new Promise<void>((resolveListen, reject) => {
        this.#server!.once("error", reject);
        this.#server!.listen(resolve(this.#options.socketPath), () => resolveListen());
      });
      await chmod(resolve(this.#options.socketPath), 0o600);
      for (const rootValue of new Set(this.#options.roots.map((root) => resolve(root)))) {
        const info = await lstat(rootValue).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
        if (!info?.isDirectory()) {
          this.#warn(`Statecase is not watching unavailable root: ${rootValue}`);
          continue;
        }
        const watcher = watch(rootValue, { recursive: true }, () => this.#scheduler?.notify());
        watcher.on("error", () => this.#warn(`Statecase filesystem watcher needs reconciliation: ${rootValue}`));
        this.#watchers.push(watcher);
      }
      this.#scheduler.start();
    } catch (error) {
      await this.#cleanup();
      throw error;
    }
  }

  status(): RuntimeStatus {
    return {
      version: 1,
      running: Boolean(this.#lock),
      pid: process.pid,
      roots: this.#watchers.length,
      startedAt: this.#startedAt ?? new Date(0).toISOString(),
      lastTrigger: this.#lastTrigger,
      lastSuccessAt: this.#lastSuccessAt,
      queued: this.#queued,
    };
  }

  async stop(): Promise<void> {
    if (!this.#lock) return;
    await this.#cleanup();
  }

  async #prepareSocket(): Promise<void> {
    const socketPath = resolve(this.#options.socketPath);
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
    const existing = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (!existing) return;
    if (!existing.isSocket()) throw new Error(`refusing to replace non-socket IPC path: ${socketPath}`);
    await rm(socketPath);
  }

  async #cleanup(): Promise<void> {
    for (const watcher of this.#watchers.splice(0)) watcher.close();
    await this.#scheduler?.stop();
    this.#scheduler = undefined;
    if (this.#server) {
      const server = this.#server;
      this.#server = undefined;
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
    if (this.#mayOwnSocket) {
      await rm(resolve(this.#options.socketPath), { force: true });
      this.#mayOwnSocket = false;
    }
    const lock = this.#lock;
    this.#lock = undefined;
    await lock?.release();
  }

  #warn(message: string): void {
    (this.#options.warn ?? ((value) => process.stderr.write(`${value}\n`)))(message);
  }
}

export function readRuntimeStatus(socketPath: string, timeoutMs = 2_000): Promise<RuntimeStatus> {
  return new Promise((resolveStatus, reject) => {
    const socket = connect(resolve(socketPath));
    let value = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Statecase daemon status timed out"));
    }, timeoutMs);
    timer.unref();
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { value += chunk; });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("end", () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(value) as RuntimeStatus;
        if (parsed.version !== 1 || parsed.running !== true || !Number.isSafeInteger(parsed.pid)) throw new Error("invalid daemon status response");
        resolveStatus(parsed);
      } catch (error) {
        reject(error);
      }
    });
  });
}
