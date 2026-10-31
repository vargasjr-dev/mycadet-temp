import { getGatewayUrl } from "@mycadet/local-mode/contract";
import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import * as backups from "../lib/backup-ops.js";
import * as docker from "../lib/docker.js";
import * as lifecycle from "../lib/upgrade-lifecycle.js";
import * as config from "../lib/assistant-config.js";
import * as localMode from "@mycadet/local-mode";
import { mockCommands } from "./commands-mock.js";
import * as loopback from "../lib/loopback-fetch.js";

const capture = spyOn(backups, "createBackup");
const images = spyOn(docker, "captureImageRefs");
const pull = spyOn(docker, "pullImage");
const wake = spyOn(docker, "wakeContainers");
const save = spyOn(localMode, "saveLockfileAssistant");
const restore = spyOn(backups, "restoreBackup");
const sleep = spyOn(docker, "sleepContainers");
const stop = spyOn(docker, "stopContainers");
const start = spyOn(docker, "startContainers");
const fetch = spyOn(loopback, "loopbackSafeFetch");
const res = docker.dockerResourceNames("recovery");
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
  stop.mockReset();
  start.mockReset();
  fetch.mockReset();
  restore.mockImplementation(async () => {
    events.push("restore-roots");
    return true;
  });
  sleep.mockImplementation(async () => {
    events.push("sleep");
  });
  stop.mockImplementation(async () => {
    events.push("remove");
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
    stop,
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
      assistantId: "recovery",
      backupPath: "pre-upgrade.tar.gz",
      backupLabel: "pre-upgrade",
      res,
      containerOptions,
    }),
  ).toEqual({ restored: true, ready: true });
  expect(restore).toHaveBeenCalledWith(
    "http://127.0.0.1:7830",
    "recovery",
    "pre-upgrade.tar.gz",
    { resume: false },
  );
  expect(events).toEqual([
    "restore-roots",
    "sleep",
    "remove",
    "start-old-version",
    "check-ready",
  ]);
});

test("failed root restore does not restart a partial installation", async () => {
  restore.mockResolvedValue(false);
  expect(
    await lifecycle.attemptFailedStateRestore({
      runtimeUrl: "http://127.0.0.1:7830",
      assistantId: "recovery",
      backupPath: "pre-upgrade.tar.gz",
      backupLabel: "pre-upgrade",
      res,
      containerOptions,
    }),
  ).toEqual({ restored: false, ready: false });
  expect(start).not.toHaveBeenCalled();
  expect(stop).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

test("versioned restore installs roots into stopped target containers before first startup", async () => {
  const commands = mockCommands();
  commands.on(
    "docker",
    (args) => args[0] === "inspect",
    () => ({
      stdout: JSON.stringify(["ACTOR_TOKEN_SIGNING_KEY=" + "01".repeat(32)]),
    }),
  );
  const entry: config.LockfileAssistant = {
    assistantId: "recovery",
    cloud: "docker",
    port: 7830,
  };
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
    expect(options.createOnly).toBe(true);
    events.push("create-stopped-target");
  });
  wake.mockImplementation(async () => {
    events.push("wake-restored-target");
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
  try {
    await lifecycle.performDockerRollback(entry, {
      targetVersion: "0.12.10",
      backupPath: "/tmp/source.tar.gz",
    });
    expect(restore).toHaveBeenCalledWith(
      getGatewayUrl(entry),
      entry.assistantId,
      "/tmp/source.tar.gz",
      { resume: false },
    );
    expect(events).toEqual([
      "capture-safety",
      "sleep",
      "remove",
      "create-stopped-target",
      "restore-roots",
      "wake-restored-target",
      "check-ready",
    ]);
  } finally {
    commands.restore();
  }
});
