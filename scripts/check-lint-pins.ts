#!/usr/bin/env bun
/**
 * The countdown pins may only move down.
 *
 * Scans every lint budget in the repo — eslint `--max-warnings`, the
 * circular-dependency `--max-cycles`, anywhere a ceiling is pinned — and
 * fails if any pin is HIGHER than the same pin on origin/main. Adding a new
 * pin is allowed (new debt must be visible to be burned down); raising an
 * existing one is not. Run by .github/workflows/pr-lint-pins.yaml.
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

type Pin = { file: string; kind: "max-warnings" | "max-cycles"; value: number };

/** The next integer after a flag, whether quoted-inline or a later array element. */
const PIN_RE = /--(max-warnings|max-cycles)["'`,\s]{1,6}?(\d+)/g;

function pinsIn(text: string, file: string): Pin[] {
  const out: Pin[] = [];
  for (const [, kind, value] of text.matchAll(PIN_RE)) {
    out.push({ file, kind: kind as Pin["kind"], value: Number(value) });
  }
  return out;
}

function localPins(): Pin[] {
  const files = execSync(
    `git ls-files | grep -E '(^|/)(package\\.json|scripts/lint\\.ts)$' | grep -v node_modules`,
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  return files.flatMap((f) => pinsIn(readFileSync(f, "utf8"), f));
}

/** origin/main's copy, fetched fresh so a stale local ref can't hide a rise. */
function mainText(file: string): string {
  execSync("git fetch --depth=1 origin main", { stdio: "ignore" });
  try {
    return execSync(`git show FETCH_HEAD:${file}`, {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return ""; // file doesn't exist on main — a brand-new pin
  }
}

const rises: string[] = [];
const current = localPins();
const all: Array<Pin & { base: number | null }> = [];

for (const pin of current) {
  const basePin = pinsIn(mainText(pin.file), pin.file).find(
    (p) => p.kind === pin.kind,
  );
  const base = basePin ? basePin.value : null;
  all.push({ ...pin, base });
  if (base !== null && pin.value > base) {
    rises.push(`${pin.file}: ${pin.kind} ${base} → ${pin.value}`);
  }
}

console.log("Lint pins (main → this PR):");
for (const { file, kind, base, value } of all) {
  console.log(`  ${file}  ${kind}: ${base ?? "—"} → ${value}`);
}

if (rises.length > 0) {
  console.error(`\nFAIL: pin(s) rose — a countdown only moves down:`);
  for (const r of rises) console.error(`  ${r}`);
  process.exit(1);
}
console.log("\nAll pins flat or lower. ✓");
