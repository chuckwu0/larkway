/**
 * Tests for src/bridge/memoryVisibility.ts — 批G G6 mechanical memory-change
 * visibility (mtime snapshot/diff + card-tail rendering). Pure fs + pure
 * rendering — no subprocesses, no network.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  snapshotMemoryMtimes,
  diffMemoryMtimes,
  renderMemoryVisibilityTail,
  KNOWLEDGE_DIFFSTAT_MAX_LINES,
} from "./memoryVisibility.js";

let ws: string;

beforeEach(async () => {
  ws = await mkdtemp(path.join(tmpdir(), "larkway-memvis-"));
  await mkdir(path.join(ws, "memory"), { recursive: true });
  await writeFile(path.join(ws, "AGENTS.md"), "# Bot\n", "utf8");
  await writeFile(path.join(ws, "memory", "README.md"), "# readme\n", "utf8");
  await writeFile(path.join(ws, "memory", "preferences.md"), "# prefs\n", "utf8");
});

afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

/** Advance a watched file's mtime deterministically (no sleeps). */
async function bumpMtime(rel: string): Promise<void> {
  const p = path.join(ws, rel);
  const later = new Date((await stat(p)).mtimeMs + 5_000);
  await utimes(p, later, later);
}

// ---------------------------------------------------------------------------
// snapshotMemoryMtimes + diffMemoryMtimes
// ---------------------------------------------------------------------------

describe("snapshotMemoryMtimes + diffMemoryMtimes (批G G6)", () => {
  it("no writes between snapshot and diff → empty", async () => {
    const snap = await snapshotMemoryMtimes(ws);
    expect(await diffMemoryMtimes(ws, snap)).toEqual([]);
  });

  it("a memory file whose mtime advanced is reported by workspace-relative name", async () => {
    const snap = await snapshotMemoryMtimes(ws);
    await bumpMtime(path.join("memory", "preferences.md"));
    expect(await diffMemoryMtimes(ws, snap)).toEqual([path.join("memory", "preferences.md")]);
  });

  it("AGENTS.md changes are watched too", async () => {
    const snap = await snapshotMemoryMtimes(ws);
    await bumpMtime("AGENTS.md");
    expect(await diffMemoryMtimes(ws, snap)).toEqual(["AGENTS.md"]);
  });

  it("a memory file created AFTER the snapshot is reported", async () => {
    const snap = await snapshotMemoryMtimes(ws);
    await writeFile(path.join(ws, "memory", "new-note.md"), "hi", "utf8");
    expect(await diffMemoryMtimes(ws, snap)).toContain(path.join("memory", "new-note.md"));
  });

  it("only *.md files one level under memory/ are watched (non-md + subdirs ignored)", async () => {
    const snap = await snapshotMemoryMtimes(ws);
    await writeFile(path.join(ws, "memory", "note.txt"), "x", "utf8");
    await mkdir(path.join(ws, "memory", "assets"), { recursive: true });
    await writeFile(path.join(ws, "memory", "assets", "deep.md"), "x", "utf8");
    expect(await diffMemoryMtimes(ws, snap)).toEqual([]);
  });

  it("nonexistent workspace → empty snapshot and empty diff (never throws)", async () => {
    const ghost = path.join(ws, "ghost");
    const snap = await snapshotMemoryMtimes(ghost);
    expect(snap.size).toBe(0);
    expect(await diffMemoryMtimes(ghost, snap)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// renderMemoryVisibilityTail
// ---------------------------------------------------------------------------

describe("renderMemoryVisibilityTail", () => {
  it("renders the workspace-files line", () => {
    const lines = renderMemoryVisibilityTail({
      changedWorkspaceFiles: ["AGENTS.md", "memory/preferences.md"],
    });
    expect(lines).toEqual(["📝 本轮修改了 AGENTS.md、memory/preferences.md"]);
  });

  it("clips a long knowledge diffstat to the max lines, keeping git's summary line", () => {
    const diffstat = [
      " topics/a.md | 2 ++",
      " topics/b.md | 2 ++",
      " topics/c.md | 2 ++",
      " topics/d.md | 2 ++",
      " topics/e.md | 2 ++",
      " 5 files changed, 10 insertions(+)",
    ].join("\n");
    const lines = renderMemoryVisibilityTail({ changedWorkspaceFiles: [], knowledgeDiffstat: diffstat });
    expect(lines[0]).toContain("组织知识库变更");
    const statLines = lines.slice(1);
    expect(statLines).toHaveLength(KNOWLEDGE_DIFFSTAT_MAX_LINES);
    // The last shown line is git's "N files changed…" summary, not a dropped middle line.
    expect(statLines[statLines.length - 1]).toContain("5 files changed");
    expect(lines.join("\n")).not.toContain("topics/d.md");
    expect(lines.join("\n")).not.toContain("topics/e.md");
  });

  it("a short diffstat is carried whole", () => {
    const lines = renderMemoryVisibilityTail({
      changedWorkspaceFiles: [],
      knowledgeDiffstat: " topics/a.md | 2 ++\n 1 file changed, 2 insertions(+)",
    });
    expect(lines).toHaveLength(3); // header + 2 stat lines
    expect(lines.join("\n")).toContain("topics/a.md");
    expect(lines.join("\n")).toContain("1 file changed");
  });

  it("agentDeclared notes render ONLY when a mechanical line exists (alone → [])", () => {
    // Declarations are annotations, not a defense line — with no mechanical
    // evidence they must render nothing.
    expect(
      renderMemoryVisibilityTail({ changedWorkspaceFiles: [], agentDeclared: ["我更新了记忆"] }),
    ).toEqual([]);

    const withMechanical = renderMemoryVisibilityTail({
      changedWorkspaceFiles: ["memory/preferences.md"],
      agentDeclared: ["更新了偏好", "note-2", "note-3", "note-4"],
    });
    expect(withMechanical[0]).toContain("📝 本轮修改了");
    const notes = withMechanical.filter((l) => l.includes("agent 自述"));
    expect(notes).toHaveLength(3); // capped at 3
    expect(notes[0]).toContain("更新了偏好");
    expect(withMechanical.join("\n")).not.toContain("note-4");
  });

  it("nothing changed and nothing declared → empty", () => {
    expect(renderMemoryVisibilityTail({ changedWorkspaceFiles: [] })).toEqual([]);
  });
});
