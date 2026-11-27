import { resolveLockfilePath, resolveLogDir } from "@mycadet/local-mode";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeEntry } from "./helpers/lockfile-entry.js";

const testDir = mkdtempSync(join(tmpdir(), "cli-logs-follow-test-"));
const originalConfigHome = process.env.XDG_CONFIG_HOME;
const cliEntry = join(import.meta.dir, "..", "index.ts");

beforeAll(() => {
  process.env.XDG_CONFIG_HOME = testDir;
  mkdirSync(join(testDir, "cadet"), { recursive: true });
  writeFileSync(
    resolveLockfilePath(),
    JSON.stringify({ assistants: [] }) + "\n",
  );
  makeEntry({ assistantId: "mine", instanceDir: join(testDir, "mine") });
  mkdirSync(resolveLogDir(), { recursive: true });
  writeFileSync(
    join(resolveLogDir(), "hatch.log"),
    "2026-01-01T00:00:01.000Z [daemon] ready\n",
  );
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
  if (originalConfigHome !== undefined) {
    process.env.XDG_CONFIG_HOME = originalConfigHome;
  } else {
    delete process.env.XDG_CONFIG_HOME;
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`logs -f exits on ${signal}`, async () => {
    const child = Bun.spawn(
      ["bun", cliEntry, "logs", "mine", "-f", "--tail", "1"],
      {
        env: { ...process.env, XDG_CONFIG_HOME: testDir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    // The existing line is printed before following starts.
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("ready");
    reader.releaseLock();
    // Give it time to start following, so the signal hits the follow loop.
    await Bun.sleep(1000);

    child.kill(signal);
    const exited = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(3000).then(() => false),
    ]);
    if (!exited) child.kill("SIGKILL");
    expect(exited).toBe(true);
  }, 15000);
}
