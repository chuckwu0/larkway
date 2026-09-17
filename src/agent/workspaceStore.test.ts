import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ensureAgentWorkspace, resetAgentWorkspacePermissions } from "./workspaceStore.js";

describe("ensureAgentWorkspace", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "larkway-workspace-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates workspace/session artifact files without secret values", async () => {
    const workspacePath = path.join(dir, "agents", "devops", "workspace");
    const reposPath = path.join(workspacePath, "repos");
    const sessionPath = path.join(workspacePath, "sessions", "om_abc");

    await ensureAgentWorkspace({
      agentId: "devops",
      workspacePath,
      reposPath,
      sessionPath,
      bot: {
        name: "DevOps",
        description: "Develop and operate Larkway",
        chats: ["oc_test"],
        gitlab_token_env: "LARKWAY_DEVOPS_GITLAB_TOKEN",
      },
      taskDescription: "Develop and operate Larkway from Feishu.",
      agentMemory: "You are the Larkway DevOps agent.",
      repos: [
        {
          slug: "chuckwu0/larkway",
          branch: "main",
          url: "https://oauth2:glpat-secret@gitlab.example.com/chuckwu0/larkway.git",
          suggestedPath: path.join(reposPath, "larkway"),
        },
      ],
      permissionRequests: [
        { capability: "GitLab read/write MR", envVarName: "LARKWAY_DEVOPS_GITLAB_TOKEN" },
        { capability: "Local shell test runner", reason: "run pnpm test/typecheck" },
      ],
      humanGates: ["deploy/restart requires confirmation"],
    });

    await expect(fs.stat(path.join(workspacePath, "AGENTS.md"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(workspacePath, "CLAUDE.md"))).resolves.toBeTruthy();
    expect((await fs.lstat(path.join(workspacePath, "CLAUDE.md"))).isSymbolicLink()).toBe(true);
    await expect(fs.readlink(path.join(workspacePath, "CLAUDE.md"))).resolves.toBe("AGENTS.md");
    await expect(fs.stat(path.join(workspacePath, "permissions-request.md"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(workspacePath, "permissions-granted.md"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(workspacePath, "tasks"))).rejects.toThrow();
    await expect(fs.stat(sessionPath)).resolves.toBeTruthy();

    await expect(
      fs.stat(path.join(workspacePath, "memory")),
    ).resolves.toBeTruthy();
    // 批G P1 (R1/R2): the six-category scaffold is retired for NEW workspaces.
    // Native memory stays local by default; sharing is an explicit opt-in.
    await expect(
      fs.stat(path.join(workspacePath, "memory", "README.md")),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(workspacePath, "memory", "preferences.md")),
    ).resolves.toBeTruthy();
    for (const retired of [
      "index.md",
      "reusable-knowledge.md",
      "workflows.md",
      "decisions.md",
      "assets.md",
    ]) {
      await expect(
        fs.stat(path.join(workspacePath, "memory", retired)),
      ).rejects.toThrow();
    }
    // assets/ and archive/ container dirs are still scaffolded.
    await expect(
      fs.stat(path.join(workspacePath, "memory", "assets")),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(workspacePath, "memory", "archive")),
    ).resolves.toBeTruthy();
    const memoryReadme = await fs.readFile(
      path.join(workspacePath, "memory", "README.md"),
      "utf8",
    );
    expect(memoryReadme).toContain("workspace 私有记忆");
    expect(memoryReadme).toContain("显式配置 `sharedKnowledge: true`");
    expect(memoryReadme).toContain("默认不写入组织知识库");
    expect(memoryReadme).not.toContain("knowledge/inbox/inbox.md");
    expect(memoryReadme).toContain("preferences.md");
    const prefSkeleton = await fs.readFile(
      path.join(workspacePath, "memory", "preferences.md"),
      "utf8",
    );
    expect(prefSkeleton).toContain("Owner Preferences");
    expect(prefSkeleton).toContain("默认属于当前 workspace");
    expect(prefSkeleton).toContain("跨 Agent 共享须由维护者显式配置");
    expect(prefSkeleton).not.toContain("知识库 inbox");

    const agentsMd = await fs.readFile(path.join(workspacePath, "AGENTS.md"), "utf8");
    expect(agentsMd).not.toContain("开场不可跳过");
    expect(agentsMd).not.toContain("Read `memory/index.md`");
    expect(agentsMd).not.toContain("before ending a turn");
    expect(agentsMd).not.toContain("Read `permissions-request.md`");
    for (const section of ["identity", "primary-task", "repos", "role-notes"]) {
      expect(agentsMd).toContain(`<!-- larkway:${section}:start`);
      expect(agentsMd).toContain(`<!-- larkway:${section}:end -->`);
    }
    // Identity facts do not imply a default organization-memory workflow.
    expect(agentsMd).not.toContain("长期知识纪律");
    expect(agentsMd).not.toContain("保养轮");
    expect(agentsMd).not.toContain("组织知识库 inbox");
    expect(agentsMd).toContain("Develop and operate Larkway from Feishu.");
    expect(agentsMd).toContain("You are the Larkway DevOps agent.");
    expect(agentsMd).toContain("https://gitlab.example.com/chuckwu0/larkway.git");
    expect(agentsMd).not.toContain("oauth2:");
    expect(agentsMd).not.toContain("glpat-secret");

    const permissions = await fs.readFile(
      path.join(workspacePath, "permissions-request.md"),
      "utf8",
    );
    expect(permissions).toContain("Feishu IM: receive mentions and reply in allowed chats");
    expect(permissions).toContain("Feishu chat allowlist: oc_test");
    expect(permissions).toContain("Git repo pointer: chuckwu0/larkway (main)");
    expect(permissions).toContain("Local shell inside the Agent Workspace");
    expect(permissions).toContain("GitLab read/write MR");
    expect(permissions).toContain("deploy/restart requires confirmation");
    expect(permissions).toContain("LARKWAY_DEVOPS_GITLAB_TOKEN");
    expect(permissions).not.toContain("glpat-");

  });

  it("can bootstrap creation-time artifacts without a session path", async () => {
    const workspacePath = path.join(dir, "workspace");
    await ensureAgentWorkspace({
      agentId: "devops",
      workspacePath,
      reposPath: path.join(workspacePath, "repos"),
      bot: { name: "DevOps", description: "Develop and operate Larkway" },
      taskDescription: "Create this agent from a task-first flow.",
    });

    await expect(fs.stat(path.join(workspacePath, "AGENTS.md"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(workspacePath, "tasks"))).rejects.toThrow();
  });

  it("scaffolds canonical .agents/skills with a .claude/skills symlink into it", async () => {
    const workspacePath = path.join(dir, "workspace");
    await ensureAgentWorkspace({
      agentId: "devops",
      workspacePath,
      reposPath: path.join(workspacePath, "repos"),
      bot: { name: "DevOps", description: "Develop and operate Larkway" },
      taskDescription: "Skills scaffold test.",
    });

    expect((await fs.stat(path.join(workspacePath, ".agents", "skills"))).isDirectory()).toBe(
      true,
    );
    const linkPath = path.join(workspacePath, ".claude", "skills");
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
    const target = await fs.readlink(linkPath);
    // Windows junctions expose an absolute target (possibly with a trailing
    // separator); compare the actual directory while retaining POSIX portability.
    expect(await fs.realpath(path.resolve(path.dirname(linkPath), target))).toBe(
      await fs.realpath(path.join(workspacePath, ".agents", "skills")),
    );
    if (process.platform !== "win32") {
      expect(target).toBe(path.join("..", ".agents", "skills"));
    }
    // A skill dropped in the canonical directory is visible through both paths.
    await fs.mkdir(path.join(workspacePath, ".agents", "skills", "demo"), { recursive: true });
    await fs.writeFile(path.join(workspacePath, ".agents", "skills", "demo", "SKILL.md"), "x");
    await expect(fs.stat(path.join(linkPath, "demo", "SKILL.md"))).resolves.toBeTruthy();
  });

  it("keeps a pre-existing real .claude/skills directory instead of replacing it", async () => {
    const workspacePath = path.join(dir, "workspace");
    const realSkills = path.join(workspacePath, ".claude", "skills", "mine");
    await fs.mkdir(realSkills, { recursive: true });
    await fs.writeFile(path.join(realSkills, "SKILL.md"), "agent-owned\n", "utf8");

    await ensureAgentWorkspace({
      agentId: "devops",
      workspacePath,
      reposPath: path.join(workspacePath, "repos"),
      bot: { name: "DevOps", description: "Develop and operate Larkway" },
      taskDescription: "Skills scaffold guard test.",
    });

    expect(
      (await fs.lstat(path.join(workspacePath, ".claude", "skills"))).isSymbolicLink(),
    ).toBe(false);
    await expect(fs.readFile(path.join(realSkills, "SKILL.md"), "utf8")).resolves.toBe(
      "agent-owned\n",
    );
  });

  it("does not overwrite existing durable workspace AGENTS.md", async () => {
    const workspacePath = path.join(dir, "workspace");
    const reposPath = path.join(workspacePath, "repos");
    const sessionPath = path.join(workspacePath, "sessions", "om_abc");
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, "AGENTS.md"), "kept\n", "utf8");

    await ensureAgentWorkspace({
      agentId: "devops",
      workspacePath,
      reposPath,
      sessionPath,
      bot: { name: "DevOps", description: "Develop and operate Larkway" },
      agentMemory: "new memory",
    });

    await expect(fs.readFile(path.join(workspacePath, "AGENTS.md"), "utf8")).resolves.toBe(
      "kept\n",
    );
  });

  it("does not refresh creation facts during runtime session preparation", async () => {
    const workspacePath = path.join(dir, "workspace");
    const reposPath = path.join(workspacePath, "repos");

    await ensureAgentWorkspace({
      agentId: "devops",
      workspacePath,
      reposPath,
      refreshFacts: true,
      bot: { name: "DevOps", description: "Creation description" },
      taskDescription: "Creation task",
    });

    await fs.writeFile(path.join(workspacePath, "AGENTS.md"), "agent self-updated facts\n", "utf8");
    await fs.writeFile(
      path.join(workspacePath, "permissions-request.md"),
      "agent pending permission notes\n",
      "utf8",
    );

    await ensureAgentWorkspace({
      agentId: "devops",
      workspacePath,
      reposPath,
      sessionPath: path.join(workspacePath, "sessions", "om_runtime"),
      bot: { name: "DevOps", description: "Runtime description" },
      taskDescription: "Runtime task",
    });

    await expect(fs.readFile(path.join(workspacePath, "AGENTS.md"), "utf8")).resolves.toBe(
      "agent self-updated facts\n",
    );
    await expect(
      fs.readFile(path.join(workspacePath, "permissions-request.md"), "utf8"),
    ).resolves.toBe("agent pending permission notes\n");
    await expect(fs.stat(path.join(workspacePath, "tasks"))).rejects.toThrow();
    await expect(
      fs.stat(path.join(workspacePath, "sessions", "om_runtime")),
    ).resolves.toBeTruthy();
  });

  it("refreshes creation facts while preserving grants and owner memory files", async () => {
    const workspacePath = path.join(dir, "workspace");
    const reposPath = path.join(workspacePath, "repos");

    await ensureAgentWorkspace({
      agentId: "devops",
      workspacePath,
      reposPath,
      bot: {
        name: "DevOps",
        description: "Old description",
        chats: ["oc_old"],
        gitlab_token_env: "OLD_TOKEN_ENV",
      },
      taskDescription: "Old task",
      agentMemory: "old memory",
      repos: [{ slug: "old/repo", branch: "main", suggestedPath: path.join(reposPath, "repo") }],
      permissionGrants: [{ category: "write", capability: "old grant" }],
    });
    await fs.writeFile(path.join(workspacePath, "permissions-granted.md"), "confirmed grant\n", "utf8");
    const memoryReadme = "# Owner memory policy\nUse the configured team knowledge/inbox/inbox.md.\n";
    const preferences = "# Owner preferences\nKeep my custom rules.\n";
    await fs.writeFile(path.join(workspacePath, "memory", "README.md"), memoryReadme, "utf8");
    await fs.writeFile(path.join(workspacePath, "memory", "preferences.md"), preferences, "utf8");
    await fs.appendFile(path.join(workspacePath, "AGENTS.md"), "\n## Custom Rules\n\nKeep this owner-written instruction.\n");

    const result = await ensureAgentWorkspace({
      agentId: "devops",
      workspacePath,
      reposPath,
      refreshFacts: true,
      bot: {
        name: "New Agent",
        description: "New description",
        chats: ["oc_new"],
        gitlab_token_env: "NEW_TOKEN_ENV",
      },
      taskDescription: "New task",
      agentMemory: "new AGENTS role notes",
      repos: [
        { slug: "chuckwu0/larkway", branch: "main", suggestedPath: path.join(reposPath, "larkway") },
      ],
      permissionRequests: [{ category: "write", capability: "GitLab write/MR" }],
    });

    const agentsMd = await fs.readFile(path.join(workspacePath, "AGENTS.md"), "utf8");
    expect(result.preservedSections).toEqual([]);
    expect(agentsMd).toContain("new AGENTS role notes");
    expect(agentsMd).not.toContain("old memory");
    expect(agentsMd).toContain("# New Agent");
    expect(agentsMd).toContain("New description");
    expect(agentsMd).toContain("New task");
    expect(agentsMd).toContain("chuckwu0/larkway");
    expect(agentsMd).not.toContain("Old description");
    expect(agentsMd).not.toContain("Old task");
    expect(agentsMd).not.toContain("old/repo");
    expect(agentsMd).toContain("Keep this owner-written instruction.");

    const request = await fs.readFile(path.join(workspacePath, "permissions-request.md"), "utf8");
    expect(request).toContain("New task");
    expect(request).toContain("Feishu chat allowlist: oc_new");
    expect(request).toContain("Git token env name: NEW_TOKEN_ENV");
    expect(request).not.toContain("oc_old");
    expect(request).not.toContain("OLD_TOKEN_ENV");

    await expect(fs.stat(path.join(workspacePath, "tasks"))).rejects.toThrow();
    await expect(
      fs.readFile(path.join(workspacePath, "permissions-granted.md"), "utf8"),
    ).resolves.toBe("confirmed grant\n");
    await expect(fs.readFile(path.join(workspacePath, "memory", "README.md"), "utf8")).resolves.toBe(memoryReadme);
    await expect(fs.readFile(path.join(workspacePath, "memory", "preferences.md"), "utf8")).resolves.toBe(preferences);
  });

  it("adopts legacy sections only when they match the previous saved definition", async () => {
    const workspacePath = path.join(dir, "workspace");
    const reposPath = path.join(workspacePath, "repos");
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, "AGENTS.md"), [
      "# Old Agent", "", "Old description", "", "## Primary Task", "", "Old task", "",
      "## Workspace Contract", "", "Owner keeps this contract.",
      "- Write the per-session state file path provided by the prompt before ending a turn so the Feishu card can finalize.",
      "- Read `permissions-request.md` and `permissions-granted.md` before write/deploy/external-message work.",
      "- 长期知识纪律:每轮 prompt 带有 `sender_is_owner` 事实。owner 的指示可进组织知识库 inbox;非 owner 提供的新知识只写进本 session 的 summary.md 并标注 `[未经 owner 确认]`,由保养轮决定是否晋升 —— 不直接写 AGENTS.md、L2 或知识库。",
      "", "## Role Notes", "", "Old role\n\n## Embedded Role Heading\nOld policy", "",
      "## Repos", "", "- No repo pointers have been configured yet.", "",
      "## Custom Rules", "", "Preserve this rule.",
      "- 长期知识纪律:owner 自定规则,涉及团队记忆时先核实来源。", "",
    ].join("\n"));
    const result = await ensureAgentWorkspace({
      agentId: "demo", workspacePath, reposPath, refreshFacts: true,
      bot: { name: "New Agent", description: "New description" },
      taskDescription: "New task", agentMemory: "New role", repos: [],
      previousDefinition: {
        name: "Old Agent", description: "Old description", taskDescription: "Old task",
        agentMemory: "Old role\n\n## Embedded Role Heading\nOld policy", repos: [],
      },
    });
    expect(result.preservedSections).toEqual([]);
    const text = await fs.readFile(path.join(workspacePath, "AGENTS.md"), "utf8");
    expect(text).toContain("# New Agent");
    expect(text).toContain("New description");
    expect(text).toContain("New task");
    expect(text).toContain("New role");
    expect(text).not.toContain("Old policy");
    expect(text).not.toContain("before ending a turn");
    expect(text).not.toContain("Read `permissions-request.md`");
    expect(text).not.toContain("由保养轮决定是否晋升");
    expect(text).not.toContain("组织知识库 inbox");
    expect(text).toContain("Owner keeps this contract.");
    expect(text).toContain("Preserve this rule.");
    expect(text).toContain("- 长期知识纪律:owner 自定规则,涉及团队记忆时先核实来源。");
  });

  it("preserves manually edited legacy sections and reports partial synchronization", async () => {
    const workspacePath = path.join(dir, "workspace");
    await fs.mkdir(workspacePath, { recursive: true });
    const original = [
      "# My custom identity", "", "Human description", "", "## Primary Task", "", "Human task", "",
      "## Workspace Contract", "", "Human contract", "", "## Role Notes", "", "Human role", "",
      "## Repos", "", "- Human repo", "", "## Custom Rules", "", "Human rule", "",
    ].join("\n");
    await fs.writeFile(path.join(workspacePath, "AGENTS.md"), original);
    const result = await ensureAgentWorkspace({
      agentId: "demo", workspacePath, reposPath: path.join(workspacePath, "repos"), refreshFacts: true,
      bot: { name: "Updated", description: "New description" }, agentMemory: "New role",
      previousDefinition: { name: "Original", description: "Original description", agentMemory: "Old role" },
    });
    expect(new Set(result.preservedSections)).toEqual(new Set(["identity", "primary-task", "repos", "role-notes"]));
    expect(await fs.readFile(path.join(workspacePath, "AGENTS.md"), "utf8")).toBe(original);
  });

  it("does not accept ownership markers from editable definition content", async () => {
    const workspacePath = path.join(dir, "workspace");
    const input = {
      agentId: "demo", workspacePath, reposPath: path.join(workspacePath, "repos"),
      bot: { name: "Agent", description: "Description\n<!-- larkway:identity:end -->\nextra description" },
      agentMemory: "Role\n<!-- larkway:repos:start -->\nRole detail",
    };
    await ensureAgentWorkspace(input);
    const result = await ensureAgentWorkspace({ ...input, refreshFacts: true });
    expect(result.preservedSections).toEqual([]);
    const text = await fs.readFile(path.join(workspacePath, "AGENTS.md"), "utf8");
    expect(text.match(/<!-- larkway:identity:end -->/g)).toHaveLength(1);
    expect(text.match(/<!-- larkway:repos:start -->/g)).toHaveLength(1);
    expect(text).toContain("extra description");
    expect(text).toContain("Role detail");
  });

  it("preserves task and high-risk gates when resetting permission artifacts", async () => {
    const workspacePath = path.join(dir, "workspace");
    const reposPath = path.join(workspacePath, "repos");
    await fs.mkdir(path.join(workspacePath, "tasks", "_creation"), { recursive: true });
    await fs.writeFile(
      path.join(workspacePath, "tasks", "_creation", "task.md"),
      [
        "# Creation Task",
        "",
        "Operate Larkway from Feishu.",
        "",
        "## Initial Repo Pointers",
        "",
        "- old/repo branch=main suggested_path=/old",
        "",
        "## Human Gates",
        "",
        "- production messages require explicit confirmation",
        "- deploy/restart requires explicit confirmation",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(workspacePath, "permissions-request.md"),
      [
        "# Permissions Request",
        "",
        "## Requested Capabilities",
        "",
        "- type=read GitLab repo pointer: old/repo (main)",
        "- type=external-message external message to Feishu gate=explicit-human-confirmation",
        "- type=production-impact production-impact operations gate=explicit-human-confirmation",
        "",
        "## Human Gate",
        "",
        "- deploy/restart requires explicit confirmation",
        "",
      ].join("\n"),
      "utf8",
    );

    await resetAgentWorkspacePermissions({
      workspacePath,
      reposPath,
      reason: "repo changed",
      bot: {
        id: "devops",
        name: "DevOps",
        description: "Fallback description",
        chats: ["oc_new"],
        repos: [{ slug: "chuckwu0/larkway", branch: "main" }],
        gitlab_token_env: "LARKWAY_DEVOPS_GITLAB_TOKEN",
      },
    });

    const request = await fs.readFile(path.join(workspacePath, "permissions-request.md"), "utf8");
    expect(request).toContain("Operate Larkway from Feishu.");
    expect(request).toContain("Feishu chat allowlist: oc_new");
    expect(request).toContain("Git repo pointer: chuckwu0/larkway (main)");
    expect(request).toContain("Git token env name: LARKWAY_DEVOPS_GITLAB_TOKEN");
    expect(request).toContain("external message to Feishu");
    expect(request).toContain("production-impact operations");
    expect(request).toContain("deploy/restart requires explicit confirmation");
    expect(request).toContain("production messages require explicit confirmation");
    expect(request).not.toContain("Git repo pointer: old/repo");

    const granted = await fs.readFile(path.join(workspacePath, "permissions-granted.md"), "utf8");
    expect(granted).toContain("This file is an audit note, not a startup gate.");
    expect(granted).toContain("Feishu chat allowlist: oc_new");
    expect(granted).toContain("Git repo pointer: chuckwu0/larkway (main)");
    expect(granted).toContain("env=LARKWAY_DEVOPS_GITLAB_TOKEN");
    expect(granted).toContain("Reset reason: repo changed");
  });
});

// ---------------------------------------------------------------------------
// 批G G4 — projectRoleNotes (surgical L2 projection)
// ---------------------------------------------------------------------------

import { projectRoleNotes } from "./workspaceStore.js";
import { mkdtemp as mkdtempG4, writeFile as writeFileG4, readFile as readFileG4 } from "node:fs/promises";
import { tmpdir as tmpdirG4 } from "node:os";
import pathG4 from "node:path";

describe("projectRoleNotes (批G G4 surgical projection)", () => {
  const AGENTS = [
    "# Elon",
    "",
    "CEO bot",
    "",
    "## Workspace Contract",
    "",
    "- 开场不可跳过:回应 owner 前,先 Read `memory/index.md`,并按相关性 Read 相关 category 文件,再开始干活(防止新 session 失忆)。",
    "- thin bridge rules here",
    "",
    "## Role Notes",
    "",
    "旧的职能描述",
    "",
    "## Repos",
    "",
    "- git/mm/workspace",
    "",
    "## Agent 自己提升的稳定规则",
    "",
    "- 真 at 回报:必须发真实 post",
    "",
  ].join("\n");

  it("replaces ONLY the Role Notes body; agent-authored sections survive; legacy ritual line is migrated out", async () => {
    const dir = await mkdtempG4(pathG4.join(tmpdirG4(), "larkway-proj-"));
    await writeFileG4(pathG4.join(dir, "AGENTS.md"), AGENTS, "utf8");
    const result = await projectRoleNotes(dir, "新的职能:协调工作。", "旧的职能描述");
    expect(result).toBe("projected");
    const out = await readFileG4(pathG4.join(dir, "AGENTS.md"), "utf8");
    expect(out).toContain("新的职能:协调工作。");
    expect(out).not.toContain("旧的职能描述");
    // The section the agent promoted itself MUST survive (the old full
    // re-render wiped it — the exact bug this function fixes).
    expect(out).toContain("真 at 回报:必须发真实 post");
    expect(out).toContain("thin bridge rules here");
    // Legacy ritual line migrated out in passing (批E E4).
    expect(out).not.toContain("开场不可跳过");
  });

  it("missing AGENTS.md → skipped (caller falls back to full ensure)", async () => {
    const dir = await mkdtempG4(pathG4.join(tmpdirG4(), "larkway-proj-"));
    expect(await projectRoleNotes(dir, "内容")).toBe("skipped");
  });

  it("no Role Notes section (ancient workspace) → appends one", async () => {
    const dir = await mkdtempG4(pathG4.join(tmpdirG4(), "larkway-proj-"));
    await writeFileG4(pathG4.join(dir, "AGENTS.md"), "# Old\n\nno sections\n", "utf8");
    await projectRoleNotes(dir, "补上的职能");
    const out = await readFileG4(pathG4.join(dir, "AGENTS.md"), "utf8");
    expect(out).toContain("## Role Notes");
    expect(out).toContain("补上的职能");
  });

  it("preserves ambiguous legacy role edits instead of deleting unrelated headings", async () => {
    const dir = await mkdtempG4(pathG4.join(tmpdirG4(), "larkway-proj-"));
    const original = "# Agent\n\n## Role Notes\n\nOld role\n\n## Human Rules\n\nKeep this.\n";
    await writeFileG4(pathG4.join(dir, "AGENTS.md"), original, "utf8");
    expect(await projectRoleNotes(dir, "New role", "Old role")).toBe("preserved");
    expect(await readFileG4(pathG4.join(dir, "AGENTS.md"), "utf8")).toBe(original);
  });

  it("adopts the legacy empty-role placeholder when the previous editor value was empty", async () => {
    const dir = await mkdtempG4(pathG4.join(tmpdirG4(), "larkway-proj-"));
    await writeFileG4(pathG4.join(dir, "AGENTS.md"), "# Agent\n\n## Role Notes\n\nNo extra role notes have been configured yet.\n\n## Repos\n\n- none\n", "utf8");
    expect(await projectRoleNotes(dir, "New role", "")).toBe("projected");
    const text = await readFileG4(pathG4.join(dir, "AGENTS.md"), "utf8");
    expect(text).toContain("New role");
    expect(text).not.toContain("No extra role notes have been configured yet.");
  });

  it("preserves malformed ownership markers with a visible result", async () => {
    const dir = await mkdtempG4(pathG4.join(tmpdirG4(), "larkway-proj-"));
    const original = "# Agent\n<!-- larkway:role-notes:start -->\nOld role\n\n## Human Rules\nKeep this.\n";
    await writeFileG4(pathG4.join(dir, "AGENTS.md"), original, "utf8");
    expect(await projectRoleNotes(dir, "New role")).toBe("preserved");
    expect(await readFileG4(pathG4.join(dir, "AGENTS.md"), "utf8")).toBe(original);
  });
});
