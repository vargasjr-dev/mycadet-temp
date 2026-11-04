import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cloudAuth from "../cloud-auth";
import * as cloudBackups from "../cloud-backup";
import * as rootBackup from "../root-backup";
import * as backupOps from "../backup-ops";
import type { LockfileAssistant } from "../lockfile-contract";
import { backupAssistant } from "../operations/backup";

const directory = mkdtempSync(join(tmpdir(), "backup-operation-test-"));
const readToken = spyOn(cloudAuth, "readCloudToken");
const cloudBackup = spyOn(cloudBackups, "createCloudBackup");
const backupDir = spyOn(backupOps, "getBackupsDir").mockReturnValue(directory);
const capture = spyOn(rootBackup, "createRootBackup");

beforeEach(() => {
  capture.mockReset();
  cloudBackup.mockReset();
  readToken.mockReset();
  capture.mockImplementation(async (_entry, path) => {
    writeFileSync(path, "tar archive");
  });
  readToken.mockReturnValue("session-token");
  cloudBackup.mockResolvedValue(undefined);
});
afterAll(() => {
  for (const spy of [readToken, cloudBackup, backupDir, capture])
    spy.mockRestore();
  rmSync(directory, { recursive: true, force: true });
});

for (const topology of ["local", "docker"] as const) {
  test(`${topology} backup captures the roots archive without session auth`, async () => {
    const entry: LockfileAssistant = {
      assistantId: "test",
      cloud: topology,
      port: 7830,
    };
    const result = await backupAssistant(entry);
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === "roots") {
      expect(result.path).toMatch(
        new RegExp(`^${directory}/test-.*\\.tar\\.gz$`),
      );
    }
    expect(capture).toHaveBeenCalledWith(
      entry,
      expect.stringMatching(new RegExp(`^${directory}/test-.*\\.tar\\.gz$`)),
    );
    expect(readToken).not.toHaveBeenCalled();
    expect(cloudBackup).not.toHaveBeenCalled();
  });
}

test("cloud backup rides the cloud API with the stored session token", async () => {
  const entry: LockfileAssistant = {
    assistantId: "cloud-test",
    cloud: "cloud",
  };
  const result = await backupAssistant(entry);
  expect(result).toEqual({ ok: true, kind: "cloud" });
  expect(cloudBackup).toHaveBeenCalledWith(entry, "session-token");
  expect(capture).not.toHaveBeenCalled();
});

test("cloud backup without a session refuses with the login pointer", async () => {
  const entry: LockfileAssistant = {
    assistantId: "cloud-test",
    cloud: "cloud",
  };
  readToken.mockReturnValue(null);
  const result = await backupAssistant(entry);
  expect(result).toEqual({
    ok: false,
    status: 401,
    error: "Not logged in. Run 'cadet login' first.",
  });
  expect(cloudBackup).not.toHaveBeenCalled();
});

test("a topology hosted elsewhere refuses", async () => {
  const entry = {
    assistantId: "remote-test",
    cloud: "baseten",
  } as unknown as LockfileAssistant;
  const result = await backupAssistant(entry);
  expect(result).toEqual({
    ok: false,
    status: 400,
    error:
      "Backup for 'baseten' must run on its host; only local, Docker and cloud backups are supported.",
  });
  expect(capture).not.toHaveBeenCalled();
  expect(cloudBackup).not.toHaveBeenCalled();
});
