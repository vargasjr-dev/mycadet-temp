import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as config from "../lib/assistant-config.js";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";
import * as localMode from "@mycadet/local-mode";
import { backup } from "../commands/backup.js";

const directory = mkdtempSync(join(tmpdir(), "backup-command-test-"));
const archive = join(directory, "test.tar.gz");
const argv = [...process.argv];
const lookup = spyOn(config, "findAssistantByName");
const backupOp = spyOn(localMode, "backupAssistant");

beforeEach(() => {
  lookup.mockReset();
  backupOp.mockReset();
});
afterEach(() => {
  process.argv = [...argv];
});
afterAll(() => {
  lookup.mockRestore();
  backupOp.mockRestore();
  rmSync(directory, { recursive: true, force: true });
});

for (const topology of ["local", "docker"] as const) {
  test(`${topology} backup renders the captured archive`, async () => {
    const entry: LockfileAssistant = {
      assistantId: "test",
      cloud: topology,
      port: 7830,
    };
    lookup.mockReturnValue(entry);
    writeFileSync(archive, "tar archive");
    backupOp.mockResolvedValue({ ok: true, kind: "roots", path: archive });
    process.argv = ["bun", "cadet", "backup", "test"];
    await backup();
    expect(backupOp).toHaveBeenCalledWith(entry);
  });
}

test("cloud backup rides the operation and renders the ready line", async () => {
  const entry: LockfileAssistant = {
    assistantId: "cloud-test",
    cloud: "cloud",
  };
  lookup.mockReturnValue(entry);
  backupOp.mockResolvedValue({ ok: true, kind: "cloud" });
  process.argv = ["bun", "cadet", "backup", "cloud-test"];
  await backup();
  expect(backupOp).toHaveBeenCalledWith(entry);
});

test("rejects legacy output names before capture", async () => {
  lookup.mockReturnValue({
    assistantId: "test",
    cloud: "local",
    port: 7830,
  });
  process.argv = [
    "bun",
    "cadet",
    "backup",
    "test",
    "--output",
    "legacy.vbundle",
  ];
  await expect(backup()).rejects.toThrow("Unknown backup option: --output");
  expect(backupOp).not.toHaveBeenCalled();
});

test("a structured op failure throws its error", async () => {
  lookup.mockReturnValue({
    assistantId: "test",
    cloud: "cloud",
  });
  backupOp.mockResolvedValue({
    ok: false,
    status: 401,
    error: "Not logged in. Run 'cadet login' first.",
  });
  process.argv = ["bun", "cadet", "backup", "test"];
  await expect(backup()).rejects.toThrow("cadet login");
});
