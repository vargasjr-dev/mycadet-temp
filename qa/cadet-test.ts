#!/usr/bin/env bun
/**
 * cadet-test — the cadet CLI with sandboxed state; the sole surface the qa
 * integration tests drive a hatch through.
 *
 * The cli is resolved as `cadet` on PATH — a release job installs the real
 * packed @mycadet/cli artifact so `cadet` just works. Config and data
 * homes redirect under CADET_TEST_STATE_ROOT (a fresh temp root when unset)
 * and the state lives in the `test` environment, so tests never touch a
 * developer's real instances. Every argument is delegated verbatim — tests
 * communicate only through cli commands, never through docker or
 * implementation internals.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateRoot =
  process.env.CADET_TEST_STATE_ROOT?.trim() ||
  mkdtempSync(join(tmpdir(), "cadet-test-state-"));

/** The cli command: `cadet` on PATH, installed by the release jobs. */
function resolveCadetCommand(): { cmd: string; preArgs: string[] } {
  for (const dir of process.env.PATH?.split(":") ?? []) {
    if (existsSync(join(dir, "cadet"))) return { cmd: "cadet", preArgs: [] };
  }
  console.error(
    "cadet-test: `cadet` not found on PATH — pack and install @mycadet/cli first",
  );
  process.exit(1);
}

const { cmd, preArgs } = resolveCadetCommand();

const result = spawnSync(cmd, [...preArgs, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: {
    ...process.env,
    CADET_ENVIRONMENT: "test",
    XDG_CONFIG_HOME: join(stateRoot, "config"),
    XDG_DATA_HOME: join(stateRoot, "data"),
  },
});
process.exit(result.status ?? 1);
