import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export type HarnessName = "codex" | "claude";
export type ReconcileReason = "preflight" | "periodic" | "final";
export type SyncDisposition = "synced" | "queued";

export interface HarnessChild {
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type HarnessSpawn = (executable: string, args: readonly string[], options: SpawnOptions) => HarnessChild;

interface SignalSource {
  on(event: NodeJS.Signals, listener: () => void): unknown;
  off(event: NodeJS.Signals, listener: () => void): unknown;
}

export interface SupervisorDependencies {
  spawn?: HarnessSpawn;
  reconcile(reason: ReconcileReason): Promise<void>;
  intervalMs?: number;
  preflightTimeoutMs?: number;
  finalFlushTimeoutMs?: number;
  warn?: (message: string) => void;
  signals?: SignalSource;
}

export interface HarnessRunOptions {
  harness: HarnessName;
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string | undefined>;
}

export interface HarnessRunResult {
  exitCode: number;
  preflight: SyncDisposition;
  finalFlush: SyncDisposition;
}

const FORWARDED_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGWINCH"];
const SIGNAL_EXIT_CODES: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

/** Supervises an unmodified interactive harness while synchronization remains local-first. */
export class HarnessSupervisor {
  readonly #spawn: HarnessSpawn;
  readonly #reconcile: (reason: ReconcileReason) => Promise<void>;
  readonly #intervalMs: number;
  readonly #preflightTimeoutMs: number;
  readonly #finalFlushTimeoutMs: number;
  readonly #warn: (message: string) => void;
  readonly #signals: SignalSource;
  #syncTail: Promise<void> = Promise.resolve();

  constructor(dependencies: SupervisorDependencies) {
    this.#spawn = dependencies.spawn ?? ((executable, args, options) => nodeSpawn(executable, args, options));
    this.#reconcile = dependencies.reconcile;
    this.#intervalMs = dependencies.intervalMs ?? 30_000;
    this.#preflightTimeoutMs = dependencies.preflightTimeoutMs ?? 10_000;
    this.#finalFlushTimeoutMs = dependencies.finalFlushTimeoutMs ?? 15_000;
    this.#warn = dependencies.warn ?? ((message) => process.stderr.write(`${message}\n`));
    this.#signals = dependencies.signals ?? process;
    if (!Number.isSafeInteger(this.#intervalMs) || this.#intervalMs < 0) throw new TypeError("sync interval must be a non-negative integer");
  }

  async run(options: HarnessRunOptions): Promise<HarnessRunResult> {
    const label = options.harness === "codex" ? "Codex" : "Claude";
    if (options.env.STATECASE_ACTIVE_HARNESS === options.harness) {
      throw new Error(`refusing recursive ${label} launch; use the recorded real executable or statecase bypass`);
    }

    const preflight = await this.#attempt("preflight", this.#preflightTimeoutMs);
    if (preflight === "queued") this.#warn(`Statecase preflight sync is queued; starting ${label} offline.`);

    const child = this.#spawn(options.executable, options.args, {
      cwd: options.cwd,
      env: { ...options.env, STATECASE_ACTIVE_HARNESS: options.harness } as unknown as NodeJS.ProcessEnv,
      stdio: "inherit",
    });
    const handlers = new Map<NodeJS.Signals, () => void>();
    for (const signal of FORWARDED_SIGNALS) {
      const handler = () => { child.kill(signal); };
      handlers.set(signal, handler);
      this.#signals.on(signal, handler);
    }
    const timer = this.#intervalMs > 0
      ? setInterval(() => { void this.#enqueueSync("periodic").catch(() => undefined); }, this.#intervalMs)
      : undefined;
    timer?.unref();

    let childExit: { code: number | null; signal: NodeJS.Signals | null };
    try {
      childExit = await new Promise((resolveExit, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolveExit({ code, signal }));
      });
    } finally {
      if (timer) clearInterval(timer);
      for (const [signal, handler] of handlers) this.#signals.off(signal, handler);
    }

    const finalFlush = await this.#attempt("final", this.#finalFlushTimeoutMs);
    if (finalFlush === "queued") this.#warn("Statecase final sync is queued and will be retried.");
    return {
      exitCode: childExit.code ?? signalExitCode(childExit.signal),
      preflight,
      finalFlush,
    };
  }

  #enqueueSync(reason: ReconcileReason): Promise<void> {
    const next = this.#syncTail.then(() => this.#reconcile(reason));
    this.#syncTail = next.catch(() => undefined);
    return next;
  }

  async #attempt(reason: ReconcileReason, timeoutMs: number): Promise<SyncDisposition> {
    try {
      await bounded(this.#enqueueSync(reason), timeoutMs);
      return "synced";
    } catch {
      return "queued";
    }
  }
}

export async function resolveHarnessExecutable(
  harness: HarnessName,
  environment: Record<string, string | undefined>,
  excludedPaths: readonly string[] = [],
): Promise<string> {
  const path = environment.PATH ?? "";
  const candidates = isAbsolute(harness) ? [harness] : path.split(delimiter).filter(Boolean).map((part) => join(part, harness));
  const excluded = new Set((await Promise.all(excludedPaths.map((candidate) => canonicalPath(candidate)))).filter(Boolean));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      const canonical = await canonicalPath(candidate);
      if (canonical && !excluded.has(canonical)) return resolve(candidate);
    } catch {
      // PATH entries commonly do not contain the requested executable.
    }
  }
  throw new Error(`could not find the real ${harness} executable in PATH`);
}

async function canonicalPath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return promise;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("operation timed out")), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  return SIGNAL_EXIT_CODES[signal] ?? 128;
}
