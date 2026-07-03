import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, utimes, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  computeMtimeFacts,
  readMtimeBaseline,
  writeMtimeBaseline,
  MTIME_WATCH_FILE_NAMES,
} from "./mtimeFacts.js";

let root: string;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function setMtime(filePath: string, date: Date): Promise<void> {
  await utimes(filePath, date, date);
}

describe("mtimeFacts — A2 mtime-change fact computation", () => {
  it("watches permissions-request.md and permissions-granted.md (bypassPermissions revocation safety net)", () => {
    expect(MTIME_WATCH_FILE_NAMES).toContain("permissions-request.md");
    expect(MTIME_WATCH_FILE_NAMES).toContain("permissions-granted.md");
  });

  it("first-ever sighting of a file seeds the immutable baseline but emits no fact", async () => {
    root = await mkdtemp(path.join(tmpdir(), "larkway-mtime-"));
    await writeFile(path.join(root, "AGENTS.md"), "hello", "utf8");

    const { facts, baseline } = await computeMtimeFacts(root, {});
    expect(facts).toEqual([]);
    expect(baseline["AGENTS.md"]).toBeDefined();
    expect(typeof baseline["AGENTS.md"]!.mtimeMs).toBe("number");
  });

  it("unchanged mtime against an existing baseline emits no fact, and the baseline is carried through unchanged", async () => {
    root = await mkdtemp(path.join(tmpdir(), "larkway-mtime-"));
    const file = path.join(root, "AGENTS.md");
    await writeFile(file, "hello", "utf8");
    const { baseline: first } = await computeMtimeFacts(root, {});

    const { facts, baseline } = await computeMtimeFacts(root, first);
    expect(facts).toEqual([]);
    expect(baseline["AGENTS.md"]).toEqual(first["AGENTS.md"]);
  });

  it("a changed mtime emits a neutral fact every turn — no cap, no going quiet (护栏④: over-injection over lost signal)", async () => {
    root = await mkdtemp(path.join(tmpdir(), "larkway-mtime-"));
    const file = path.join(root, "AGENTS.md");
    await writeFile(file, "hello", "utf8");
    let { baseline } = await computeMtimeFacts(root, {});

    await setMtime(file, new Date(Date.now() + 60_000));

    // Ask 5 times in a row (simulating 5 turns with no further mtime change)
    // — the fact must keep firing every single time, not just for a fixed
    // number of turns.
    for (let turn = 1; turn <= 5; turn++) {
      const result = await computeMtimeFacts(root, baseline);
      expect(result.facts).toHaveLength(1);
      expect(result.facts[0]).toContain("AGENTS.md");
      expect(result.facts[0]).toContain("被修改过");
      baseline = result.baseline;
    }
  });

  it("the baseline is seeded once and NEVER rewritten afterward, even as the file keeps changing (护栏④ + minor fix)", async () => {
    root = await mkdtemp(path.join(tmpdir(), "larkway-mtime-"));
    const file = path.join(root, "AGENTS.md");
    await writeFile(file, "hello", "utf8");
    let { baseline } = await computeMtimeFacts(root, {});
    const originalBaselineMs = baseline["AGENTS.md"]!.mtimeMs;

    await setMtime(file, new Date(Date.now() + 60_000));
    let result = await computeMtimeFacts(root, baseline);
    baseline = result.baseline;
    expect(baseline["AGENTS.md"]!.mtimeMs).toBe(originalBaselineMs);

    // Change it again — baseline must still not move.
    await setMtime(file, new Date(Date.now() + 120_000));
    result = await computeMtimeFacts(root, baseline);
    baseline = result.baseline;
    expect(baseline["AGENTS.md"]!.mtimeMs).toBe(originalBaselineMs);
    expect(result.facts).toHaveLength(1); // still reports the change vs the original baseline
  });

  it("a missing watched file is skipped silently — never throws, no fact, no baseline entry", async () => {
    root = await mkdtemp(path.join(tmpdir(), "larkway-mtime-"));
    // Nothing created under root at all.
    const { facts, baseline } = await computeMtimeFacts(root, {});
    expect(facts).toEqual([]);
    expect(Object.keys(baseline)).toHaveLength(0);
  });

  it("handles nested memory/ category files", async () => {
    root = await mkdtemp(path.join(tmpdir(), "larkway-mtime-"));
    await mkdir(path.join(root, "memory"), { recursive: true });
    const file = path.join(root, "memory", "preferences.md");
    await writeFile(file, "x", "utf8");
    const { baseline: seen } = await computeMtimeFacts(root, {});

    await setMtime(file, new Date(Date.now() + 60_000));
    const { facts } = await computeMtimeFacts(root, seen);
    expect(facts.some((f) => f.includes("memory/preferences.md"))).toBe(true);
  });

  it("fact wording states only the verifiable stat fact — no unverifiable 'not yet read' claim (minor fix)", async () => {
    root = await mkdtemp(path.join(tmpdir(), "larkway-mtime-"));
    const file = path.join(root, "AGENTS.md");
    await writeFile(file, "hello", "utf8");
    const { baseline } = await computeMtimeFacts(root, {});
    await setMtime(file, new Date(Date.now() + 60_000));

    const { facts } = await computeMtimeFacts(root, baseline);
    expect(facts[0]).toMatch(/^AGENTS\.md 于 .+ 被修改过。$/);
    expect(facts[0]).not.toContain("尚未读过");
  });

  describe("baseline persistence", () => {
    it("round-trips through readMtimeBaseline/writeMtimeBaseline", async () => {
      root = await mkdtemp(path.join(tmpdir(), "larkway-mtime-"));
      const baselinePath = path.join(root, ".larkway", "mtime-baseline.json");
      const baseline = { "AGENTS.md": { mtimeMs: 12345 } };

      await writeMtimeBaseline(baselinePath, baseline);
      const readBack = await readMtimeBaseline(baselinePath);
      expect(readBack).toEqual(baseline);
    });

    it("readMtimeBaseline returns {} for a missing or corrupt file — never throws", async () => {
      root = await mkdtemp(path.join(tmpdir(), "larkway-mtime-"));
      const missingPath = path.join(root, "nope.json");
      await expect(readMtimeBaseline(missingPath)).resolves.toEqual({});

      const corruptPath = path.join(root, "corrupt.json");
      await writeFile(corruptPath, "not json{{{", "utf8");
      await expect(readMtimeBaseline(corruptPath)).resolves.toEqual({});
    });

    it("writeMtimeBaseline never throws even if the parent cannot be created (best-effort)", async () => {
      root = await mkdtemp(path.join(tmpdir(), "larkway-mtime-"));
      // Point at a path through a file (not a directory) — mkdir will fail.
      const blocker = path.join(root, "blocker");
      await writeFile(blocker, "x", "utf8");
      const badPath = path.join(blocker, "sub", "baseline.json");
      await expect(writeMtimeBaseline(badPath, {})).resolves.toBeUndefined();
    });
  });

  it("sample read confirms file contents are never inspected — only mtimes matter", async () => {
    root = await mkdtemp(path.join(tmpdir(), "larkway-mtime-"));
    const file = path.join(root, "AGENTS.md");
    await writeFile(file, "irrelevant content", "utf8");
    await computeMtimeFacts(root, {});
    // Sanity: the file is untouched by computeMtimeFacts (still readable, same content).
    expect(await readFile(file, "utf8")).toBe("irrelevant content");
  });
});
