import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");

// Execute the real browser form functions with only the DOM fields they use.
// No browser, live backend, or duplicated serialization implementation.
function browserFunction(name: string, globals: Record<string, unknown> = {}) {
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
  if (!match) throw new Error(`Missing browser function ${name}`);
  const end = source.indexOf("\n}", match.index) + 2;
  return runInNewContext(`(${source.slice(match.index, end)})`, { URL, ...globals });
}

function panelFixture(workspace = "") {
  const repoRows = [
    { dataset: { repoSlug: "acme/release", repoIdx: "0" }, querySelector: (s: string) => ({ value: s.includes("branch") ? "release/2026" : "https://example.com/acme/release.git" }) },
    { dataset: { repoSlug: "acme/legacy", repoIdx: "1" }, querySelector: (s: string) => ({ value: s.includes("branch") ? "master" : "" }) },
  ];
  const fields: Record<string, unknown> = {
    "#ac-name": { value: "New name" },
    "#ac-desc": { value: "Responsible for releases" },
    "#ac-memory": { value: "Short identity" },
    "#ac-workspace": { value: workspace },
    "#ac-turn-limit": { value: "10" },
    "#ac-chats": { value: "oc_first\noc_second" },
    "#ac-code-access-btn": { getAttribute: () => "true" },
    "[name='id']": { value: "release-bot" },
  };
  const ac = {
    dataset: {},
    querySelector: (s: string) => fields[s] ?? null,
    querySelectorAll: () => repoRows,
  };
  return { querySelector: (s: string) => s === "#ac-panel" ? ac : null };
}

describe("Agent configuration form", () => {
  const readValues = browserFunction("readAgentConfigValues", {
    inferRepoSlugFromUrl: browserFunction("inferRepoSlugFromUrl"),
  });

  it("preserves existing release branches and legacy slug-only pointers when saving metadata", () => {
    const config = readValues(panelFixture());
    expect(config.repos).toEqual([
      { slug: "acme/release", branch: "release/2026", url: "https://example.com/acme/release.git" },
      { slug: "acme/legacy", branch: "master" },
    ]);
    expect(config.chats).toEqual(["oc_first", "oc_second"]);
    expect(config._memContent).toBe("Short identity");
  });

  it("does not serialize managed identity notes for native workspaces", () => {
    const config = readValues(panelFixture("/existing/project"));
    expect(config.workspace).toBe("/existing/project");
    expect(config).not.toHaveProperty("_memContent");
  });

  it("keeps branch values when rebuilding repo rows", () => {
    const getRepos = browserFunction("acGetRepos", { inferRepoSlugFromUrl: browserFunction("inferRepoSlugFromUrl") });
    const repos = getRepos(panelFixture().querySelector("#ac-panel"));
    expect(repos.map((repo: { branch: string }) => repo.branch)).toEqual(["release/2026", "master"]);
  });

  it.each(["", "/existing/project"])("finalizes the complete creation payload in one request (workspace %s)", async (workspace) => {
    const values = readValues(panelFixture(workspace));
    const api = vi.fn(async () => ({ ok: true, json: { status: "done", botId: "release-bot" } }));
    const submit = browserFunction("submitOnboardName", {
      validateCodeAccessConfig: () => true,
      readAgentConfigValues: () => values,
      api,
      onboard: { sessionId: "onboard-session" },
      btnLoading: () => () => {},
      LK_BACKEND_DEFAULT: "codex",
      loadBots: async () => {},
      state: { bots: [] },
      document: { getElementById: () => null },
      toast: vi.fn(),
    });
    await submit({}, "onboard-session", { querySelector: () => null });
    expect(api).toHaveBeenCalledTimes(1);
    const payload = api.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(payload[0]).toBe("POST");
    expect(payload[1]).toBe("/api/onboard/finalize");
    expect(payload[2].chats).toEqual(["oc_first", "oc_second"]);
    if (workspace) {
      expect(payload[2].workspace).toBe(workspace);
      expect(payload[2]).not.toHaveProperty("memory_content");
    } else {
      expect(payload[2].memory_content).toBe("Short identity");
    }
  });
});
