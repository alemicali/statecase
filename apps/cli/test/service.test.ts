import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  activateService,
  installServiceDefinition,
  removeServiceDefinition,
  serviceDefinition,
} from "../src/service.js";

const temporary: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("native daemon service definitions (RT-008, RT-010, RT-012)", () => {
  it("renders and installs a hardened systemd user unit without shell interpolation", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-systemd-"));
    temporary.push(home);
    const definition = serviceDefinition({
      platform: "linux",
      home,
      statecaseExecutable: join(home, "bin with spaces", "statecase"),
      statecaseHome: join(home, ".statecase"),
      roots: [join(home, "project 100%"), join(home, "project 100%")],
    });
    expect(definition.path).toBe(join(home, ".config", "systemd", "user", "statecase.service"));
    expect(definition.contents).toContain("# statecase-service-v1");
    expect(definition.contents).toContain("NoNewPrivileges=true");
    expect(definition.contents).toContain("Restart=on-failure");
    expect(definition.contents).toContain("project 100%%");
    expect(definition.contents).not.toContain("sh -c");
    expect((await installServiceDefinition(definition)).created).toBe(true);
    expect((await installServiceDefinition(definition)).created).toBe(false);
    const updated = serviceDefinition({ ...definition.source, statecaseExecutable: join(home, "new-statecase") });
    expect((await installServiceDefinition(updated)).created).toBe(true);
    if (process.platform !== "win32") expect((await stat(definition.path)).mode & 0o777).toBe(0o600);
  });

  it("renders a launchd plist with escaped values and owner-only logs", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-launchd-"));
    temporary.push(home);
    const definition = serviceDefinition({
      platform: "darwin",
      home,
      statecaseExecutable: join(home, "a&b", "statecase"),
      statecaseHome: join(home, "state<case"),
      roots: [],
      uid: 501,
    });
    expect(definition.path).toBe(join(home, "Library", "LaunchAgents", "com.statecase.daemon.plist"));
    expect(definition.contents).toContain("<!-- statecase-service-v1 -->");
    expect(definition.contents).toContain("a&amp;b");
    expect(definition.contents).toContain("state&lt;case");
    expect(definition.enableCommands[0]).toEqual(["launchctl", ["bootstrap", "gui/501", definition.path]]);
    expect(serviceDefinition({ ...definition.source, uid: undefined }).enableCommands[0][1][1]).toBe(`gui/${process.getuid?.()}`);
    expect(() => serviceDefinition({ ...definition.source, uid: -1 })).toThrow("user ID");
    expect(() => serviceDefinition({ ...definition.source, platform: "win32" as "darwin" })).toThrow("supported on Linux and macOS");
  });

  it("refuses unknown service files and removes only Statecase-owned definitions", async () => {
    const home = await mkdtemp(join(tmpdir(), "statecase-service-owned-"));
    temporary.push(home);
    const definition = serviceDefinition({ platform: "linux", home, statecaseExecutable: "/bin/statecase", statecaseHome: join(home, ".statecase"), roots: [] });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, ".config", "systemd", "user"), { recursive: true });
    await writeFile(definition.path, "user-owned");
    await expect(installServiceDefinition(definition)).rejects.toThrow("refusing to replace");
    await expect(removeServiceDefinition(definition)).rejects.toThrow("refusing to remove");
    expect(await readFile(definition.path, "utf8")).toBe("user-owned");
    const fresh = serviceDefinition({ ...definition.source, home: join(home, "fresh") });
    await installServiceDefinition(fresh);
    expect(await removeServiceDefinition(fresh)).toBe(true);
    expect(await removeServiceDefinition(fresh)).toBe(false);
    const { symlink } = await import("node:fs/promises");
    const unsafe = serviceDefinition({ ...definition.source, home: join(home, "unsafe") });
    await mkdir(join(home, "unsafe", ".config", "systemd", "user"), { recursive: true });
    await symlink(definition.path, unsafe.path);
    await expect(installServiceDefinition(unsafe)).rejects.toThrow("unsafe service definition path");
  });

  it("runs activation commands without a shell and stops after the first failure", async () => {
    const definition = serviceDefinition({ platform: "linux", home: "/tmp/test", statecaseExecutable: "/bin/statecase", statecaseHome: "/tmp/test/state", roots: [] });
    const calls: string[] = [];
    await activateService(definition, "enable", async (file, args) => { calls.push(`${file} ${args.join(" ")}`); });
    expect(calls).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now statecase.service",
    ]);
    await activateService(definition, "disable", async (file, args) => { calls.push(`${file} ${args.join(" ")}`); });
    expect(calls.slice(-2)).toEqual([
      "systemctl --user disable --now statecase.service",
      "systemctl --user daemon-reload",
    ]);
    const failing = vi.fn(async () => { throw new Error("system manager unavailable"); });
    await expect(activateService(definition, "disable", failing)).rejects.toThrow("system manager unavailable");
    expect(failing).toHaveBeenCalledTimes(1);
  });
});
