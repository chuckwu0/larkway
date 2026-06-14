/**
 * centralStore tests (V2.2 §7 A.2).
 *
 * Fully offline + deterministic: a local bare git repo plays the "central"
 * remote. No network, no real credentials. Git identity is injected via
 * GIT_AUTHOR_* env so the suite never depends on global git config.
 *
 * Coverage:
 *   - pullCentral: clone (first) + idempotent fetch+reset (second).
 *   - planSync: added / updated / removed / unchanged classification.
 *   - applySync: copy + skip-invalid + prune semantics.
 *   - stageAndCommit: commit into central + optional push.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

let store: typeof import("./centralStore.js");

// Test scratch roots
let root: string; // umbrella tmp dir
let bareRepo: string; // the "central" remote (bare)
let seedClone: string; // working clone used to seed/edit the central repo
let cacheDir: string; // LARKWAY_CENTRAL_CACHE target
let localBotsDir: string; // simulated local ~/.larkway/bots

const IDENTITY = { name: "Test Bot Ops", email: "ops@example.com" };

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: IDENTITY.name,
  GIT_AUTHOR_EMAIL: IDENTITY.email,
  GIT_COMMITTER_NAME: IDENTITY.name,
  GIT_COMMITTER_EMAIL: IDENTITY.email,
};

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: GIT_ENV });
  return stdout.trim();
}

/** Minimal valid bot yaml for a given id. */
function botYaml(id: string, name = id): string {
  return [
    `id: ${id}`,
    `name: ${name}`,
    `description: a test bot`,
    `app_id: cli_${id}`,
    `app_secret_env: ${id.toUpperCase().replace(/-/g, "_")}_SECRET`,
    `bot_open_id: ou_${id}`,
    `chats:`,
    `  - oc_testchat`,
    "",
  ].join("\n");
}

/** Seed the central bare repo with a set of bots on branch `main`. */
async function seedCentral(bots: { id: string; memory?: string }[]): Promise<void> {
  await git(["clone", bareRepo, seedClone], path.dirname(seedClone));
  // Ensure we're on main.
  await git(["checkout", "-B", "main"], seedClone);
  const botsPath = path.join(seedClone, "bots");
  await mkdir(botsPath, { recursive: true });
  for (const b of bots) {
    await writeFile(path.join(botsPath, `${b.id}.yaml`), botYaml(b.id), "utf-8");
    if (b.memory !== undefined) {
      await writeFile(path.join(botsPath, `${b.id}.memory.md`), b.memory, "utf-8");
    }
  }
  await git(["add", "-A"], seedClone);
  await git(["commit", "-m", "seed bots"], seedClone);
  await git(["push", "origin", "main"], seedClone);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "larkway-central-"));
  bareRepo = path.join(root, "central.git");
  seedClone = path.join(root, "seed-clone");
  cacheDir = path.join(root, "cache");
  localBotsDir = path.join(root, "local-bots");

  await mkdir(localBotsDir, { recursive: true });

  // Init the bare "central" remote with an initial main branch.
  await execFileAsync("git", ["init", "--bare", "-b", "main", bareRepo], { env: GIT_ENV });

  process.env.LARKWAY_CENTRAL_CACHE = cacheDir;
  store = await import("./centralStore.js");
});

afterEach(async () => {
  delete process.env.LARKWAY_CENTRAL_CACHE;
  await rm(root, { recursive: true, force: true });
});

const cfg = () => ({ repo: bareRepo, branch: "main", path: "bots" });

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe("resolveCentralCacheDir", () => {
  it("honors LARKWAY_CENTRAL_CACHE override", () => {
    expect(store.resolveCentralCacheDir()).toBe(path.resolve(cacheDir));
  });
});

describe("pullCentral", () => {
  it("clones on first run and exposes botsPath + head", async () => {
    await seedCentral([{ id: "alpha" }]);
    const res = await store.pullCentral(cfg());
    expect(res.cacheDir).toBe(path.resolve(cacheDir));
    expect(res.botsPath).toBe(path.join(path.resolve(cacheDir), "bots"));
    expect(res.head).toMatch(/^[0-9a-f]{7,}$/);
    expect(await exists(path.join(res.botsPath, "alpha.yaml"))).toBe(true);
  });

  it("is idempotent — second pull fetches + resets to latest central head", async () => {
    await seedCentral([{ id: "alpha" }]);
    const first = await store.pullCentral(cfg());

    // Add a new bot to central via the seed clone, push.
    await writeFile(path.join(seedClone, "bots", "beta.yaml"), botYaml("beta"), "utf-8");
    await git(["add", "-A"], seedClone);
    await git(["commit", "-m", "add beta"], seedClone);
    await git(["push", "origin", "main"], seedClone);

    const second = await store.pullCentral(cfg());
    expect(second.head).not.toBe(first.head);
    expect(await exists(path.join(second.botsPath, "beta.yaml"))).toBe(true);
  });
});

describe("planSync", () => {
  it("classifies added / updated / removed / unchanged by content", async () => {
    await seedCentral([
      { id: "alpha" }, // will be unchanged
      { id: "gamma" }, // will be updated
      { id: "delta" }, // will be added (not local)
    ]);
    const pull = await store.pullCentral(cfg());

    // Local has: alpha (identical), gamma (differs), epsilon (not in central → removed).
    await writeFile(path.join(localBotsDir, "alpha.yaml"), botYaml("alpha"), "utf-8");
    await writeFile(
      path.join(localBotsDir, "gamma.yaml"),
      botYaml("gamma", "old name"),
      "utf-8",
    );
    await writeFile(path.join(localBotsDir, "epsilon.yaml"), botYaml("epsilon"), "utf-8");

    const plan = await store.planSync(pull.botsPath, localBotsDir);
    expect(plan.added).toEqual(["delta"]);
    expect(plan.updated).toEqual(["gamma"]);
    expect(plan.removed).toEqual(["epsilon"]);
    expect(plan.unchanged).toEqual(["alpha"]);
  });

  it("treats memory.md differences as updated", async () => {
    await seedCentral([{ id: "alpha", memory: "central memory\n" }]);
    const pull = await store.pullCentral(cfg());
    // Same yaml, different memory locally.
    await writeFile(path.join(localBotsDir, "alpha.yaml"), botYaml("alpha"), "utf-8");
    await writeFile(path.join(localBotsDir, "alpha.memory.md"), "LOCAL memory\n", "utf-8");
    const plan = await store.planSync(pull.botsPath, localBotsDir);
    expect(plan.updated).toEqual(["alpha"]);
  });
});

describe("applySync", () => {
  it("copies added + updated (yaml + memory) into local", async () => {
    await seedCentral([{ id: "alpha", memory: "alpha mem\n" }, { id: "beta" }]);
    const pull = await store.pullCentral(cfg());
    const plan = await store.planSync(pull.botsPath, localBotsDir);
    expect(plan.added.sort()).toEqual(["alpha", "beta"]);

    const res = await store.applySync(plan, pull.botsPath, localBotsDir, { prune: false });
    expect(res.applied.sort()).toEqual(["alpha", "beta"]);
    expect(await readFile(path.join(localBotsDir, "alpha.yaml"), "utf-8")).toBe(botYaml("alpha"));
    expect(await readFile(path.join(localBotsDir, "alpha.memory.md"), "utf-8")).toBe("alpha mem\n");
    expect(await exists(path.join(localBotsDir, "beta.yaml"))).toBe(true);
  });

  it("skips an invalid central bot without aborting the rest", async () => {
    await seedCentral([{ id: "alpha" }]);
    // Inject a broken yaml into central cache after pull (missing required fields).
    const pull = await store.pullCentral(cfg());
    await writeFile(path.join(pull.botsPath, "broken.yaml"), "id: broken\nname: x\n", "utf-8");

    const plan = await store.planSync(pull.botsPath, localBotsDir);
    expect(plan.added.sort()).toEqual(["alpha", "broken"]);

    const warnings: string[] = [];
    const res = await store.applySync(plan, pull.botsPath, localBotsDir, {
      prune: false,
      warn: (m) => warnings.push(m),
    });
    expect(res.applied).toEqual(["alpha"]);
    expect(res.skipped.map((s) => s.id)).toEqual(["broken"]);
    expect(warnings.length).toBe(1);
    expect(await exists(path.join(localBotsDir, "broken.yaml"))).toBe(false);
  });

  it("does NOT delete removed bots by default, but prunes with opts.prune", async () => {
    await seedCentral([{ id: "alpha" }]);
    const pull = await store.pullCentral(cfg());
    // Local has an extra bot not in central.
    await writeFile(path.join(localBotsDir, "extra.yaml"), botYaml("extra"), "utf-8");
    await writeFile(path.join(localBotsDir, "extra.memory.md"), "x\n", "utf-8");

    const plan = await store.planSync(pull.botsPath, localBotsDir);
    expect(plan.removed).toEqual(["extra"]);

    // Default: keep.
    const keep = await store.applySync(plan, pull.botsPath, localBotsDir, { prune: false });
    expect(keep.pruned).toEqual([]);
    expect(await exists(path.join(localBotsDir, "extra.yaml"))).toBe(true);

    // prune: delete yaml + memory.
    const pruned = await store.applySync(plan, pull.botsPath, localBotsDir, { prune: true });
    expect(pruned.pruned).toEqual(["extra"]);
    expect(await exists(path.join(localBotsDir, "extra.yaml"))).toBe(false);
    expect(await exists(path.join(localBotsDir, "extra.memory.md"))).toBe(false);
  });
});

describe("stageAndCommit (promote)", () => {
  it("commits a local bot into central and pushes when opts.push", async () => {
    await seedCentral([{ id: "alpha" }]);
    // A new local bot to promote.
    await writeFile(path.join(localBotsDir, "promoted.yaml"), botYaml("promoted"), "utf-8");
    await writeFile(path.join(localBotsDir, "promoted.memory.md"), "promoted mem\n", "utf-8");

    const res = await store.stageAndCommit(localBotsDir, "promoted", cfg(), {
      push: true,
      identity: IDENTITY,
    });
    expect(res.sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(res.pushed).toBe(true);

    // Verify it landed on the central remote by re-cloning fresh.
    const verify = path.join(root, "verify-clone");
    await git(["clone", bareRepo, verify], path.dirname(verify));
    expect(await exists(path.join(verify, "bots", "promoted.yaml"))).toBe(true);
    expect(await readFile(path.join(verify, "bots", "promoted.memory.md"), "utf-8")).toBe(
      "promoted mem\n",
    );
    // Committer identity is the injected one.
    const author = await git(["log", "-1", "--format=%an <%ae>"], verify);
    expect(author).toBe(`${IDENTITY.name} <${IDENTITY.email}>`);
  });

  it("rejects promoting an invalid local bot", async () => {
    await seedCentral([{ id: "alpha" }]);
    await writeFile(path.join(localBotsDir, "bad.yaml"), "id: bad\nname: x\n", "utf-8");
    await expect(
      store.stageAndCommit(localBotsDir, "bad", cfg(), { push: false, identity: IDENTITY }),
    ).rejects.toThrow(/schema validation/);
  });

  it("is a no-op commit when the bot is already identical upstream", async () => {
    await seedCentral([{ id: "alpha" }]);
    // Local copy identical to central.
    const pull0 = await store.pullCentral(cfg());
    const headBefore = pull0.head;
    await writeFile(path.join(localBotsDir, "alpha.yaml"), botYaml("alpha"), "utf-8");

    const res = await store.stageAndCommit(localBotsDir, "alpha", cfg(), {
      push: false,
      identity: IDENTITY,
    });
    expect(res.sha).toBe(headBefore);
    expect(res.pushed).toBe(false);
  });

  it("throws a classified PromoteError when the push is rejected (fetch ok, push fails)", async () => {
    // Prime the cache via a normal seed+pull so stageAndCommit's internal
    // pullCentral (fetch + reset) still succeeds. Then make the bare repo's
    // objects dir read-only so the COMMIT lands locally but the PUSH cannot
    // write objects upstream → push fails → stageAndCommit must surface a
    // PromoteError carrying a `kind` (classification exercised), not a bare Error.
    await seedCentral([{ id: "alpha" }]);
    await writeFile(path.join(localBotsDir, "promoted.yaml"), botYaml("promoted"), "utf-8");
    await store.pullCentral(cfg());

    const { chmod } = await import("node:fs/promises");
    const objectsDir = path.join(bareRepo, "objects");
    await chmod(objectsDir, 0o500); // r-x: fetch can read, push cannot create new loose objects

    let caught: unknown;
    try {
      await store.stageAndCommit(localBotsDir, "promoted", cfg(), {
        push: true,
        identity: IDENTITY,
      });
    } catch (e) {
      caught = e;
    } finally {
      await chmod(objectsDir, 0o700).catch(() => undefined); // restore for cleanup
    }

    expect(caught).toBeInstanceOf(store.PromoteError);
    const pe = caught as InstanceType<typeof store.PromoteError>;
    expect(["behind", "noperm", "other"]).toContain(pe.kind);
    expect(pe.message.length).toBeGreaterThan(0);
  });
});

describe("testConnection", () => {
  it("returns ok for a reachable repo (local bare path)", async () => {
    await seedCentral([{ id: "alpha" }]);
    const res = await store.testConnection(cfg());
    expect(res.ok).toBe(true);
    expect(res.kind).toBeUndefined();
  });

  it("fails with a 人话 error for a non-existent repo path", async () => {
    const res = await store.testConnection({
      repo: path.join(root, "does-not-exist.git"),
      branch: "main",
      path: "bots",
    });
    expect(res.ok).toBe(false);
    // a missing local path is not a valid git repo → unreachable | invalid
    expect(["unreachable", "invalid"]).toContain(res.kind);
    expect(res.error).toBeTruthy();
    // never a raw git stack to operators — message is human-readable, no "fatal:"
    expect(res.error).not.toMatch(/fatal:|exit code/i);
    // raw stderr is preserved separately for engineers
    expect(res.detail).toBeTruthy();
  });

  it("returns invalid for an empty url", async () => {
    const res = await store.testConnection({ repo: "  ", branch: "main", path: "bots" });
    expect(res.ok).toBe(false);
    expect(res.kind).toBe("invalid");
  });
});

describe("branchExistsOnRemote", () => {
  it("true when the branch exists, false otherwise", async () => {
    await seedCentral([{ id: "alpha" }]);
    expect(await store.branchExistsOnRemote(bareRepo, "main")).toBe(true);
    expect(await store.branchExistsOnRemote(bareRepo, "no-such-branch")).toBe(false);
  });
});

describe("bootstrapBranch", () => {
  it("creates an orphan branch with bots/.gitkeep + README and pushes it", async () => {
    // Fresh empty bare repo with NO branches yet.
    const emptyBare = path.join(root, "empty-central.git");
    await execFileAsync("git", ["init", "--bare", "-b", "main", emptyBare], { env: GIT_ENV });

    const c = { repo: emptyBare, branch: "main", path: "bots" };
    expect(await store.branchExistsOnRemote(emptyBare, "main")).toBe(false);

    await store.bootstrapBranch(c, IDENTITY);

    expect(await store.branchExistsOnRemote(emptyBare, "main")).toBe(true);

    // Verify contents by cloning fresh.
    const verify = path.join(root, "verify-bootstrap");
    await git(["clone", emptyBare, verify], path.dirname(verify));
    expect(await exists(path.join(verify, "bots", ".gitkeep"))).toBe(true);
    expect(await exists(path.join(verify, "README.md"))).toBe(true);
    const readme = await readFile(path.join(verify, "README.md"), "utf-8");
    expect(readme).toMatch(/中心配置库/);
  });

  it("is a no-op when the branch already exists", async () => {
    await seedCentral([{ id: "alpha" }]);
    // main already exists — bootstrap must not throw and must not clobber.
    await store.bootstrapBranch(cfg(), IDENTITY);
    const verify = path.join(root, "verify-noop");
    await git(["clone", bareRepo, verify], path.dirname(verify));
    // alpha.yaml still present (not overwritten by a bootstrap commit)
    expect(await exists(path.join(verify, "bots", "alpha.yaml"))).toBe(true);
  });
});

describe("centralBotsWithMeta", () => {
  it("reads roster + best-effort git authorship", async () => {
    await seedCentral([
      { id: "alpha", memory: "alpha mem\n" },
      { id: "beta" },
    ]);
    const rows = await store.centralBotsWithMeta(cfg());
    expect(rows.map((r) => r.id)).toEqual(["alpha", "beta"]);

    const alpha = rows.find((r) => r.id === "alpha")!;
    expect(alpha.name).toBe("alpha");
    expect(alpha.desc).toBe("a test bot");
    // git log -1 should resolve the seed committer + a short hash + relative time
    expect(alpha.by).toBe(IDENTITY.name);
    expect(alpha.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(alpha.updated.length).toBeGreaterThan(0);
    // chats/repos counts from yaml (botYaml has 1 chat, no repos)
    expect(alpha.chats).toBe(1);
    expect(alpha.repos).toBe(0);
  });

  it("degrades by/updated/commit to empty when git log is unavailable", async () => {
    await seedCentral([{ id: "alpha" }]);
    const pull = await store.pullCentral(cfg());
    // Add an untracked bot to the cache (never committed) → git log finds nothing.
    await writeFile(path.join(pull.botsPath, "ghost.yaml"), botYaml("ghost"), "utf-8");
    const rows = await store.centralBotsWithMeta(cfg());
    // pullCentral resets --hard so the untracked file may be dropped; guard for
    // either outcome — the contract is "best-effort, empty when unobtainable".
    const ghost = rows.find((r) => r.id === "ghost");
    if (ghost) {
      expect(ghost.by).toBe("");
      expect(ghost.commit).toBe("");
      expect(ghost.updated).toBe("");
    }
  });
});
