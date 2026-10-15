import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as config from "../lib/assistant-config.js";
import * as roots from "../lib/root-backup.js";
import * as cloud from "../lib/cloud-client.js";
import * as lifecycle from "../lib/upgrade-lifecycle.js";
import * as guardian from "../lib/guardian-token.js";
import { restore } from "../commands/restore.js";

const directory = await mkdtemp(join(tmpdir(), "root-restore-command-"));
const file = join(directory, "backup.tar.gz");
const source = join(directory, "source");
for (const root of roots.STATE_ROOTS)
  await mkdir(join(source, root), { recursive: true });
await writeFile(
  join(source, "gateway-security", "actor-token-signing-key"),
  Buffer.alloc(32, 1),
);
await roots.packRoot(source, file);
const argv = [...process.argv];
const lookup = spyOn(config, "findAssistantByName");
const versionRestore = spyOn(lifecycle, "performDockerRollback");
const hostRestore = spyOn(roots, "restoreRootBackup");
const token = spyOn(cloud, "readCloudToken");
const signedUrl = spyOn(cloud, "cloudRequestSignedUrl");
const upload = spyOn(cloud, "platformUploadToSignedUrl");
const importCloud = spyOn(cloud, "platformImportBundleFromGcs");
const guardianRead = spyOn(guardian, "loadGuardianToken");
const guardianLease = spyOn(guardian, "leaseGuardianToken");

beforeEach(() => {
  for (const spy of [
    lookup,
    hostRestore,
    versionRestore,
    token,
    signedUrl,
    upload,
    importCloud,
    guardianRead,
    guardianLease,
  ])
    spy.mockReset();
  versionRestore.mockResolvedValue(undefined);
  hostRestore.mockResolvedValue(join(directory, "recovery.tar.gz"));
  token.mockReturnValue("session-token");
  signedUrl.mockResolvedValue({
    url: "https://storage.googleapis.com/upload",
    bundleKey: "root-archive",
    expiresAt: "2026-10-15T00:00:00Z",
  });
  upload.mockResolvedValue(undefined);
  importCloud.mockResolvedValue({ statusCode: 200, body: { success: true } });
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
afterAll(async () => {
  for (const spy of [
    lookup,
    hostRestore,
    versionRestore,
    token,
    signedUrl,
    upload,
    importCloud,
    guardianRead,
    guardianLease,
  ])
    spy.mockRestore();
  await rm(directory, { recursive: true, force: true });
});

for (const topology of ["local", "docker"] as const) {
  test(`${topology} restore uses root storage without runtime authentication`, async () => {
    const entry: config.AssistantEntry = {
      assistantId: "test",
      cloud: topology,
      runtimeUrl: "http://127.0.0.1:1",
    };
    lookup.mockReturnValue(entry);
    process.argv = ["bun", "cadet", "restore", "test", "--from", file];
    await restore();
    expect(hostRestore).toHaveBeenCalledWith(entry, file, { dryRun: false });
    expect(guardianRead).not.toHaveBeenCalled();
    expect(guardianLease).not.toHaveBeenCalled();
    expect(importCloud).not.toHaveBeenCalled();
  });
}

test("cloud restore uploads tar and calls the cloud API using the assistant's cloud session", async () => {
  const entry: config.AssistantEntry = {
    assistantId: "cloud-test",
    cloud: "cloud",
    runtimeUrl: "https://cloud.mycadet.ai",
  };
  lookup.mockReturnValue(entry);
  process.argv = ["bun", "cadet", "restore", "cloud-test", "--from", file];
  await restore();
  expect(signedUrl).toHaveBeenCalledWith(
    { operation: "upload" },
    "session-token",
    entry.runtimeUrl,
  );
  expect(upload).toHaveBeenCalled();
  expect(importCloud).toHaveBeenCalledWith(
    "root-archive",
    "session-token",
    entry.runtimeUrl,
  );
  expect(hostRestore).not.toHaveBeenCalled();
  expect(guardianRead).not.toHaveBeenCalled();
});

test("Docker version restore passes the archive to the version switch as one operation", async () => {
  const entry: config.AssistantEntry = {
    assistantId: "docker-test",
    cloud: "docker",
    runtimeUrl: "http://127.0.0.1:1",
  };
  lookup.mockReturnValue(entry);
  process.argv = [
    "bun",
    "cadet",
    "restore",
    "docker-test",
    "--from",
    file,
    "--version",
    "0.12.10",
  ];
  await restore();
  expect(versionRestore).toHaveBeenCalledWith(entry, {
    targetVersion: "0.12.10",
    backupPath: file,
  });
  expect(hostRestore).not.toHaveBeenCalled();
});
