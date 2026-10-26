/**
 * Shared CLI test preload — runs before every test file.
 *
 * Sets CADET_WORKSPACE_DIR to a temporary directory so that any CLI helper
 * that resolves workspace paths won't accidentally touch the real workspace.
 *
 * Cleanup: the temp dir is removed after all tests in the file complete.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, mock } from "bun:test";

const testDir = realpathSync(
  mkdtempSync(join(tmpdir(), "cadet-cli-test-workspace-")),
);
process.env.CADET_WORKSPACE_DIR = testDir;
// The lockfile writes resolve from the environment (the package's one save);
// point them at the same temp workspace so no test touches production state.
process.env.XDG_CONFIG_HOME = testDir;

// Tests run from a source checkout, whose `-local.` stamp would pin the
// ambient environment to `local`. Pretend to be an installed production
// copy instead; tests that want another environment set CADET_ENVIRONMENT.
(globalThis as { __CADET_OWN_VERSION__?: string }).__CADET_OWN_VERSION__ =
  "0.0.0";

afterAll(() => {
  delete process.env.CADET_WORKSPACE_DIR;
  delete process.env.XDG_CONFIG_HOME;
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }

  // Restore spies created via spyOn()/mock() at the end of the run.
  //
  // NOTE: this does NOT prevent inter-file leaks of `mock.module()`. This
  // `afterAll` runs once, after ALL files complete (a preload's afterAll wraps
  // the whole run, not each file), and `mock.restore()` does not undo
  // `mock.module()` registrations anyway. A file that calls `mock.module()`
  // must restore the real module itself in its own `afterAll` by re-registering
  // the captured real exports (see e.g. teleport.test.ts / recover.test.ts),
  // otherwise the mock leaks into whichever file Bun runs next.
  mock.restore();
});
