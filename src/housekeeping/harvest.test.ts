/**
 * 批G G3 — GC harvest protocol tests (P1 R1: destination = org knowledge repo).
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  harvestSessionArtifacts,
  enforceHarvestCaps,
  HARVEST_MAX_FILES,
} from "./harvest.js";

const PLACEHOLDER = [
  "# Session Summary",
  "",
  "Bridge creates this placeholder only.",
  "The Agent owns any task summary, decisions, and next-step notes for this Feishu topic.",
  "",
].join("\n");

async function makeSession(files: Record<string, string>): Promise<{
  sessionPath: string;
  knowledgeDir: string;
  harvestPath: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "larkway-harvest-"));
  const sessionPath = path.join(root, "workspace", "sessions", "om_test1");
  const knowledgeDir = path.join(root, "knowledge");
  await mkdir(sessionPath, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(sessionPath, name), content, "utf8");
  }
  return {
    sessionPath,
    knowledgeDir,
    harvestPath: path.join(knowledgeDir, "raw", "sessions", "elon", "om_test1.md"),
  };
}

describe("harvestSessionArtifacts (批G G3)", () => {
  it("harvests agent summary + transcript tail into knowledge raw/sessions/<agent>/", async () => {
    const { sessionPath, knowledgeDir, harvestPath } = await makeSession({
      "summary.md": `${PLACEHOLDER}\n## 进展\n- 官网逻辑已核验`,
      "transcript.md": "## turn 1\n用户问了转化\n### Agent Answer (completed)\n  下降2%",
    });
    const outcome = await harvestSessionArtifacts({
      sessionPath,
      knowledgeDir,
      agentId: "elon",
      threadId: "om_test1",
      dryRun: false,
    });
    expect(outcome).toBe("harvested");
    const harvested = await readFile(harvestPath, "utf8");
    expect(harvested).toContain("官网逻辑已核验");
    expect(harvested).toContain("下降2%");
    // The bridge placeholder is stripped from the harvested summary.
    expect(harvested).not.toContain("Bridge creates this placeholder");
    // Raw-material disclaimer for the maintenance turn.
    expect(harvested).toContain("不是已确认记忆");
    // Namespaced header: agent/key.
    expect(harvested).toContain("elon/om_test1");
  });

  it("placeholder-only summary + no transcript → nothing-to-harvest, no file", async () => {
    const { sessionPath, knowledgeDir } = await makeSession({
      "summary.md": PLACEHOLDER,
    });
    const outcome = await harvestSessionArtifacts({
      sessionPath,
      knowledgeDir,
      agentId: "elon",
      threadId: "om_test1",
      dryRun: false,
    });
    expect(outcome).toBe("nothing-to-harvest");
    await expect(readdir(path.join(knowledgeDir, "raw", "sessions"))).rejects.toThrow();
  });

  it("dry-run writes nothing", async () => {
    const { sessionPath, knowledgeDir } = await makeSession({
      "transcript.md": "some content",
    });
    const outcome = await harvestSessionArtifacts({
      sessionPath,
      knowledgeDir,
      agentId: "elon",
      threadId: "om_test1",
      dryRun: true,
    });
    expect(outcome).toBe("harvested");
    await expect(readdir(path.join(knowledgeDir, "raw", "sessions"))).rejects.toThrow();
  });

  it("appends to an existing harvest (revive-then-re-GC keeps the earlier extract)", async () => {
    const { sessionPath, knowledgeDir, harvestPath } = await makeSession({
      "transcript.md": "第一代富内容结论",
    });
    await harvestSessionArtifacts({
      sessionPath,
      knowledgeDir,
      agentId: "elon",
      threadId: "om_test1",
      dryRun: false,
    });
    await writeFile(path.join(sessionPath, "transcript.md"), "复活后的薄内容", "utf8");
    await harvestSessionArtifacts({
      sessionPath,
      knowledgeDir,
      agentId: "elon",
      threadId: "om_test1",
      dryRun: false,
    });
    const harvested = await readFile(harvestPath, "utf8");
    expect(harvested).toContain("第一代富内容结论");
    expect(harvested).toContain("复活后的薄内容");
  });

  it("rejects unsafe agentId/threadId path segments", async () => {
    const { sessionPath, knowledgeDir } = await makeSession({
      "transcript.md": "x",
    });
    await expect(
      harvestSessionArtifacts({
        sessionPath,
        knowledgeDir,
        agentId: "../evil",
        threadId: "om_test1",
        dryRun: false,
      }),
    ).rejects.toThrow(/agentId/);
  });

  it("long transcript keeps only the tail (code-point clip with truncation note)", async () => {
    const big = "头部旧内容-".repeat(2000) + "尾部关键结论";
    const { sessionPath, knowledgeDir, harvestPath } = await makeSession({
      "transcript.md": big,
    });
    await harvestSessionArtifacts({
      sessionPath,
      knowledgeDir,
      agentId: "elon",
      threadId: "om_test1",
      dryRun: false,
    });
    const harvested = await readFile(harvestPath, "utf8");
    expect(harvested).toContain("尾部关键结论");
    expect(harvested).toContain("前文已截断");
  });
});

describe("enforceHarvestCaps", () => {
  it("drops the OLDEST files past the count cap, across agent subdirs", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "larkway-caps-"));
    // Split files across two agent subdirs to exercise the one-level walk.
    await mkdir(path.join(dir, "elon"), { recursive: true });
    await mkdir(path.join(dir, "turing"), { recursive: true });
    const total = HARVEST_MAX_FILES + 5;
    for (let i = 0; i < total; i++) {
      const sub = i % 2 === 0 ? "elon" : "turing";
      const p = path.join(dir, sub, `s${String(i).padStart(4, "0")}.md`);
      await writeFile(p, `content ${i}`, "utf8");
      // Deterministic mtimes: older index = older file.
      const t = new Date(2026, 0, 1, 0, i);
      await utimes(p, t, t);
    }
    await enforceHarvestCaps(dir);
    const left = [
      ...(await readdir(path.join(dir, "elon"))),
      ...(await readdir(path.join(dir, "turing"))),
    ].sort();
    expect(left).toHaveLength(HARVEST_MAX_FILES);
    // The 5 oldest are gone; the newest survive.
    expect(left).not.toContain("s0000.md");
    expect(left).not.toContain("s0004.md");
    expect(left).toContain(`s${String(total - 1).padStart(4, "0")}.md`);
  });
});
