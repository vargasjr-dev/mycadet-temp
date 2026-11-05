#!/usr/bin/env node
/**
 * Knip ratchet: dead code can only shrink, never grow.
 *
 * Runs knip and compares its findings against the committed baseline
 * (scripts/knip-baseline.json). New findings fail the run with the diff;
 * the `--update` flag re-baselines after a cleanup round.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const baselinePath = join(here, "knip-baseline.json");
const update = process.argv.includes("--update");

const run = spawnSync(
  "bunx",
  ["knip", "--reporter", "json", "--no-exit-code"],
  {
    cwd: join(here, ".."),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  },
);

if (run.error) {throw run.error;}
const report = JSON.parse(run.stdout);

// One stable key per finding: rule, file, symbol.
// The JSON shape is one group per file: { file, exports: [{name}…], … }.
const keys = new Set();
for (const group of report.issues) {
  if (!group || typeof group !== "object") {
    continue;
  }
  for (const [rule, findings] of Object.entries(group)) {
    if (rule === "file" || !Array.isArray(findings)) {
      continue;
    }
    for (const finding of findings) {
      const symbol = typeof finding === "string" ? finding : finding?.name;
      keys.add(`${rule}|${group.file}|${symbol ?? ""}`);
    }
  }
}

if (update) {
  writeFileSync(baselinePath, JSON.stringify([...keys].sort(), null, 2) + "\n");
  console.log(`knip: baseline saved (${keys.size} known findings)`);
  process.exit(0);
}

const baseline = new Set(JSON.parse(readFileSync(baselinePath, "utf8")));
const fresh = [...keys].filter((k) => !baseline.has(k));

if (fresh.length === 0) {
  console.log(`knip: clean (${keys.size} findings, all known)`);
  process.exit(0);
}

console.error(`knip: ${fresh.length} new dead-code finding(s):`);
for (const key of fresh.sort()) {
  const [rule, file, symbol] = key.split("|");
  console.error(`  ${rule.padEnd(15)} ${file}${symbol ? ` — ${symbol}` : ""}`);
}
console.error(
  "Fix them, or run `bun run knip:update` if they are intentional.",
);
process.exit(1);
