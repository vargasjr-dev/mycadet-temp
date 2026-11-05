import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import * as sleepOps from "../operations/sleep";
import * as wakeOps from "../operations/wake";
import * as restoreOps from "../operations/restore";
import * as retireOps from "../operations/retire";
import * as lookup from "../operations/lookup";
import * as backupOps from "../backup-ops";
import * as readiness from "../daemon-readiness";
import * as localTeleport from "../remotes/local/teleport";
import * as dockerTeleport from "../remotes/docker/teleport";
import type { LockfileAssistant } from "../lockfile-contract";
import { teleportAssistant } from "../operations/teleport";

const sleepLeg = spyOn(sleepOps, "sleepAssistant");
const wakeLeg = spyOn(wakeOps, "wakeAssistant");
const restoreLeg = spyOn(restoreOps, "restoreAssistant");
const retireLeg = spyOn(retireOps, "retireAssistant");
const findAssistant = spyOn(lookup, "findAssistantByName");
const createBackupSpy = spyOn(backupOps, "createBackup");
const pruneSpy = spyOn(backupOps, "pruneOldBackups").mockImplementation(
  (() => {}) as never,
);
const healthSpy = spyOn(readiness, "checkHealth");
const livenessSpy = spyOn(readiness, "isAssistantHealthy");

const okSleep = (wasRunning: boolean) =>
  ({
    ok: true,
    wasRunning,
    kind: "services",
    services: {
      assistant: wasRunning ? "stopped" : "not-running",
      gateway: wasRunning ? "stopped" : "not-running",
      ces: wasRunning ? "stopped" : "not-running",
    },
    notes: [],
  }) as never;

const source: LockfileAssistant = {
  assistantId: "source",
  cloud: "local",
  port: 7830,
};
const target: LockfileAssistant = {
  assistantId: "target",
  cloud: "docker",
  port: 7831,
};

let order: string[];
let running: Map<string, boolean>;

beforeEach(() => {
  order = [];
  running = new Map([
    ["source", true],
    ["target", true],
  ]);
  for (const spy of [
    sleepLeg,
    wakeLeg,
    restoreLeg,
    retireLeg,
    findAssistant,
    createBackupSpy,
    healthSpy,
    livenessSpy,
  ]) {
    spy.mockReset();
  }
  sleepLeg.mockImplementation(async (entry) => {
    order.push(`sleep:${entry.assistantId}`);
    const wasRunning = running.get(entry.assistantId) ?? false;
    running.set(entry.assistantId, false);
    return okSleep(wasRunning);
  });
  wakeLeg.mockImplementation(async (entry) => {
    order.push(`wake:${entry.assistantId}`);
    running.set(entry.assistantId, true);
    return { ok: true };
  });
  restoreLeg.mockImplementation(async (args) => {
    order.push(`restore:${args.entry?.assistantId}`);
    return {
      ok: true,
      kind: "roots",
      dryRun: false,
      recoveryPath: "/r.tar.gz",
    };
  });
  retireLeg.mockImplementation(async (entry) => {
    order.push(`retire:${entry.assistantId}`);
    return { ok: true };
  });
  findAssistant.mockImplementation(
    (name) =>
      (({ target, source }) as Record<string, LockfileAssistant>)[name] ?? null,
  );
  createBackupSpy.mockImplementation(async (assistantId) => {
    order.push(`backup:${assistantId}`);
    return `/backups/${assistantId}-pre-teleport.tar.gz`;
  });
  healthSpy.mockImplementation(async (entry: LockfileAssistant) =>
    running.get(entry.assistantId)
      ? ({ version: "0.0.1", status: "healthy", authenticated: true } as never)
      : ({
          version: undefined,
          status: "unreachable",
          authenticated: true,
        } as never),
  );
  livenessSpy.mockImplementation(
    async (entry: LockfileAssistant) => running.get(entry.assistantId) ?? false,
  );
});
afterAll(() => {
  for (const spy of [
    sleepLeg,
    wakeLeg,
    restoreLeg,
    retireLeg,
    findAssistant,
    createBackupSpy,
    pruneSpy,
    healthSpy,
    livenessSpy,
  ]) {
    spy.mockRestore();
  }
});

// ---------------------------------------------------------------------------
// the ideal path: sleep -> backup -> move -> restore -> wake
// ---------------------------------------------------------------------------

test("an existing target rides sleep, backup, restore, wake — then the source retires", async () => {
  const result = await teleportAssistant({
    source,
    targetEnv: "docker",
    targetName: "target",
  });

  expect(result).toEqual({
    ok: true,
    kind: "moved",
    sourceId: "source",
    targetId: "target",
    sourceRetired: true,
  });
  // The transferred archive is the exact stopped-source safety tar; the
  // restore rides the restore operation's own door.
  expect(restoreLeg).toHaveBeenCalledWith({
    entry: target,
    fromPath: "/backups/source-pre-teleport.tar.gz",
  });
  expect(order).toEqual([
    "sleep:source",
    "backup:source",
    "sleep:target",
    "restore:target",
    "wake:target",
    "retire:source",
  ]);
  expect(pruneSpy).toHaveBeenCalledWith("source", 3, "pre-teleport");
});

test("keep-source retains the stopped original", async () => {
  const result = await teleportAssistant({
    source,
    targetEnv: "docker",
    targetName: "target",
    keepSource: true,
  });

  expect(result).toEqual({
    ok: true,
    kind: "moved",
    sourceId: "source",
    targetId: "target",
    sourceRetired: false,
  });
  expect(retireLeg).not.toHaveBeenCalled();
});

test("a fresh target initializes from the archive and wakes — the install is the restore", async () => {
  const localInit = spyOn(localTeleport, "initializeLocalTeleportTarget");
  const dockerInit = spyOn(dockerTeleport, "initializeDockerTeleportTarget");
  findAssistant.mockImplementation((name) =>
    name === "source" ? source : null,
  );
  const fresh = { ...target, assistantId: "fresh-1" };
  dockerInit.mockImplementation(async (instanceName) => {
    order.push(`init:docker:${instanceName}`);
    return fresh;
  });
  try {
    const result = await teleportAssistant({
      source,
      targetEnv: "docker",
      targetName: "fresh-1",
    });

    expect(result).toEqual({
      ok: true,
      kind: "moved",
      sourceId: "source",
      targetId: "fresh-1",
      sourceRetired: true,
    });
    // The target becomes ready before the source retires.
    expect(order).toEqual([
      "sleep:source",
      "backup:source",
      "init:docker:fresh-1",
      "wake:fresh-1",
      "retire:source",
    ]);
    expect(restoreLeg).not.toHaveBeenCalled();
    expect(localInit).not.toHaveBeenCalled();
  } finally {
    dockerInit.mockRestore();
    localInit.mockRestore();
  }
});

test("a fresh local target rides the local init arm", async () => {
  const localInit = spyOn(localTeleport, "initializeLocalTeleportTarget");
  findAssistant.mockImplementation((name) =>
    name === "source" ? source : null,
  );
  const fresh = { ...source, assistantId: "fresh-2" };
  localInit.mockImplementation(async (instanceName) => {
    order.push(`init:local:${instanceName}`);
    return fresh;
  });
  try {
    await teleportAssistant({
      source: { ...source, cloud: "docker" },
      targetEnv: "local",
      targetName: "fresh-2",
    });

    expect(order).toContain("init:local:fresh-2");
  } finally {
    localInit.mockRestore();
  }
});

test("a dry run reports the move without stopping anything or creating archives", async () => {
  const result = await teleportAssistant({
    source,
    targetEnv: "docker",
    targetName: "target",
    dryRun: true,
    keepSource: true,
  });

  expect(result.ok).toBe(true);
  if (result.ok && result.kind === "dry-run") {
    expect(result.lines.join(" ")).toContain("Would move");
    expect(result.lines.join(" ")).toContain("keep the source stopped");
  }
  expect(order).toEqual([]);
  expect(createBackupSpy).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// the refusals that run before anything stops
// ---------------------------------------------------------------------------

test("a cloud destination refuses before any host operation", async () => {
  const result = await teleportAssistant({
    source,
    targetEnv: "cloud",
  });
  expect(result).toEqual({
    ok: false,
    status: 400,
    error:
      "Cloud teleport is unavailable until cloud root archive transfer is supported. No installation was changed.",
  });
  expect(order).toEqual([]);
});

test("a cloud or apple-container source refuses before any host operation", async () => {
  for (const cloud of ["cloud", "apple-container"] as const) {
    const result = await teleportAssistant({
      source: { ...source, cloud } as never,
      targetEnv: "docker",
    });
    expect(result.ok).toBe(false);
    expect(order).toEqual([]);
  }
});

test("the same environment refuses before any host operation", async () => {
  const result = await teleportAssistant({
    source,
    targetEnv: "local",
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("Cannot teleport between two local");
  }
  expect(order).toEqual([]);
});

test("an existing target of the wrong environment refuses before any host operation", async () => {
  findAssistant.mockImplementation((name) =>
    name === "target" ? { ...target, cloud: "local" } : null,
  );
  const mismatch = await teleportAssistant({
    source,
    targetEnv: "docker",
    targetName: "target",
  });
  expect(mismatch.ok).toBe(false);
  if (!mismatch.ok) {
    expect(mismatch.error).toContain("is a local assistant, not docker");
  }
  expect(order).toEqual([]);
});

test("a multi-patch downgrade fails before shutdown", async () => {
  healthSpy.mockImplementation(async (entry: LockfileAssistant) =>
    entry.assistantId === "source"
      ? ({ version: "1.2.3", status: "healthy", authenticated: true } as never)
      : ({ version: "1.0.0", status: "healthy", authenticated: true } as never),
  );
  const result = await teleportAssistant({
    source,
    targetEnv: "docker",
    targetName: "target",
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("older than source");
  }
  expect(order).toEqual([]);
});

// ---------------------------------------------------------------------------
// the failure rewinds what it can
// ---------------------------------------------------------------------------

test("a source backup failure wakes the source and never touches the target", async () => {
  createBackupSpy.mockResolvedValue(null);
  const result = await teleportAssistant({
    source,
    targetEnv: "docker",
    targetName: "target",
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("Could not capture 'source'");
  }
  expect(order).toEqual(["sleep:source", "wake:source"]);
  expect(restoreLeg).not.toHaveBeenCalled();
});

test("a failed graceful shutdown aborts with sleep's own error", async () => {
  sleepLeg.mockImplementation(
    async () =>
      ({
        ok: false,
        status: 500,
        error: "the process tree refused to stop",
        wasRunning: true,
      }) as never,
  );
  const result = await teleportAssistant({
    source,
    targetEnv: "docker",
    targetName: "target",
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("the process tree refused to stop");
  }
  expect(order).toEqual([]);
});

test("a failed restore resumes a running target and wakes the source", async () => {
  restoreLeg.mockImplementation(async (args) => {
    order.push(`restore:${args.entry?.assistantId}`);
    return { ok: false, status: 500, error: "the archive refused to unpack" };
  });
  const result = await teleportAssistant({
    source,
    targetEnv: "docker",
    targetName: "target",
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("the archive refused to unpack");
  }
  expect(order).toEqual([
    "sleep:source",
    "backup:source",
    "sleep:target",
    "restore:target",
    "wake:target",
    "wake:source",
  ]);
});

test("an originally sleeping source stays asleep on a failure", async () => {
  running.set("source", false);
  createBackupSpy.mockResolvedValue(null);
  const result = await teleportAssistant({
    source,
    targetEnv: "docker",
    targetName: "target",
  });

  expect(result.ok).toBe(false);
  expect(order).toEqual(["sleep:source"]);
});

test("a failed new-target wake cleans the target up before waking the source", async () => {
  const dockerInit = spyOn(dockerTeleport, "initializeDockerTeleportTarget");
  findAssistant.mockImplementation((name) =>
    name === "source" ? source : null,
  );
  dockerInit.mockImplementation(async (instanceName) => {
    order.push(`init:docker:${instanceName}`);
    return { ...target, assistantId: instanceName };
  });
  wakeLeg.mockImplementation(async (entry) => {
    order.push(`wake:${entry.assistantId}`);
    if (entry.assistantId === "fresh-3") {
      return { ok: false, status: 503, error: "the gateway refused to start" };
    }
    running.set(entry.assistantId, true);
    return { ok: true };
  });
  try {
    const result = await teleportAssistant({
      source,
      targetEnv: "docker",
      targetName: "fresh-3",
    });

    expect(result.ok).toBe(false);
    // The half-built target is slept and retired, then the source rewinds.
    expect(order).toEqual([
      "sleep:source",
      "backup:source",
      "init:docker:fresh-3",
      "wake:fresh-3",
      "sleep:fresh-3",
      "retire:fresh-3",
      "wake:source",
    ]);
  } finally {
    dockerInit.mockRestore();
  }
});

test("a source restarted during transfer is retained to preserve newer writes", async () => {
  // The source comes back up between the restore and the retirement.
  livenessSpy.mockImplementation(async (entry) =>
    entry.assistantId === "source"
      ? true
      : (running.get(entry.assistantId) ?? false),
  );
  const result = await teleportAssistant({
    source,
    targetEnv: "docker",
    targetName: "target",
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("retained to preserve newer writes");
  }
  expect(order).not.toContain("retire:source");
});
