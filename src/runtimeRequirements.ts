import { execFileSync } from "node:child_process";
import type { BotConfig } from "./config/botLoader.js";

export type RuntimeRequirementSeverity = "required" | "optional";

export interface RuntimeRequirement {
  id: string;
  label: string;
  command?: string;
  kind: "cli" | "secret";
  severity: RuntimeRequirementSeverity;
  ok: boolean;
  version?: string;
  reason?: string;
  installHint?: string;
  botIds: string[];
}

function checkCli(command: string): { ok: boolean; version?: string } {
  try {
    execFileSync("which", [command], { stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    return { ok: false };
  }

  try {
    const version = execFileSync(command, ["--version"], { stdio: ["pipe", "pipe", "pipe"] })
      .toString()
      .trim()
      .split("\n")[0];
    return { ok: true, ...(version ? { version } : {}) };
  } catch {
    return { ok: true };
  }
}

function repoLooksGitLab(urlOrSlug: string): boolean {
  return /(^|[./:@-])gitlab([./:@-]|$)/i.test(urlOrSlug);
}

function botUsesGitLab(bot: BotConfig): boolean {
  return bot.repos.some((repo) => repoLooksGitLab(repo.url ?? repo.slug));
}

function addCliRequirement(
  requirements: Map<string, RuntimeRequirement>,
  input: {
    command: string;
    label?: string;
    severity: RuntimeRequirementSeverity;
    botIds: string[];
    reason: string;
    installHint?: string;
  },
): void {
  const existing = requirements.get(`cli:${input.command}`);
  if (existing) {
    existing.botIds = Array.from(new Set([...existing.botIds, ...input.botIds])).sort();
    if (existing.severity === "optional" && input.severity === "required") {
      existing.severity = "required";
    }
    return;
  }
  const probe = checkCli(input.command);
  requirements.set(`cli:${input.command}`, {
    id: `cli:${input.command}`,
    label: input.label ?? input.command,
    command: input.command,
    kind: "cli",
    severity: input.severity,
    ok: probe.ok,
    ...(probe.version ? { version: probe.version } : {}),
    reason: input.reason,
    ...(input.installHint ? { installHint: input.installHint } : {}),
    botIds: Array.from(new Set(input.botIds)).sort(),
  });
}

function addSecretRequirement(
  requirements: Map<string, RuntimeRequirement>,
  input: {
    envName: string;
    botIds: string[];
    reason: string;
    severity?: RuntimeRequirementSeverity;
  },
): void {
  const id = `secret:${input.envName}`;
  const existing = requirements.get(id);
  if (existing) {
    existing.botIds = Array.from(new Set([...existing.botIds, ...input.botIds])).sort();
    return;
  }
  const value = process.env[input.envName];
  requirements.set(id, {
    id,
    label: input.envName,
    kind: "secret",
    severity: input.severity ?? "required",
    ok: value != null && value !== "",
    reason: input.reason,
    installHint: `Set ${input.envName} in ~/.larkway/.env and restart Larkway.`,
    botIds: Array.from(new Set(input.botIds)).sort(),
  });
}

export function runtimeRequirementsForBots(bots: BotConfig[]): RuntimeRequirement[] {
  const requirements = new Map<string, RuntimeRequirement>();

  if (bots.length > 0) {
    addCliRequirement(requirements, {
      command: "lark-cli",
      label: "Feishu CLI",
      severity: "required",
      botIds: bots.map((bot) => bot.id),
      reason: "Required for agents to read Feishu topic history, attachments, docs, and other context.",
      installHint: "Install and configure lark-cli, then restart Larkway.",
    });
  }

  for (const bot of bots) {
    addCliRequirement(requirements, {
      command: bot.backend ?? "claude",
      severity: "required",
      botIds: [bot.id],
      reason: `Required to run this bot's ${bot.backend ?? "claude"} backend.`,
    });

    if (bot.runtime === "agent_workspace" && bot.repos.length > 0) {
      const tokenEnvName = bot.git_token_env ?? bot.gitlab_token_env;
      if (tokenEnvName) {
        addSecretRequirement(requirements, {
          envName: tokenEnvName,
          botIds: [bot.id],
          severity: "optional",
          reason: "Optional Git identity material. When absent, agents use the host's normal Git auth.",
        });
      } else {
        requirements.set(`secret:missing-git-token:${bot.id}`, {
          id: `secret:missing-git-token:${bot.id}`,
          label: "Git access token env",
          kind: "secret",
          severity: "optional",
          ok: false,
          reason: `Bot "${bot.id}" has repo pointers but no git_token_env. It will use the host's normal Git auth.`,
          installHint: "Add a Git access token only when you want this agent to use a specific GitHub/GitLab identity.",
          botIds: [bot.id],
        });
      }
    }

    if (botUsesGitLab(bot)) {
      addCliRequirement(requirements, {
        command: "glab",
        label: "GitLab CLI",
        severity: "optional",
        botIds: [bot.id],
        reason: "Only needed when an agent uses GitLab-specific actions such as MRs, pipelines, or releases.",
        installHint: "Install glab only for bots that need GitLab-specific workflow commands.",
      });
    }
  }

  return [...requirements.values()].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "required" ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === "cli" ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}
