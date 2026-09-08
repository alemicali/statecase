import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { SyncEngine } from "../../apps/cli/src/sync.ts";
import { StatecaseClient } from "../../apps/cli/src/client.ts";
import { randomKey } from "../../packages/crypto/src/index.ts";
import { claudeProjectDirectory } from "../../packages/adapters/claude/src/index.ts";
import { referenceTransport } from "./native-reference.mjs";
import { assertClaudeMemoryContext } from "./native-memory.mjs";

// AD-MEM-008. Real pinned native file tools and startup memory, not hosted
// inference. Run only on disposable runner VMs, never the operator machine.
const execute = promisify(execFile);
const executable = process.env.STATECASE_UAT_CLAUDE, parent = process.env.STATECASE_UAT_PARENT;
assert.ok(executable && isAbsolute(executable));
assert.ok(parent && isAbsolute(parent));
assert.equal(process.env.STATECASE_UAT_CONFIRM, "run-native-harness-in-disposable-sandbox");
const root = await mkdtemp(join(parent, "statecase-native-memory-"));
const originalCwd = process.cwd();
const indexMarkers = Array.from({ length: 3 }, () => `index-${randomBytes(16).toString("hex")}`);
const topicMarkers = Array.from({ length: 3 }, () => `topic-${randomBytes(16).toString("hex")}`);
const unrelatedMarker = `unselected-${randomBytes(16).toString("hex")}`;
const prompt = "Perform the synthetic memory fixture task and then finish.";
const source = { home: join(root, "source-home"), project: join(root, "source-repository") };
const target = { home: join(root, "target-home"), project: join(root, "different", "target-repository") };
source.memory = join(claudeProjectDirectory(join(source.home, "claude"), source.project), "memory");
target.memory = join(target.home, "custom-memory");
const index = (marker) => `# Memory\n${marker}\n- [Synthetic project context](project_context.md)\n`;
const topic = `---\nname: Synthetic project context\ndescription: Synthetic fixture only\ntype: project\n---\n${topicMarkers[0]}\n`;
let phase = "setup", active, requestCount = 0, fixtureFailure, key, healthProbes = 0, invocation = 0;
const check = (condition, code) => { if (!condition) { fixtureFailure ??= code; throw new Error("native memory fixture assertion failed"); } };
const environment = (machine, disabled = false) => ({
  PATH: process.env.PATH, HOME: machine.home, CLAUDE_CONFIG_DIR: join(machine.home, "claude"),
  CODEX_HOME: join(machine.home, "codex"), CODEX_SQLITE_HOME: join(machine.home, "sqlite"),
  XDG_CONFIG_HOME: join(machine.home, "xdg"), TMPDIR: join(root, "tmp"),
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  ANTHROPIC_API_KEY: "statecase-synthetic-fixture-key",
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${provider.address()?.port ?? 1}`,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_MAX_RETRIES: "0", API_TIMEOUT_MS: "10000",
  ...(disabled ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } : {}),
});
const provider = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (request.method === "HEAD" && pathname === "/api/hello") {
      check(++healthProbes <= 12, "health-probe-limit"); response.writeHead(200); response.end(); return;
    }
    check(request.method === "POST" && ["/v1/messages", "/v1/messages/count_tokens"].includes(pathname), "unexpected-route");
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; check(size <= 8 * 1024 * 1024, "request-limit"); chunks.push(chunk); }
    let bytes = Buffer.concat(chunks);
    if (request.headers["content-encoding"] === "gzip") bytes = gunzipSync(bytes, { maxOutputLength: 8 * 1024 * 1024 });
    const body = JSON.parse(bytes.toString());
    if (pathname.endsWith("/count_tokens")) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ input_tokens: 100 })); return; }
    check(active && ++requestCount <= active.turns, "unexpected-model-turn");
    if (requestCount === 1 && active.resume) {
      const historyCalls = body.messages.filter((message) => message.role === "assistant")
        .flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((block) => block.type === "tool_use");
      check(historyCalls.length === 3, "memory-history-call-count");
      check(historyCalls.every((call) => call.input.file_path === join(target.memory, call.name === "Write" ? "MEMORY.md" : "project_context.md")), "memory-history-path-not-localized");
      const historyResults = body.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((block) => block.type === "tool_result");
      check(JSON.stringify(historyResults).includes(topicMarkers[0]), "memory-original-read-history-lost");
    } else if (requestCount === 1) {
      assertClaudeMemoryContext(body, {
        prompt, required: active.disabled ? [] : [active.unrelated ? unrelatedMarker : indexMarkers[active.generation], active.machine.memory],
        forbidden: [...indexMarkers.filter((_, i) => active.disabled || active.unrelated || i !== active.generation),
          ...topicMarkers, ...(active.unrelated ? [] : [unrelatedMarker])],
      });
    } else {
      const result = body.messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .find((block) => block.type === "tool_result" && block.tool_use_id === `${active.toolPrefix}_${requestCount - 1}`);
      check(result && !result.is_error, "native-tool-failed");
      if (requestCount === 2) check(JSON.stringify(result.content).includes(topicMarkers[active.generation]), "native-topic-not-read");
    }
    let tool;
    const memoryPath = (filename) => active.resume ? join(active.machine.memory, filename) : relative(active.machine.project, join(active.machine.memory, filename));
    if ((active.write || active.resume) && requestCount === 1) tool = { name: "Read", input: { file_path: memoryPath("project_context.md") } };
    else if (active.write && requestCount === 2) tool = { name: "Edit", input: {
      file_path: memoryPath("project_context.md"), old_string: topicMarkers[active.generation], new_string: topicMarkers[active.generation + 1],
    } };
    else if (active.write && requestCount === 3) tool = { name: "Write", input: { file_path: memoryPath("MEMORY.md"), content: index(indexMarkers[active.generation + 1]) } };
    if (tool) check(body.tools.some((candidate) => candidate.name === tool.name), "native-tool-not-offered");
    const content = tool ? { type: "tool_use", id: `${active.toolPrefix}_${requestCount}`, ...tool } : { type: "text", text: "Synthetic fixture complete." };
    const message = { id: `msg_memory_${requestCount}`, type: "message", role: "assistant", model: body.model,
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
    fixtureFailure ??= error.code === "NATIVE_MEMORY_MISMATCH" ? error.code : "provider-exception";
    response.writeHead(500); response.end();
  }
});
try {
  await mkdir(join(root, "tmp"), { mode: 0o700 });
  for (const machine of [source, target]) await mkdir(join(machine.home, "claude"), { recursive: true, mode: 0o700 });
  await execute("git", ["init", "-q", source.project], { env: environment(source) });
  await writeFile(join(source.project, "baseline.txt"), "Synthetic baseline\n");
  await execute("git", ["-C", source.project, "add", "."], { env: environment(source) });
  await execute("git", ["-C", source.project, "-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "synthetic baseline"], { env: environment(source) });
  await mkdir(join(root, "different"));
  await execute("git", ["clone", "-q", source.project, target.project], { env: environment(target) });
  for (const machine of [source, target]) {
    await writeFile(join(machine.home, "claude", "settings.json"), JSON.stringify({ model: "claude-sonnet-4-6", autoMemoryEnabled: true,
      ...(machine === target ? { autoMemoryDirectory: machine.memory } : {}) }), { mode: 0o600 });
    const unselected = join(claudeProjectDirectory(join(machine.home, "claude"), join(machine.home, "unrelated-repository")), "memory");
    await mkdir(unselected, { recursive: true, mode: 0o700 });
    await writeFile(join(unselected, "MEMORY.md"), unrelatedMarker, { mode: 0o600 });
  }
  await mkdir(source.memory, { recursive: true, mode: 0o700 });
  await writeFile(join(source.memory, "MEMORY.md"), index(indexMarkers[0]), { mode: 0o600 });
  await writeFile(join(source.memory, "project_context.md"), topic, { mode: 0o600 });
  const targetSettings = await readFile(join(target.home, "claude", "settings.json"), "utf8");
  const version = (await execute(executable, ["--version"], { env: environment(source), timeout: 15_000 })).stdout.trim();
  assert.equal(version, "2.1.263 (Claude Code)");
  await new Promise((accept, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", accept); });
  const ids = new Set();
  phase = "memory-source";
  const sourceSession = await harness(source, 0, { write: true }); ids.add(sourceSession);
  const sourceHistory = (await readFile(join(claudeProjectDirectory(join(source.home, "claude"), source.project), `${sourceSession}.jsonl`), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  const sourceCalls = sourceHistory.flatMap((record) => record.message?.role === "assistant" && Array.isArray(record.message.content) ? record.message.content : [])
    .filter((block) => block.type === "tool_use");
  check(sourceCalls.length === 3 && sourceCalls.every((call) => typeof call.input.file_path === "string" && !isAbsolute(call.input.file_path) &&
    call.input.file_path === relative(source.project, join(source.memory, call.name === "Write" ? "MEMORY.md" : "project_context.md"))), "memory-source-relative-history-missing");
  const written = await memoryBytes(source);
  assert.ok(written.topic.includes(topicMarkers[1]));
  assert.ok(!written.topic.includes(topicMarkers[0]));
  assert.ok(written.index.includes(indexMarkers[1]));
  phase = "memory-transfer";
  const remote = referenceTransport(indexMarkers[1]);
  key = await randomKey();
  const engine = new SyncEngine(new StatecaseClient("https://native-fixture.invalid", "synthetic", remote.fetch), "vlt_native", key);
  const a = config(source), b = config(target);
  process.chdir(source.project);
  assert.equal((await engine.push(a)).outcome, "pushed");
  const reports = await engine.dependencies();
  assert.equal(reports.length, 1);
  assert.ok(reports[0].dependencies.some((dependency) => dependency.source === "memory" && dependency.logicalPath === "project-memory/project_context.md" && dependency.status === "resolved"));
  process.chdir(target.project);
  await engine.hydrate(b, reports[0].sessionCapsuleId, { mode: "strict", dryRun: true });
  assert.deepEqual(b.applied, {});
  await assert.rejects(readdir(target.memory), { code: "ENOENT" });
  assert.equal(await readFile(join(target.home, "claude", "settings.json"), "utf8"), targetSettings);
  await engine.hydrate(b, reports[0].sessionCapsuleId, { mode: "strict" });
  assert.deepEqual(await memoryBytes(target), written);
  assert.equal(await readFile(join(target.home, "claude", "settings.json"), "utf8"), targetSettings);
  assert.equal((await engine.push(b)).outcome, "unchanged");
  phase = "memory-resume";
  assert.equal(await harness(target, 1, { resume: sourceSession }), sourceSession);
  assert.deepEqual(await memoryBytes(target), written);
  phase = "memory-target";
  const fresh = await harness(target, 1, { write: true });
  assert.ok(!ids.has(fresh)); ids.add(fresh);
  const returned = await memoryBytes(target);
  assert.ok(returned.topic.includes(topicMarkers[2]));
  assert.ok(!returned.topic.includes(topicMarkers[1]));
  assert.ok(returned.index.includes(indexMarkers[2]));
  phase = "memory-return-publish";
  assert.equal((await engine.push(b)).outcome, "pushed");
  process.chdir(source.project);
  phase = "memory-return-pull";
  assert.equal((await engine.pull(a)).outcome, "pulled");
  assert.deepEqual(await memoryBytes(source), returned);
  phase = "memory-return-noop";
  assert.equal((await engine.push(a)).outcome, "unchanged");
  phase = "memory-recall";
  for (const disabled of [false, true]) {
    const id = await harness(source, 2, { disabled });
    assert.ok(!ids.has(id)); ids.add(id);
    assert.deepEqual(await memoryBytes(source), returned);
  }
  phase = "memory-worktree";
  const worktree = { ...source, project: join(root, "linked-worktree") };
  await execute("git", ["-C", source.project, "worktree", "add", "--detach", worktree.project, "HEAD"], { env: environment(source) });
  const worktreeId = await harness(worktree, 2);
  assert.ok(!ids.has(worktreeId)); ids.add(worktreeId);
  assert.deepEqual(await memoryBytes(source), returned);
  phase = "memory-subdirectory";
  const subdirectory = { ...source, project: join(source.project, "nested", "directory") };
  await mkdir(subdirectory.project, { recursive: true, mode: 0o700 });
  const subdirectoryId = await harness(subdirectory, 2);
  assert.ok(!ids.has(subdirectoryId)); ids.add(subdirectoryId);
  assert.deepEqual(await memoryBytes(source), returned);
  phase = "memory-unrelated";
  const unrelated = { ...source, project: join(source.home, "unrelated-repository") };
  unrelated.memory = join(claudeProjectDirectory(join(source.home, "claude"), unrelated.project), "memory");
  await execute("git", ["init", "-q", unrelated.project], { env: environment(source) });
  const unrelatedId = await harness(unrelated, undefined, { unrelated: true });
  assert.ok(!ids.has(unrelatedId)); ids.add(unrelatedId);
  for (const machine of [source, target]) {
    const unselected = join(claudeProjectDirectory(join(machine.home, "claude"), join(machine.home, "unrelated-repository")), "memory");
    assert.equal(await readFile(join(unselected, "MEMORY.md"), "utf8"), unrelatedMarker);
    assert.deepEqual((await readdir(machine.memory)).sort(), ["MEMORY.md", "project_context.md"]);
  }
  console.log(JSON.stringify({ result: "pass", harness: version, node: process.version, backend: "in-memory-reference",
    topology: "two-homes-one-host", inference: "deterministic-loopback", freshSessions: ids.size,
    nativeDefaultMemoryRoot: true, nativeCustomMemoryRoot: true, startupIndexRecall: true, topicReadOnDemand: true,
    nativeMemoryEditWrite: true, disabledMemoryNegativeControl: true, unselectedMemoryPreserved: true,
    worktreeSharedRecall: true, subdirectorySharedRecall: true, unrelatedProjectIsolatedRecall: true,
    sameSessionMemoryResume: true, memoryHistoryPathsLocalized: true, originalMemoryReadHistoryPreserved: true,
    resumedNativeRead: true, localizedSessionNoOpRoundTrip: true,
    sourceRelativeMemoryHistory: true, nativeRelativeMemoryTools: true,
    exactMemoryTransfer: true, memoryDependencyResolved: true, hydrationPreviewNonMutating: true,
    localMemorySettingsPreserved: true, returnTransferAndFreshRecall: true, encryptedObjects: remote.objectCount() }));
} catch (error) {
  console.error(JSON.stringify({ result: "fail", phase, error: error.name, fixtureFailure, requests: requestCount }));
  process.exitCode = 1;
} finally {
  key?.fill(0); provider.closeAllConnections();
  await new Promise((accept) => provider.close(accept));
  process.chdir(originalCwd);
  await rm(root, { recursive: true, force: true });
}

async function memoryBytes(machine) {
  return { index: await readFile(join(machine.memory, "MEMORY.md"), "utf8"), topic: await readFile(join(machine.memory, "project_context.md"), "utf8") };
}
async function harness(machine, generation, { write = false, disabled = false, unrelated = false, resume } = {}) {
  active = { machine, generation, write, disabled, unrelated, resume, turns: write ? 4 : resume ? 2 : 1, toolPrefix: `toolu_memory_${++invocation}` }; requestCount = 0;
  const args = ["--setting-sources", "user", "--disable-slash-commands", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--no-chrome", "--tools", "Read,Write,Edit", "--allowedTools", "Read,Write,Edit", "--permission-mode", "acceptEdits",
    "--max-turns", "5", "--output-format", "json", ...(resume ? ["--resume", resume] : []), "-p", prompt];
  const pending = execute(executable, args, { cwd: machine.project, env: environment(machine, disabled), timeout: 45_000, maxBuffer: 1024 * 1024, detached: true });
  pending.child.stdin.end();
  let result, cleanupError;
  try { result = await pending; }
  finally { if (pending.child.pid) { try { process.kill(-pending.child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") cleanupError = error; } } }
  if (cleanupError) throw cleanupError;
  check(fixtureFailure === undefined, "provider-failed");
  check(requestCount === active.turns, "model-turn-count");
  const output = JSON.parse(result.stdout);
  check(output.type === "result" && output.subtype === "success" && output.is_error === false, "native-result-failed");
  assert.match(output.session_id, /^[a-f0-9-]{36}$/u);
  return output.session_id;
}
function config(machine) {
  return { version: 1, apiUrl: "https://native-fixture.invalid", deviceId: "device_fixture",
    mappings: [{ id: "claude-default", kind: "claude", mode: "two-way", namespace: "harness:claude:default", path: join(machine.home, "claude") }],
    workspaces: [{ id: "ws_native", path: machine.project, sync: "git", gitFetch: "never" }],
    memories: [{ id: "project-memory", kind: "claude-project", harnessNamespace: "harness:claude:default", workspaceId: "ws_native", path: machine.memory, mode: "two-way" }], applied: {} };
}
