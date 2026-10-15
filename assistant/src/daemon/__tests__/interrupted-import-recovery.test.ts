import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { recoverInterruptedImport } from "../interrupted-import-recovery.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(swapCompleted = false) {
  const root = await mkdtemp(join(tmpdir(), "import-recovery-"));
  roots.push(root);
  const temp = join(root, ".import-test");
  const backup = join(root, ".pre-import-test");
  await mkdir(join(temp, "data", "db"), { recursive: true });
  await mkdir(join(backup, "data"), { recursive: true });
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(
    join(temp, "data", "db", "assistant.db"),
    "committed WAL state",
  );
  await writeFile(join(backup, "data", "settings.json"), "original settings");
  await writeFile(join(root, "data", "settings.json"), "partial import");
  await writeFile(
    join(root, ".import-marker.json"),
    JSON.stringify({
      tempWorkspaceDir: temp,
      backupDir: backup,
      swapCompleted,
      carried: [
        {
          liveChild: join(root, "data", "db"),
          tempChild: join(temp, "data", "db"),
        },
      ],
    }),
  );
  return { root, temp, backup };
}
test("recovers a partial workspace swap and carried database before startup", async () => {
  const { root, temp, backup } = await fixture();
  expect(await recoverInterruptedImport(root)).toEqual({
    ok: true,
    failedCount: 0,
  });
  expect(await readFile(join(root, "data", "settings.json"), "utf8")).toBe(
    "original settings",
  );
  expect(await readFile(join(root, "data", "db", "assistant.db"), "utf8")).toBe(
    "committed WAL state",
  );
  await expect(access(temp)).rejects.toThrow();
  await expect(access(backup)).rejects.toThrow();
  expect(await recoverInterruptedImport(root)).toEqual({
    ok: true,
    failedCount: 0,
  });
});
test("completed swaps keep imported state and discard stale recovery artifacts", async () => {
  const { root, temp, backup } = await fixture(true);
  expect(await recoverInterruptedImport(root)).toEqual({
    ok: true,
    failedCount: 0,
  });
  expect(await readFile(join(root, "data", "settings.json"), "utf8")).toBe(
    "partial import",
  );
  await expect(access(temp)).rejects.toThrow();
  await expect(access(backup)).rejects.toThrow();
});
test("failed restoration retains recovery journal and source data for retry", async () => {
  const { root, temp, backup } = await fixture();
  await rm(join(root, "data"), { recursive: true });
  await writeFile(join(root, "data"), "blocking file");
  expect((await recoverInterruptedImport(root)).ok).toBe(false);
  await access(temp);
  await access(backup);
  await access(join(root, ".import-marker.json"));
  await rm(join(root, "data"));
  expect((await recoverInterruptedImport(root)).ok).toBe(true);
  expect(await readFile(join(root, "data", "db", "assistant.db"), "utf8")).toBe(
    "committed WAL state",
  );
});
