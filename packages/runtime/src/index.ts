import { constants } from "node:fs";
import { link, mkdir, open, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { LocalFileMutex, LocalMutexBusy } from "@statecase/storage-local";

export type ReconcileTrigger = "filesystem" | "remote-poll" | "maximum" | "retry" | "manual";

interface LockRecord {
  version: 1 | 2;
  pid: number;
  token: string;
  createdAt: number;
}

export class ProfileLock {
  #released = false;

  private constructor(readonly path: string, readonly record: LockRecord, readonly mutex: LocalFileMutex) {}

  static async acquire(
    path: string,
    options: { pid?: number; isAlive?: (pid: number) => boolean; beforeStaleRecovery?: () => Promise<void>; beforePublish?: () => Promise<void> } = {},
  ): Promise<ProfileLock> {
    const lockPath = resolve(path);
    const pid = options.pid ?? process.pid;
    const isAlive = options.isAlive ?? processIsAlive;
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError("runtime lock PID is invalid");
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    const record: LockRecord = { version: 2, pid, token: crypto.randomUUID(), createdAt: Date.now() };
    let mutex: LocalFileMutex;
    try {
      mutex = LocalFileMutex.acquire(`${lockPath}.statecase-lock.sqlite`);
    } catch (error) {
      if (error instanceof LocalMutexBusy) throw new Error("Statecase runtime is already running or acquiring its lock");
      throw error;
    }
    try {
      const existing = await readLock(lockPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw new Error("invalid existing runtime lock");
      });
      if (existing) {
        // Retain PID checking for compatibility with pre-mutex processes.
        if (existing.version === 1 && isAlive(existing.pid)) throw new Error(`Statecase runtime is already running with PID ${existing.pid}`);
        await options.beforeStaleRecovery?.();
        const current = await readLock(lockPath);
        if (current.token !== existing.token || current.pid !== existing.pid) throw new Error("runtime lock ownership changed during recovery");
        await rm(lockPath);
      }
      // A crash cannot publish a half-written JSON owner record. Hard-link
      // publication also refuses an independently created replacement path.
      const temporary = `${lockPath}.${record.token}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      try { await options.beforePublish?.(); await link(temporary, lockPath); }
      finally { await rm(temporary, { force: true }); }
      return new ProfileLock(lockPath, record, mutex);
    } catch (error) {
      mutex.release(); throw error;
    }
  }

  async release(): Promise<void> {
    if (this.#released) return;
    try {
      const existing = await readLock(this.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (existing) {
        if (existing.token !== this.record.token || existing.pid !== this.record.pid) {
          throw new Error("runtime lock ownership changed; refusing to remove it");
        }
        await rm(this.path);
      }
    } finally { this.mutex.release(); this.#released = true; }
  }
}

export interface SchedulerOptions {
  debounceMs?: number;
  maximumMs?: number;
  pollMs?: number;
  retryMinimumMs?: number;
  retryMaximumMs?: number;
  jitter?: () => number;
}

export class ReconcileScheduler {
  readonly #reconcile: (trigger: ReconcileTrigger) => Promise<void>;
  readonly #options: Required<SchedulerOptions>;
  #running = false;
  #tail: Promise<void> = Promise.resolve();
  #debounceTimer?: NodeJS.Timeout;
  #retryTimer?: NodeJS.Timeout;
  #maximumTimer?: NodeJS.Timeout;
  #pollTimer?: NodeJS.Timeout;
  #retryDelay: number;

  constructor(reconcile: (trigger: ReconcileTrigger) => Promise<void>, options: SchedulerOptions = {}) {
    this.#reconcile = reconcile;
    this.#options = {
      debounceMs: options.debounceMs ?? 2_000,
      maximumMs: options.maximumMs ?? 30_000,
      pollMs: options.pollMs ?? 20_000,
      retryMinimumMs: options.retryMinimumMs ?? 1_000,
      retryMaximumMs: options.retryMaximumMs ?? 300_000,
      jitter: options.jitter ?? Math.random,
    };
    for (const [name, value] of [
      ["debounceMs", this.#options.debounceMs],
      ["maximumMs", this.#options.maximumMs],
      ["pollMs", this.#options.pollMs],
      ["retryMinimumMs", this.#options.retryMinimumMs],
      ["retryMaximumMs", this.#options.retryMaximumMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
    }
    this.#retryDelay = this.#options.retryMinimumMs;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#maximumTimer = setInterval(() => this.#background("maximum"), this.#options.maximumMs);
    this.#pollTimer = setInterval(() => this.#background("remote-poll"), this.#options.pollMs);
    this.#maximumTimer.unref();
    this.#pollTimer.unref();
  }

  notify(): void {
    if (!this.#running) return;
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = undefined;
      this.#background("filesystem");
    }, this.#options.debounceMs);
    this.#debounceTimer.unref();
  }

  async flush(): Promise<void> {
    await this.#enqueue("manual");
  }

  async stop(): Promise<void> {
    this.#running = false;
    for (const timer of [this.#debounceTimer, this.#retryTimer, this.#maximumTimer, this.#pollTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.#debounceTimer = undefined;
    this.#retryTimer = undefined;
    this.#maximumTimer = undefined;
    this.#pollTimer = undefined;
    await this.#tail;
  }

  #background(trigger: ReconcileTrigger): void {
    if (!this.#running) return;
    void this.#enqueue(trigger).catch(() => this.#scheduleRetry());
  }

  #enqueue(trigger: ReconcileTrigger): Promise<void> {
    const next = this.#tail.then(() => this.#reconcile(trigger));
    this.#tail = next.then(() => {
      this.#retryDelay = this.#options.retryMinimumMs;
    }, () => undefined);
    return next;
  }

  #scheduleRetry(): void {
    if (!this.#running || this.#retryTimer) return;
    const jitter = Math.max(0, Math.min(1, this.#options.jitter()));
    const delay = Math.round(this.#retryDelay * (1 + jitter));
    this.#retryDelay = Math.min(this.#retryDelay * 2, this.#options.retryMaximumMs);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      this.#background("retry");
    }, delay);
    this.#retryTimer.unref();
  }
}

async function readLock(path: string): Promise<LockRecord> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new Error("invalid runtime lock");
  }
  const bytes = Buffer.alloc(4097);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.size > 4096 ||
        (process.getuid && info.uid !== process.getuid())) throw new Error("invalid runtime lock");
    const read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== info.size || read.bytesRead > 4096) throw new Error("invalid runtime lock");
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, read.bytesRead))) as Partial<LockRecord> | null;
    if (!value || (value.version !== 1 && value.version !== 2) || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 ||
        typeof value.token !== "string" || value.token.length === 0 || !Number.isSafeInteger(value.createdAt)) throw new Error("invalid runtime lock");
    return value as LockRecord;
  } catch { throw new Error("invalid runtime lock"); }
  finally { bytes.fill(0); await handle.close(); }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
