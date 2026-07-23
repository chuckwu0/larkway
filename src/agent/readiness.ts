/**
 * src/agent/readiness.ts
 *
 * Startup readiness diagnostics: PATH augmentation + per-backend login probes.
 *
 * Two failure families produce "bot silently unresponsive" in production and
 * are expensive to debug from a dead card, yet cheap to detect at startup:
 *
 * 1. Auth not usable — the backend CLI is installed but cannot authenticate.
 *    claude keeps its OAuth token in the macOS keychain: a locked login
 *    keychain (headless/SSH start) yields "Not logged in" even though the
 *    operator logged in from the GUI. codex similarly reports its login state
 *    via `codex login status`.
 * 2. CLI not on PATH — supervisors (launchd/systemd/watchdog scripts) run
 *    with a minimal PATH that misses `~/.local/bin`, where claude's native
 *    installer puts the binary. Every turn then dies with "CLI not found".
 *
 * main.ts calls {@link ensureLocalBinOnPath} once at boot (fixes family 2 for
 * the bridge process and every subprocess that inherits its env) and probes
 * each distinct backend once, logging a loud, actionable diagnosis on failure.
 *
 * Diagnostics ONLY: startup proceeds regardless. The bridge stays a thin
 * channel — it reports readiness, it does not gate or orchestrate on it.
 */

import path from "node:path";
import { spawnProcess } from "../platform/spawn.js";

/**
 * Prepend `$HOME/.local/bin` to PATH when absent (POSIX only; no-op on win32
 * or when HOME is unset). Mutates the given env (default: process.env) so the
 * fix applies to this process's own CLI resolution AND to spawned agents.
 *
 * Returns the prepended dir when a change was made, undefined otherwise.
 */
export function ensureLocalBinOnPath(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === "win32") return undefined;
  const home = env["HOME"];
  if (!home) return undefined;
  const localBin = path.join(home, ".local", "bin");
  const current = env["PATH"] ?? "";
  if (current.split(path.delimiter).includes(localBin)) return undefined;
  env["PATH"] = current ? `${localBin}${path.delimiter}${current}` : localBin;
  return localBin;
}

// ---------------------------------------------------------------------------
// Backend login probes
// ---------------------------------------------------------------------------

export interface ProbeSpec {
  bin: string;
  args: string[];
}

/** Login-status probe command per backend; undefined = backend has no probe. */
export function probeSpecForBackend(backend: string): ProbeSpec | undefined {
  switch (backend) {
    case "claude":
      return { bin: "claude", args: ["auth", "status"] };
    case "codex":
      return { bin: "codex", args: ["login", "status"] };
    default:
      return undefined;
  }
}

export interface ProbeOutcome {
  ok: boolean;
  /** Actionable one-paragraph diagnosis; only set when !ok. */
  diagnosis?: string;
}

/**
 * Pure interpretation of a probe result (unit-testable; no subprocess).
 *
 * `errorCode` is the spawn-level failure ("ENOENT" = binary not found);
 * exitCode/stdout are the probe process results when it ran.
 */
export function interpretProbe(
  backend: string,
  result: {
    errorCode?: string;
    timedOut?: boolean;
    exitCode?: number | null;
    stdout?: string;
    stderr?: string;
  },
  platform: NodeJS.Platform = process.platform,
): ProbeOutcome {
  const spec = probeSpecForBackend(backend);
  if (!spec) return { ok: true };

  if (result.errorCode === "ENOENT") {
    return {
      ok: false,
      diagnosis:
        `${spec.bin} CLI not found on PATH. Every turn for backend "${backend}" will fail to spawn. ` +
        `If ${spec.bin} is installed, the supervisor's PATH is likely minimal — ` +
        `ensure ~/.local/bin (claude's native install dir) and the npm global bin are on PATH ` +
        `for the process that starts larkway (launchd/systemd/watchdog script).`,
    };
  }
  if (result.errorCode !== undefined || result.timedOut) {
    return {
      ok: false,
      diagnosis:
        `${spec.bin} ${spec.args.join(" ")} could not be evaluated ` +
        `(${result.timedOut ? "timed out" : `spawn error ${result.errorCode}`}). ` +
        `Backend "${backend}" may still work; investigate if bots on it do not respond.`,
    };
  }

  // claude reports JSON with a loggedIn flag AND exits non-zero when logged
  // out; trust either signal (belt and braces across CLI versions).
  const claudeLoggedOut =
    backend === "claude" && /"loggedIn"\s*:\s*false/.test(result.stdout ?? "");
  if ((result.exitCode ?? 1) !== 0 || claudeLoggedOut) {
    const keychainHint =
      backend === "claude" && platform === "darwin"
        ? " On macOS a LOCKED login keychain produces this too (claude stores its OAuth token there; " +
          "SSH-started processes cannot unlock it) — restart the bridge from a GUI session / launchd, not a bare SSH shell."
        : "";
    return {
      ok: false,
      diagnosis:
        `${spec.bin} reports not logged in (exit ${result.exitCode}). ` +
        `Bots on backend "${backend}" will spawn agents that immediately fail or hang. ` +
        `Fix: run \`${spec.bin} login\` as the bridge's user.` +
        keychainHint,
    };
  }
  return { ok: true };
}

/** Run the login probe for one backend (10 s cap). Never throws. */
export async function probeBackendReadiness(backend: string): Promise<ProbeOutcome> {
  const spec = probeSpecForBackend(backend);
  if (!spec) return { ok: true };
  return new Promise<ProbeOutcome>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (outcome: ProbeOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(outcome);
    };
    let child: ReturnType<typeof spawnProcess>;
    try {
      child = spawnProcess(spec.bin, spec.args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      done(interpretProbe(backend, { errorCode: typeof code === "string" ? code : "unknown" }));
      return;
    }
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      done(interpretProbe(backend, { timedOut: true }));
    }, 10_000);
    const out: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => out.push(c));
    child.on("error", (err: NodeJS.ErrnoException) => {
      done(
        interpretProbe(backend, {
          errorCode: typeof err.code === "string" ? err.code : "unknown",
        }),
      );
    });
    child.on("close", (code) => {
      done(
        interpretProbe(backend, {
          exitCode: code,
          stdout: Buffer.concat(out).toString("utf8"),
        }),
      );
    });
  });
}
