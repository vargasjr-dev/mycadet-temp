import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as config from "../lib/assistant-config.js";
import * as localMode from "@mycadet/local-mode";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";
import { restore } from "../commands/restore.js";

const directory = await mkdtemp(join(tmpdir(), "root-restore-command-"));
const file = join(directory, "backup.tar.gz");
await writeFile(file, Buffer.alloc(32, 1));
const argv = [...process.argv];
const lookup = spyOn(config, "findAssistantByName");
const restoreOp = spyOn(localMode, "restoreAssistant");

beforeEach(() => {
  for (const spy of [lookup, restoreOp]) spy.mockReset();
  lookup.mockReturnValue(null);
});
afterEach(() => {
  process.argv = [...argv];
});
afterAll(async () => {
  for (const spy of [lookup, restoreOp]) spy.mockRestore();
  await rm(directory, { recursive: true, force: true });
});

for (const topology of ["local", "docker"] as const) {
  test(`${topology} restore delegates to the operation and reports the recovery path`, async () => {
    const entry: LockfileAssistant = {
      assistantId: "test",
      cloud: topology,
      port: 7830,
    };
    lookup.mockReturnValue(entry);
    restoreOp.mockResolvedValue({
      ok: true,
      kind: "roots",
      dryRun: false,
      recoveryPath: join(directory, "recovery.tar.gz"),
    });
    process.argv = ["bun", "cadet", "restore", "test", "--from", file];
    await restore();
    expect(restoreOp).toHaveBeenCalledWith({
      entry,
      fromPath: file,
      dryRun: false,
      log: expect.any(Function),
    });
  });
}

test("cloud restore delegates through the same operation", async () => {
  const entry: LockfileAssistant = {
    assistantId: "cloud-test",
    cloud: "cloud",
  };
  lookup.mockReturnValue(entry);
  restoreOp.mockResolvedValue({
    ok: true,
    kind: "cloud",
    dryRun: false,
    import: {
      filesCreated: 2,
      filesOverwritten: 1,
      filesSkipped: 0,
      backupsCreated: 3,
      warnings: [],
    },
  });
  process.argv = ["bun", "cadet", "restore", "cloud-test", "--from", file];
  await restore();
  expect(restoreOp).toHaveBeenCalledWith({
    entry,
    fromPath: file,
    dryRun: false,
    log: expect.any(Function),
  });
});

test("without --from the command recovers the retired assistant", async () => {
  process.argv = ["bun", "cadet", "restore", "retired-one"];
  restoreOp.mockResolvedValue({ ok: true, kind: "recovery" });
  await restore();
  expect(restoreOp).toHaveBeenCalledWith({ name: "retired-one" });
});

for (const topology of ["local", "docker", "cloud"] as const) {
  test(`${topology} rejects removed --version before lookup or mutation`, async () => {
    process.argv = [
      "bun",
      "cadet",
      "restore",
      "test",
      "--from",
      file,
      "--version",
      "0.12.10",
    ];
    await expect(restore()).rejects.toThrow(
      "Unknown restore option: --version",
    );
    expect(lookup).not.toHaveBeenCalled();
    expect(restoreOp).not.toHaveBeenCalled();
  });
}
