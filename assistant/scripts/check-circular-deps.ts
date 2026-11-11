#!/usr/bin/env bun
/**
 * Detect circular dependencies in the assistant package using madge.
 *
 * Usage:
 *   bun run scripts/check-circular-deps.ts            # human output
 *   bun run scripts/check-circular-deps.ts -- --json  # machine-readable output
 *   bun run scripts/check-circular-deps.ts -- --max-cycles 199
 *
 * Also runs as the circular-deps step of `bun run lint` (scripts/lint.ts).
 *
 * `--max-cycles N` is a countdown, not a license: the daemon's import graph
 * carries a long-standing cycle backlog (199 chains at the time this pin
 * was last lowered), and the lint script holds the pin so each PR is expected to
 * chip away at it — never to raise it.
 */

import { execSync } from "node:child_process";
import { resolve } from "node:path";

const assistantRoot = resolve(import.meta.dirname, "..");
const tsConfig = resolve(assistantRoot, "tsconfig.json");

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const maxCycles = args.includes("--max-cycles")
  ? Number(args[args.indexOf("--max-cycles") + 1])
  : 0;

// Madge always answers in JSON here — the human view is rendered below, and
// the count has to be readable in both modes for the pin to work.
const cmd = [
  "bunx",
  "madge",
  "--circular",
  "--extensions",
  "ts,tsx",
  "--ts-config",
  tsConfig,
  "--json",
  resolve(assistantRoot, "src"),
]
  .filter(Boolean)
  .join(" ");

/** Madge's JSON cycle list, or null when its output isn't one. */
function parseCycles(output: string): string[][] | null {
  try {
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const report = (count: number): string =>
  count === 0
    ? "✓ No circular dependencies detected"
    : `✓ ${count} circular dependency chain(s) (pinned max ${maxCycles} — chip away, don't raise)`;

const fail = (cycles: string[][]): never => {
  if (jsonMode) {
    console.log(JSON.stringify(cycles, null, 2));
  } else {
    for (const [index, chain] of cycles.entries()) {
      console.log(`${index + 1}) ${chain.join(" > ")}`);
    }
  }
  console.error(`\n✗ Found ${cycles.length} circular dependency chain(s)`);
  process.exit(1);
};

// madge exits non-zero when it finds cycles, so the happy path only ever
// sees an empty list.
let cycles: string[][];
try {
  const output = execSync(cmd, {
    cwd: assistantRoot,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  cycles = parseCycles(output) ?? [];
} catch (error: unknown) {
  const execError = error as {
    stdout?: string;
    stderr?: string;
    status?: number;
  };
  cycles = (execError.stdout && parseCycles(execError.stdout)) ?? null;
  if (cycles === null) {
    // Not a parseable madge answer — surface whatever it said and die.
    if (execError.stdout) {
      process.stdout.write(execError.stdout);
    }
    if (execError.stderr) {
      process.stderr.write(execError.stderr);
    }
    process.exit(execError.status ?? 1);
  }
}

if (cycles.length > maxCycles) {
  fail(cycles);
}
console.log(report(cycles.length));
process.exit(0);
