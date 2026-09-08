import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

// UAT-03, AD-CL-006, RT-001/003: independent-host peer. No imports from product
// source: every Statecase operation uses an independently installed CLI/shim.
// An authorized orchestrator supplies a private synthetic fixture input file,
// transports only the encrypted enrollment kit and opaque IDs between hosts,
// and must delete the exact owned sandboxes/account/vault after qualification.
const execute = promisify(execFile);
const phase = process.argv[2];
const inputPath = process.argv[3];
let provider;
let failure;
let step = "input";
try {
  assert.equal(process.env.STATECASE_UAT_CONFIRM, "create-and-modify-remote-state");
  assert.ok(["init", "source", "hydrate", "resume", "return", "inspect"].includes(phase));
  assert.ok(inputPath && isAbsolute(inputPath) && basename(inputPath) === "input.json");
  const root = dirname(inputPath);
  assert.match(basename(root), /^statecase-crosshost-[a-f0-9]{24}-[ab]$/u);
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  assert.match(input.runId, /^[a-f0-9]{24}$/u);
  assert.ok(input.role === "a" || input.role === "b");
  assert.equal(basename(root), `statecase-crosshost-${input.runId}-${input.role}`);
  assert.equal(input.apiUrl, "https://statecase-api.hi-0e6.workers.dev");
  assert.ok(isAbsolute(input.cli) && isAbsolute(input.claude));
  const home = join(root, "user-home");
  const project = join(root, input.role === "a" ? "source-project" : "elsewhere/target-project");
  const claudeRoot = join(home, "claude");
  const profile = join(home, "statecase");
  const statePath = join(root, "state.json");
  const recovery = join(root, "recovery.json");
  const marker = `claude-cloud-${input.runId}`;
  const originalPrompt = `Read input.txt, edit artifact.txt to contain ${marker}, and create note.txt.`;
  const inputBytes = "synthetic tracked cross-host input\n";
  const noteBytes = "synthetic untracked cross-host note\n";
  const env = { PATH: `${dirname(input.claude)}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
    HOME: home, TMPDIR: join(root, "tmp"), XDG_CONFIG_HOME: join(home, "xdg"),
    CLAUDE_CONFIG_DIR: claudeRoot, CODEX_HOME: join(home, "codex"), CODEX_SQLITE_HOME: join(home, "sqlite"),
    STATECASE_HOME: profile, STATECASE_API_URL: input.apiUrl,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_DATE: "2026-09-08T00:00:00Z", GIT_COMMITTER_DATE: "2026-09-08T00:00:00Z" };
  const check = (condition, code) => { if (!condition) { failure ??= code; throw new Error("fixture assertion failed"); } };
  const command = async (args, extra = {}) => {
    const result = await bounded(process.execPath, [input.cli, "--json", ...args], { ...env, ...extra }, project);
    return JSON.parse(result.stdout.trim().split("\n").at(-1));
  };
  const git = async (...args) => (await bounded("git", ["-C", project, ...args], env, project)).stdout.trim();
  const nativePath = (id) => join(claudeRoot, "projects", project.replaceAll(/[^\p{L}\p{N}._-]/gu, "-"), `${id}.jsonl`);
  const state = phase === "init" ? {} : JSON.parse(await readFile(statePath, "utf8"));
  const save = () => writeFile(statePath, JSON.stringify(state), { mode: 0o600 });

  if (phase === "init") {
    assert.ok(typeof input.token === "string" && input.token.length > 0);
    assert.ok(typeof input.recoveryPassphrase === "string" && input.recoveryPassphrase.length >= 12);
    await mkdir(home, { mode: 0o700 });
    await mkdir(env.TMPDIR, { mode: 0o700 });
    await mkdir(project, { recursive: true, mode: 0o700 });
    await git("init", "-q", "--initial-branch=main");
    await writeFile(join(project, "input.txt"), inputBytes);
    await writeFile(join(project, "artifact.txt"), "baseline artifact\n");
    await git("add", ".");
    await git("-c", "user.name=Statecase Test", "-c", "user.email=test@statecase.invalid", "commit", "-qm", "synthetic cross-host baseline");
    state.baseline = await git("rev-parse", "HEAD");
    await command(["login", "--non-interactive", "--device-name", `native-peer-${input.role}`], { STATECASE_TOKEN: input.token });
    if (input.role === "a") {
      const vault = await command(["vault", "create", "Native cross-host UAT", "--recovery-file", recovery],
        { STATECASE_RECOVERY_PASSPHRASE: input.recoveryPassphrase });
      state.vaultId = vault.id;
    } else {
      assert.match(input.vaultId, /^vlt_[a-f0-9]{32}$/u);
      await command(["vault", "join", input.vaultId, "--recovery-file", recovery],
        { STATECASE_RECOVERY_PASSPHRASE: input.recoveryPassphrase });
      state.vaultId = input.vaultId;
    }
    const setup = await command(["setup", "--harness", "claude", "--transparent", "--shim-dir", join(root, "shims")]);
    check(setup.shims.length === 1 && setup.shims[0].realExecutable === input.claude, "shim-executable-mismatch");
    await command(["workspace", "attach", "--id", "ws_crosshost", "--path", project, "--mode", "git-overlay", "--git-fetch", "never"]);
    await save();
    console.log(JSON.stringify({ result: "pass", phase, role: input.role, vaultId: state.vaultId, baseline: state.baseline }));
  } else if (phase === "hydrate") {
    assert.equal(input.role, "b");
    step = "dependency-report";
    const reports = (await command(["workspace", "dependencies", "--workspace", "ws_crosshost"])).reports;
    check(reports.length === 1, "capsule-count");
    state.capsuleId = reports[0].sessionCapsuleId;
    state.sessionId = input.sessionId;
    assert.match(state.sessionId, /^[a-f0-9-]{36}$/u);
    step = "preview-baseline";
    const beforeConfig = await readFile(join(profile, "config.json"));
    const beforeHarness = await treeDigest(claudeRoot);
    step = "preview-command";
    await command(["workspace", "hydrate", "--session", state.capsuleId, "--mode", "strict", "--dry-run"]);
    step = "preview-invariants";
    assert.deepEqual(await readFile(join(profile, "config.json")), beforeConfig);
    assert.equal(await treeDigest(claudeRoot), beforeHarness);
    assert.equal(await readFile(join(project, "artifact.txt"), "utf8"), "baseline artifact\n");
    await assert.rejects(readFile(join(project, "note.txt")), { code: "ENOENT" });
    step = "hydrate-command";
    await command(["workspace", "hydrate", "--session", state.capsuleId, "--mode", "strict"]);
    step = "hydrate-invariants";
    assert.equal(await git("rev-parse", "HEAD"), state.baseline);
    assert.equal(await readFile(join(project, "input.txt"), "utf8"), inputBytes);
    assert.equal(await readFile(join(project, "artifact.txt"), "utf8"), `${marker}\n`);
    assert.equal(await readFile(join(project, "note.txt"), "utf8"), noteBytes);
    assert.ok((await readFile(nativePath(state.sessionId))).byteLength > 0);
    await save();
    console.log(JSON.stringify({ result: "pass", phase, strictHydration: true, previewNonMutating: true, nativeProjectPath: true }));
  } else if (phase === "inspect") {
    const config = JSON.parse(await readFile(join(profile, "config.json"), "utf8"));
    const exists = async (path) => { try { await readdir(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
    const artifact = await readFile(join(project, "artifact.txt"), "utf8");
    console.log(JSON.stringify({ result: "pass", phase, appliedNamespaces: Object.keys(config.applied).length,
      nativeRootExists: await exists(claudeRoot), defaultNativeRootExists: await exists(join(home, ".claude")),
      artifactAtBaseline: artifact === "baseline artifact\n", artifactHydrated: artifact === `${marker}\n`,
      bindingCount: Object.keys(config.sessionBindings ?? {}).length }));
  } else if (phase === "source" || phase === "resume") {
    const source = phase === "source";
    assert.equal(input.role, source ? "a" : "b");
    assert.equal((await bounded(input.claude, ["--version"], env, project)).stdout.trim(), "2.1.263 (Claude Code)");
    let requests = 0, probes = 0;
    provider = createServer(async (request, response) => {
      try {
        const path = new URL(request.url, "http://127.0.0.1").pathname;
        if (request.method === "HEAD" && path === "/api/hello") {
          check(++probes <= 4, "probe-limit"); response.writeHead(200); response.end(); return;
        }
        check(request.method === "POST" && ["/v1/messages", "/v1/messages/count_tokens"].includes(path), "unexpected-provider-route");
        let size = 0; const chunks = [];
        for await (const chunk of request) { size += chunk.length; check(size <= 8 * 1024 * 1024, "request-limit"); chunks.push(chunk); }
        let bytes = Buffer.concat(chunks);
        if (request.headers["content-encoding"] === "gzip") bytes = gunzipSync(bytes, { maxOutputLength: 8 * 1024 * 1024 });
        const body = JSON.parse(bytes.toString());
        if (path.endsWith("/count_tokens")) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ input_tokens: 100 })); return; }
        check(++requests <= (source ? 5 : 3), "extra-model-turn");
        const results = body.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((block) => block.type === "tool_result");
        if (requests > 1) {
          const result = results.find((item) => item.tool_use_id === `toolu_${input.role}_${requests - 1}`);
          check(result && !result.is_error, "native-tool-failed");
          if (requests === 2) check(JSON.stringify(result.content).includes(source ? inputBytes.trim() : marker), "native-read-content");
        }
        if (!source && requests === 1) {
          check(body.messages.some((message) => message.role === "user" &&
            (typeof message.content === "string" ? message.content.includes(originalPrompt) :
              Array.isArray(message.content) && message.content.some((block) => block.type === "text" && block.text.includes(originalPrompt)))), "original-prompt-lost");
          check(JSON.stringify(results).includes(inputBytes.trim()), "original-tool-output-lost");
        }
        let tool;
        if (requests === 1) tool = { name: "Read", input: { file_path: join(project, source ? "input.txt" : "artifact.txt") } };
        else if (source && requests === 2) tool = { name: "Read", input: { file_path: join(project, "artifact.txt") } };
        else if ((source && requests === 3) || (!source && requests === 2)) tool = { name: "Edit", input: {
          file_path: join(project, "artifact.txt"), old_string: source ? "baseline artifact\n" : `${marker}\n`,
          new_string: source ? `${marker}\n` : `${marker}\ncontinued on separate peer\n` } };
        else if (source && requests === 4) tool = { name: "Write", input: { file_path: join(project, "note.txt"), content: noteBytes } };
        else {
          check(await readFile(join(project, "artifact.txt"), "utf8") === `${marker}\n${source ? "" : "continued on separate peer\n"}`, "native-edit-content");
          check(await readFile(join(project, "note.txt"), "utf8") === noteBytes, "native-note-content");
        }
        if (tool) check(body.tools.some((item) => item.name === tool.name), "tool-not-offered");
        respond(response, body, tool, input.role, requests);
      } catch { failure ??= "provider-failed"; response.writeHead(500); response.end(); }
    });
    await new Promise((accept, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", accept); });
    const args = ["--restricted", "--disable-slash-commands", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--no-chrome", "--tools", "Read,Write,Edit", "--allowedTools", "Read,Write,Edit", "--permission-mode", "acceptEdits",
      "--model", "claude-sonnet-4-6", "--max-turns", "6", "--system-prompt", "Execute the synthetic file-tool fixture.",
      "--output-format", "json", ...(source ? [] : ["--resume", state.sessionId]), "-p",
      source ? originalPrompt : "Continue the earlier task: read its artifact and append the continuation line."];
    const native = await bounded(join(root, "shims", "claude"), args, { ...env,
      ANTHROPIC_API_KEY: "statecase-synthetic-fixture-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${provider.address().port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_MAX_RETRIES: "0", API_TIMEOUT_MS: "10000" }, project);
    check(!failure && requests === (source ? 5 : 3), "native-incomplete");
    const output = JSON.parse(native.stdout);
    check(output.type === "result" && output.subtype === "success" && output.is_error === false, "native-result");
    if (source) state.sessionId = output.session_id;
    else assert.equal(output.session_id, state.sessionId);
    assert.match(state.sessionId, /^[a-f0-9-]{36}$/u);
    // No manual push: this verifies the shim's final flush reached the service.
    const { reports } = await command(["workspace", "dependencies", "--workspace", "ws_crosshost"]);
    check(reports.length === 1, "final-flush-capsule-count");
    for (const path of ["input.txt", "artifact.txt", "note.txt"]) check(reports[0].dependencies.some((item) => item.logicalPath === path && item.status === "resolved"), "missing-dependency");
    check(reports[0].sessionCapsuleId !== state.capsuleId, "final-flush-did-not-advance");
    state.capsuleId = reports[0].sessionCapsuleId;
    await save();
    console.log(JSON.stringify({ result: "pass", phase, sessionId: state.sessionId, capsuleId: state.capsuleId,
      nativeReadEditWrite: true, originalHistory: !source, shimFinalFlush: true }));
  } else {
    assert.equal(input.role, "a");
    assert.equal(await readFile(join(project, "artifact.txt"), "utf8"), `${marker}\n`);
    await command(["pull"]);
    assert.equal(await readFile(join(project, "artifact.txt"), "utf8"), `${marker}\ncontinued on separate peer\n`);
    assert.equal(await readFile(join(project, "input.txt"), "utf8"), inputBytes);
    assert.equal(await readFile(join(project, "note.txt"), "utf8"), noteBytes);
    const nativeBytes = await readFile(nativePath(state.sessionId), "utf8");
    check(nativeBytes.includes("continued on separate peer"), "returned-native-history-missing");
    const config = JSON.parse(await readFile(join(profile, "config.json"), "utf8"));
    check(Object.keys(config.sessionBindings).length === 1, "duplicate-session-binding");
    console.log(JSON.stringify({ result: "pass", phase, returnSync: true, returnedSessionHistory: true, originalNativePath: true }));
  }
} catch {
  console.error(JSON.stringify({ result: "fail", phase, step, failure: failure ?? "PeerQualificationFailed" }));
  process.exitCode = 1;
} finally {
  if (provider) { provider.closeAllConnections(); await new Promise((accept) => provider.close(accept)); }
}

async function bounded(executable, args, env, cwd) {
  const pending = execute(executable, args, { env, cwd, timeout: 45_000, maxBuffer: 1024 * 1024, detached: true });
  pending.child.stdin.end();
  let result, cleanupError;
  try { result = await pending; }
  finally {
    if (pending.child.pid) {
      try { process.kill(-pending.child.pid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") cleanupError = new Error("owned process cleanup failed"); }
    }
  }
  if (cleanupError) throw cleanupError;
  return result;
}

async function treeDigest(root) {
  // A fresh mapping need not exist before the harness's first launch. Absence
  // is itself preview state and must remain absent after a dry run.
  try { await readdir(root); }
  catch (error) { if (error.code === "ENOENT") return "absent"; throw error; }
  const hash = createHash("sha256");
  const visit = async (path) => {
    const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      hash.update(entry.name); hash.update("\0");
      if (entry.isDirectory()) await visit(join(path, entry.name));
      else { assert.ok(entry.isFile()); hash.update(await readFile(join(path, entry.name))); }
    }
  };
  await visit(root); return hash.digest("hex");
}

function respond(response, body, tool, role, turn) {
  const content = tool ? { type: "tool_use", id: `toolu_${role}_${turn}`, ...tool } : { type: "text", text: "Fixture turn complete." };
  const message = { id: `msg_${role}_${turn}`, type: "message", role: "assistant", model: body.model,
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
}
