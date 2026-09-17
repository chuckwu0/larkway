import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverWorkspaceRepoDirs } from "./workspaceRepos.js";

describe("discoverWorkspaceRepoDirs", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "larkway-repo-discovery-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("returns an empty list for a not-yet-created repo directory", async () => {
    expect(await discoverWorkspaceRepoDirs(path.join(root, "missing"))).toEqual([]);
  });

  it("sorts directory paths deterministically and ignores ordinary files", async () => {
    await mkdir(path.join(root, "zeta"));
    await mkdir(path.join(root, "alpha"));
    await writeFile(path.join(root, "README.md"), "repo pointers");
    expect(await discoverWorkspaceRepoDirs(root)).toEqual([path.join(root, "alpha"), path.join(root, "zeta")]);
  });

  it("caps native discovery inputs at the first 16 sorted directories", async () => {
    const names = Array.from({ length: 18 }, (_, index) => `repo-${String(index).padStart(2, "0")}`);
    await Promise.all([...names].reverse().map((name) => mkdir(path.join(root, name))));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await discoverWorkspaceRepoDirs(root)).toEqual(names.slice(0, 16).map((name) => path.join(root, name)));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("first 16"));
  });

  it.skipIf(process.platform === "win32")("accepts directory symlinks but rejects files and dangling links", async () => {
    const repos = path.join(root, "repos");
    const target = path.join(root, "target");
    await mkdir(repos);
    await mkdir(target);
    await writeFile(path.join(root, "file"), "not a directory");
    await symlink(target, path.join(repos, "directory-link"));
    await symlink(path.join(root, "file"), path.join(repos, "file-link"));
    await symlink(path.join(root, "missing"), path.join(repos, "dangling-link"));
    expect(await discoverWorkspaceRepoDirs(repos)).toEqual([path.join(repos, "directory-link")]);
  });
});
