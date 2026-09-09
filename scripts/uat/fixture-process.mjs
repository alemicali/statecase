const phases = new Set(["setup", "authenticated-startup", "automatic-bidirectional-transfer", "interrupted-upload-journal-retained",
  "offline-crash-recovery-and-disjoint-convergence", "deletion-and-idle-noop", "idle"]);
const networkCodes = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
const signals = new Set(["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGBUS", "SIGINT"]);
const diagnosticCodes = [...networkCodes, "ERR_RUNTIME_FAILURE", "ERR_WORKER_OUT_OF_MEMORY", "ERR_IPC_CHANNEL_CLOSED",
  "ERR_STREAM_PREMATURE_CLOSE", "ERR_STREAM_DESTROYED", "EMFILE", "ENFILE", "ENOSPC", "EIO"];

/** Test-only supervisor metadata. Drain pipes but never print raw output,
 * command arguments, native paths or exception messages. A running supervisor
 * does not imply its service socket or descendant processes remain healthy. */
export function trackFixtureProcess(process, role) {
  const tracked = { process, role: ["backend", "daemon"].includes(role) ? role : "other", done: false, expectedStop: false,
    exitCode: null, signal: null, spawnError: undefined, stdoutCategories: new Set(), stderrCategories: new Set() };
  const tails = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  for (const channel of ["stdout", "stderr"]) process[channel]?.on("data", (chunk) => {
    const suffix = Buffer.from(chunk).subarray(-16_384);
    const next = Buffer.concat([tails[channel], suffix]).subarray(-16_384);
    tails[channel].fill(0); tails[channel] = next;
    const text = next.toString("utf8"), categories = tracked[`${channel}Categories`];
    if (/out of memory|heap limit|allocation failed/iu.test(text)) categories.add("out-of-memory");
    if (/EADDRINUSE|address already in use/iu.test(text)) categories.add("address-in-use");
    if (/kj::Exception|workerd[^\n]*(?:fatal|crash)/iu.test(text)) categories.add("workerd-runtime");
    if (/\[ERROR\]|Error:|UnhandledPromiseRejection/u.test(text)) categories.add("reported-error");
    for (const code of diagnosticCodes) if (new RegExp(`\\b${code}\\b`, "u").test(text)) categories.add(`code:${code}`);
  });
  const wipe = () => { tails.stdout.fill(0); tails.stderr.fill(0); };
  tracked.exited = new Promise((resolveExit) => {
    process.once("exit", (code, signal) => {
      tracked.done = true;
      tracked.exitCode = Number.isInteger(code) && code >= 0 && code <= 255 ? code : null;
      tracked.signal = signals.has(signal) ? signal : null;
      wipe(); resolveExit();
    });
    process.once("error", (error) => {
      tracked.done = true; tracked.spawnError = ["ENOENT", "EACCES", "ENOMEM", "EAGAIN"].includes(error?.code) ? error.code : "unknown";
      wipe(); resolveExit();
    });
  });
  return tracked;
}

export function fixtureFailureSummary(error, phase, children) {
  const code = error?.cause?.code ?? error?.code;
  return { result: "fail", phase: phases.has(phase) ? phase : "unknown", network: networkCodes.has(code) ? code : undefined,
    processes: children.slice(0, 16).map((child) => ({ role: child.role, state: child.done ? "exited" : "running", expectedStop: child.expectedStop,
      exitCode: child.exitCode, signal: child.signal, spawnError: child.spawnError,
      stdoutCategories: [...child.stdoutCategories].sort(), stderrCategories: [...child.stderrCategories].sort() })) };
}
