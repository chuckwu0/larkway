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
    // Per-agent memory keeps ONLY identity/preferences; shared knowledge lives
    // in the host-level knowledge repo (src/knowledge/store.ts).
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
    expect(memoryReadme).toContain("仅身份与偏好");
    // Cross-agent knowledge is pointed at the org knowledge inbox, not here.
    expect(memoryReadme).toContain("knowledge/inbox/inbox.md");
    expect(memoryReadme).toContain("preferences.md");
    const prefSkeleton = await fs.readFile(
      path.join(workspacePath, "memory", "preferences.md"),
      "utf8",
    );
    expect(prefSkeleton).toContain("Owner Preferences");
    expect(prefSkeleton).toContain("有相同/相关条目就不重复写");
    expect(prefSkeleton).toContain("组织级知识请走知识库 inbox");

    const agentsMd = await fs.readFile(path.join(workspacePath, "AGENTS.md"), "utf8");
    // D4: unskippable startup-load contract is baked into the AGENTS.md template.
    // 批G G4: the "开场不可跳过:先 Read memory/index.md" ritual line is retired
    // (index.md content is injected verbatim into every full prompt).
    expect(agentsMd).not.toContain("开场不可跳过");
    expect(agentsMd).not.toContain("Read `memory/index.md`");
    // 批G G7 (P1): the DEFAULT non-owner knowledge policy ships as a template
    // line in the Workspace Contract (owner-editable — the bridge only injects
    // the sender_is_owner fact; what to do with it is policy).
    expect(agentsMd).toContain("`sender_is_owner`");
    expect(agentsMd).toContain("非 owner 提供的新知识只写进本 session 的 summary.md");
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
    expect(await fs.readlink(linkPath)).toBe(path.join("..", ".agents", "skills"));
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

  it("refreshes creation facts while preserving grants", async () => {
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

    await ensureAgentWorkspace({
      agentId: "devops",
      workspacePath,
      reposPath,
      refreshFacts: true,
      bot: {
        name: "DevOps",
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
    // 批G G4 (adversarial-review fix): refreshFacts on an EXISTING AGENTS.md
    // no longer full-rewrites the file (that wiped agent-promoted sections)
    // — it surgically re-projects Role Notes only. Header/task/repos keep
    // their creation-time values (accepted trade-off; live repo pointers
    // ride every prompt). permissions-request.md refresh is unchanged.
    expect(agentsMd).toContain("new AGENTS role notes");
    expect(agentsMd).not.toContain("old memory");
    expect(agentsMd).toContain("Old description");
    expect(agentsMd).toContain("Old task");

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
    const result = await projectRoleNotes(dir, "新的职能:CEO/总协调,不亲自写码。");
    expect(result).toBe("projected");
    const out = await readFileG4(pathG4.join(dir, "AGENTS.md"), "utf8");
    expect(out).toContain("新的职能:CEO/总协调");
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
});
