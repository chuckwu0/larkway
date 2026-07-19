import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { findOnPath, spawnCollect } from "./spawn.js";

describe("findOnPath", () => {
  it("finds an executable on PATH and returns its absolute path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lw-path-"));
    const bin = path.join(dir, "lw-fake-tool");
    await writeFile(bin, "#!/bin/sh\n", "utf-8");
    await chmod(bin, 0o755);
    expect(findOnPath("lw-fake-tool", { PATH: dir })).toBe(bin);
  });

  it("returns null for a missing command", () => {
    expect(findOnPath("definitely-not-a-real-cmd-xyz", { PATH: "/nonexistent" })).toBeNull();
  });

  it("skips non-executable files on POSIX", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lw-path-"));
    await writeFile(path.join(dir, "lw-plain-file"), "data", "utf-8");
    expect(findOnPath("lw-plain-file", { PATH: dir })).toBeNull();
  });
});

describe("spawnCollect", () => {
  it("resolves with exitCode and output on any exit", async () => {
    const r = await spawnCollect(process.execPath, ["-e", "console.log('hi'); process.exit(3)"]);
    expect(r.exitCode).toBe(3);
    expect(r.stdout.trim()).toBe("hi");
  });

  it("rejects on spawn failure (command not found)", async () => {
    await expect(spawnCollect("/nonexistent/lw-cmd", [])).rejects.toThrow();
  });
});
