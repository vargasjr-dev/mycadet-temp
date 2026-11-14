/**
 * The docker upgrade's recovery core: failed-state restore ordering and the
 * versioned rollback's stop → install → wake sequence. The subprocess fake
 * harness stays cli-side (shared with the teleport tests).
 */
import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import * as backups from "../backup-ops";
import * as dockerUpgrade from "../remotes/docker/upgrade";
import * as dockerWake from "../remotes/docker/wake";
import * as lifecycle from "../upgrade-lifecycle";
import * as localMode from "..";
import * as sleepDockerModule from "../remotes/docker/sleep";
import { mockChildProcessSpawn } from "./helpers/child-process-mock";
import type { LockfileAssistant } from "../lockfile-contract";

const capture = spyOn(backups, "createBackup");
const images = spyOn(dockerUpgrade, "captureImageRefs");
const pull = spyOn(localMode, "pullImage");
const wake = spyOn(dockerWake, "wakeDocker");
const save = spyOn(localMode, "saveLockfileAssistant");
const restore = spyOn(backups, "restoreBackup");
const sleep = spyOn(sleepDockerModule, "sleepDocker");
const start = spyOn(dockerWake, "startContainers");
const fetch = spyOn(localMode, "loopbackSafeFetch");
const res = localMode.dockerResourceNames("recovery");
const entry: LockfileAssistant = {
  assistantId: "recovery",
  cloud: "docker",
  port: 7830,
};
const containerOptions = {
  gatewayPort: 7830,
  assistantPort: 3001,
  imageTags: {
    assistant: "assistant:old",
    gateway: "gateway:old",
    "credential-executor": "ces:old",
  },
  instanceName: "recovery",
  res,
};
const events: string[] = [];
beforeEach(() => {
  events.length = 0;
  capture.mockReset();
  images.mockReset();
  pull.mockReset();
  wake.mockReset();
  save.mockReset();
  save.mockImplementation(() => ({
    ok: true,
    lockfile: { assistants: [], activeAssistant: null },
  }));
  restore.mockReset();
  sleep.mockReset();
  start.mockReset();
  fetch.mockReset();
  restore.mockImplementation(async () => {
    events.push("restore-roots");
    return true;
  });
  sleep.mockImplementation(async () => {
    events.push("sleep");
  });
  start.mockImplementation(async () => {
    events.push("start-old-version");
  });
  fetch.mockImplementation(async () => {
    events.push("check-ready");
    return Response.json({ ready: true });
  });
});
afterAll(() => {
  for (const spy of [
    restore,
    sleep,
    start,
    fetch,
    capture,
    images,
    pull,
    wake,
    save,
  ])
    spy.mockRestore();
});

test("failed-state recovery restores tar roots while stopped before restarting old services", async () => {
  expect(
    await lifecycle.attemptFailedStateRestore({
      runtimeUrl: "http://127.0.0.1:7830",
      entry,
      backupPath: "pre-upgrade.tar.gz",
      backupLabel: "pre-upgrade",
      res,
      containerOptions,
    }),
  ).toEqual({ restored: true, ready: true });
  expect(restore).toHaveBeenCalledWith("recovery", "pre-upgrade.tar.gz", {
    resume: false,
  });
  expect(events).toEqual([
    "restore-roots",
    "sleep",
    "start-old-version",
    "check-ready",
  ]);
});

test("failed root restore does not restart a partial installation", async () => {
  restore.mockResolvedValue(false);
  expect(
    await lifecycle.attemptFailedStateRestore({
      runtimeUrl: "http://127.0.0.1:7830",
      entry,
      backupPath: "pre-upgrade.tar.gz",
      backupLabel: "pre-upgrade",
      res,
      containerOptions,
    }),
  ).toEqual({ restored: false, ready: false });
  expect(start).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

test("versioned restore installs roots into stopped target containers before first startup", async () => {
  // The docker `inspect` that reads the stopped container's env goes through
  // the package's child-process mock (the house spawn seam — a leaked spy on
  // the builtin namespace strips `spawn` for every later file in the run).
  await mockChildProcessSpawn((command, args) => {
    if (command === "docker" && args[0] === "inspect") {
      return {
        stdout: JSON.stringify(["PATH=/usr/local/bin:/usr/bin"]),
        code: 0,
        pid: 4242,
        unref: () => {},
      };
    }
    // The archive/restore path spawns detached tar processes that only
    // unref — give them a real-shaped child so the mock stays whole.
    return { stdout: "", code: 0, pid: 4243, unref: () => {} };
  });

  capture.mockImplementation(async () => {
    events.push("capture-safety");
    return "/tmp/pre-rollback.tar.gz";
  });
  images.mockResolvedValue({
    assistant: "assistant:current",
    gateway: "gateway:current",
    "credential-executor": "ces:current",
  });
  pull.mockResolvedValue(undefined);
  start.mockImplementation(async (options) => {
    expect((options as { createOnly?: boolean }).createOnly).toBe(true);
    events.push("create-stopped-target");
  });
  wake.mockImplementation(async () => {
    events.push("wake-restored-target");
    return { ok: true };
  });
  fetch.mockImplementation(async (url) => {
    if (String(url).includes("/healthz"))
      return Response.json({ version: "0.12.11" });
    if (String(url).includes("/readyz")) {
      events.push("check-ready");
      return Response.json({ ready: true });
    }
    return Response.json({});
  });
  await lifecycle.performDockerRollback(entry, {
    targetVersion: "0.12.10",
    backupPath: "/tmp/source.tar.gz",
  });
  expect(restore).toHaveBeenCalledWith(
    entry.assistantId,
    "/tmp/source.tar.gz",
    {
      resume: false,
    },
  );
  expect(events).toEqual([
    "capture-safety",
    "sleep",
    "create-stopped-target",
    "restore-roots",
    "wake-restored-target",
    "check-ready",
  ]);
});
