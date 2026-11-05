import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as cloudRestore from "../remotes/cloud/restore";
import * as localRestore from "../remotes/local/restore";
import * as dockerRestore from "../remotes/docker/restore";
import * as localArchive from "../remotes/local/archive";
import * as execModule from "../exec";
import * as localInstance from "../remotes/local/instance";
import * as wakeOps from "../operations/wake";
import type { LockfileAssistant } from "../lockfile-contract";
import { restoreAssistant } from "../operations/restore";

const cloudLeg = spyOn(cloudRestore, "restoreCloud");
const localLeg = spyOn(localRestore, "restoreLocal");
const dockerLeg = spyOn(dockerRestore, "restoreDocker");

beforeEach(() => {
  cloudLeg.mockReset();
  localLeg.mockReset();
  dockerLeg.mockReset();
});
afterAll(() => {
  for (const spy of [cloudLeg, localLeg, dockerLeg]) spy.mockRestore();
});

const fromPath = "/somewhere/backup.tar.gz";

for (const topology of ["local", "docker"] as const) {
  test(`${topology} restore rides the roots leg and maps the recovery path`, async () => {
    const entry: LockfileAssistant = {
      assistantId: "test",
      cloud: topology,
      port: 7830,
    };
    const leg = topology === "local" ? localLeg : dockerLeg;
    leg.mockResolvedValue({
      ok: true,
      dryRun: false,
      recoveryPath: "/somewhere/recovery.tar.gz",
    });

    const result = await restoreAssistant({ entry, fromPath });

    expect(result).toEqual({
      ok: true,
      kind: "roots",
      dryRun: false,
      recoveryPath: "/somewhere/recovery.tar.gz",
    });
    expect(leg).toHaveBeenCalledWith(entry, { fromPath, dryRun: false });
    expect(cloudLeg).not.toHaveBeenCalled();
  });
}

test("cloud restore rides the cloud leg; the dry run maps the preflight report", async () => {
  const entry: LockfileAssistant = {
    assistantId: "cloud-test",
    cloud: "cloud",
  };
  cloudLeg.mockResolvedValue({
    ok: true,
    dryRun: true,
    preflight: {
      filesToCreate: 2,
      filesToOverwrite: 1,
      filesUnchanged: 3,
      totalFiles: 6,
      conflicts: [],
      files: [{ path: "workspace/x", action: "create" }],
    },
  });

  const result = await restoreAssistant({ entry, fromPath, dryRun: true });

  expect(result).toEqual({
    ok: true,
    kind: "cloud",
    dryRun: true,
    preflight: {
      filesToCreate: 2,
      filesToOverwrite: 1,
      filesUnchanged: 3,
      totalFiles: 6,
      conflicts: [],
      files: [{ path: "workspace/x", action: "create" }],
    },
  });
  expect(cloudLeg).toHaveBeenCalledWith(entry, {
    fromPath,
    dryRun: true,
    log: undefined,
  });
  expect(localLeg).not.toHaveBeenCalled();
});

test("a cloud leg refusal passes through untouched", async () => {
  const entry: LockfileAssistant = {
    assistantId: "cloud-test",
    cloud: "cloud",
  };
  cloudLeg.mockResolvedValue({
    ok: false,
    status: 401,
    error: "Not logged in.",
  });

  const result = await restoreAssistant({ entry, fromPath });

  expect(result).toEqual({ ok: false, status: 401, error: "Not logged in." });
});

test("the router refuses the topologies that run on their own host", async () => {
  const entry: LockfileAssistant = {
    assistantId: "baseten-test",
    cloud: "baseten",
    sandboxUrl: "https://sandbox.example.test",
    port: 7830,
  };

  const result = await restoreAssistant({ entry, fromPath });

  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("baseten");
  expect(cloudLeg).not.toHaveBeenCalled();
  expect(localLeg).not.toHaveBeenCalled();
  expect(dockerLeg).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// the recovery arm — the retire-archive recovery, reached through the one operation
// ---------------------------------------------------------------------------

const retiredDir = mkdtempSync(join(tmpdir(), "restore-operation-retired-"));
const instanceDir = mkdtempSync(join(tmpdir(), "restore-operation-instance-"));
const archivePath = join(retiredDir, "retired-one.tar.gz");
const metadataPath = join(retiredDir, "retired-one.metadata.json");

const archivePaths = spyOn(localArchive, "getArchivePath");
const metadataPaths = spyOn(localArchive, "getMetadataPath");
const instanceDirOf = spyOn(localInstance, "getLocalInstanceDir");
const wake = spyOn(wakeOps, "wakeAssistant");

/**
 * The wake tests' mock.module("../exec") is process-permanent, so the
 * recovery's tar call is spied rather than run: the simulated extraction
 * materialises the staged dir the real tarball would unpack.
 */
const execSpy = spyOn(execModule, "exec").mockImplementation((async (
  _cmd: string,
  args: string[],
) => {
  if (args[0] === "xzf") {
    // The real tarball's top-level entry is "<archive basename>.staging",
    // unpacked into the -C target (args[3]).
    const staging = join(args[3]!, `${basename(args[1]!)}.staging`);
    mkdirSync(join(staging, "workspace"), { recursive: true });
    writeFileSync(join(staging, "workspace", "keep.txt"), "roots");
  }
  return { stdout: "", stderr: "", code: 0 };
}) as never);

function stageRetiredArchive(
  name: string,
  metadata: unknown,
): { archive: string; metadata: string; target: string } {
  const archive = join(retiredDir, `${name}.tar.gz`);
  writeFileSync(archive, "tar archive");
  const metadataFile = join(retiredDir, `${name}.metadata.json`);
  writeFileSync(metadataFile, JSON.stringify(metadata));
  return { archive, metadata: metadataFile, target: join(instanceDir, name) };
}

beforeEach(() => {
  wake.mockReset();
  wake.mockResolvedValue({ ok: true });
  archivePaths.mockImplementation(((name: string) =>
    join(retiredDir, `${name}.tar.gz`)) as never);
  metadataPaths.mockImplementation(((name: string) =>
    join(retiredDir, `${name}.metadata.json`)) as never);
  instanceDirOf.mockImplementation(((entry: { assistantId: string }) =>
    join(instanceDir, entry.assistantId)) as never);
});
afterAll(() => {
  for (const spy of [archivePaths, metadataPaths, instanceDirOf, wake, execSpy])
    spy.mockRestore();
  rmSync(retiredDir, { recursive: true, force: true });
  rmSync(instanceDir, { recursive: true, force: true });
});

test("recovering a name with no archive refuses with 404", async () => {
  const result = await restoreAssistant({ name: "no-such-archive" });
  expect(result).toEqual({
    ok: false,
    status: 404,
    error: "No retired archive found for 'no-such-archive'.",
  });
  expect(wake).not.toHaveBeenCalled();
});

test("recovering a non-local archive refuses", async () => {
  const staged = stageRetiredArchive("retired-cloud", {
    assistantId: "cloud-one",
    cloud: "cloud",
  });
  const result = await restoreAssistant({ name: "retired-cloud" });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.status).toBe(400);
    expect(result.error).toContain("only local archives");
  }
  expect(existsSync(staged.archive)).toBe(true);
  expect(wake).not.toHaveBeenCalled();
});

test("recovering onto an owned target refuses with 409", async () => {
  const staged = stageRetiredArchive("retired-owned", {
    assistantId: "retired-owned",
    cloud: "local",
    port: 7830,
  });
  mkdirSync(staged.target, { recursive: true });
  const result = await restoreAssistant({ name: "retired-owned" });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.status).toBe(409);
    expect(result.error).toContain("already exists");
  }
  expect(wake).not.toHaveBeenCalled();
});

test("recovery extracts the instance dir, restores the entry, wakes, and clears the archive", async () => {
  const staged = stageRetiredArchive("retired-one", {
    assistantId: "retired-one",
    cloud: "local",
    port: 7830,
  });

  const result = await restoreAssistant({ name: "retired-one" });

  expect(result).toEqual({ ok: true, kind: "recovery" });
  expect(existsSync(staged.target)).toBe(true);
  expect(existsSync(join(staged.target, "workspace", "keep.txt"))).toBe(true);
  expect(existsSync(staged.archive)).toBe(false);
  expect(existsSync(staged.metadata)).toBe(false);
  expect(wake).toHaveBeenCalledTimes(1);
});
test("recovery creates the target's parent directories when they do not exist", async () => {
  const name = "deep-nested-instance";
  const nestedTarget = join(instanceDir, "new-parent", "deeper", name);
  instanceDirOf.mockImplementation((() => nestedTarget) as never);
  const staged = stageRetiredArchive(name, {
    assistantId: name,
    cloud: "local",
    port: 7830,
  });

  const result = await restoreAssistant({ name });

  expect(result).toEqual({ ok: true, kind: "recovery" });
  expect(existsSync(nestedTarget)).toBe(true);
  expect(existsSync(join(nestedTarget, "workspace", "keep.txt"))).toBe(true);
  expect(existsSync(staged.archive)).toBe(false);
});
