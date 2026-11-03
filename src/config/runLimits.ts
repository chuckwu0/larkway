import { resolveRunTimeoutMs } from "../agent/runTimeout.js";
import type { BotConfig } from "./botLoader.js";

/** Shared startup mapping: total budget, idle notice, and idle kill are separate. */
export function botRunLimits(bot: Pick<BotConfig,
  "subprocess_timeout_seconds" | "idle_timeout_seconds" | "idle_kill_seconds"
>): {
  subprocessTimeoutMs?: number;
  responseSurfaceIdleTimeoutMs?: number;
  responseSurfaceIdleKillMs?: number;
} {
  return {
    subprocessTimeoutMs: resolveRunTimeoutMs(
      bot.subprocess_timeout_seconds === undefined ? undefined : bot.subprocess_timeout_seconds * 1000,
    ),
    responseSurfaceIdleTimeoutMs: bot.idle_timeout_seconds === undefined ? undefined : bot.idle_timeout_seconds * 1000,
    responseSurfaceIdleKillMs: bot.idle_kill_seconds === undefined ? undefined : bot.idle_kill_seconds * 1000,
  };
}
