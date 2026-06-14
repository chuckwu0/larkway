import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { run } from "./dogfood.js";
import * as botsStoreReal from "../botsStore.js";
import * as hostConfigReal from "../hostConfig.js";
import * as centralStoreReal from "../centralStore.js";
import * as uiReal from "../ui.js";
import type { CliContext } from "../types.js";

let root: string;
let botsDir: string;
let larkwayDir: string;
let envPath: string;
let originalPath: string | undefined;
let originalCodexHome: string | undefined;
let originalOpenAiApiKey: string | undefined;
let originalAnthropicAuthToken: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "larkway-dogfood-"));
  botsDir = path.join(root, "bots");
  larkwayDir = path.join(root, ".larkway");
  envPath = path.join(larkwayDir, ".env");
  await mkdir(botsDir, { recursive: true });
  await mkdir(larkwayDir, { recursive: true });
  originalPath = process.env.PATH;
  originalCodexHome = process.env.CODEX_HOME;
  originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  originalAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const fakeBin = path.join(root, "bin");
  const fakeCodexHome = path.join(root, ".codex");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(fakeCodexHome, { recursive: true });
  const fakeCodex = path.join(fakeBin, "codex");
  await writeFile(fakeCodex, "#!/usr/bin/env sh\necho 'codex 0.0.0-test'\n", "utf8");
  await chmod(fakeCodex, 0o755);
  const fakeClaude = path.join(fakeBin, "claude");
  await writeFile(fakeClaude, "#!/usr/bin/env sh\necho 'claude 0.0.0-test'\n", "utf8");
  await chmod(fakeClaude, 0o755);
  await writeFile(path.join(fakeCodexHome, "auth.json"), "{\"ok\":true}\n", "utf8");
  process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ""}`;
  process.env.CODEX_HOME = fakeCodexHome;
  delete process.env.OPENAI_API_KEY;
  process.env.LARKWAY_BOTS_DIR = botsDir;
});

afterEach(async () => {
  delete process.env.LARKWAY_BOTS_DIR;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  if (originalAnthropicAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
  else process.env.ANTHROPIC_AUTH_TOKEN = originalAnthropicAuthToken;
  await rm(root, { recursive: true, force: true });
});

function makeCtx(captureJson: unknown[] = []): CliContext {
  return {
    paths: {
      larkwayDir,
      botsDir,
      configJsonPath: path.join(larkwayDir, "config.json"),
      envPath,
    },
    ui: {
      ...uiReal,
      print: () => {},
      success: () => {},
      failure: () => {},
      warning: () => {},
      step: () => {},
      emitJson: (obj: unknown) => {
        captureJson.push(obj);
      },
    },
    botsStore: botsStoreReal,
    hostConfig: {
      ...hostConfigReal,
      resolveLarkwayHome: () => larkwayDir,
      resolveEnvPath: () => envPath,
      readSecret: async (name: string) => {
        const raw = await readFile(envPath, "utf8").catch(() => "");
        for (const line of raw.split("\n")) {
          const [key, ...rest] = line.split("=");
          if (key === name) return rest.join("=");
        }
        return null;
      },
    },
    centralStore: centralStoreReal,
    flags: { json: true, nonInteractive: true, advanced: false },
    cwd: path.join(root, "source-checkout"),
  };
}

async function writeDogfoodFixture(opts: {
  botId?: string;
  repoSlug?: string;
  backend?: string;
  leakSecret?: boolean;
  permissionText?: string;
  grantedText?: string;
  omitAppSecret?: boolean;
  omitGitlabToken?: boolean;
} = {}): Promise<void> {
  const botId = opts.botId ?? "larkway-devops";
  const repoSlug = opts.repoSlug ?? "chuckwu0/larkway";
  await writeFile(
    path.join(botsDir, `${botId}.yaml`),
    [
      `id: ${botId}`,
      "name: Larkway DevOps",
      "description: Develop and operate Larkway through Feishu",
      "app_id: cli_test",
      "app_secret_env: LARKWAY_DEVOPS_APP_SECRET",
      "bot_open_id: ou_devops",
      "chats: [oc_test]",
      "runtime: agent_workspace",
      `backend: ${opts.backend ?? "codex"}`,
      "gitlab_token_env: LARKWAY_DEVOPS_GITLAB_TOKEN",
      "repos:",
      `  - slug: ${repoSlug}`,
      "    branch: main",
      "    url: https://gitlab.example.com/chuckwu0/larkway.git",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    envPath,
    [
      ...(opts.omitAppSecret ? [] : ["LARKWAY_DEVOPS_APP_SECRET=app-secret-value"]),
      ...(opts.omitGitlabToken ? [] : ["LARKWAY_DEVOPS_GITLAB_TOKEN=glpat-secret-value"]),
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(envPath, 0o600);

  const workspace = path.join(larkwayDir, "agents", botId, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "AGENTS.md"), "Develop and operate Larkway\n", "utf8");
  await writeFile(
    path.join(workspace, "permissions-request.md"),
    opts.permissionText ??
      (opts.leakSecret
        ? "GitLab env LARKWAY_DEVOPS_GITLAB_TOKEN glpat-secret-value\n"
        : [
            "- type=read GitLab read chuckwu0/larkway",
            "- type=write GitLab write/MR env=LARKWAY_DEVOPS_GITLAB_TOKEN",
            "- type=write Local shell tests",
            "- type=deploy deploy/restart gate=human-confirmation",
            "- type=external-message external message to Feishu gate=human-confirmation",
            "- type=production-impact production-impact operations gate=human-confirmation",
            "",
          ].join("\n")),
    "utf8",
  );
  await writeFile(
    path.join(workspace, "permissions-granted.md"),
    opts.grantedText ??
      [
        "- type=read Feishu chat allowlist: oc_test confirmed by host",
        "- type=read GitLab read chuckwu0/larkway confirmed by host",
        "- type=write GitLab write/MR env=LARKWAY_DEVOPS_GITLAB_TOKEN confirmed by host",
        "- type=write Local shell tests confirmed by host",
        "- type=external-message Feishu test group replies; production external-message remains gated by explicit per-action confirmation",
        "- type=deploy deploy/restart remains gated by explicit per-action confirmation",
        "- type=production-impact production-impact operations remain gated by explicit per-action confirmation",
        "",
      ].join("\n"),
    "utf8",
  );
}

describe("dogfood preflight", () => {
  it("guide prints the normal creation path and exits 0 when larkway-devops is missing", async () => {
    const json: unknown[] = [];
    const code = await run(makeCtx(json), ["guide"]);
    expect(code).toBe(0);
    const payload = json[0] as {
      ok: boolean;
      preflightOk: boolean;
      commands: { create: string; grantPermissions: string; preflight: string };
      nextSteps: string[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.preflightOk).toBe(false);
    expect(payload.commands.create).toContain("larkway init");
    expect(payload.commands.create).toContain("--bot-id=larkway-devops");
    expect(payload.commands.create).toContain("--gitlab-token-env=LARKWAY_DEVOPS_GITLAB_TOKEN");
    expect(payload.commands.create.indexOf("--task-description")).toBeLessThan(
      payload.commands.create.indexOf("--bot-id"),
    );
    expect(payload.commands.grantPermissions).toContain("larkway perms larkway-devops");
    expect(payload.commands.preflight).toBe("larkway dogfood preflight larkway-devops");
    expect(payload.nextSteps.join("\n")).toContain("正常创建/绑定流程");
  });

  it("guide returns start/send/verify next steps when preflight is ready", async () => {
    await writeDogfoodFixture();
    const json: unknown[] = [];
    const code = await run(makeCtx(json), ["guide"]);
    expect(code).toBe(0);
    const payload = json[0] as {
      preflightOk: boolean;
      commands: {
        localAcceptance: string;
        startBridge: string;
        readiness: string;
        bridgeReady: string;
        userReady: string;
        sendE2E: string;
        replyE2E: string;
        verifyE2E: string;
      };
      nextSteps: string[];
    };
    expect(payload.preflightOk).toBe(true);
    expect(payload.commands.localAcceptance).toBe("pnpm test:v0.3");
    expect(payload.commands.startBridge).toBe("larkway start");
    expect(payload.commands.readiness).toBe("./bin/v0.3-dogfood-e2e.sh readiness");
    expect(payload.commands.bridgeReady).toBe("./bin/v0.3-dogfood-e2e.sh bridge-ready --wait 120");
    expect(payload.commands.userReady).toBe("./bin/v0.3-dogfood-e2e.sh user-ready");
    expect(payload.commands.sendE2E).toContain("./bin/v0.3-dogfood-e2e.sh send");
    expect(payload.commands.sendE2E).toContain("git remote -v");
    expect(payload.commands.sendE2E).toContain("git status");
    expect(payload.commands.sendE2E).toContain("docs/v0.3-dogfood-proof.md");
    expect(payload.commands.sendE2E).toContain("thread_id");
    expect(payload.commands.sendE2E).toContain("pnpm typecheck");
    expect(payload.commands.sendE2E).toContain("验证命令");
    expect(payload.commands.sendE2E).toContain("README");
    expect(payload.commands.sendE2E).toContain("AGENTS.md");
    expect(payload.commands.replyE2E).toContain("./bin/v0.3-dogfood-e2e.sh reply <thread_id>");
    expect(payload.commands.replyE2E).toContain("同一 topic continuation");
    expect(payload.commands.verifyE2E).toBe("./bin/v0.3-dogfood-e2e.sh verify <thread_id> 2");
    expect(payload.nextSteps).toContain(payload.commands.localAcceptance);
    expect(payload.nextSteps).toContain("larkway start");
    expect(payload.nextSteps).toContain(payload.commands.readiness);
    expect(payload.nextSteps).toContain(payload.commands.bridgeReady);
    expect(payload.nextSteps).toContain(payload.commands.userReady);
    expect(payload.nextSteps).toContain(payload.commands.replyE2E);
    expect(payload.nextSteps).toContain(payload.commands.verifyE2E);
    expect(payload.nextSteps.indexOf(payload.commands.readiness)).toBeLessThan(
      payload.nextSteps.indexOf(payload.commands.bridgeReady),
    );
    expect(payload.nextSteps.indexOf(payload.commands.bridgeReady)).toBeLessThan(
      payload.nextSteps.indexOf(payload.commands.userReady),
    );
    expect(payload.nextSteps.indexOf(payload.commands.userReady)).toBeLessThan(
      payload.nextSteps.indexOf(payload.commands.sendE2E),
    );
  });

  it("explains the normal creation path when larkway-devops is missing", async () => {
    const json: unknown[] = [];
    const code = await run(makeCtx(json), ["preflight"]);
    expect(code).toBe(2);
    const payload = json[0] as { checks: Array<{ id: string; message?: string }> };
    expect(payload.checks[0]).toMatchObject({ id: "bot-config" });
    expect(payload.checks[0]?.message).toContain("larkway init");
    expect(payload.checks[0]?.message).toContain("larkway bot add");
    expect(payload.checks[0]?.message).toContain("larkway-devops");
  });

  it("passes for a valid larkway-devops workspace", async () => {
    await writeDogfoodFixture();
    const json: unknown[] = [];
    const code = await run(makeCtx(json), ["preflight"]);
    expect(code).toBe(0);
    expect(json).toHaveLength(1);
    expect(json[0]).toMatchObject({ ok: true, botId: "larkway-devops", exitCode: 0 });
  });

  it("smokes Claude backend health for non-default agent_workspace bots", async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "claude-auth-token-present";
    await writeDogfoodFixture({ botId: "claude-devops", backend: "claude" });
    const json: unknown[] = [];
    const code = await run(makeCtx(json), ["preflight", "claude-devops"]);
    expect(code).toBe(0);
    const payload = json[0] as { checks: Array<{ id: string; status: string; message?: string }> };
    expect(payload.checks).toContainEqual(
      expect.objectContaining({ id: "claude-binary", status: "ok" }),
    );
    expect(payload.checks).toContainEqual(
      expect.objectContaining({ id: "claude-login", status: "ok" }),
    );
  });

  it("fails if larkway-devops is not codex-backed", async () => {
    await writeDogfoodFixture({ backend: "claude" });
    const json: unknown[] = [];
    const code = await run(makeCtx(json), ["preflight"]);
    expect(code).toBe(2);
    const payload = json[0] as { checks: Array<{ id: string; status: string; message?: string }> };
    expect(payload.checks).toContainEqual(
      expect.objectContaining({ id: "backend", status: "error", message: "claude" }),
    );
  });

  it("fails if codex CLI is missing for larkway-devops", async () => {
    await writeDogfoodFixture();
    process.env.PATH = "";
    const json: unknown[] = [];
    const code = await run(makeCtx(json), ["preflight"]);
    expect(code).toBe(2);
    const payload = json[0] as { checks: Array<{ id: string; status: string }> };
    expect(payload.checks).toContainEqual(
      expect.objectContaining({ id: "codex-binary", status: "error" }),
    );
  });

  it("fails if codex CLI is not logged in for larkway-devops", async () => {
    await writeDogfoodFixture();
    process.env.CODEX_HOME = path.join(root, "missing-codex-home");
    process.env.OPENAI_API_KEY = "sk-should-not-count";
    const json: unknown[] = [];
    const code = await run(makeCtx(json), ["preflight"]);
    expect(code).toBe(2);
    const payload = json[0] as { checks: Array<{ id: string; status: string; message?: string }> };
    expect(payload.checks).toContainEqual(
      expect.objectContaining({ id: "codex-login", status: "error" }),
    );
    expect(payload.checks.find((check) => check.id === "codex-login")?.message).toContain(
      "OPENAI_API_KEY 不作为 dogfood 登录态",
    );
  });

  it("fails when larkway-devops does not point at chuckwu0/larkway", async () => {
    await writeDogfoodFixture({ repoSlug: "chuckwu0/other" });
    const json: unknown[] = [];
    const code = await run(makeCtx(json), ["preflight"]);
    expect(code).toBe(2);
    const payload = json[0] as { checks: Array<{ id: string; status: string }> };
    expect(payload.checks).toContainEqual(
      expect.objectContaining({ id: "larkway-repo-pointer", status: "error" }),
    );
  });

  it("fails if the app secret env value is missing", async () => {
    await writeDogfoodFixture({ omitAppSecret: true });
    const json: unknown[] = [];
    const code = await run(makeCtx(json), ["preflight"]);
    expect(code).toBe(2);
    const payload = json[0] as { checks: Array<{ id: string; status: string }> };
    expect(payload.checks).toContainEqual(
      expect.objectContaining({ id: "app-secret-env", status: "error" }),
    );
  });

  it("fails if the larkway-devops GitLab token env value is missing", async () => {
    await writeDogfoodFixture({ omitGitlabToken: true });
    const json: unknown[] = [];
    const code = await run(makeCtx(json), ["preflight"]);
    expect(code).toBe(2);
    const payload = json[0] as { checks: Array<{ id: string; status: string }> };
    expect(payload.checks).toContainEqual(
      expect.objectContaining({ id: "gitlab-token-env", status: "error" }),
    );
  });

  it("fails if larkway-devops permissions are not classified into required categories", async () => {
    await writeDogfoodFixture({
      permissionText: "GitLab env LARKWAY_DEVOPS_GITLAB_TOKEN\n",
    });
    const json: unknown[] = [];
    const code = await run(makeCtx(json), ["preflight"]);
    expect(code).toBe(2);
    const payload = json[0] as { checks: Array<{ id: string; status: string; message?: string }> };
    expect(payload.checks).toContainEqual(
      expect.objectContaining({ id: "permission-categories", status: "error" }),
    );
    expect(
      payload.checks.find((check) => check.id === "permission-categories")?.message,
    ).toContain("type=read");
  });

  it("warns if larkway-devops permission audit notes are still placeholders", async () => {
    await writeDogfoodFixture({
      grantedText: "No permissions have been granted yet.\n",
    });
    const json: unknown[] = [];
    const code = await run(makeCtx(json), ["preflight"]);
    expect(code).toBe(1);
    const payload = json[0] as { checks: Array<{ id: string; status: string; message?: string }> };
    expect(payload.checks).toContainEqual(
      expect.objectContaining({ id: "permissions-granted", status: "warn" }),
    );
    expect(payload.checks.find((check) => check.id === "permissions-granted")?.message).toContain(
      "placeholder",
    );
  });

  it("warns if stale audit notes no longer cover the current bot permission surface", async () => {
    await writeDogfoodFixture({
      grantedText: [
        "- type=read Feishu chat allowlist: oc_old confirmed by host",
        "- type=read GitLab read chuckwu0/old confirmed by host",
        "- type=write GitLab write/MR env=OLD_GITLAB_TOKEN confirmed by host",
        "- type=deploy deploy/restart gate=explicit-human-confirmation confirmed by host",
        "- type=external-message external message to Feishu gate=explicit-human-confirmation confirmed by host",
        "- type=production-impact production-impact operations gate=explicit-human-confirmation confirmed by host",
        "",
      ].join("\n"),
    });
    const json: unknown[] = [];
    const code = await run(makeCtx(json), ["preflight"]);
    expect(code).toBe(1);
    const payload = json[0] as { checks: Array<{ id: string; status: string; message?: string }> };
    expect(payload.checks).toContainEqual(
      expect.objectContaining({ id: "permissions-current-surface", status: "warn" }),
    );
    const message = payload.checks.find((check) => check.id === "permissions-current-surface")?.message;
    expect(message).toContain("chuckwu0/larkway");
    expect(message).toContain("LARKWAY_DEVOPS_GITLAB_TOKEN");
    expect(message).toContain("oc_test");
  });

  it("warns if high-risk larkway-devops permissions do not keep explicit audit gates", async () => {
    await writeDogfoodFixture({
      grantedText: [
        "- type=read Feishu chat allowlist: oc_test confirmed by host",
        "- type=read GitLab read chuckwu0/larkway confirmed by host",
        "- type=write GitLab write/MR env=LARKWAY_DEVOPS_GITLAB_TOKEN confirmed by host",
        "- type=deploy deploy/restart confirmed by host",
        "- type=external-message external message confirmed by host",
        "",
      ].join("\n"),
    });
    const json: unknown[] = [];
    const code = await run(makeCtx(json), ["preflight"]);
    expect(code).toBe(1);
    const payload = json[0] as { checks: Array<{ id: string; status: string; message?: string }> };
    expect(payload.checks).toContainEqual(
      expect.objectContaining({ id: "high-risk-human-gates", status: "warn" }),
    );
    expect(
      payload.checks.find((check) => check.id === "high-risk-human-gates")?.message,
    ).toContain("production-impact");
  });

  it("fails if workspace artifacts leak secret values", async () => {
    await writeDogfoodFixture({ leakSecret: true });
    const json: unknown[] = [];
    const code = await run(makeCtx(json), ["preflight"]);
    expect(code).toBe(2);
    const payload = json[0] as { checks: Array<{ id: string; status: string }> };
    expect(payload.checks).toContainEqual(
      expect.objectContaining({ id: "secret-scan", status: "error" }),
    );
  });
});
