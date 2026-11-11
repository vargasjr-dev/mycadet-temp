#!/usr/bin/env bun
/**
 * Count the assistant's knip production-exports violations against a pin.
 *
 * Usage:
 *   bun run scripts/check-unused-production-exports.ts           # enforce the pin
 *   bun run scripts/check-unused-production-exports.ts -- --max-unused 1300  # override locally
 *
 * Also runs as the knip (production exports) step of `bun run lint`
 * (scripts/lint.ts).
 *
 * knip has no `--max` flag, so this wraps the JSON report and compares the
 * violation count to a pin. `--max-unused` is a countdown, not a license:
 * it holds the current count of unused production exports and each PR is
 * expected to chip away at it — never to raise it.
 */

import { execSync } from "node:child_process";
import { resolve } from "node:path";

const assistantRoot = resolve(import.meta.dirname, "..");

/** The countdown. Lower it as exports drain; never raise it. */
const PINNED_MAX_UNUSED = 1257;

const args = process.argv.slice(2);
const maxUnused = args.includes("--max-unused")
  ? Number(args[args.indexOf("--max-unused") + 1])
  : PINNED_MAX_UNUSED;

const cmd = [
  "bunx",
  "knip",
  "--production",
  "--include",
  "exports",
  "--reporter",
  "json",
].join(" ");

type KnipIssue = { file: string; exports?: { name: string; line: number }[] };
type KnipReport = { issues?: KnipIssue[] };

/** knip's JSON report, or null when its output isn't one. */
function parseReport(output: string): KnipReport | null {
  try {
    const parsed = JSON.parse(output);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

const report = (count: number): string =>
  count === 0
    ? "✓ No unused production exports"
    : `✓ ${count} unused production exports (pinned max ${maxUnused} — chip away, don't raise)`;

const fail = (issues: KnipIssue[], count: number): never => {
  for (const issue of issues) {
    for (const exp of issue.exports ?? []) {
      console.log(`${issue.file}:${exp.line} ${exp.name}`);
    }
  }
  console.error(
    `\n✗ Found ${count} unused production exports (pinned max ${maxUnused})`,
  );
  process.exit(1);
};

// knip exits non-zero when it finds violations, so the happy path only
// ever sees an empty list.
let report_: KnipReport | null = null;
try {
  const output = execSync(cmd, {
    cwd: assistantRoot,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  report_ = parseReport(output);
} catch (error: unknown) {
  const execError = error as {
    stdout?: string;
    stderr?: string;
    status?: number;
  };
  report_ = (execError.stdout && parseReport(execError.stdout)) ?? null;
  if (report_ === null) {
    // Not a parseable knip answer — surface whatever it said and die.
    if (execError.stdout) {
      process.stdout.write(execError.stdout);
    }
    if (execError.stderr) {
      process.stderr.write(execError.stderr);
    }
    process.exit(execError.status ?? 1);
  }
}

const issues = report_?.issues ?? [];
const count = issues.reduce(
  (sum, issue) => sum + (issue.exports?.length ?? 0),
  0,
);

if (count > maxUnused) {
  fail(issues, count);
}
console.log(report(count));
process.exit(0);
