/**
 * src/bridge/memoryVisibility.ts — 批G G6: 记忆变更机械可见(原则 4).
 *
 * 「agent 说没说不重要,文件变没变 bridge 直接看得见。」turn 前快照 workspace
 * 内记忆类文件的 mtime,finalize 时 diff — 变了的文件名机械渲染进终态卡尾;
 * 申报字段只是可选注释,不是防线。防护面(诚实声明):常规写入路径必现;
 * 蓄意 backdate(touch -t / cp -p)可绕过 mtime 判断——若需对抗该级别,
 * 升级为内容哈希(watch 集很小,代价可控),预留为后续加固项。同 bot 并发
 * turn 共享一个 workspace,卡尾措辞因此说「本轮期间」而非「本轮所改」。
 *
 * 与 agent/mtimeFacts.ts 的分工:mtimeFacts 面向 PROMPT(告诉 agent「有东西
 * 变了去重读」,带 G8 分层降噪);本模块面向 OWNER 的卡片(报告「这一轮改了
 * 什么」,turn 边界内的一次性 diff,无跨 turn 状态)。两者都是纯 stat。
 *
 * 知识库(git repo)的可见性走更强的主路 — commit diffstat(见 handler 的
 * finalize:commitKnowledgeIfDirty 返回的 diffstat 直接进卡尾),不在这里。
 */

import fs from "node:fs/promises";
import path from "node:path";

/** Fixed watch: AGENTS.md + everything under memory/*.md (one level). */
async function listWatchedFiles(workspacePath: string): Promise<string[]> {
  const names: string[] = ["AGENTS.md"];
  try {
    for (const entry of await fs.readdir(path.join(workspacePath, "memory"), {
      withFileTypes: true,
    })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        names.push(path.join("memory", entry.name));
      }
    }
  } catch {
    /* no memory dir */
  }
  return names;
}

export type MemoryMtimeSnapshot = Map<string, number>;

/** Snapshot watched files' mtimes at turn start. Never throws. */
export async function snapshotMemoryMtimes(workspacePath: string): Promise<MemoryMtimeSnapshot> {
  const snapshot: MemoryMtimeSnapshot = new Map();
  for (const rel of await listWatchedFiles(workspacePath)) {
    try {
      snapshot.set(rel, (await fs.stat(path.join(workspacePath, rel))).mtimeMs);
    } catch {
      /* absent at start — creation during the turn will show up in the diff */
    }
  }
  return snapshot;
}

/**
 * Files whose mtime advanced (or that appeared) since the snapshot, as
 * workspace-relative names for the card line. Never throws.
 */
export async function diffMemoryMtimes(
  workspacePath: string,
  before: MemoryMtimeSnapshot,
): Promise<string[]> {
  const changed: string[] = [];
  for (const rel of await listWatchedFiles(workspacePath)) {
    let mtime: number;
    try {
      mtime = (await fs.stat(path.join(workspacePath, rel))).mtimeMs;
    } catch {
      continue; // deleted mid-turn — deletion of watched files is not reported (rare, G0-era cleanup noise)
    }
    const prev = before.get(rel);
    if (prev === undefined || mtime > prev) changed.push(rel);
  }
  return changed;
}

/** Cap on diffstat lines carried into the card tail (files… + summary line). */
export const KNOWLEDGE_DIFFSTAT_MAX_LINES = 4;

/**
 * Render the mechanical card-tail lines. Pure — the single composition point
 * all three final-render surfaces share (they all consume the same
 * baseCardPayload.finalText).
 */
export function renderMemoryVisibilityTail(input: {
  changedWorkspaceFiles: string[];
  knowledgeDiffstat?: string;
  /** state.json 可选自述(仅注释;机械行不依赖它)。 */
  agentDeclared?: string[];
}): string[] {
  const lines: string[] = [];
  if (input.changedWorkspaceFiles.length > 0) {
    // 「本轮期间」not「本轮修改」— 同 bot 并发 turn 共享 workspace,mtime
    // diff 只能证明变更发生在本轮时间窗内,不能证明是本轮所为。
    lines.push(`📝 本轮期间变更了 ${input.changedWorkspaceFiles.join("、")}`);
  }
  if (input.knowledgeDiffstat && input.knowledgeDiffstat.trim() !== "") {
    const statLines = input.knowledgeDiffstat.trim().split("\n");
    const shown =
      statLines.length > KNOWLEDGE_DIFFSTAT_MAX_LINES
        ? [
            ...statLines.slice(0, KNOWLEDGE_DIFFSTAT_MAX_LINES - 1),
            statLines[statLines.length - 1]!, // git's "N files changed…" summary line
          ]
        : statLines;
    lines.push("📚 组织知识库变更(已自动 commit):");
    for (const statLine of shown) lines.push(`  ${statLine.trim()}`);
  }
  if (lines.length > 0 && input.agentDeclared && input.agentDeclared.length > 0) {
    for (const note of input.agentDeclared.slice(0, 3)) {
      lines.push(`  ↳ agent 自述: ${note}`);
    }
  }
  return lines;
}
