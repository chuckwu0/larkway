/**
 * src/cli/serviceAdapter.ts
 *
 * OS service-manager integration for the bridge daemon — the successor to the
 * bash supervisor wrapper (bin/start-bridge.sh). Instead of a shell loop that
 * respawns the bridge on crash, the bridge is registered with the platform's
 * own service manager, which provides BOTH crash-restart and boot/login
 * autostart:
 *
 *   - macOS:  launchd LaunchAgent (~/Library/LaunchAgents/<label>.plist),
 *             KeepAlive.SuccessfulExit=false → restart only on non-zero exit,
 *             matching the supervisor's "clean exit 0 = intentional stop" rule.
 *   - Linux:  systemd USER unit (~/.config/systemd/user/<unit>), Restart=on-failure.
 *             A pre-existing SYSTEM unit `larkway-bridge` (docs/server-deployment.md
 *             deployments) takes priority and keeps its externally-managed semantics.
 *   - Windows: not yet — schtasks adapter lands with native Windows support.
 *
 * Service mode only applies to the installed-package scenario (dist/main.js
 * exists). Dev checkouts keep the legacy supervisor path so `pnpm start` /
 * tsx workflows are untouched. Callers opt in via BridgeControlOpts.serviceAdapter
 * ("auto" in lifecycle.ts / web api.ts); bridgeControl with no adapter behaves
 * exactly as before, which keeps existing tests hermetic.
 *
 * All process interaction goes through an injectable exec so unit tests can
 * assert command sequences without spawning anything.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { mkdir, writeFile, unlink, access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const execFileAsync = promisify(execFile);

export type ExecFn = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFn = async (cmd, args) => {
  const { stdout, stderr } = await execFileAsync(cmd, args);
  return { stdout, stderr };
};

export type ServiceKind = "launchd" | "systemd-user" | "systemd-system";

export interface ServiceAdapter {
  kind: ServiceKind;
  /** Human-readable service identifier for status output (label / unit name). */
  name: string;
  /** Write/refresh the service definition and enable autostart. Idempotent. */
  install(): Promise<void>;
  /** Start the service now (after install). Idempotent when already running. */
  start(): Promise<void>;
  /** Stop the service AND disable autostart ("stop = stay stopped"). Idempotent. */
  stop(): Promise<void>;
  isRunning(): Promise<boolean>;
  isInstalled(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Naming — one service per LARKWAY_HOME
// ---------------------------------------------------------------------------

/** Short stable suffix so multiple LARKWAY_HOME instances on one machine get
 *  distinct services; the default home keeps the clean un-suffixed name. */
export function homeSuffix(larkwayDir: string): string {
  const defaultHome = path.join(homedir(), ".larkway");
  if (path.resolve(larkwayDir) === defaultHome) return "";
  return "." + createHash("sha256").update(path.resolve(larkwayDir)).digest("hex").slice(0, 8);
}

export function launchdLabel(larkwayDir: string): string {
  return `com.larkway.bridge${homeSuffix(larkwayDir)}`;
}

export function systemdUserUnit(larkwayDir: string): string {
  const suffix = homeSuffix(larkwayDir).replace(".", "-");
  return `larkway-bridge${suffix}.service`;
}

// ---------------------------------------------------------------------------
// Definition-file content generation (pure — unit-tested directly)
// ---------------------------------------------------------------------------

export interface ServiceDefInputs {
  /** Absolute path to the node executable (process.execPath). */
  nodePath: string;
  /** Absolute path to dist/main.js. */
  distMain: string;
  /** LARKWAY_HOME for this instance. */
  larkwayDir: string;
  /** Log file both stdout and stderr are appended to. */
  logPath: string;
  /** PATH baked into the service env — service managers run with a minimal
   *  default env, which would hide lark-cli / claude / codex from the bridge. */
  envPath: string;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * launchd plist. KeepAlive.SuccessfulExit=false restarts the bridge only when
 * it exits non-zero (crash / WS watchdog), never after a clean shutdown —
 * the same contract the bash supervisor enforced.
 */
export function buildLaunchdPlist(label: string, inputs: ServiceDefInputs): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(inputs.nodePath)}</string>
    <string>${xmlEscape(inputs.distMain)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LARKWAY_HOME</key>
    <string>${xmlEscape(inputs.larkwayDir)}</string>
    <key>PATH</key>
    <string>${xmlEscape(inputs.envPath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(inputs.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(inputs.logPath)}</string>
</dict>
</plist>
`;
}

/**
 * systemd user unit. `append:` output targets require systemd ≥ 240 (2018);
 * Restart=on-failure mirrors the supervisor's non-zero-exit-only rule.
 */
export function buildSystemdUserUnitFile(inputs: ServiceDefInputs): string {
  const q = (s: string): string => s.replace(/"/g, '\\"');
  return `[Unit]
Description=Larkway bridge (Feishu <-> local coding agent)

[Service]
ExecStart="${q(inputs.nodePath)}" "${q(inputs.distMain)}"
Environment="LARKWAY_HOME=${q(inputs.larkwayDir)}"
Environment="PATH=${q(inputs.envPath)}"
Restart=on-failure
RestartSec=3
StandardOutput=append:${inputs.logPath}
StandardError=append:${inputs.logPath}

[Install]
WantedBy=default.target
`;
}

// ---------------------------------------------------------------------------
// launchd adapter (macOS)
// ---------------------------------------------------------------------------

export interface LaunchdAdapterOpts {
  exec?: ExecFn;
  /** Override for tests. */
  plistDir?: string;
  uid?: number;
}

export function makeLaunchdAdapter(
  inputs: ServiceDefInputs,
  opts: LaunchdAdapterOpts = {},
): ServiceAdapter {
  const exec = opts.exec ?? defaultExec;
  const label = launchdLabel(inputs.larkwayDir);
  const plistDir = opts.plistDir ?? path.join(homedir(), "Library", "LaunchAgents");
  const plistPath = path.join(plistDir, `${label}.plist`);
  const uid = opts.uid ?? (process.getuid ? process.getuid() : 0);
  const domainTarget = `gui/${uid}`;
  const serviceTarget = `${domainTarget}/${label}`;

  return {
    kind: "launchd",
    name: label,
    async install(): Promise<void> {
      await mkdir(plistDir, { recursive: true });
      await mkdir(path.dirname(inputs.logPath), { recursive: true });
      await writeFile(plistPath, buildLaunchdPlist(label, inputs), "utf-8");
      // Re-bootstrap so a changed plist takes effect. bootout fails when the
      // service isn't loaded — that's the normal first-install case.
      try {
        await exec("launchctl", ["bootout", serviceTarget]);
      } catch {
        /* not loaded — fine */
      }
      await exec("launchctl", ["bootstrap", domainTarget, plistPath]);
    },
    async start(): Promise<void> {
      // RunAtLoad already started it at bootstrap; kickstart covers the
      // "installed earlier, currently stopped after clean exit" case.
      try {
        await exec("launchctl", ["kickstart", serviceTarget]);
      } catch {
        /* already running — kickstart without -k can report EALREADY */
      }
    },
    async stop(): Promise<void> {
      // bootout = stop + unload. Removing the plist afterwards prevents the
      // next login from auto-starting it again ("stop = stay stopped").
      try {
        await exec("launchctl", ["bootout", serviceTarget]);
      } catch {
        /* not loaded */
      }
      try {
        await unlink(plistPath);
      } catch {
        /* not installed */
      }
    },
    async isRunning(): Promise<boolean> {
      try {
        const { stdout } = await exec("launchctl", ["print", serviceTarget]);
        return /\bpid = \d+/.test(stdout) || /\bstate = running/.test(stdout);
      } catch {
        return false;
      }
    },
    async isInstalled(): Promise<boolean> {
      try {
        await access(plistPath);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// systemd user adapter (Linux without a pre-existing system unit)
// ---------------------------------------------------------------------------

export interface SystemdUserAdapterOpts {
  exec?: ExecFn;
  /** Override for tests. */
  unitDir?: string;
}

export function makeSystemdUserAdapter(
  inputs: ServiceDefInputs,
  opts: SystemdUserAdapterOpts = {},
): ServiceAdapter {
  const exec = opts.exec ?? defaultExec;
  const unit = systemdUserUnit(inputs.larkwayDir);
  const unitDir = opts.unitDir ?? path.join(homedir(), ".config", "systemd", "user");
  const unitPath = path.join(unitDir, unit);

  return {
    kind: "systemd-user",
    name: unit,
    async install(): Promise<void> {
      await mkdir(unitDir, { recursive: true });
      await mkdir(path.dirname(inputs.logPath), { recursive: true });
      await writeFile(unitPath, buildSystemdUserUnitFile(inputs), "utf-8");
      await exec("systemctl", ["--user", "daemon-reload"]);
      await exec("systemctl", ["--user", "enable", unit]);
    },
    async start(): Promise<void> {
      await exec("systemctl", ["--user", "start", unit]);
    },
    async stop(): Promise<void> {
      try {
        await exec("systemctl", ["--user", "disable", "--now", unit]);
      } catch {
        /* not loaded / not enabled */
      }
    },
    async isRunning(): Promise<boolean> {
      try {
        const { stdout } = await exec("systemctl", ["--user", "is-active", unit]);
        return stdout.trim() === "active";
      } catch {
        return false;
      }
    },
    async isInstalled(): Promise<boolean> {
      try {
        await access(unitPath);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// systemd system adapter (pre-existing externally-managed unit — legacy servers)
// ---------------------------------------------------------------------------

export function makeSystemdSystemAdapter(exec: ExecFn = defaultExec): ServiceAdapter {
  const unit = "larkway-bridge";
  return {
    kind: "systemd-system",
    name: unit,
    // The unit is provisioned by the deployment runbook, not by us — install is
    // a no-op and stop does NOT disable (external management keeps autostart).
    async install(): Promise<void> {
      /* externally managed */
    },
    async start(): Promise<void> {
      await exec("systemctl", ["start", unit]);
    },
    async stop(): Promise<void> {
      await exec("systemctl", ["stop", unit]);
    },
    async isRunning(): Promise<boolean> {
      try {
        const { stdout } = await exec("systemctl", ["is-active", unit]);
        return stdout.trim() === "active";
      } catch {
        return false;
      }
    },
    async isInstalled(): Promise<boolean> {
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolveServiceAdapterOpts {
  exec?: ExecFn;
  platform?: NodeJS.Platform;
  /** Absolute dist/main.js path, or null when not built (dev mode → legacy). */
  distMain: string | null;
  larkwayDir: string;
  logPath: string;
  /** Overrides for tests. */
  plistDir?: string;
  unitDir?: string;
  uid?: number;
}

/**
 * Pick the service adapter for this host, or null when service mode doesn't
 * apply (dev checkout without dist, Windows until 2b, unknown platforms, or a
 * Linux host whose systemd user manager is unreachable).
 */
export async function resolveServiceAdapter(
  opts: ResolveServiceAdapterOpts,
): Promise<ServiceAdapter | null> {
  const exec = opts.exec ?? defaultExec;
  const platform = opts.platform ?? process.platform;
  if (!opts.distMain) return null; // dev mode — keep the supervisor path

  const inputs: ServiceDefInputs = {
    nodePath: process.execPath,
    distMain: opts.distMain,
    larkwayDir: opts.larkwayDir,
    logPath: opts.logPath,
    envPath: process.env["PATH"] ?? "",
  };

  if (platform === "darwin") {
    return makeLaunchdAdapter(inputs, { exec, plistDir: opts.plistDir, uid: opts.uid });
  }

  if (platform === "linux") {
    // A provisioned system unit wins — don't shadow existing server deployments.
    try {
      await exec("systemctl", ["cat", "larkway-bridge"]);
      return makeSystemdSystemAdapter(exec);
    } catch {
      /* no system unit */
    }
    // User units need a reachable per-user systemd instance (absent in some
    // containers / bare SSH sessions without a session bus).
    try {
      await exec("systemctl", ["--user", "show-environment"]);
      return makeSystemdUserAdapter(inputs, { exec, unitDir: opts.unitDir });
    } catch {
      return null;
    }
  }

  // win32 → schtasks adapter arrives with native Windows support (BL-49 2b).
  return null;
}
