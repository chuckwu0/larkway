import fs from "node:fs/promises";
import path from "node:path";
import type { BotConfig } from "../config/botLoader.js";

export interface WorkspacePermissionGate {
  ok: boolean;
  filePath: string;
  reason?: string;
}

export type WorkspacePermissionGateBot = Pick<
  BotConfig,
  "chats" | "repos" | "gitlab_token_env"
>;

export async function checkWorkspacePermissionGrant(
  workspacePath: string,
  bot?: WorkspacePermissionGateBot,
): Promise<WorkspacePermissionGate> {
  const filePath = path.join(workspacePath, "permissions-granted.md");
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return {
      ok: false,
      filePath,
      reason: "permissions-granted.md is missing",
    };
  }

  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return {
      ok: false,
      filePath,
      reason: "permissions-granted.md is empty",
    };
  }
  if (
    normalized.includes("no permissions have been granted yet") ||
    normalized.includes("no permissions granted")
  ) {
    return {
      ok: false,
      filePath,
      reason: "permissions-granted.md is still a placeholder",
    };
  }

  if (bot) {
    const semantic = checkGrantMatchesBot(normalized, bot);
    if (!semantic.ok) {
      return {
        ok: false,
        filePath,
        reason: semantic.reason,
      };
    }
  }

  return { ok: true, filePath };
}

function checkGrantMatchesBot(
  normalizedGrantText: string,
  bot: WorkspacePermissionGateBot,
): { ok: boolean; reason?: string } {
  const missing: string[] = [];

  if (bot.gitlab_token_env && !normalizedGrantText.includes(bot.gitlab_token_env.toLowerCase())) {
    missing.push(`gitlab_token_env ${bot.gitlab_token_env}`);
  }

  for (const repo of bot.repos) {
    if (!normalizedGrantText.includes(repo.slug.toLowerCase())) {
      missing.push(`repo ${repo.slug}`);
    }
  }

  for (const chat of bot.chats) {
    if (!normalizedGrantText.includes(chat.toLowerCase())) {
      missing.push(`chat ${chat}`);
    }
  }

  if (bot.repos.length > 0 && !/type=(read|write)/.test(normalizedGrantText)) {
    missing.push("repo read/write permission category");
  }

  if (missing.length > 0) {
    return {
      ok: false,
      reason: `permissions-granted.md does not confirm current bot permission surface: missing ${missing.join(", ")}`,
    };
  }

  const highRiskPatterns = [
    "type=deploy",
    "type=external-message",
    "type=production-impact",
    "deploy",
    "restart",
    "external message",
    "production impact",
    "production-impact",
  ];
  const highRiskLines = normalizedGrantText
    .split(/\r?\n/)
    .filter((line) => highRiskPatterns.some((pattern) => line.includes(pattern)));
  const ungated = highRiskLines.filter(
    (line) =>
      !line.includes("gate") &&
      !line.includes("gated") &&
      !line.includes("confirm") &&
      !line.includes("confirmation"),
  );
  if (ungated.length > 0) {
    return {
      ok: false,
      reason: "permissions-granted.md includes high-risk capabilities without explicit gate/confirmation",
    };
  }

  return { ok: true };
}
