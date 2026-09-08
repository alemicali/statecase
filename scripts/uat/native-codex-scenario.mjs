import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { SyncEngine } from "../../apps/cli/src/sync.ts";
import { StatecaseClient } from "../../apps/cli/src/client.ts";
import { randomKey } from "../../packages/crypto/src/index.ts";
import { assertNativePreferences, summarizeNativeConfigChange, summarizeNativeProjectChange } from "./native-preferences.mjs";
import { nativeResponseEvents } from "./native-responses-events.mjs";
import { assertNativeInstructions } from "./native-instructions.mjs";

// AD-CX-007, WS-022, UAT-02 subset. Real harness + actual encryption/engine,
// deterministic loopback Responses provider, in-memory reference transport.
// This is not a hosted-model, packaged-CLI, live-cloud, or separate-host drill.
const execute = promisify(execFile);
const executable = process.env.STATECASE_UAT_CODEX;
const parent = process.env.STATECASE_UAT_PARENT;
assert.ok(executable && isAbsolute(executable));
assert.ok(parent && isAbsolute(parent) && !resolve(parent).startsWith("/tmp"), "Codex helpers need a persistent fixture parent outside /tmp");
const externalIsolation = process.env.STATECASE_UAT_CODEX_SANDBOX === "externally-isolated";
if (externalIsolation) {
  assert.equal(process.env.STATECASE_UAT_CONFIRM, "run-native-harness-in-disposable-sandbox");
}
const root = await mkdtemp(join(parent, "statecase-native-codex-"));
const originalCwd = process.cwd();
const marker = `native-canary-${randomBytes(12).toString("hex")}`;
const instructionMarker = `instruction-${randomBytes(12).toString("hex")}`;
const fallbackMarker = `fallback-${randomBytes(12).toString("hex")}`;
const source = { home: join(root, "source-home"), project: join(root, "source-project") };
const target = { home: join(root, "target-home"), project: join(root, "different", "target-project") };
const memoryPath = (machine) => join(machine.home, "selected-memory", "topic.md");
const sourcePatch = (memoryFile) => `*** Begin Patch\n*** Add File: artifact.txt\n+${marker}\n*** Add File: ${memoryFile}\n+${marker}\n*** End Patch`;
let phase = "setup";
let requests = 0;
let stage = "source";
let fixtureError;
let sessionId;
let key;
let expectedEffort = "low";
let preferenceProbe;
let configChange;
let projectChange;
const inputBytes = "synthetic input continuity\n";
const environment = (machine) => ({
  PATH: process.env.PATH, HOME: machine.home,
  CODEX_HOME: join(machine.home, "codex"), CODEX_SQLITE_HOME: join(machine.home, "sqlite"),
  CLAUDE_CONFIG_DIR: join(machine.home, "claude"), TMPDIR: join(root, "tmp"),
  XDG_CONFIG_HOME: join(machine.home, "xdg"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
});
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/responses");
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      assert.ok(size <= 8 * 1024 * 1024, "fixture request bound exceeded");
      chunks.push(chunk);
    }
    let bytes = Buffer.concat(chunks);
    if (request.headers["content-encoding"] === "gzip") bytes = gunzipSync(bytes, { maxOutputLength: 8 * 1024 * 1024 });
    const body = JSON.parse(bytes.toString());
    assertNativePreferences("codex", body, { model: "gpt-5.6-terra", effort: expectedEffort });
    if (phase === "native-preferences" || stage === "source") {
      assertNativeInstructions("codex", body, { required: [instructionMarker], forbidden: [fallbackMarker] });
    }
    requests++;
    assert.ok(requests <= 3, "unexpected provider retry or extra tool turn");
    const machine = stage === "source" ? source : target;
    const outputs = body.input.filter((item) => ["function_call_output", "custom_tool_call_output"].includes(item.type));
    let item;
    if (phase === "native-preferences") {
      item = { id: "msg_preferences", type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "Fixture preferences confirmed.", annotations: [] }] };
    } else if (requests === 1) {
      if (stage === "target") {
        assert.ok(JSON.stringify(body.input).includes(marker), "native resume lost the original prompt");
        assert.ok(JSON.stringify(outputs).includes(inputBytes.trim()), "native resume lost the original tool output");
        const historicalPatch = body.input.find((entry) => entry.type === "custom_tool_call" && entry.call_id === "patch_source");
        assert.equal(historicalPatch?.input, sourcePatch(memoryPath(target)), "native patch history did not localize the selected memory header");
      }
      item = { id: `fc_${stage}`, type: "function_call", name: "exec_command", call_id: `read_${stage}`,
        arguments: JSON.stringify({ cmd: stage === "source" ? "pwd && cat input.txt" : "pwd && cat artifact.txt", login: false }) };
    } else if (requests === 2) {
      const output = outputs.find((candidate) => candidate.call_id === `read_${stage}`)?.output;
      assert.equal(typeof output, "string");
      assert.ok(output.includes(machine.project), "tool used the wrong mapped cwd");
      assert.ok(output.includes(stage === "source" ? inputBytes.trim() : marker), "tool did not read transferred bytes");
      assert.match(output, /exited with code 0/u, "native read command failed");
      item = { id: `ct_${stage}`, type: "custom_tool_call", name: "apply_patch", call_id: `patch_${stage}`,
        input: stage === "source"
          ? sourcePatch(relative(machine.project, memoryPath(machine)))
          : `*** Begin Patch\n*** Update File: artifact.txt\n@@\n ${marker}\n+continued on target\n*** Update File: ${relative(machine.project, memoryPath(machine))}\n@@\n ${marker}\n+continued memory on target\n*** End Patch` };
    } else {
      assert.equal(await readFile(join(machine.project, "artifact.txt"), "utf8"), `${marker}\n${stage === "target" ? "continued on target\n" : ""}`);
      assert.equal(await readFile(memoryPath(machine), "utf8"), `${marker}\n${stage === "target" ? "continued memory on target\n" : ""}`);
      item = { id: `msg_${stage}`, type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "Fixture turn completed.", annotations: [] }] };
    }
    const responseScope = phase === "native-preferences" ? `preferences_${preferenceProbe}` : stage;
    const completed = { id: `resp_${responseScope}_${requests}`, object: "response", created_at: Math.floor(Date.now() / 1000),
      model: body.model, status: "completed", output: [item], usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40 } };
    const events = nativeResponseEvents(completed);
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [sequence_number, event] of events.entries()) response.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`);
    response.end();
  } catch (error) {
    fixtureError ??= error;
    response.writeHead(500);
    response.end();
  }
});
try {
  await mkdir(join(root, "tmp"), { mode: 0o700 });
  for (const machine of [source, target]) {
    for (const path of [machine.project, join(machine.home, "codex"), join(machine.home, "sqlite"), join(machine.home, "selected-memory")]) await mkdir(path, { recursive: true, mode: 0o700 });
    await execute("git", ["init", "-q", machine.project], { env: environment(machine), timeout: 15_000 });
  }
  const version = (await execute(executable, ["--version"], { env: environment(source), timeout: 15_000 })).stdout.trim();
  assert.equal(version, "codex-cli 0.153.4", "new harness versions require explicit compatibility qualification");
  await new Promise((accept, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", accept); });
  await configure(source);
  await configure(target);
  await writeFile(join(source.home, "codex", "AGENTS.md"), `Synthetic fallback instruction: ${fallbackMarker}\n`, { mode: 0o600 });
  await writeFile(join(source.home, "codex", "AGENTS.override.md"), `Synthetic active instruction: ${instructionMarker}\n`, { mode: 0o600 });
  const targetLocalSettings = await readFile(join(target.home, "codex", "config.toml"), "utf8");
  await writeFile(join(source.project, "input.txt"), inputBytes);
  phase = "native-source";
  sessionId = await harness(source, ["exec", "--skip-git-repo-check", "--json", "-C", source.project,
    `Read input.txt and create artifact.txt containing the synthetic marker ${marker}.`]);
  assert.match(sessionId, /^[a-f0-9-]{36}$/u);
  const sourceSessions = join(source.home, "codex", "sessions");
  const sourceNames = (await readdir(sourceSessions, { recursive: true })).filter((name) => name.endsWith(".jsonl"));
  assert.equal(sourceNames.length, 1);
  const sourceRecords = (await readFile(join(sourceSessions, sourceNames[0]), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const recordedPatch = sourceRecords.find((record) => record.type === "response_item" && record.payload?.type === "custom_tool_call" && record.payload.call_id === "patch_source");
  assert.equal(recordedPatch?.payload.input, sourcePatch(relative(source.project, memoryPath(source))));

  phase = "encrypted-transfer";
  const remote = referenceTransport(marker);
  key = await randomKey();
  const engine = new SyncEngine(new StatecaseClient("https://native-fixture.invalid", "synthetic", remote.fetch), "vlt_native", key);
  const a = config(source);
  const b = config(target);
  process.chdir(source.project);
  assert.equal((await engine.push(a)).outcome, "pushed");
  process.chdir(target.project);
  const reports = await engine.dependencies();
  assert.equal(reports.length, 1);
  assert.ok(reports[0].dependencies.some((dependency) => dependency.logicalPath === "artifact.txt"
    && dependency.source === "workspace-overlay" && dependency.status === "resolved"), "native patch target missing from dependency closure");
  assert.ok(reports[0].dependencies.some((dependency) => dependency.logicalPath === "recall/topic.md"
    && dependency.source === "memory" && dependency.status === "resolved"), "native memory patch target missing from dependency closure");
  // An empty native database is deliberate: Statecase never transports SQLite.
  assert.deepEqual(await readdir(join(target.home, "sqlite")), []);
  const preview = await engine.hydrate(b, reports[0].sessionCapsuleId, { mode: "strict", dryRun: true });
  assert.equal(preview.warnings.length, 0);
  await assert.rejects(readFile(join(target.project, "artifact.txt")), { code: "ENOENT" });
  await assert.rejects(readFile(memoryPath(target)), { code: "ENOENT" });
  assert.deepEqual(b.applied, {});
  assert.equal(await readFile(join(target.home, "codex", "config.toml"), "utf8"), targetLocalSettings);
  await assert.rejects(readFile(join(target.home, "codex", "AGENTS.override.md")), { code: "ENOENT" });
  const hydrated = await engine.hydrate(b, reports[0].sessionCapsuleId, { mode: "strict" });
  assert.equal(hydrated.warnings.length, 0);
  assert.equal(await readFile(join(target.project, "input.txt"), "utf8"), inputBytes);
  assert.equal(await readFile(join(target.project, "artifact.txt"), "utf8"), `${marker}\n`);
  assert.equal(await readFile(memoryPath(target), "utf8"), `${marker}\n`);
  assert.deepEqual(await readdir(join(target.home, "sqlite")), []);
  const hydratedSettings = await readFile(join(target.home, "codex", "config.toml"), "utf8");
  assert.ok(hydratedSettings.endsWith(targetLocalSettings), "native local-only config changed");
  assert.ok(!hydratedSettings.includes("statecase_fixture_source"), "source provider configuration crossed devices");
  assert.ok(!hydratedSettings.includes(source.project), "source project trust crossed devices");
  for (const name of ["AGENTS.md", "AGENTS.override.md"]) {
    assert.deepEqual(await readFile(join(target.home, "codex", name)), await readFile(join(source.home, "codex", name)));
  }
  assert.equal((await engine.push(b)).outcome, "unchanged");

  phase = "native-resume";
  stage = "target";
  requests = 0;
  // Keep the hydrated file intact: a local rewrite here would mask sync defects.
  assert.equal(await harness(target, ["exec", "-C", target.project, "resume", "--skip-git-repo-check", "--json", sessionId,
    "Continue the earlier task: inspect its artifact and append the continuation line."]), sessionId);
  assert.equal(await readFile(join(source.project, "artifact.txt"), "utf8"), `${marker}\n`);
  assert.equal(await readFile(memoryPath(source), "utf8"), `${marker}\n`);
  phase = "return-publish";
  assert.equal((await engine.push(b)).outcome, "pushed");
  phase = "return-pull";
  process.chdir(source.project);
  assert.equal((await engine.pull(a)).outcome, "pulled");
  assert.equal(await readFile(join(source.project, "artifact.txt"), "utf8"), `${marker}\ncontinued on target\n`);
  assert.equal(await readFile(memoryPath(source), "utf8"), `${marker}\ncontinued memory on target\n`);
  assert.equal((await engine.push(a)).outcome, "unchanged");
  assert.equal(Object.keys(a.sessionBindings).length, 1);
  assert.equal(Object.keys(b.sessionBindings).length, 1);
  phase = "native-preferences";
  for (const override of [false, true]) {
    preferenceProbe = override ? "override" : "synced";
    requests = 0; expectedEffort = override ? "high" : "low";
    const beforeProbeSettings = await readFile(join(target.home, "codex", "config.toml"), "utf8");
    const fresh = await harness(target, [...(override ? ["-c", 'model_reasoning_effort="high"'] : []),
      "exec", "--skip-git-repo-check", "--json", "-C", target.project, "Reply with fixture completion text."]);
    requireNative(typeof fresh === "string" && /^[a-f0-9-]{36}$/u.test(fresh), "NATIVE_SESSION_ID_INVALID");
    requireNative(fresh !== sessionId, "NATIVE_SESSION_REUSED");
    const afterProbeSettings = await readFile(join(target.home, "codex", "config.toml"), "utf8");
    configChange = summarizeNativeConfigChange(beforeProbeSettings, afterProbeSettings);
    projectChange = summarizeNativeProjectChange(beforeProbeSettings, afterProbeSettings, { source: source.project, target: target.project });
    requireNative(afterProbeSettings === beforeProbeSettings, "NATIVE_CONFIG_CHANGED");
  }
  console.log(JSON.stringify({ result: "pass", harness: version, node: process.version,
    backend: "in-memory-reference", topology: "two-homes-one-host", inference: "deterministic-loopback",
    sameSessionId: true, originalHistory: true, nativeReadWrite: true, mappedCwd: true,
    nativeDatabaseNotCopied: true, patchDependency: true, hydrationPreviewNonMutating: true,
    sourceUnchangedBeforeSync: true, returnSync: true, syncFromMappedCwd: true,
    nativeEffectivePreferences: true, freshPreferenceSession: true, localConfigPreserved: true, cliPreferenceOverride: true,
    nativeGlobalInstructions: true, nativeInstructionOverridePrecedence: true,
    nativeMemoryPatchWrite: true, sourceRelativeMemoryPatchHistory: true, localizedMemoryPatchHistory: true,
    memoryPatchDependency: true, exactMemoryPatchReturn: true, canonicalNoOpRoundTrip: true,
    encryptedObjects: remote.objectCount() }));
} catch (error) {
  const conflictKinds = Array.isArray(error.paths) ? [...new Set(error.paths.map((path) =>
    path.startsWith("harness:codex:default:") ? "codex" : path.startsWith("workspace:ws_native:") ? "workspace" : "other"))] : undefined;
  console.error(JSON.stringify({ result: "fail", phase, error: error.name, fixtureError: fixtureError?.name,
    preferenceFailure: fixtureError?.code, nativeFailure: error.code, preferenceProbe, configChange, projectChange, requests, conflictKinds }));
  process.exitCode = 1;
} finally {
  key?.fill(0);
  provider.closeAllConnections();
  await new Promise((accept) => provider.close(accept));
  process.chdir(originalCwd);
  await rm(root, { recursive: true, force: true });
}

async function configure(machine) {
  const providerId = machine === source ? "statecase_fixture_source" : "statecase_fixture_target";
  await writeFile(join(machine.home, "codex", "config.toml"),
    `${machine === source ? 'model = "gpt-5.6-terra"\nmodel_reasoning_effort = "low"\n' : ""}# device-local provider\nmodel_provider = "${providerId}"\napproval_policy = "never"\nsandbox_mode = "${externalIsolation ? "danger-full-access" : "workspace-write"}"\nweb_search = "disabled"\n[model_providers.${providerId}]\nname = "Statecase deterministic fixture"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n# Each disposable device approves only its own synthetic project.\n[projects.${JSON.stringify(machine.project)}]\ntrust_level = "trusted"\n`, { mode: 0o600 });
}

async function harness(machine, args) {
  // Every invocation belongs to this synthetic device, including startup
  // project discovery before CLI -C is applied. Never inherit the engine's
  // most recent peer cwd after the A -> B -> A round trip.
  const pending = execute(executable, args, { cwd: machine.project, env: environment(machine), timeout: 45_000, maxBuffer: 1024 * 1024, detached: true });
  // exec also consumes piped stdin; without EOF a command can hang before inference.
  pending.child.stdin.end();
  let result;
  let cleanupError;
  try { result = await pending; }
  finally {
    // The separate process group contains only this fixture invocation. Also
    // terminate helper descendants after an early failure or parent timeout.
    if (pending.child.pid) {
      try { process.kill(-pending.child.pid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") cleanupError = error; }
    }
  }
  if (cleanupError) throw cleanupError;
  assert.equal(requests, phase === "native-preferences" ? 1 : 3);
  assert.equal(fixtureError, undefined);
  const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  requireNative(events.some((event) => event.type === "turn.completed"), "NATIVE_TURN_INCOMPLETE");
  return events.find((event) => event.type === "thread.started")?.thread_id;
}

function requireNative(condition, code) {
  if (!condition) { const error = new Error("native qualification assertion failed"); error.code = code; throw error; }
}

function config(machine) {
  return { version: 1, apiUrl: "https://native-fixture.invalid", deviceId: "device_fixture",
    mappings: [{ id: "codex-default", kind: "codex", mode: "two-way", name: "Native fixture",
      namespace: "harness:codex:default", path: join(machine.home, "codex") }],
    memories: [{ id: "recall", kind: "codex-global", harnessNamespace: "harness:codex:default",
      path: join(machine.home, "selected-memory"), mode: "two-way" }],
    workspaces: [{ id: "ws_native", path: machine.project, sync: "git", gitFetch: "never" }], applied: {} };
}

function referenceTransport(canary) {
  const objects = new Map(), heads = new Map(), revisions = new Map(), checkpoints = new Map();
  let head = null;
  return { objectCount: () => objects.size, fetch: async (input, init) => {
    const url = new URL(input);
    let match = /\/namespaces\/([^/]+)\/objects\/([^/]+)$/u.exec(url.pathname);
    if (match) {
      const objectKey = `${decodeURIComponent(match[1])}\0${match[2]}`;
      if (init?.method === "PUT") {
        const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
        assert.ok(!new TextDecoder().decode(bytes).includes(canary), "plaintext canary reached object storage");
        objects.set(objectKey, bytes);
        return Response.json({ created: true, size: bytes.byteLength }, { status: 201 });
      }
      assert.ok(objects.has(objectKey));
      return new Response(objects.get(objectKey));
    }
    match = /\/namespaces\/([^/]+)\/revisions\/([^/]+)$/u.exec(url.pathname);
    if (match) return Response.json(revisions.get(`${decodeURIComponent(match[1])}\0${match[2]}`));
    match = /\/scoped-revisions\/([^/]+)$/u.exec(url.pathname);
    if (match) return Response.json(checkpoints.get(match[1]));
    if (url.pathname.endsWith("/namespaces")) return Response.json({ revisionId: head, namespaces: [...heads.values()], commitProvenance: 1 });
    if (url.pathname.endsWith("/head")) return Response.json({ revisionId: null, manifestObjectId: null });
    if (url.pathname.endsWith("/namespace-commits")) {
      const request = JSON.parse(init.body);
      for (const update of request.updates) assert.equal(heads.get(update.namespace)?.revisionId ?? null, update.baseNamespaceRevisionId);
      for (const update of request.updates) {
        const previousRevisionId = heads.get(update.namespace)?.revisionId ?? null;
        const value = { namespace: update.namespace, revisionId: update.namespaceRevisionId, manifestObjectId: update.manifestObjectId, keyEpoch: update.keyEpoch ?? 1, commitMode: update.mode };
        heads.set(update.namespace, value);
        revisions.set(`${update.namespace}\0${update.namespaceRevisionId}`, { ...value, previousRevisionId });
      }
      const previousRevisionId = head;
      head = request.vaultRevisionId;
      checkpoints.set(head, { revisionId: head, previousRevisionId, namespaces: [...heads.values()] });
      return Response.json({ outcome: "committed", revisionId: head });
    }
    throw new Error("unsupported reference transport route");
  } };
}
