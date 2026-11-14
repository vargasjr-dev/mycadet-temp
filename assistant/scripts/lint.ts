#!/usr/bin/env bun
/**
 * The assistant's lint gates in one pass — the single `bun run lint`.
 *
 * Steps run in order and the first failure stops the pass, so a red run's
 * output starts at the step that failed. Each step streams its own output.
 *
 * The eslint `--max-warnings` pin is a countdown, not a license: it holds
 * the current count of `mock.module` uses (see eslint.config.mjs) and each
 * PR is expected to chip away at it — never to raise it.
 */

import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");

type Step = { name: string; command: string[] };

const steps: Step[] = [
  {
    name: "skill specs",
    command: [
      "bun",
      "../scripts/skills/lint-skill-spec.mjs",
      "--dir",
      "src/config/bundled-skills",
      "--allow-tools-json",
    ],
  },
  {
    name: "eslint",
    command: ["bunx", "eslint", ".", "--max-warnings", "2743"],
  },
  {
    name: "knip",
    command: [
      "bunx",
      "knip",
      "--include",
      "files,dependencies,unlisted,exports",
    ],
  },
  {
    name: "circular dependencies",
    command: [
      "bun",
      "scripts/check-circular-deps.ts",
      "--",
      "--max-cycles",
      "166",
    ],
  },
];

for (const step of steps) {
  console.log(`==> ${step.name}`);
  const proc = Bun.spawnSync(step.command, {
    cwd: packageRoot,
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (proc.exitCode !== 0) {
    console.error(`✗ ${step.name}`);
    process.exit(proc.exitCode ?? 1);
  }
  console.log(`✓ ${step.name}`);
}

console.log("lint: all gates clear");
