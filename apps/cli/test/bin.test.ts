import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli, type CliIO } from "../src/bin.js";

const temporary: string[] = [];
const originalEnvironment = { ...process.env };

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
});

describe("CLI first-use and second-device UAT (AU-001, CR-009, DR-001)", () => {
  it("creates, exports, joins, maps, pushes, and pulls a vault without revealing credentials", async () => {
    const base = await mkdtemp(join(tmpdir(), "statecase-cli-uat-"));
    temporary.push(base);
    const machineA = join(base, "machine-a");
    const machineB = join(base, "machine-b");
    const source = join(base, "source");
    const target = join(base, "target");
    const recovery = join(base, "recovery", "personal.statecase-recovery.json");
    await Promise.all([mkdir(source), mkdir(target)]);
    await writeFile(join(source, "context.txt"), "context from machine A\n");
    const remote = new CliRemote();
    const output: string[] = [];
    const errors: string[] = [];
    const io: CliIO = { stdout: (value) => output.push(value), stderr: (value) => errors.push(value), fetch: remote.fetch };
    process.env.STATECASE_API_URL = "https://remote.test";
    process.env.STATECASE_TOKEN = "injected-token-value";
    process.env.STATECASE_RECOVERY_PASSPHRASE = "correct horse battery staple";

    process.env.STATECASE_HOME = machineA;
    expect(await command(io, "--json", "login", "--non-interactive", "--device-name", "laptop")).toBe(0);
    const firstDeviceId = (JSON.parse(await readFile(join(machineA, "config.json"), "utf8")) as { deviceId: string }).deviceId;
    expect(firstDeviceId).toMatch(/^dev_[a-f0-9]{32}$/u);
    expect(await command(io, "--json", "login", "--non-interactive", "--device-name", "laptop renamed")).toBe(0);
    expect((JSON.parse(await readFile(join(machineA, "config.json"), "utf8")) as { deviceId: string }).deviceId).toBe(firstDeviceId);
    expect(await command(io, "--json", "vault", "create", "personal", "--recovery-file", recovery)).toBe(0);
    const created = JSON.parse(output.at(-1)!) as { id: string };
    expect(await command(io, "--json", "vault", "list")).toBe(0);
    expect(await command(io, "--json", "drop", "add", source, "--name", "working-context")).toBe(0);
    const drop = JSON.parse(output.at(-1)!) as { id: string };
    expect(await command(io, "--json", "push")).toBe(0);
    expect(await command(io, "--json", "workspace", "dependencies")).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toEqual({ reports: [], unresolved: 0 });
    expect(await command(io, "--json", "snapshot", "create", "Before second device")).toBe(0);
    const snapshot = JSON.parse(output.at(-1)!) as { id: string };
    expect(await command(io, "--json", "snapshot", "list")).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ snapshots: [{ id: snapshot.id, protected: true }] });
    expect(await command(io, "--json", "snapshot", "delete", snapshot.id)).toBe(2);
    expect(await command(io, "--json", "snapshot", "delete", snapshot.id, "--yes")).toBe(0);
    const restoreTarget = join(base, "historical-restore");
    expect(await command(io, "--json", "restore", "--revision", remote.revisionId!, "--mapping", drop.id, "--target", restoreTarget, "--dry-run")).toBe(0);
    await expect(readFile(join(restoreTarget, "context.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await command(io, "--json", "restore", "--revision", remote.revisionId!, "--mapping", drop.id, "--target", restoreTarget)).toBe(0);
    expect(await readFile(join(restoreTarget, "context.txt"), "utf8")).toBe("context from machine A\n");
    expect(await command(io, "--json", "restore", "--revision", remote.revisionId!, "--mapping", drop.id, "--target", restoreTarget)).toBe(2);
    expect(await command(io, "--json", "restore", "--revision", remote.revisionId!, "--mapping", "missing", "--target", join(base, "missing"))).toBe(2);
    expect(await command(io, "--json", "conflicts", "resolve", "--mapping", drop.id, "--strategy", "local")).toBe(2);
    expect(await command(io, "--json", "conflicts", "resolve", "--mapping", drop.id, "--strategy", "remote", "--yes")).toBe(2);
    expect(await command(io, "--json", "conflicts", "resolve", "--mapping", drop.id, "--strategy", "local", "--yes")).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ mappingId: drop.id, strategy: "local", protectedSnapshotId: expect.stringMatching(/^snp_/u) });
    expect(await command(io, "--json", "status")).toBe(0);
    expect(await command(io, "--json", "doctor")).toBe(0);
    expect(await command(io, "--json", "device", "list")).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ devices: expect.any(Array) });
    expect(await command(io, "--json", "device", "revoke", "dev_other")).toBe(2);
    expect(await command(io, "--json", "device", "revoke", "dev_other", "--yes")).toBe(0);
    expect(await command(io, "--json", "workspace", "attach", "--path", source, "--id", "ws_test", "--mode", "metadata-only")).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ id: "ws_test", mode: "metadata-only" });
    expect(await command(io, "--json", "workspace", "list")).toBe(0);

    process.env.STATECASE_HOME = machineB;
    expect(await command(io, "--json", "login", "--non-interactive", "--device-name", "vps")).toBe(0);
    expect(await command(io, "--json", "vault", "join", created.id, "--recovery-file", recovery)).toBe(0);
    expect(await command(io, "--json", "drop", "map", drop.id, target, "--name", "working-context")).toBe(0);
    expect(await command(io, "--json", "pull")).toBe(0);
    expect(await readFile(join(target, "context.txt"), "utf8")).toBe("context from machine A\n");
    expect(await command(io, "--json", "vault", "select", created.id)).toBe(0);
    expect(await command(io, "--json", "logout")).toBe(0);
    expect(errors.join("\n")).not.toContain("injected-token-value");
    expect(output.join("\n")).not.toContain("injected-token-value");
  });

  it("returns stable exit codes for missing authentication and recovery input", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-cli-errors-"));
    temporary.push(home);
    process.env.STATECASE_HOME = home;
    delete process.env.STATECASE_TOKEN;
    delete process.env.STATECASE_RECOVERY_PASSPHRASE;
    const output: string[] = [];
    const errors: string[] = [];
    const io: CliIO = { stdout: (value) => output.push(value), stderr: (value) => errors.push(value), fetch: fetch };
    expect(await command(io, "--json", "push")).toBe(3);
    expect(JSON.parse(errors.at(-1)!)).toMatchObject({ error: { code: 3 } });
    expect(await command(io, "--json", "login", "--non-interactive")).toBe(3);
  });

  it("fails early when Git overlay is requested for a non-Git directory (WS-001)", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-cli-workspace-"));
    const ordinary = join(home, "ordinary");
    temporary.push(home);
    await mkdir(ordinary);
    process.env.STATECASE_HOME = home;
    const output: string[] = [];
    const errors: string[] = [];
    const io: CliIO = { stdout: (value) => output.push(value), stderr: (value) => errors.push(value), fetch };

    expect(await command(io, "--json", "workspace", "attach", "--path", ordinary, "--id", "ws_plain")).toBe(2);
    expect(JSON.parse(errors.at(-1)!)).toMatchObject({ error: { code: 2, message: expect.stringContaining("Git working tree") } });
    expect(await command(io, "--json", "workspace", "attach", "--path", ordinary, "--id", "ws_plain", "--mode", "metadata-only")).toBe(0);
  });

  it("runs an unmodified harness offline and preserves its exit code (RT-002, RT-004, RT-011)", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-cli-run-"));
    temporary.push(home);
    process.env.STATECASE_HOME = home;
    const output: string[] = [];
    const errors: string[] = [];
    const io: CliIO = { stdout: (value) => output.push(value), stderr: (value) => errors.push(value), fetch };

    expect(await command(
      io,
      "run",
      "codex",
      "--executable",
      process.execPath,
      "--sync-interval",
      "0",
      "--",
      "-e",
      "process.exit(19)",
    )).toBe(19);
    expect(errors).toContain("Statecase preflight sync is queued; starting Codex offline.");
    expect(errors).toContain("Statecase final sync is queued and will be retried.");
  });
});

function command(io: CliIO, ...arguments_: string[]): Promise<number> {
  return runCli(["node", "statecase", ...arguments_], io);
}

class CliRemote {
  readonly objects = new Map<string, Uint8Array>();
  readonly vaults: Array<{ id: string; name: string; role: "owner" }> = [];
  revisionId: string | null = null;
  manifestObjectId: string | null = null;
  readonly devices = new Map<string, { id: string; name: string; status: "active" | "revoked" }>();
  readonly snapshots = new Map<string, { id: string; name: string; revisionId: string; manifestObjectId: string; protected: true; createdAt: number }>();
  readonly revisions = new Map<string, { revisionId: string; manifestObjectId: string; previousRevisionId: string | null }>();

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    if (url.pathname === "/v1/devices/current") {
      const input = JSON.parse(String(init?.body)) as { id: string; name: string };
      const device = { id: input.id, name: input.name, status: "active" as const };
      this.devices.set(device.id, device);
      return Response.json({ accountId: "acct_test", deviceId: device.id, name: device.name });
    }
    if (url.pathname === "/v1/devices" && method === "GET") return Response.json({ devices: [...this.devices.values()] });
    const device = /^\/v1\/devices\/([^/]+)$/u.exec(url.pathname);
    if (device && method === "DELETE") {
      this.devices.set(device[1], { id: device[1], name: device[1], status: "revoked" });
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/v1/vaults" && method === "POST") {
      const vault = { id: "vlt_test", name: "personal", role: "owner" as const };
      this.vaults.push(vault);
      return Response.json(vault, { status: 201 });
    }
    if (url.pathname === "/v1/vaults" && method === "GET") return Response.json({ vaults: this.vaults });
    if (url.pathname.endsWith("/join")) return Response.json({ id: "vlt_test", name: "personal", role: "writer" });
    if (url.pathname.endsWith("/head")) return Response.json({ revisionId: this.revisionId, manifestObjectId: this.manifestObjectId });
    const revision = /\/revisions\/([^/]+)$/u.exec(url.pathname);
    if (revision) {
      const value = this.revisions.get(revision[1]);
      return value ? Response.json(value) : Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    }
    if (url.pathname.endsWith("/snapshots") && method === "POST") {
      const input = JSON.parse(String(init?.body)) as { id: string; name: string };
      const snapshot = { id: input.id, name: input.name, revisionId: this.revisionId!, manifestObjectId: this.manifestObjectId!, protected: true as const, createdAt: 1 };
      this.snapshots.set(snapshot.id, snapshot);
      return Response.json(snapshot, { status: 201 });
    }
    if (url.pathname.endsWith("/snapshots") && method === "GET") return Response.json({ snapshots: [...this.snapshots.values()] });
    const snapshot = /^\/v1\/vaults\/vlt_test\/snapshots\/([^/]+)$/u.exec(url.pathname);
    if (snapshot && method === "DELETE") {
      this.snapshots.delete(snapshot[1]);
      return new Response(null, { status: 204 });
    }
    const object = /^\/v1\/vaults\/vlt_test\/objects\/([^/]+)$/u.exec(url.pathname);
    if (object && method === "PUT") {
      const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
      this.objects.set(object[1], bytes);
      return Response.json({ created: true, size: bytes.byteLength }, { status: 201 });
    }
    if (object) return new Response(this.objects.get(object[1]));
    if (url.pathname.endsWith("/commits")) {
      const body = JSON.parse(String(init?.body)) as { revisionId: string; manifestObjectId: string };
      this.revisionId = body.revisionId;
      this.manifestObjectId = body.manifestObjectId;
      this.revisions.set(body.revisionId, { revisionId: body.revisionId, manifestObjectId: body.manifestObjectId, previousRevisionId: null });
      return Response.json({ outcome: "committed", revisionId: body.revisionId });
    }
    return Response.json({ error: { code: "NOT_FOUND", message: "not found" } }, { status: 404 });
  };
}
