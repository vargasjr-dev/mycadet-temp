#!/usr/bin/env bun
/**
 * The macOS client's lint gates in one pass — the single `bun run lint`.
 *
 * Steps run in order and the first failure stops the pass, so a red run's
 * output starts at the step that failed. Each step streams its own output.
 *
 * eslint pins `--max-warnings 0`: the client's `as`-cast debt was cleared,
 * and a warning is a gate again rather than a countdown to hold.
 */

import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");

type Step = { name: string; command: string[] };

const steps: Step[] = [
  {
    name: "eslint",
    command: ["bunx", "eslint", ".", "--max-warnings", "0"],
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
