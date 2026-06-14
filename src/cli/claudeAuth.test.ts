/**
 * src/cli/claudeAuth.test.ts
 *
 * detectClaudeLogin 多后端检测。用 HOME override 隔离凭据文件;HOME 指向临时目录时
 * macOS `security` 探测自然失败(临时树无 login keychain),故测试里 keychain 后端 no-op,
 * 检测结果由「文件 / env token」确定,确定性可控。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectClaudeLogin, claudeCredentialsPath } from "./claudeAuth.js";

let tmpDir: string;
let origHome: string | undefined;
let origAuthToken: string | undefined;
let origApiKey: string | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "larkway-claudeauth-test-"));
  origHome = process.env["HOME"];
  origAuthToken = process.env["ANTHROPIC_AUTH_TOKEN"];
  origApiKey = process.env["ANTHROPIC_API_KEY"];
  process.env["HOME"] = tmpDir;
  delete process.env["ANTHROPIC_AUTH_TOKEN"];
  delete process.env["ANTHROPIC_API_KEY"];
});

afterEach(async () => {
  if (origHome !== undefined) process.env["HOME"] = origHome;
  else delete process.env["HOME"];
  if (origAuthToken !== undefined) process.env["ANTHROPIC_AUTH_TOKEN"] = origAuthToken;
  else delete process.env["ANTHROPIC_AUTH_TOKEN"];
  if (origApiKey !== undefined) process.env["ANTHROPIC_API_KEY"] = origApiKey;
  else delete process.env["ANTHROPIC_API_KEY"];
  await rm(tmpDir, { recursive: true, force: true });
});

describe("detectClaudeLogin", () => {
  it("claudeCredentialsPath() 跟随 HOME(调用时算,非 import 固化)", () => {
    expect(claudeCredentialsPath()).toBe(path.join(tmpDir, ".claude", ".credentials.json"));
  });

  it("凭据文件存在 → true", async () => {
    const claudeDir = path.join(tmpDir, ".claude");
    await mkdir(claudeDir, { recursive: true });
    await writeFile(path.join(claudeDir, ".credentials.json"), "{}", "utf-8");
    expect(await detectClaudeLogin()).toBe(true);
  });

  it("ANTHROPIC_AUTH_TOKEN 设置(proxy 模式)→ true", async () => {
    process.env["ANTHROPIC_AUTH_TOKEN"] = "sk-fake-token";
    expect(await detectClaudeLogin()).toBe(true);
  });

  it("无文件 / 无 env / 临时 HOME(keychain no-op)→ false", async () => {
    expect(await detectClaudeLogin()).toBe(false);
  });
});
