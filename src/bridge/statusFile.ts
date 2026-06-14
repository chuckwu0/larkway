/**
 * src/bridge/statusFile.ts
 *
 * Structured per-bot liveness file — `~/.larkway/<botId>/status.json`.
 *
 * Why this exists: the bridge previously only wrote heartbeats to the log, so the
 * Web 管理面's GET /api/status could only show a host-level summary — it could NOT
 * tell whether any given bot was *actually serving* or had gone "deaf" (WS
 * silently disconnected, 2026-05-29 channel-SDK reconnect blocker). This file is a
 * tiny structured heartbeat the running bridge rewrites on a ~30s interval; the
 * Web layer reads it and classifies a bot into one of three 状态:
 *
 *   🟢 serving  — file fresh (<staleMs) AND ws=true
 *   🟡 degraded — file fresh (<staleMs) BUT ws=false (bridge alive, WS not连上)
 *   🔴 offline  — file missing OR stale (>staleMs) → bridge not running
 *
 * Thin-channel: this carries ONLY liveness (updatedAt / ws / name / pid) — no
 * business workflow state (that's <worktree>/.larkway/state.json).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveLarkwayDir } from "../config/paths.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The structured liveness record persisted to status.json. */
export interface StatusFile {
  /** ISO-8601 timestamp of when the bridge last wrote this file (system time). */
  updatedAt: string;
  /** Whether the bot's Channel SDK WS was connected at write time. */
  ws: boolean;
  /** Human-facing bot name (for the UI; avoids a second yaml read). */
  name: string;
  /** OS pid of the bridge process that wrote this (diagnostics). */
  pid: number;
  /**
   * Bot avatar URL (Feishu bot/v3/info `avatar_url`) — a public image/png URL the
   * Web 管理面 loads directly via <img src>. Optional + best-effort: absent on a
   * pre-avatar status.json or when the one-shot fetch at boot failed (network /
   * V1 single-bot). Readers fall back to a placeholder when missing.
   */
  avatar?: string;
  /**
   * The backend actually loaded by THIS bridge process (from in-memory botConfig,
   * NOT re-read from yaml). Represents the running backend, not the on-disk config.
   * Optional: absent on status.json written by older bridge versions. Readers that
   * need to compare running vs configured backend treat absence as "unknown" and
   * suppress any mismatch badge (avoid false positives on legacy files).
   */
  backend?: string;
  /**
   * The runtime actually loaded by THIS bridge process (from in-memory botConfig).
   * Optional for backward compatibility with older status.json files. Dogfood E2E
   * treats absence as "unknown" so a stale old bridge cannot masquerade as v0.3.
   */
  runtime?: "legacy" | "agent_workspace";
}

/** What the bridge supplies per write; updatedAt + pid are filled in here. */
export interface StatusWrite {
  ws: boolean;
  name: string;
  /** Optional bot avatar URL; omitted until the boot fetch resolves it. */
  avatar?: string;
  /**
   * The backend actually running in this bridge process (from in-memory botConfig).
   * Omitted when not relevant (e.g. dry-run exit writes). Readers treat absence as
   * "unknown" to stay backward-compatible with pre-BL-17 status.json files.
   */
  backend?: string;
  /**
   * The runtime actually running in this bridge process (from in-memory botConfig).
   * Omitted only for legacy/backward-compatible callers.
   */
  runtime?: "legacy" | "agent_workspace";
}

/** The 3-state classification surfaced to the Web 管理面. */
export type BotLivenessState = "serving" | "degraded" | "offline";

/** Default staleness window (ms). A status.json older than this → offline. */
export const DEFAULT_STALE_MS = 90_000;

// ---------------------------------------------------------------------------
// Path
// ---------------------------------------------------------------------------

/**
 * Resolve `~/.larkway/<botId>/status.json` (or `~/.larkway/status.json` for the
 * V1/undefined bucket — see resolveLarkwayDir). Pure path calc; does NOT mkdir.
 */
export function resolveStatusFilePath(larkwayHome: string, botId?: string): string {
  // resolveLarkwayDir(botId) gives ~/.larkway/<botId> (or ~/.larkway for V1).
  // We honor an explicit larkwayHome by swapping the homedir-rooted prefix only
  // when callers pass a custom home; in practice prod uses the real home and the
  // two agree. Keep it simple: derive the leaf from resolveLarkwayDir but rebase
  // onto larkwayHome so tests can inject a tmp home.
  const dir =
    botId === undefined
      ? larkwayHome
      : path.join(larkwayHome, botId);
  return path.join(dir, "status.json");
}

// ---------------------------------------------------------------------------
// Write (bridge runtime)
// ---------------------------------------------------------------------------

/**
 * Atomically write `~/.larkway/<botId>/status.json`. mkdir -p the parent, write a
 * tmp sibling, then rename (atomic on POSIX). Stamps updatedAt with system time
 * (this is runtime code — the wall clock IS the truth here) and pid with the
 * current process. Never throws into the caller's interval — a transient FS error
 * just means one missed heartbeat; the next tick retries.
 */
export async function writeStatusFile(botId: string | undefined, w: StatusWrite): Promise<void> {
  const dir = resolveLarkwayDir(botId);
  const file = path.join(dir, "status.json");
  const record: StatusFile = {
    updatedAt: new Date().toISOString(),
    ws: w.ws,
    name: w.name,
    pid: process.pid,
    // Only persist optional fields when present — keeps the file shape identical
    // to older versions when fields are absent (old readers stay happy).
    ...(w.avatar !== undefined ? { avatar: w.avatar } : {}),
    ...(w.backend !== undefined ? { backend: w.backend } : {}),
    ...(w.runtime !== undefined ? { runtime: w.runtime } : {}),
  };
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(record), "utf-8");
  await fs.rename(tmp, file);
}

// ---------------------------------------------------------------------------
// Read (Web 管理面)
// ---------------------------------------------------------------------------

/**
 * Read + parse `~/.larkway/<botId>/status.json` rooted at `larkwayHome`. Returns
 * null on missing file OR corrupt/invalid content — both mean "no trustworthy
 * liveness", which the caller treats as offline. Validates the minimal shape so a
 * truncated/partial write (rename makes this rare but not impossible mid-write
 * on some FSes) doesn't masquerade as live.
 */
export async function readStatusFile(
  larkwayHome: string,
  botId?: string,
): Promise<StatusFile | null> {
  const file = resolveStatusFilePath(larkwayHome, botId);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch {
    return null; // missing / unreadable → no liveness
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // corrupt JSON → no liveness
  }
  if (!isStatusFile(parsed)) return null;
  return parsed;
}

/** Minimal structural guard for a parsed status.json. */
function isStatusFile(v: unknown): v is StatusFile {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  // Optional fields: absent → fine (old status.json); present → must be the
  // correct type. A wrong-typed optional field invalidates the record (defensive).
  const avatarOk = o["avatar"] === undefined || typeof o["avatar"] === "string";
  const backendOk = o["backend"] === undefined || typeof o["backend"] === "string";
  const runtimeOk =
    o["runtime"] === undefined || o["runtime"] === "legacy" || o["runtime"] === "agent_workspace";
  return (
    typeof o["updatedAt"] === "string" &&
    typeof o["ws"] === "boolean" &&
    typeof o["name"] === "string" &&
    typeof o["pid"] === "number" &&
    avatarOk &&
    backendOk &&
    runtimeOk
  );
}

// ---------------------------------------------------------------------------
// Classify (pure — testable without timers)
// ---------------------------------------------------------------------------

/**
 * Classify a (possibly null) status into the 3-state liveness model. PURE: the
 * caller passes `nowMs` (so tests inject a fixed clock; production passes
 * Date.now()). `staleMs` is the freshness window (default 90s).
 *
 *   - null / unparsable                          → "offline"
 *   - updatedAt older than staleMs (or unparsable)→ "offline"
 *   - fresh + ws=true                            → "serving"
 *   - fresh + ws=false                           → "degraded"
 */
export function classifyStatus(
  status: StatusFile | null,
  nowMs: number,
  staleMs: number = DEFAULT_STALE_MS,
): BotLivenessState {
  if (status === null) return "offline";
  const updatedMs = Date.parse(status.updatedAt);
  if (!Number.isFinite(updatedMs)) return "offline"; // unparsable timestamp → can't trust
  if (nowMs - updatedMs > staleMs) return "offline"; // stale → bridge not running
  return status.ws ? "serving" : "degraded";
}
