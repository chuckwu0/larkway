#!/usr/bin/env node
/**
 * scripts/check-doc-links.mjs
 *
 * Cross-platform, zero-dependency markdown local-link checker.
 * Checks relative links inside git-tracked *.md files (excluding docs/archive/**)
 * or explicit file paths passed via argv. Exits 1 on any broken local link.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(repoRoot);

const argvFiles = process.argv.slice(2);
let files;
if (argvFiles.length > 0) {
  files = argvFiles;
} else {
  const out = execFileSync("git", ["ls-files", "-z", "--", "*.md", ":!:docs/archive/**"], {
    encoding: "utf8",
  });
  files = out
    .split("\0")
    .filter(Boolean);
}

files = files.filter((f) => {
  if (!f.endsWith(".md")) return false;
  try {
    return statSync(f).isFile();
  } catch {
    return false;
  }
});

const linkRe = /\]\(\s*([^)]+?)\s*\)/g;
const schemeRe = /^[a-zA-Z][\w+.-]*:\/\//;
const bad = [];

for (const f of files) {
  const base = path.dirname(f);
  const lines = readFileSync(f, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    linkRe.lastIndex = 0;
    let match;
    while ((match = linkRe.exec(line)) !== null) {
      const target = match[1].trim();
      const rawPath = target ? target.split(/\s+/)[0].split("#", 1)[0] : "";
      if (!rawPath) continue;
      if (schemeRe.test(rawPath)) continue;
      if (rawPath.startsWith("mailto:") || rawPath.startsWith("~") || rawPath.startsWith("/")) {
        continue;
      }
      const resolved = path.normalize(path.join(base, rawPath));
      if (!existsSync(resolved)) {
        bad.push([f, i + 1, target]);
      }
    }
  }
}

if (bad.length > 0) {
  console.error(`✗ 发现 ${bad.length} 个死链：`);
  for (const [f, lineNo, target] of bad) {
    console.error(`  ${f}:${lineNo}  →  ${target}`);
  }
  process.exit(1);
}

console.log(`✓ ${files.length} 个 markdown 文件，仓库内本地链接全部有效`);
