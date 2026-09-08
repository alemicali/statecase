const phases = new Set(["setup", "authenticated-startup", "automatic-bidirectional-transfer", "interrupted-upload-journal-retained",
  "offline-crash-recovery-and-disjoint-convergence", "deletion-and-idle-noop", "idle"]);
const networkCodes = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
const signals = new Set(["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGBUS", "SIGINT"]);

/** Test-only supervisor metadata. Drain pipes but never print raw output,
 * command arguments, native paths or exception messages. A running supervisor
 * does not imply its service socket or descendant processes remain healthy. */
export function trackFixtureProcess(process, role) {
  const tracked = { process, role: ["backend", "daemon"].includes(role) ? role : "other", done: false, expectedStop: false,
    exitCode: null, signal: null, spawnError: undefined, stderrCategories: new Set() };
  let tail = Buffer.alloc(0);
  process.stdout?.resume();
  process.stderr?.on("data", (chunk) => {
    const suffix = Buffer.from(chunk).subarray(-16_384);
    const next = Buffer.concat([tail, suffix]).subarray(-16_384);
    tail.fill(0); tail = next;
    const text = tail.toString("utf8");
    if (/out of memory|heap limit|allocation failed/iu.test(text)) tracked.stderrCategories.add("out-of-memory");
    if (/EADDRINUSE|address already in use/iu.test(text)) tracked.stderrCategories.add("address-in-use");
    if (/kj::Exception|workerd[^\n]*(?:fatal|crash)/iu.test(text)) tracked.stderrCategories.add("workerd-runtime");
  });
  tracked.exited = new Promise((resolveExit) => {
    process.once("exit", (code, signal) => {
      tracked.done = true;
      tracked.exitCode = Number.isInteger(code) && code >= 0 && code <= 255 ? code : null;
      tracked.signal = signals.has(signal) ? signal : null;
      tail.fill(0); resolveExit();
    });
    process.once("error", (error) => {
      tracked.done = true; tracked.spawnError = ["ENOENT", "EACCES", "ENOMEM", "EAGAIN"].includes(error?.code) ? error.code : "unknown";
      tail.fill(0); resolveExit();
    });
  });
  return tracked;
}

export function fixtureFailureSummary(error, phase, children) {
  const code = error?.cause?.code ?? error?.code;
  return { result: "fail", phase: phases.has(phase) ? phase : "unknown", network: networkCodes.has(code) ? code : undefined,
    processes: children.slice(0, 16).map((child) => ({ role: child.role, state: child.done ? "exited" : "running", expectedStop: child.expectedStop,
      exitCode: child.exitCode, signal: child.signal, spawnError: child.spawnError, stderrCategories: [...child.stderrCategories].sort() })) };
}
