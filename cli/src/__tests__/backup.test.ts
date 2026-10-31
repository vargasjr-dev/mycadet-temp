import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as config from "../lib/assistant-config.js";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";
import * as backupOps from "../lib/backup-ops.js";
import * as roots from "../lib/root-backup.js";
import * as cloud from "../lib/cloud-client.js";
import * as platform from "../lib/teleport-backup.js";
import * as guardian from "../lib/guardian-token.js";
import { backup } from "../commands/backup.js";

const directory = mkdtempSync(join(tmpdir(), "backup-command-test-"));
const argv = [...process.argv];
const lookup = spyOn(config, "findAssistantByName");
const backupDir = spyOn(backupOps, "getBackupsDir").mockReturnValue(directory);
const capture = spyOn(roots, "createRootBackup");
const readToken = spyOn(cloud, "readCloudToken");
const cloudBackup = spyOn(platform, "createPlatformBackup");
const guardianRead = spyOn(guardian, "loadGuardianToken");
const guardianLease = spyOn(guardian, "leaseGuardianToken");

beforeEach(() => {
  lookup.mockReset();
  capture.mockReset();
  readToken.mockReset();
  cloudBackup.mockReset();
  guardianRead.mockReset();
  guardianLease.mockReset();
  capture.mockImplementation(async (_entry, path) => {
    writeFileSync(path, "tar archive");
  });
  readToken.mockReturnValue("session-token");
  cloudBackup.mockResolvedValue(undefined);
  guardianRead.mockImplementation(() => {
    throw new Error("must not read guardian tokens");
  });
  guardianLease.mockImplementation(async () => {
    throw new Error("must not lease guardian tokens");
  });
});
afterEach(() => {
  process.argv = [...argv];
});
afterAll(() => {
  for (const spy of [
    lookup,
    capture,
    backupDir,
    readToken,
    cloudBackup,
    guardianRead,
    guardianLease,
  ])
    spy.mockRestore();
  rmSync(directory, { recursive: true, force: true });
});

for (const topology of ["local", "docker"] as const) {
  test(`${topology} backup uses root storage without runtime auth`, async () => {
    const entry: LockfileAssistant = {
      assistantId: "test",
      cloud: topology,
      port: 7830,
    };
    lookup.mockReturnValue(entry);
    process.argv = ["bun", "cadet", "backup", "test"];
    await backup();
    expect(capture).toHaveBeenCalledWith(
      entry,
      expect.stringMatching(new RegExp(`^${directory}/test-.*\\.tar\\.gz$`)),
    );
    expect(guardianRead).not.toHaveBeenCalled();
    expect(guardianLease).not.toHaveBeenCalled();
    expect(cloudBackup).not.toHaveBeenCalled();
  });
}

test("cloud backup calls the cloud backup API with session authentication", async () => {
  const entry: LockfileAssistant = {
    assistantId: "cloud-test",
    cloud: "cloud",
  };
  lookup.mockReturnValue(entry);
  process.argv = ["bun", "cadet", "backup", "cloud-test"];
  await backup();
  expect(cloudBackup).toHaveBeenCalledWith(entry, "session-token");
  expect(capture).not.toHaveBeenCalled();
  expect(guardianRead).not.toHaveBeenCalled();
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
  expect(capture).not.toHaveBeenCalled();
});

test("cloud backup requires cloud login and rejects host output paths", async () => {
  lookup.mockReturnValue({
    assistantId: "test",
    cloud: "cloud",
  });
  process.argv = [
    "bun",
    "cadet",
    "backup",
    "test",
    "--output",
    "backup.tar.gz",
  ];
  await expect(backup()).rejects.toThrow("Unknown backup option: --output");
  process.argv = ["bun", "cadet", "backup", "test"];
  readToken.mockReturnValue(null);
  await expect(backup()).rejects.toThrow("cadet login");
  expect(cloudBackup).not.toHaveBeenCalled();
});
