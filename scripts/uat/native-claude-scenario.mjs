import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { SyncEngine } from "../../apps/cli/src/sync.ts";
import { StatecaseClient } from "../../apps/cli/src/client.ts";
import { randomKey } from "../../packages/crypto/src/index.ts";
import { claudeProjectDirectory } from "../../packages/adapters/claude/src/index.ts";
import { referenceTransport } from "./native-reference.mjs";
import { assertNativePreferences } from "./native-preferences.mjs";

// AD-CL-006, WS-034, UAT-03 subset. Native file tools/session persistence;
// deterministic Messages fixture and reference storage, not hosted inference.
const execute = promisify(execFile);
const executable = process.env.STATECASE_UAT_CLAUDE;
const parent = process.env.STATECASE_UAT_PARENT;
assert.ok(executable && isAbsolute(executable));
assert.ok(parent && isAbsolute(parent));
assert.equal(process.env.STATECASE_UAT_CONFIRM, "run-native-harness-in-disposable-sandbox");
const root = await mkdtemp(join(parent, "statecase-native-claude-"));
const originalCwd = process.cwd();
const marker = `claude-canary-${randomBytes(12).toString("hex")}`;
const sourcePrompt = `Read input.txt, edit artifact.txt to contain ${marker}, and create note.txt.`;
const inputBytes = "synthetic tracked input continuity\n";
const noteBytes = "synthetic untracked note\n";
const source = { home: join(root, "source-home"), project: join(root, "source-project") };
const target = { home: join(root, "target-home"), project: join(root, "different", "target-project") };
let phase = "setup", stage = "source", requests = 0, fixtureFailure, key, unexpectedRoute, sessionShape;
let healthProbes = 0;
let expectedEffort = "low";
const check = (condition, code) => { if (!condition) { fixtureFailure ??= code; throw new Error("native fixture assertion failed"); } };
const environment = (machine) => ({
  PATH: process.env.PATH, HOME: machine.home, CLAUDE_CONFIG_DIR: join(machine.home, "claude"),
  CODEX_HOME: join(machine.home, "codex"), CODEX_SQLITE_HOME: join(machine.home, "sqlite"),
  XDG_CONFIG_HOME: join(machine.home, "xdg"), TMPDIR: join(root, "tmp"),
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  ANTHROPIC_API_KEY: "statecase-synthetic-fixture-key",
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${provider.address()?.port ?? 1}`,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_MAX_RETRIES: "0", API_TIMEOUT_MS: "10000",
});
const provider = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (request.method === "HEAD" && pathname === "/api/hello") {
      check(++healthProbes <= 4, "health-probe-limit");
      response.writeHead(200); response.end(); return;
    }
    if (request.method !== "POST") unexpectedRoute = `${request.method} ${pathname}`.slice(0, 120);
    check(request.method === "POST", "unexpected-method");
    check(pathname === "/v1/messages" || pathname === "/v1/messages/count_tokens", "unexpected-route");
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; check(size <= 8 * 1024 * 1024, "request-limit"); chunks.push(chunk); }
    let bytes = Buffer.concat(chunks);
    if (request.headers["content-encoding"] === "gzip") bytes = gunzipSync(bytes, { maxOutputLength: 8 * 1024 * 1024 });
    const body = JSON.parse(bytes.toString());
    if (pathname.endsWith("/count_tokens")) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ input_tokens: 100 })); return; }
    assertNativePreferences("claude", body, { model: "claude-sonnet-4-6", effort: expectedEffort });
    requests++;
    check(requests <= (stage === "source" ? 5 : 3), "unexpected-model-turn");
    const machine = stage === "source" ? source : target;
    const results = body.messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((block) => block.type === "tool_result");
    if (requests > 1) {
      const last = results.find((result) => result.tool_use_id === `toolu_${stage}_${requests - 1}`);
      check(last && !last.is_error, "native-tool-failed");
      if (requests === 2) check(JSON.stringify(last.content).includes(stage === "source" ? inputBytes.trim() : marker), "native-read-missing-bytes");
    }
    if (phase !== "native-preferences" && stage === "target" && requests === 1) {
      check(body.messages.some((message) => message.role === "user" &&
        (typeof message.content === "string" ? message.content.includes(sourcePrompt) :
          Array.isArray(message.content) && message.content.some((block) => block.type === "text" && block.text.includes(sourcePrompt)))), "original-prompt-lost");
      check(JSON.stringify(results).includes(inputBytes.trim()), "original-tool-output-lost");
    }
    let tool;
    if (phase === "native-preferences") { /* Fresh session tests config, not restored session metadata. */ }
    else if (requests === 1) tool = { name: "Read", input: { file_path: join(machine.project, stage === "source" ? "input.txt" : "artifact.txt") } };
    else if (stage === "source" && requests === 2) tool = { name: "Read", input: { file_path: join(machine.project, "artifact.txt") } };
    else if ((stage === "source" && requests === 3) || (stage === "target" && requests === 2)) {
      tool = { name: "Edit", input: { file_path: join(machine.project, "artifact.txt"),
        old_string: stage === "source" ? "baseline artifact\n" : `${marker}\n`,
        new_string: stage === "source" ? `${marker}\n` : `${marker}\ncontinued on target\n` } };
    } else if (stage === "source" && requests === 4) tool = { name: "Write", input: { file_path: join(machine.project, "note.txt"), content: noteBytes } };
    else {
      check(await readFile(join(machine.project, "artifact.txt"), "utf8") === `${marker}\n${stage === "target" ? "continued on target\n" : ""}`, "native-edit-bytes");
      check(await readFile(join(machine.project, "note.txt"), "utf8") === noteBytes, "untracked-note-bytes");
    }
    if (tool) check(body.tools.some((candidate) => candidate.name === tool.name), "native-tool-not-offered");
    const content = tool ? { type: "tool_use", id: `toolu_${stage}_${requests}`, ...tool } : { type: "text", text: "Fixture turn complete." };
    const message = { id: `msg_${stage}_${requests}`, type: "message", role: "assistant", model: body.model,
      content: [content], stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 30 } };
    if (!body.stream) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(message)); return; }
    const events = [
      { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      { type: "content_block_start", index: 0, content_block: tool ? { ...content, input: {} } : { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } : { type: "text_delta", text: content.text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 30 } },
      { type: "message_stop" },
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  } catch (error) {
    fixtureFailure ??= ["NATIVE_MODEL_MISMATCH", "NATIVE_EFFORT_MISMATCH"].includes(error.code) ? error.code : "provider-exception";
    response.writeHead(500); response.end();
  }
});
try {
  await mkdir(join(root, "tmp"), { mode: 0o700 });
  for (const machine of [source, target]) await mkdir(join(machine.home, "claude"), { recursive: true, mode: 0o700 });
  await mkdir(source.project);
  await execute("git", ["init", "-q", source.project], { env: environment(source) });
  await writeFile(join(source.project, "input.txt"), inputBytes);
  await writeFile(join(source.project, "artifact.txt"), "baseline artifact\n");
  await execute("git", ["-C", source.project, "add", "."], { env: environment(source) });
  await execute("git", ["-C", source.project, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "synthetic baseline"], { env: environment(source) });
  await mkdir(join(root, "different"));
  await execute("git", ["clone", "-q", source.project, target.project], { env: environment(target) });
  const version = (await execute(executable, ["--version"], { env: environment(source), timeout: 15_000 })).stdout.trim();
  assert.equal(version, "2.1.263 (Claude Code)");
  await new Promise((accept, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", accept); });
  for (const machine of [source, target]) {
    await writeFile(join(machine.home, "claude", "settings.json"), JSON.stringify({
      ...(machine === source ? { model: "claude-sonnet-4-6", effortLevel: "low" } : {}),
      env: { STATECASE_FIXTURE_LOCAL_ONLY: machine === source ? "source-canary" : "target-canary" },
    }), { mode: 0o600 });
  }
  const targetLocalSettings = await readFile(join(target.home, "claude", "settings.json"), "utf8");
  phase = "native-source";
  const sessionId = await harness(source, sourcePrompt);
  assert.match(sessionId, /^[a-f0-9-]{36}$/u);
  const sourceSession = join(claudeProjectDirectory(join(source.home, "claude"), source.project), `${sessionId}.jsonl`);
  const records = (await readFile(sourceSession, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(records.length > 0);
  sessionShape = [...new Set(records.map((record) => JSON.stringify({ type: record.type, cwdMatches: record.cwd === source.project,
    sessionIdMatches: record.sessionId === sessionId, messageRole: record.message?.role })))].map((value) => JSON.parse(value));
  phase = "encrypted-transfer";
  const remote = referenceTransport(marker);
  key = await randomKey();
  const engine = new SyncEngine(new StatecaseClient("https://native-fixture.invalid", "synthetic", remote.fetch), "vlt_native", key);
  const a = config(source), b = config(target);
  process.chdir(source.project);
  assert.equal((await engine.push(a)).outcome, "pushed");
  const reports = await engine.dependencies();
  check(reports.length === 1, "native-session-not-workspace-bound");
  for (const path of ["input.txt", "artifact.txt", "note.txt"]) {
    check(reports[0].dependencies.some((dependency) => dependency.logicalPath === path && dependency.status === "resolved"), "native-dependency-missing");
  }
  process.chdir(target.project);
  await engine.hydrate(b, reports[0].sessionCapsuleId, { mode: "strict", dryRun: true });
  assert.deepEqual(b.applied, {});
  assert.deepEqual(await readdir(join(target.home, "claude")), ["settings.json"]);
  assert.equal(await readFile(join(target.home, "claude", "settings.json"), "utf8"), targetLocalSettings);
  assert.equal(await readFile(join(target.project, "artifact.txt"), "utf8"), "baseline artifact\n");
  await engine.hydrate(b, reports[0].sessionCapsuleId, { mode: "strict" });
  assert.equal(await readFile(join(target.project, "artifact.txt"), "utf8"), `${marker}\n`);
  assert.equal(await readFile(join(target.project, "note.txt"), "utf8"), noteBytes);
  const targetSession = join(claudeProjectDirectory(join(target.home, "claude"), target.project), `${sessionId}.jsonl`);
  assert.ok((await readFile(targetSession)).byteLength > 0);
  const hydratedSettings = await readFile(join(target.home, "claude", "settings.json"), "utf8");
  assert.deepEqual(JSON.parse(hydratedSettings), { model: "claude-sonnet-4-6", effortLevel: "low", env: { STATECASE_FIXTURE_LOCAL_ONLY: "target-canary" } });
  phase = "native-resume"; stage = "target"; requests = 0;
  assert.equal(await harness(target, "Continue the earlier task: read its artifact and append the continuation line.", sessionId), sessionId);
  assert.equal(await readFile(join(source.project, "artifact.txt"), "utf8"), `${marker}\n`);
  phase = "return-publish";
  assert.equal((await engine.push(b)).outcome, "pushed");
  phase = "return-pull"; process.chdir(source.project);
  assert.equal((await engine.pull(a)).outcome, "pulled");
  assert.equal(await readFile(join(source.project, "artifact.txt"), "utf8"), `${marker}\ncontinued on target\n`);
  assert.equal(Object.keys(a.sessionBindings).length, 1);
  assert.equal(Object.keys(b.sessionBindings).length, 1);
  phase = "native-preferences";
  for (const override of [false, true]) {
    requests = 0; expectedEffort = override ? "high" : "low";
    const fresh = await harness(target, "Reply with fixture completion text.", undefined, override ? "high" : undefined);
    assert.match(fresh, /^[a-f0-9-]{36}$/u);
    assert.notEqual(fresh, sessionId, "preference qualification reused session metadata");
    assert.equal(await readFile(join(target.home, "claude", "settings.json"), "utf8"), hydratedSettings);
  }
  console.log(JSON.stringify({ result: "pass", harness: version, node: process.version, backend: "in-memory-reference",
    topology: "two-homes-one-host", inference: "deterministic-loopback", sameSessionId: true, originalHistory: true,
    nativeReadEditWrite: true, trackedBaseline: true, untrackedNote: true, mappedCwd: true,
    hydrationPreviewNonMutating: true, nativeProjectPath: true, returnSync: true,
    nativeEffectivePreferences: true, freshPreferenceSession: true, localConfigPreserved: true, cliPreferenceOverride: true,
    encryptedObjects: remote.objectCount() }));
} catch (error) {
  console.error(JSON.stringify({ result: "fail", phase, error: error.name, fixtureFailure,
    preferenceFailure: fixtureFailure, requests, unexpectedRoute, sessionShape }));
  process.exitCode = 1;
} finally {
  key?.fill(0); provider.closeAllConnections();
  await new Promise((accept) => provider.close(accept));
  process.chdir(originalCwd);
  await rm(root, { recursive: true, force: true });
}

async function harness(machine, prompt, resume, effortOverride) {
  // Restricted mode intentionally ignores user settings. This scenario is
  // gated to disposable hosts and loads only its synthetic user root; explicit
  // file-tool/MCP/browser restrictions remain in force.
  const args = ["--setting-sources", "user", "--disable-slash-commands", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--no-chrome", "--tools", "Read,Write,Edit", "--allowedTools", "Read,Write,Edit", "--permission-mode", "acceptEdits",
    ...(effortOverride ? ["--effort", effortOverride] : []), "--max-turns", "6", "--system-prompt", "Execute the synthetic file-tool fixture.",
    "--output-format", "json", ...(resume ? ["--resume", resume] : []), "-p", prompt];
  const pending = execute(executable, args, { cwd: machine.project, env: environment(machine), timeout: 45_000, maxBuffer: 1024 * 1024, detached: true });
  pending.child.stdin.end();
  let result, cleanupError;
  try { result = await pending; }
  finally {
    if (pending.child.pid) {
      try { process.kill(-pending.child.pid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") cleanupError = error; }
    }
  }
  if (cleanupError) throw cleanupError;
  check(requests === (phase === "native-preferences" ? 1 : stage === "source" ? 5 : 3), "model-turn-count");
  check(fixtureFailure === undefined, "provider-failed");
  const output = JSON.parse(result.stdout);
  check(output.type === "result" && output.subtype === "success" && output.is_error === false, "native-result-failed");
  return output.session_id;
}

function config(machine) {
  return { version: 1, apiUrl: "https://native-fixture.invalid", deviceId: "device_fixture",
    mappings: [{ id: "claude-default", kind: "claude", mode: "two-way", name: "Native fixture",
      namespace: "harness:claude:default", path: join(machine.home, "claude") }],
    workspaces: [{ id: "ws_native", path: machine.project, sync: "git", gitFetch: "never" }], applied: {} };
}
