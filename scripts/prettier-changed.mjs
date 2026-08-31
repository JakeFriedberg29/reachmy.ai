#!/usr/bin/env node
/**
 * Incremental Prettier: check/write files changed vs origin/main, plus untracked files.
 * Historical trees are not reformatted until they appear in a diff.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const write = process.argv.includes("--write");
const prettierExt = /\.(?:[cm]?[jt]s|json|ya?ml|md)$/;

function gitLines(...args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || "git command failed\n");
    process.exit(result.status ?? 1);
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function resolveBase() {
  const probe = spawnSync("git", ["rev-parse", "--verify", "origin/main"], {
    encoding: "utf8",
  });
  return probe.status === 0 ? "origin/main" : "main";
}

const base = resolveBase();
const changed = [
  ...gitLines("diff", "--name-only", "--diff-filter=ACMR", base),
  ...gitLines("ls-files", "--others", "--exclude-standard"),
];
const files = [...new Set(changed)].filter(
  (file) =>
    existsSync(file) &&
    prettierExt.test(file) &&
    !file.startsWith("docs/") &&
    !file.endsWith(".sql"),
);

if (files.length === 0) {
  process.exit(0);
}

const result = spawnSync("pnpm", ["exec", "prettier", write ? "--write" : "--check", ...files], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
