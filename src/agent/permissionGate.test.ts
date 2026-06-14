import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkWorkspacePermissionGrant } from "./permissionGate.js";

async function withWorkspace(
  body: string | null,
  fn: (workspace: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "larkway-permission-gate-"));
  try {
    const workspace = path.join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    if (body !== null) {
      await writeFile(path.join(workspace, "permissions-granted.md"), body, "utf8");
    }
    await fn(workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("checkWorkspacePermissionGrant", () => {
  it("reports when permissions-granted.md is missing", async () => {
    await withWorkspace(null, async (workspace) => {
      const result = await checkWorkspacePermissionGrant(workspace);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("missing");
    });
  });

  it("reports while the grant artifact is still a placeholder", async () => {
    await withWorkspace("No permissions have been granted yet.\n", async (workspace) => {
      const result = await checkWorkspacePermissionGrant(workspace);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("placeholder");
    });
  });

  it("passes after a human-confirmed grant is recorded", async () => {
    await withWorkspace("- type=write GitLab write/MR confirmed by host\n", async (workspace) => {
      const result = await checkWorkspacePermissionGrant(workspace);
      expect(result.ok).toBe(true);
    });
  });

  it("reports when a grant does not cover the current repo/token/chat surface", async () => {
    await withWorkspace("- type=write GitLab write/MR confirmed by host\n", async (workspace) => {
      const result = await checkWorkspacePermissionGrant(workspace, {
        chats: ["oc_new"],
        repos: [{ slug: "chuckwu0/larkway", branch: "main" }],
        gitlab_token_env: "LARKWAY_DEVOPS_GITLAB_TOKEN",
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("chuckwu0/larkway");
      expect(result.reason).toContain("LARKWAY_DEVOPS_GITLAB_TOKEN");
      expect(result.reason).toContain("oc_new");
    });
  });

  it("passes when the grant covers the current repo/token/chat surface", async () => {
    await withWorkspace(
      [
        "- type=read Feishu chat allowlist: oc_new",
        "- type=read GitLab repo pointer: chuckwu0/larkway (main)",
        "- type=write GitLab write/MR env=LARKWAY_DEVOPS_GITLAB_TOKEN",
        "",
      ].join("\n"),
      async (workspace) => {
        const result = await checkWorkspacePermissionGrant(workspace, {
          chats: ["oc_new"],
          repos: [{ slug: "chuckwu0/larkway", branch: "main" }],
          gitlab_token_env: "LARKWAY_DEVOPS_GITLAB_TOKEN",
        });
        expect(result.ok).toBe(true);
      },
    );
  });

  it("reports when high-risk permission lines are not explicitly gated", async () => {
    await withWorkspace(
      [
        "- type=read Feishu chat allowlist: oc_new",
        "- type=read GitLab repo pointer: chuckwu0/larkway (main)",
        "- type=write GitLab write/MR env=LARKWAY_DEVOPS_GITLAB_TOKEN",
        "- type=deploy deploy/restart",
        "",
      ].join("\n"),
      async (workspace) => {
        const result = await checkWorkspacePermissionGrant(workspace, {
          chats: ["oc_new"],
          repos: [{ slug: "chuckwu0/larkway", branch: "main" }],
          gitlab_token_env: "LARKWAY_DEVOPS_GITLAB_TOKEN",
        });
        expect(result.ok).toBe(false);
        expect(result.reason).toContain("high-risk");
      },
    );
  });
});
