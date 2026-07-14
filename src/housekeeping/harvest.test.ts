/**
 * 批G G3 — GC harvest protocol tests.
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

async function makeSession(files: Record<string, string>): Promise<{ sessionPath: string; workspacePath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "larkway-harvest-"));
  const workspacePath = path.join(root, "workspace");
  const sessionPath = path.join(workspacePath, "sessions", "om_test1");
  await mkdir(sessionPath, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(sessionPath, name), content, "utf8");
  }
  return { sessionPath, workspacePath };
}

describe("harvestSessionArtifacts (批G G3)", () => {
  it("harvests agent summary + transcript tail into memory/harvest/sessions/", async () => {
    const { sessionPath, workspacePath } = await makeSession({
      "summary.md": `${PLACEHOLDER}\n## 进展\n- 官网逻辑已核验`,
      "transcript.md": "## turn 1\n用户问了转化\n### Agent Answer (completed)\n  下降2%",
    });
    const outcome = await harvestSessionArtifacts({
      sessionPath,
      workspacePath,
      threadId: "om_test1",
      dryRun: false,
    });
    expect(outcome).toBe("harvested");
    const harvested = await readFile(
      path.join(workspacePath, "memory", "harvest", "sessions", "om_test1.md"),
      "utf8",
    );
    expect(harvested).toContain("官网逻辑已核验");
    expect(harvested).toContain("下降2%");
    // The bridge placeholder is stripped from the harvested summary.
    expect(harvested).not.toContain("Bridge creates this placeholder");
    // Raw-material disclaimer for the maintenance turn.
    expect(harvested).toContain("不是已确认记忆");
  });

  it("placeholder-only summary + no transcript → nothing-to-harvest, no file", async () => {
    const { sessionPath, workspacePath } = await makeSession({
      "summary.md": PLACEHOLDER,
    });
    const outcome = await harvestSessionArtifacts({
      sessionPath,
      workspacePath,
      threadId: "om_test1",
      dryRun: false,
    });
    expect(outcome).toBe("nothing-to-harvest");
    await expect(
      readdir(path.join(workspacePath, "memory", "harvest", "sessions")),
    ).rejects.toThrow();
  });

  it("dry-run writes nothing", async () => {
    const { sessionPath, workspacePath } = await makeSession({
      "transcript.md": "some content",
    });
    const outcome = await harvestSessionArtifacts({
      sessionPath,
      workspacePath,
      threadId: "om_test1",
      dryRun: true,
    });
    expect(outcome).toBe("harvested");
    await expect(
      readdir(path.join(workspacePath, "memory", "harvest", "sessions")),
    ).rejects.toThrow();
  });

  it("long transcript keeps only the tail (code-point clip with truncation note)", async () => {
    const big = "头部旧内容-".repeat(2000) + "尾部关键结论";
    const { sessionPath, workspacePath } = await makeSession({ "transcript.md": big });
    await harvestSessionArtifacts({ sessionPath, workspacePath, threadId: "om_test1", dryRun: false });
    const harvested = await readFile(
      path.join(workspacePath, "memory", "harvest", "sessions", "om_test1.md"),
      "utf8",
    );
    expect(harvested).toContain("尾部关键结论");
    expect(harvested).toContain("前文已截断");
  });
});

describe("enforceHarvestCaps", () => {
  it("drops the OLDEST files past the count cap", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "larkway-caps-"));
    const total = HARVEST_MAX_FILES + 5;
    for (let i = 0; i < total; i++) {
      const p = path.join(dir, `s${String(i).padStart(4, "0")}.md`);
      await writeFile(p, `content ${i}`, "utf8");
      // Deterministic mtimes: older index = older file.
      const t = new Date(2026, 0, 1, 0, i);
      await utimes(p, t, t);
    }
    await enforceHarvestCaps(dir);
    const left = (await readdir(dir)).sort();
    expect(left).toHaveLength(HARVEST_MAX_FILES);
    // The 5 oldest are gone; the newest survive.
    expect(left).not.toContain("s0000.md");
    expect(left).not.toContain("s0004.md");
    expect(left).toContain(`s${String(total - 1).padStart(4, "0")}.md`);
  });
});
