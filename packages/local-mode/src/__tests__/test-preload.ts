/**
 * Local-mode test preload — runs before every test file.
 *
 * `scripts/run-tests.ts` (run-isolated-tests) spawns one `bun test` process
 * per file, so this preload — and its temp dir — is per-file.
 *
 * Local-mode code persists through the XDG state homes: the lockfile,
 * device.json and the config dir resolve under XDG_CONFIG_HOME; avatar and
 * other data writes resolve under XDG_DATA_HOME. Tests that drove those
 * paths wrote into the real ~/.config/cadet of whoever ran them (#949).
 * Redirect both homes to a per-file temp dir so any file that gains a write
 * stays isolated without per-file ceremony.
 *
 * Files needing tighter isolation (or testing the env resolution itself)
 * still set their own — remotes-local-port-heal, avatar, lockfile-lock do.
 *
 * No source-module imports
 * ------------------------
 * The only static imports are node stdlib (`node:fs`, `node:os`,
 * `node:path`) and `bun:test`. Importing from the package risks import-time
 * side effects (see assistant/src/__tests__/test-preload.ts for the house
 * reasoning).
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";

const testRoot = realpathSync(
  mkdtempSync(join(tmpdir(), "cadet-local-mode-test-")),
);
const savedEnv: Record<string, string | undefined> = {};
for (const [key, dirName] of [
  ["XDG_CONFIG_HOME", "config"],
  ["XDG_DATA_HOME", "data"],
] as const) {
  savedEnv[key] = process.env[key];
  const dir = join(testRoot, dirName);
  mkdirSync(dir, { recursive: true });
  process.env[key] = dir;
}

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});
