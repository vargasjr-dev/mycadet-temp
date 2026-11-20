#!/usr/bin/env bun
/**
 * cadet-test — the cadet CLI with sandboxed state; the sole surface the qa
 * integration tests drive a hatch through.
 *
 * Config and data homes redirect under CADET_TEST_STATE_ROOT (a fresh temp
 * root when unset) so tests never touch a developer's real instances, and
 * every argument is delegated to the real cadet CLI verbatim. Tests
 * communicate only through CLI commands — `cadet-test hatch --remote
 * docker`, `cadet-test exec`, `cadet-test retire` — never through docker
 * or implementation internals.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const stateRoot =
  process.env.CADET_TEST_STATE_ROOT?.trim() ||
  mkdtempSync(join(tmpdir(), "cadet-test-state-"));
const repoRoot = dirname(dirname(new URL(import.meta.url).pathname));
const cliEntry = join(repoRoot, "cli", "src", "index.ts");

const result = spawnSync(
  process.execPath,
  [cliEntry, ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      CADET_TEST_STATE_ROOT: stateRoot,
      XDG_CONFIG_HOME: join(stateRoot, "config"),
      XDG_DATA_HOME: join(stateRoot, "data"),
    },
  },
);
process.exit(result.status ?? 1);
