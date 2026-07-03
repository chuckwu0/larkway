/**
 * Tests for src/tasklist/teamRegistry.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readTeamTasklistGuid, claimTeamTasklistGuid, overwriteTeamTasklistGuid } from "./teamRegistry.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "larkway-teamregistry-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function registryPath(): string {
  return path.join(tmpDir, "task-team.json");
}

describe("readTeamTasklistGuid", () => {
  it("returns undefined when the file does not exist", async () => {
    await expect(readTeamTasklistGuid(registryPath())).resolves.toBeUndefined();
  });

  it("returns undefined on malformed JSON (never throws)", async () => {
    await writeFile(registryPath(), "{not json", "utf8");
    await expect(readTeamTasklistGuid(registryPath())).resolves.toBeUndefined();
  });

  it("returns undefined when tasklistGuid is missing or not a string", async () => {
    await writeFile(registryPath(), JSON.stringify({ version: 1 }), "utf8");
    await expect(readTeamTasklistGuid(registryPath())).resolves.toBeUndefined();

    await writeFile(registryPath(), JSON.stringify({ version: 1, tasklistGuid: 42 }), "utf8");
    await expect(readTeamTasklistGuid(registryPath())).resolves.toBeUndefined();
  });

  it("returns the guid when present", async () => {
    await writeFile(registryPath(), JSON.stringify({ version: 1, tasklistGuid: "tl-1" }), "utf8");
    await expect(readTeamTasklistGuid(registryPath())).resolves.toBe("tl-1");
  });
});

describe("claimTeamTasklistGuid", () => {
  it("writes the guid when the registry is empty and returns it", async () => {
    const result = await claimTeamTasklistGuid(registryPath(), "tl-new");
    expect(result).toBe("tl-new");
    await expect(readTeamTasklistGuid(registryPath())).resolves.toBe("tl-new");
  });

  it("creates parent directories as needed", async () => {
    const nested = path.join(tmpDir, "nested", "dir", "task-team.json");
    const result = await claimTeamTasklistGuid(nested, "tl-1");
    expect(result).toBe("tl-1");
    await expect(readTeamTasklistGuid(nested)).resolves.toBe("tl-1");
  });

  it("first-writer-wins: does NOT clobber an existing guid, returns the existing one instead", async () => {
    await claimTeamTasklistGuid(registryPath(), "tl-first");
    const result = await claimTeamTasklistGuid(registryPath(), "tl-second");
    expect(result).toBe("tl-first"); // the caller's own guid lost the race
    await expect(readTeamTasklistGuid(registryPath())).resolves.toBe("tl-first");
  });

  it("degrades to returning the passed-in guid (never throws) when the write fails", async () => {
    // Make the parent directory unwritable so mkdir/rename fails.
    const blockedDir = path.join(tmpDir, "blocked");
    await writeFile(blockedDir, "i am a file, not a directory", "utf8");
    const blockedPath = path.join(blockedDir, "task-team.json");
    await expect(claimTeamTasklistGuid(blockedPath, "tl-x")).resolves.toBe("tl-x");
    // No crash, and nothing readable back (write never landed).
    await expect(readTeamTasklistGuid(blockedPath)).resolves.toBeUndefined();
  });
});

describe("overwriteTeamTasklistGuid", () => {
  it("writes the guid when the registry is empty", async () => {
    await overwriteTeamTasklistGuid(registryPath(), "tl-new");
    await expect(readTeamTasklistGuid(registryPath())).resolves.toBe("tl-new");
  });

  it("UNLIKE claimTeamTasklistGuid, clobbers an existing guid (the whole point of --force)", async () => {
    await claimTeamTasklistGuid(registryPath(), "tl-first");
    await overwriteTeamTasklistGuid(registryPath(), "tl-second");
    await expect(readTeamTasklistGuid(registryPath())).resolves.toBe("tl-second");
  });

  it("creates parent directories as needed", async () => {
    const nested = path.join(tmpDir, "nested", "dir", "task-team.json");
    await overwriteTeamTasklistGuid(nested, "tl-1");
    await expect(readTeamTasklistGuid(nested)).resolves.toBe("tl-1");
  });

  it("never throws when the write fails (best-effort, same as claimTeamTasklistGuid)", async () => {
    const blockedDir = path.join(tmpDir, "blocked-overwrite");
    await writeFile(blockedDir, "i am a file, not a directory", "utf8");
    const blockedPath = path.join(blockedDir, "task-team.json");
    await expect(overwriteTeamTasklistGuid(blockedPath, "tl-x")).resolves.toBeUndefined();
    await expect(readTeamTasklistGuid(blockedPath)).resolves.toBeUndefined();
  });
});
