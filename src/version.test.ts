/**
 * src/version.test.ts
 *
 * Guards the version banner against the regression where a hardcoded literal
 * (`const VERSION = "0.1.0"`) drifted from package.json and made the bridge
 * banner lie. resolveLarkwayVersion must report the REAL package.json version.
 *
 * Pure unit test — no subprocess, no network. Reads package.json off disk only.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLarkwayVersion } from "./version.js";

const pkg = JSON.parse(
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf-8",
  ),
) as { name: string; version: string };

describe("resolveLarkwayVersion", () => {
  it("resolves to package.json's real version (not the old hardcoded 0.1.0)", () => {
    const v = resolveLarkwayVersion(import.meta.url);
    expect(v).toBe(pkg.version);
    expect(v).not.toBe("0.1.0");
    expect(v).not.toBe("unknown");
  });

  it("is the larkway package", () => {
    expect(pkg.name).toBe("larkway");
  });

  it("returns the fallback when no larkway package.json is found above the file", () => {
    // A file URL deep under /tmp has no larkway package.json above it.
    const bogus = "file:///tmp/__larkway_no_pkg__/nested/file.js";
    expect(resolveLarkwayVersion(bogus, "fallback-xyz")).toBe("fallback-xyz");
  });
});
