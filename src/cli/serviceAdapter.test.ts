/**
 * serviceAdapter unit tests — definition-file generation, adapter command
 * sequences (via injected exec, nothing spawned), resolution logic, and the
 * bridgeControl integration seam (opts.serviceAdapter).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, access, writeFile, mkdir } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import {
  homeSuffix,
  launchdLabel,
  systemdUserUnit,
  buildLaunchdPlist,
  buildSystemdUserUnitFile,
  makeLaunchdAdapter,
  makeSystemdUserAdapter,
  makeSystemdSystemAdapter,
  makeSchtasksAdapter,
  buildWindowsLauncherCmd,
  resolveServiceAdapter,
  type ServiceDefInputs,
  type ExecFn,
} from "./serviceAdapter.js";
import { startBridge, stopBridge, detectBridgeStatus } from "./bridgeControl.js";
import type { ServiceAdapter } from "./serviceAdapter.js";

const INPUTS: ServiceDefInputs = {
  nodePath: "/usr/local/bin/node",
  distMain: "/opt/larkway/dist/main.js",
  larkwayDir: "/home/u/.larkway",
  logPath: "/home/u/.larkway/logs/bridge.log",
  envPath: "/usr/bin:/bin",
};

/** Records exec calls; per-command canned results or throwers. */
function makeFakeExec(
  responder?: (cmd: string, args: string[]) => { stdout: string } | Error,
): { exec: ExecFn; calls: string[][] } {
  const calls: string[][] = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const r = responder?.(cmd, args);
    if (r instanceof Error) throw r;
    return { stdout: r?.stdout ?? "", stderr: "" };
  };
  return { exec, calls };
}

describe("service naming", () => {
  it("default home gets the clean un-suffixed names", () => {
    const home = path.join(homedir(), ".larkway");
    expect(homeSuffix(home)).toBe("");
    expect(launchdLabel(home)).toBe("com.larkway.bridge");
    expect(systemdUserUnit(home)).toBe("larkway-bridge.service");
  });

  it("non-default homes get a stable 8-hex suffix per home", () => {
    const s1 = homeSuffix("/srv/a/.larkway");
    const s2 = homeSuffix("/srv/b/.larkway");
    expect(s1).toMatch(/^\.[0-9a-f]{8}$/);
    expect(s1).not.toBe(s2);
    expect(homeSuffix("/srv/a/.larkway")).toBe(s1); // stable
    expect(systemdUserUnit("/srv/a/.larkway")).toBe(`larkway-bridge${s1.replace(".", "-")}.service`);
  });
});

describe("buildLaunchdPlist", () => {
  const plist = buildLaunchdPlist("com.larkway.bridge", INPUTS);

  it("runs node dist/main.js with LARKWAY_HOME and PATH baked in", () => {
    expect(plist).toContain("<string>/usr/local/bin/node</string>");
    expect(plist).toContain("<string>/opt/larkway/dist/main.js</string>");
    expect(plist).toContain("<key>LARKWAY_HOME</key>");
    expect(plist).toContain("<string>/home/u/.larkway</string>");
    expect(plist).toContain("<key>PATH</key>");
  });

  it("restarts only on failure (KeepAlive.SuccessfulExit=false) and starts at load", () => {
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
  });

  it("appends both stdout and stderr to bridge.log", () => {
    const matches = plist.match(/bridge\.log/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it("XML-escapes special characters in paths", () => {
    const p = buildLaunchdPlist("l", { ...INPUTS, larkwayDir: "/a&b<c>" });
    expect(p).toContain("/a&amp;b&lt;c&gt;");
  });
});

describe("buildSystemdUserUnitFile", () => {
  const unit = buildSystemdUserUnitFile(INPUTS);

  it("quotes ExecStart and bakes env", () => {
    expect(unit).toContain('ExecStart="/usr/local/bin/node" "/opt/larkway/dist/main.js"');
    expect(unit).toContain('Environment="LARKWAY_HOME=/home/u/.larkway"');
    expect(unit).toContain('Environment="PATH=/usr/bin:/bin"');
  });

  it("restarts on failure only, appends logs, enables at login", () => {
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("StandardOutput=append:/home/u/.larkway/logs/bridge.log");
    expect(unit).toContain("StandardError=append:/home/u/.larkway/logs/bridge.log");
    expect(unit).toContain("WantedBy=default.target");
  });
});

describe("makeLaunchdAdapter", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "lw-launchd-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const inputs = (logDir: string): ServiceDefInputs => ({
    ...INPUTS,
    logPath: path.join(logDir, "logs", "bridge.log"),
  });

  it("install writes the plist and re-bootstraps (bootout then bootstrap)", async () => {
    const { exec, calls } = makeFakeExec();
    const label = launchdLabel(INPUTS.larkwayDir);
    const a = makeLaunchdAdapter(inputs(dir), { exec, plistDir: dir, uid: 501 });
    await a.install();
    const plistPath = path.join(dir, `${label}.plist`);
    const written = await readFile(plistPath, "utf-8");
    expect(written).toContain(label);
    expect(calls).toEqual([
      ["launchctl", "bootout", `gui/501/${label}`],
      ["launchctl", "bootstrap", "gui/501", plistPath],
    ]);
    expect(await a.isInstalled()).toBe(true);
  });

  it("install succeeds when bootout fails (first install)", async () => {
    const { exec, calls } = makeFakeExec((cmd, args) =>
      args[0] === "bootout" ? new Error("not loaded") : { stdout: "" },
    );
    const a = makeLaunchdAdapter(inputs(dir), { exec, plistDir: dir, uid: 501 });
    await a.install();
    expect(calls.at(-1)?.[1]).toBe("bootstrap");
  });

  it("stop boots out AND removes the plist so login doesn't restart it", async () => {
    const { exec, calls } = makeFakeExec();
    const a = makeLaunchdAdapter(inputs(dir), { exec, plistDir: dir, uid: 501 });
    await a.install();
    await a.stop();
    expect(calls.at(-1)).toEqual(["launchctl", "bootout", `gui/501/${launchdLabel(INPUTS.larkwayDir)}`]);
    expect(await a.isInstalled()).toBe(false);
  });

  it("isRunning parses `launchctl print` (pid line = running; error = stopped)", async () => {
    const running = makeLaunchdAdapter(inputs(dir), {
      exec: makeFakeExec(() => ({ stdout: "state = running\n\tpid = 1234\n" })).exec,
      plistDir: dir,
      uid: 501,
    });
    expect(await running.isRunning()).toBe(true);

    const stopped = makeLaunchdAdapter(inputs(dir), {
      exec: makeFakeExec(() => new Error("Could not find service")).exec,
      plistDir: dir,
      uid: 501,
    });
    expect(await stopped.isRunning()).toBe(false);
  });
});

describe("makeSystemdUserAdapter", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "lw-systemd-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("install writes the unit then daemon-reload + enable", async () => {
    const { exec, calls } = makeFakeExec();
    const a = makeSystemdUserAdapter({ ...INPUTS, logPath: path.join(dir, "l", "b.log") }, { exec, unitDir: dir });
    const unit = systemdUserUnit(INPUTS.larkwayDir);
    await a.install();
    await access(path.join(dir, unit));
    expect(calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", unit],
    ]);
  });

  it("start/stop/isRunning wrap systemctl --user", async () => {
    const { exec, calls } = makeFakeExec((cmd, args) =>
      args.includes("is-active") ? { stdout: "active\n" } : { stdout: "" },
    );
    const a = makeSystemdUserAdapter(INPUTS, { exec, unitDir: dir });
    const unit = systemdUserUnit(INPUTS.larkwayDir);
    await a.start();
    expect(await a.isRunning()).toBe(true);
    await a.stop();
    expect(calls).toEqual([
      ["systemctl", "--user", "start", unit],
      ["systemctl", "--user", "is-active", unit],
      ["systemctl", "--user", "disable", "--now", unit],
    ]);
  });
});

describe("schtasks adapter (Windows)", () => {
  it("launcher .cmd bakes env, appends logs, and uses CRLF", () => {
    const cmd = buildWindowsLauncherCmd(INPUTS);
    expect(cmd).toContain('set "LARKWAY_HOME=/home/u/.larkway"');
    expect(cmd).toContain('set "PATH=/usr/bin:/bin"');
    expect(cmd).toContain('>> "/home/u/.larkway/logs/bridge.log" 2>&1');
    expect(cmd).toContain("\r\n");
    expect(cmd.startsWith("@echo off")).toBe(true);
  });

  it("install writes the launcher and registers an ONLOGON task without elevation", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lw-schtasks-"));
    const { exec, calls } = makeFakeExec();
    const a = makeSchtasksAdapter({ ...INPUTS, logPath: path.join(dir, "l", "b.log") }, { exec, launcherDir: dir });
    await a.install();
    await access(path.join(dir, "bridge-launcher.cmd"));
    const create = calls[0]!;
    expect(create[0]).toBe("schtasks");
    expect(create).toContain("/Create");
    expect(create).toContain("ONLOGON");
    expect(create).toContain("LIMITED");
    await rm(dir, { recursive: true, force: true });
  });

  it("stop ends the running instance AND disables autostart", async () => {
    const { exec, calls } = makeFakeExec();
    const a = makeSchtasksAdapter(INPUTS, { exec, launcherDir: "/tmp" });
    await a.stop();
    expect(calls.map((c) => c[1])).toEqual(["/End", "/Change"]);
    expect(calls[1]).toContain("/Disable");
  });

  it("isRunning parses /Query CSV status", async () => {
    const running = makeSchtasksAdapter(INPUTS, {
      exec: makeFakeExec(() => ({ stdout: '"LarkwayBridge","19/07/2026","Running"' })).exec,
      launcherDir: "/tmp",
    });
    expect(await running.isRunning()).toBe(true);
    const stopped = makeSchtasksAdapter(INPUTS, {
      exec: makeFakeExec(() => ({ stdout: '"LarkwayBridge","19/07/2026","Ready"' })).exec,
      launcherDir: "/tmp",
    });
    expect(await stopped.isRunning()).toBe(false);
  });
});

describe("resolveServiceAdapter", () => {
  const base = {
    larkwayDir: "/home/u/.larkway",
    logPath: "/home/u/.larkway/logs/bridge.log",
  };

  it("returns null in dev mode (no dist bundle)", async () => {
    const r = await resolveServiceAdapter({ ...base, distMain: null, platform: "darwin" });
    expect(r).toBeNull();
  });

  it("darwin → launchd", async () => {
    const r = await resolveServiceAdapter({
      ...base,
      distMain: "/x/dist/main.js",
      platform: "darwin",
      exec: makeFakeExec().exec,
    });
    expect(r?.kind).toBe("launchd");
  });

  it("linux with a provisioned system unit → systemd-system (server deployments win)", async () => {
    const { exec } = makeFakeExec((cmd, args) =>
      args[0] === "cat" ? { stdout: "[Unit]..." } : { stdout: "" },
    );
    const r = await resolveServiceAdapter({ ...base, distMain: "/x/dist/main.js", platform: "linux", exec });
    expect(r?.kind).toBe("systemd-system");
  });

  it("linux without system unit but with reachable user manager → systemd-user", async () => {
    const { exec } = makeFakeExec((cmd, args) =>
      args[0] === "cat" ? new Error("No files found") : { stdout: "" },
    );
    const r = await resolveServiceAdapter({ ...base, distMain: "/x/dist/main.js", platform: "linux", exec });
    expect(r?.kind).toBe("systemd-user");
  });

  it("linux with neither → null (legacy supervisor)", async () => {
    const { exec } = makeFakeExec(() => new Error("unreachable"));
    const r = await resolveServiceAdapter({ ...base, distMain: "/x/dist/main.js", platform: "linux", exec });
    expect(r).toBeNull();
  });

  it("win32 → schtasks", async () => {
    const r = await resolveServiceAdapter({
      ...base,
      distMain: "/x/dist/main.js",
      platform: "win32",
      exec: makeFakeExec().exec,
    });
    expect(r?.kind).toBe("schtasks");
  });
});

// ---------------------------------------------------------------------------
// bridgeControl integration seam — opts.serviceAdapter with a fake adapter
// ---------------------------------------------------------------------------

function makeFakeAdapter(state: { running: boolean; installed: boolean }): {
  adapter: ServiceAdapter;
  log: string[];
} {
  const log: string[] = [];
  const adapter: ServiceAdapter = {
    kind: "launchd",
    name: "com.larkway.bridge",
    async install() {
      log.push("install");
      state.installed = true;
    },
    async start() {
      log.push("start");
      state.running = true;
    },
    async stop() {
      log.push("stop");
      state.running = false;
      state.installed = false;
    },
    async isRunning() {
      log.push("isRunning");
      return state.running;
    },
    async isInstalled() {
      log.push("isInstalled");
      return state.installed;
    },
  };
  return { adapter, log };
}

describe("bridgeControl × serviceAdapter", () => {
  let home: string;
  // A supervisor script path that matches no real process → legacy paths see nothing.
  const noSupervisor = "/nonexistent/lw-test-supervisor.sh";

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "lw-home-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("startBridge installs + starts via the adapter (after legacy reap)", async () => {
    const state = { running: false, installed: false };
    const { adapter, log } = makeFakeAdapter(state);
    const r = await startBridge(home, { serviceAdapter: adapter, supervisorScript: noSupervisor });
    expect(r.ok).toBe(true);
    expect(r.alreadyRunning).toBe(false);
    expect(log).toContain("install");
    expect(log).toContain("start");
    expect(state.running).toBe(true);
    expect(r.message).toContain("开机自启");
  });

  it("startBridge is idempotent when the service is already running", async () => {
    const state = { running: true, installed: true };
    const { adapter, log } = makeFakeAdapter(state);
    const r = await startBridge(home, { serviceAdapter: adapter, supervisorScript: noSupervisor });
    expect(r.ok).toBe(true);
    expect(r.alreadyRunning).toBe(true);
    expect(log).not.toContain("install");
  });

  it("stopBridge stops the service and reports it", async () => {
    const state = { running: true, installed: true };
    const { adapter } = makeFakeAdapter(state);
    const r = await stopBridge(home, { serviceAdapter: adapter, supervisorScript: noSupervisor });
    expect(r.ok).toBe(true);
    expect(r.wasRunning).toBe(true);
    expect(state.running).toBe(false);
    expect(r.message).toContain("禁用自启");
  });

  it("stopBridge on a stopped service reports not running", async () => {
    const state = { running: false, installed: false };
    const { adapter } = makeFakeAdapter(state);
    const r = await stopBridge(home, { serviceAdapter: adapter, supervisorScript: noSupervisor });
    expect(r.ok).toBe(true);
    expect(r.wasRunning).toBe(false);
  });

  it("detectBridgeStatus reports running with the adapter kind and status.json pid", async () => {
    const state = { running: true, installed: true };
    const { adapter } = makeFakeAdapter(state);
    // Fresh per-bot status.json supplies the display pid.
    await mkdir(path.join(home, "bot-a"), { recursive: true });
    await writeFile(
      path.join(home, "bot-a", "status.json"),
      JSON.stringify({ updatedAt: new Date().toISOString(), pid: 4242 }),
      "utf-8",
    );
    const s = await detectBridgeStatus(home, { serviceAdapter: adapter, supervisorScript: noSupervisor });
    expect(s.running).toBe(true);
    expect(s.mode).toBe("launchd");
    expect(s.pid).toBe(4242);
  });

  it("detectBridgeStatus surfaces the adapter kind when nothing is running", async () => {
    const state = { running: false, installed: true };
    const { adapter } = makeFakeAdapter(state);
    const s = await detectBridgeStatus(home, {
      serviceAdapter: adapter,
      supervisorScript: noSupervisor,
      mainProcessPattern: "no-such-process-pattern-xyz",
    });
    expect(s.running).toBe(false);
    expect(s.mode).toBe("launchd");
  });
});
