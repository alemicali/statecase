import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type ReconcileTrigger = "filesystem" | "remote-poll" | "maximum" | "retry" | "manual";

interface LockRecord {
  version: 1;
  pid: number;
  token: string;
  createdAt: number;
}

export class ProfileLock {
  #released = false;

  private constructor(readonly path: string, readonly record: LockRecord) {}

  static async acquire(
    path: string,
    options: { pid?: number; isAlive?: (pid: number) => boolean } = {},
  ): Promise<ProfileLock> {
    const lockPath = resolve(path);
    const pid = options.pid ?? process.pid;
    const isAlive = options.isAlive ?? processIsAlive;
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError("runtime lock PID is invalid");
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    const record: LockRecord = { version: 1, pid, token: crypto.randomUUID(), createdAt: Date.now() };
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return new ProfileLock(lockPath, record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const existing = await readLock(lockPath).catch(() => {
      throw new Error("invalid existing runtime lock");
    });
    if (isAlive(existing.pid)) throw new Error(`Statecase runtime is already running with PID ${existing.pid}`);
    const stale = `${lockPath}.stale-${crypto.randomUUID()}`;
    try {
      await rename(lockPath, stale);
      await rm(stale, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return ProfileLock.acquire(lockPath, { pid, isAlive });
  }

  async release(): Promise<void> {
    if (this.#released) return;
    const existing = await readLock(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!existing) {
      this.#released = true;
      return;
    }
    if (existing.token !== this.record.token || existing.pid !== this.record.pid) {
      throw new Error("runtime lock ownership changed; refusing to remove it");
    }
    await rm(this.path);
    this.#released = true;
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
  const value = JSON.parse(await readFile(path, "utf8")) as Partial<LockRecord>;
  if (value.version !== 1 || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 ||
      typeof value.token !== "string" || value.token.length === 0 || !Number.isSafeInteger(value.createdAt)) {
    throw new Error("invalid runtime lock");
  }
  return value as LockRecord;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
