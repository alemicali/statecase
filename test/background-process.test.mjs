import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { trackFixtureProcess, fixtureFailureSummary } from "../scripts/uat/fixture-process.mjs";

function child() { const value = new EventEmitter(); value.stdout = new PassThrough(); value.stderr = new PassThrough(); return value; }
describe("redacted background fixture diagnostics (RT-017)", () => {
  it("classifies backend stdout errors across chunks without exposing output", async () => {
    const process = child(), tracked = trackFixtureProcess(process, "backend");
    process.stdout.write("private-stdout-canary [ERROR] ERR_RUNTIME_");
    process.stdout.write("FAILURE ECONNRESET private-token\n");
    process.emit("exit", 1, null); await tracked.exited;
    const report = fixtureFailureSummary({}, "interrupted-upload-journal-retained", [tracked]);
    expect(report.processes[0]).toMatchObject({ state: "exited", exitCode: 1,
      stdoutCategories: ["code:ECONNRESET", "code:ERR_RUNTIME_FAILURE", "reported-error"], stderrCategories: [] });
    expect(JSON.stringify(report)).not.toMatch(/private|token/u);
  });
  it("keeps stdout and stderr classifications independent and bounded to known categories", async () => {
    const process = child(), tracked = trackFixtureProcess(process, "backend");
    process.stdout.write("secret-output".repeat(20_000)); process.stdout.write("Error: EPIPE\n");
    process.stderr.write("private-stderr-canary out of memory\n");
    process.emit("exit", 1, null); await tracked.exited;
    const report = fixtureFailureSummary({}, "setup", [tracked]);
    expect(report.processes[0]).toMatchObject({ stdoutCategories: ["code:EPIPE", "reported-error"], stderrCategories: ["out-of-memory"] });
    expect(JSON.stringify(report)).not.toMatch(/secret|private/u);
  });
  it("records real termination separately from network failure without printing child output", async () => {
    const process = child(), tracked = trackFixtureProcess(process, "backend");
    process.stderr.write("private-canary secret-token FATAL ERROR: out of memory\n");
    process.emit("exit", null, "SIGKILL"); await tracked.exited;
    const report = fixtureFailureSummary(new TypeError("private-path", { cause: { code: "ECONNREFUSED" } }), "idle", [tracked]);
    expect(report).toMatchObject({ result: "fail", network: "ECONNREFUSED", processes: [{ role: "backend", state: "exited", signal: "SIGKILL", stderrCategories: ["out-of-memory"] }] });
    expect(JSON.stringify(report)).not.toMatch(/private|secret-token/u);
  });
  it("reports a live supervisor without assuming its socket or grandchildren are alive", () => {
    const process = child(), tracked = trackFixtureProcess(process, "backend");
    process.stderr.write("unknown-private-canary".repeat(20_000));
    const report = fixtureFailureSummary({ code: "injected-secret", cause: { code: "another-secret" } }, "untrusted-phase", [tracked]);
    expect(report.phase).toBe("unknown"); expect(report.network).toBeUndefined();
    expect(report.processes[0]).toMatchObject({ state: "running", stderrCategories: [] });
    expect(JSON.stringify(report)).not.toMatch(/secret|private|untrusted/u);
    process.emit("exit", 0, null);
  });
  it("bounds and allowlists signal, exit and startup failure metadata", async () => {
    const process = child(), tracked = trackFixtureProcess(process, "untrusted-role");
    process.stderr.write("EADDRINUSE\nkj::Exception fatal\n");
    process.emit("error", { code: "ENOENT", message: "private-canary" }); await tracked.exited;
    expect(fixtureFailureSummary({}, "setup", [tracked]).processes[0]).toMatchObject({ role: "other", spawnError: "ENOENT", stderrCategories: ["address-in-use", "workerd-runtime"] });
    process.emit("exit", 99999, "secret-signal");
    expect(JSON.stringify(fixtureFailureSummary({}, "setup", [tracked]))).not.toMatch(/99999|secret-signal|private-canary/u);
  });
});
