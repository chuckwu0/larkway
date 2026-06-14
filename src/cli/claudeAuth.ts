/**
 * src/cli/claudeAuth.ts
 *
 * 检测 Claude Code 是否已登录(订阅态 / 已配置鉴权),**不读取也不注入任何 secret 真值**(铁律5)。
 *
 * 跨平台有三种凭据后端,任一存在即视为已登录:
 *   1. ~/.claude/.credentials.json —— Linux / 旧版安装。
 *   2. ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY env —— proxy 模式(服务器)。
 *   3. macOS Keychain "Claude Safe Storage" —— Claude Code 在 macOS 的默认存储。
 *      用 `security find-generic-password -s` 仅查条目存在性(不带 -w/-g,不解密 secret,
 *      不会弹 Keychain 授权框)。
 *
 * 背景:Claude Code 在 macOS 默认把凭据放 Keychain 而非 .credentials.json,只查文件会在
 * **每台 Mac 上误判"未登录"**,而本地部署主力人群正是 Mac 工程师。见 onboarding 流程修复。
 */

import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Claude Code 凭据文件路径(Linux / 旧版)。
 * **每次调用时算** —— 不能固化成模块级 const,否则会在 import 时固定 homedir(),
 * 让依赖 HOME override 的单测(及任何运行时 HOME 变化)失效。
 */
export function claudeCredentialsPath(): string {
  return path.join(homedir(), ".claude", ".credentials.json");
}

/**
 * 检测 Claude Code 是否已登录。任一后端命中即返回 true。
 * 纯只读探测,不会修改环境、不解密 secret、不弹窗。
 */
export async function detectClaudeLogin(): Promise<boolean> {
  // 1. credentials 文件(Linux / 旧版)。路径调用时算,尊重 HOME。
  try {
    await access(claudeCredentialsPath());
    return true;
  } catch {
    /* 继续探测其它后端 */
  }

  // 2. proxy env(服务器走 ANTHROPIC_AUTH_TOKEN)。只读检测存在性,非注入。
  if (process.env["ANTHROPIC_AUTH_TOKEN"] || process.env["ANTHROPIC_API_KEY"]) {
    return true;
  }

  // 3. macOS Keychain(Claude Code 在 macOS 的默认)。-s 仅查存在,不解密、不弹窗。
  if (process.platform === "darwin") {
    try {
      await execFileAsync("security", ["find-generic-password", "-s", "Claude Safe Storage"]);
      return true;
    } catch {
      /* Keychain 无该条目 */
    }
  }

  return false;
}

/** 已登录时人类可读的「凭据来源」描述,用于体检输出。 */
export function claudeLoginHint(): string {
  return "未检测到 Claude 登录态。请先运行 `claude` 登录(macOS 存 Keychain / Linux 存 ~/.claude/.credentials.json / 服务器走 ANTHROPIC_AUTH_TOKEN)。larkway 用本地订阅态,不注入 API key(铁律5)。";
}
