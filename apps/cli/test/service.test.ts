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

describe("native daemon service definitions (RT-010, RT-012, RT-013)", () => {
  it.each(["linux", "darwin"] as const)("pins the Node interpreter without relying on the login-shell PATH (%s)", (platform) => {
    const source = { platform, home: "/tmp/service-home", statecaseExecutable: "/tmp/app ${UNSET}/statecase",
      nodeExecutable: "/tmp/node runtime/bin/node", statecaseHome: "/tmp/service-home/state", roots: [], uid: 501 };
    const definition = serviceDefinition(source);
    if (platform === "linux") {
      expect(definition.contents).toContain('ExecStart=:"/tmp/node runtime/bin/node" "/tmp/app ${UNSET}/statecase" daemon foreground');
    } else {
      expect(definition.contents).toContain('<string>/tmp/node runtime/bin/node</string>\n    <string>/tmp/app ${UNSET}/statecase</string>');
    }
  });

  it.each(["linux", "darwin"] as const)("rejects control characters in every service path before serialization (%s)", (platform) => {
    const source = { platform, home: "/tmp/service-home", statecaseExecutable: "/tmp/statecase",
      nodeExecutable: "/tmp/node", statecaseHome: "/tmp/state", roots: ["/tmp/drop"], uid: 501 };
    for (const field of ["home", "statecaseExecutable", "nodeExecutable", "statecaseHome", "roots"] as const) {
      for (const control of ["\n", "\r", "\0", "\t", "\u007f"]) {
        const injected = `/tmp/path${control}ExecStart=/tmp/unexpected`;
        expect(() => serviceDefinition({ ...source, [field]: field === "roots" ? [injected] : injected })).toThrow("control characters");
      }
    }
  });

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
    const definition = await installed("linux");
    const calls: string[] = [];
    const runner = async (file: string, args: readonly string[]) => {
      calls.push(`${file} ${args.join(" ")}`);
      return { stdout: args.includes("show") ? `${definition.path}\n` : "" };
    };
    await activateService(definition, "enable", runner);
    expect(calls).toEqual([
      "systemctl --user show statecase.service --property=FragmentPath --value",
      "systemctl --user daemon-reload",
      "systemctl --user enable --now statecase.service",
    ]);
    await activateService(definition, "disable", runner);
    expect(calls.slice(-2)).toEqual([
      "systemctl --user disable --now statecase.service",
      "systemctl --user daemon-reload",
    ]);
    const failing = vi.fn(async () => { throw new Error("system manager unavailable"); });
    await expect(activateService(definition, "disable", failing)).rejects.toThrow("native service manager command failed");
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it.each(["linux", "darwin"] as const)("never replaces, removes, or controls another profile's service (%s)", async (platform) => {
    const definition = await installed(platform);
    const other = serviceDefinition({ ...definition.source, statecaseHome: join(definition.source.home, "other-profile") });
    const runner = vi.fn(async () => ({ stdout: "" }));
    await expect(installServiceDefinition(other)).rejects.toThrow("another profile");
    await expect(removeServiceDefinition(other)).rejects.toThrow("another profile");
    for (const action of ["enable", "disable", "start", "stop"] as const) {
      await expect(activateService(other, action, runner)).rejects.toThrow("another profile");
    }
    expect(runner).not.toHaveBeenCalled();
    expect(await readFile(definition.path, "utf8")).toBe(definition.contents);
  });

  it.each(["linux", "darwin"] as const)("refuses missing and unknown definitions before manager operations (%s)", async (platform) => {
    const definition = await installed(platform);
    const runner = vi.fn(async () => ({ stdout: "" }));
    await writeFile(definition.path, "unrelated service");
    await expect(activateService(definition, "disable", runner)).rejects.toThrow("non-Statecase");
    const { rm } = await import("node:fs/promises");
    await rm(definition.path);
    await expect(activateService(definition, "enable", runner)).rejects.toThrow("not installed");
    expect(runner).not.toHaveBeenCalled();
  });

  it("starts and stops Linux without changing autostart, accepting only the installed unit or its symlink", async () => {
    const definition = await installed("linux");
    const { symlink } = await import("node:fs/promises");
    const alias = join(definition.source.home, "runtime-unit");
    await symlink(definition.path, alias);
    const calls: string[][] = [];
    const runner = async (_file: string, args: readonly string[]) => {
      calls.push([...args]);
      return { stdout: args.includes("show") ? `${alias}\n` : "" };
    };
    await activateService(definition, "start", runner);
    await activateService(definition, "stop", runner);
    expect(calls.filter((args) => !args.includes("show"))).toEqual([
      ["--user", "daemon-reload"], ["--user", "start", "statecase.service"],
      ["--user", "stop", "statecase.service"],
    ]);
    const foreign = vi.fn(async () => ({ stdout: `${definition.source.home}\n` }));
    await expect(activateService(definition, "disable", foreign)).rejects.toThrow("different service definition");
    expect(foreign).toHaveBeenCalledTimes(1);
  });

  it("keeps macOS start idempotent and unloads on stop so KeepAlive cannot respawn", async () => {
    const definition = await installed("darwin");
    const calls: string[][] = [];
    const runner = async (_file: string, args: readonly string[]) => {
      calls.push([...args]);
      return { stdout: args[0] === "print" ? `gui/501/com.statecase.daemon = {\n\tpath = ${definition.path}\n}\n` : "" };
    };
    await activateService(definition, "start", runner);
    await activateService(definition, "stop", runner);
    expect(calls.filter((args) => args[0] !== "print")).toEqual([
      ["enable", "gui/501/com.statecase.daemon"], ["kickstart", "gui/501/com.statecase.daemon"],
      ["bootout", "gui/501/com.statecase.daemon"],
    ]);
  });

  it("handles unloaded Linux units without stopping anything and stops after an activation failure", async () => {
    const definition = await installed("linux");
    const runner = vi.fn(async () => ({ stdout: "" }));
    await activateService(definition, "stop", runner);
    expect(runner).toHaveBeenCalledTimes(1);
    await activateService(definition, "start", runner);
    expect(runner).toHaveBeenLastCalledWith("systemctl", ["--user", "start", "statecase.service"]);
    const failing = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args.includes("daemon-reload")) throw new Error("private manager diagnostic");
      return { stdout: "" };
    });
    await expect(activateService(definition, "enable", failing)).rejects.toThrow("native service manager command failed");
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("bootstraps only explicitly missing macOS services, enabling before loading", async () => {
    const definition = await installed("darwin");
    const runner = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args[0] === "print") throw Object.assign(new Error("missing"), { code: 113, stderr: 'Could not find service "com.statecase.daemon" in domain for user gui: 501' });
      return { stdout: "" };
    });
    await activateService(definition, "enable", runner);
    expect(runner.mock.calls.map(([, args]) => args)).toEqual([
      ["print", "gui/501/com.statecase.daemon"], ["enable", "gui/501/com.statecase.daemon"],
      ["bootstrap", "gui/501", definition.path], ["kickstart", "gui/501/com.statecase.daemon"],
    ]);
    runner.mockClear();
    await activateService(definition, "stop", runner);
    expect(runner).toHaveBeenCalledTimes(1);
    await activateService(definition, "disable", runner);
    expect(runner).toHaveBeenLastCalledWith("launchctl", ["disable", "gui/501/com.statecase.daemon"]);
  });

  it("fails closed for macOS inspection errors, ambiguous output, and foreign loaded paths", async () => {
    const definition = await installed("darwin");
    for (const failure of [
      { code: 5, stderr: 'Could not find service "com.statecase.daemon"' },
      { code: 113 }, { code: 113, stderr: "Could not find domain" },
    ]) {
      const runner = vi.fn(async () => { throw failure; });
      await expect(activateService(definition, "start", runner)).rejects.toThrow("inspection failed");
      expect(runner).toHaveBeenCalledTimes(1);
    }
    for (const stdout of ["", "\tpath = one\n\tpath = two\n"]) {
      const runner = vi.fn(async () => ({ stdout }));
      await expect(activateService(definition, "stop", runner)).rejects.toThrow("unrecognized");
      expect(runner).toHaveBeenCalledTimes(1);
    }
    const foreign = vi.fn(async () => ({ stdout: `\tpath = ${definition.source.home}\n` }));
    await expect(activateService(definition, "disable", foreign)).rejects.toThrow("different service definition");
    expect(foreign).toHaveBeenCalledTimes(1);
  });
});

async function installed(platform: "linux" | "darwin") {
  const home = await mkdtemp(join(tmpdir(), "statecase-service-control-"));
  temporary.push(home);
  const definition = serviceDefinition({ platform, home, statecaseExecutable: "/bin/statecase", statecaseHome: join(home, "state"), roots: [], uid: 501 });
  await installServiceDefinition(definition);
  return definition;
}
