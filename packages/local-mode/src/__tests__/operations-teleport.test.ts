import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import * as sleepOps from "../operations/sleep";
import * as wakeOps from "../operations/wake";
import * as retireOps from "../operations/retire";
import * as backupOps from "../backup-ops";
import * as readiness from "../daemon-readiness";
import * as lookup from "../operations/lookup";
import * as localTeleport from "../remotes/local/teleport";
import * as dockerTeleport from "../remotes/docker/teleport";
import type { LockfileAssistant } from "../lockfile-contract";
import { teleportAssistant } from "../operations/teleport";

const sleepLeg = spyOn(sleepOps, "sleepAssistant");
const wakeLeg = spyOn(wakeOps, "wakeAssistant");
const retireLeg = spyOn(retireOps, "retireAssistant");
const createBackupSpy = spyOn(backupOps, "createBackup");
const pruneSpy = spyOn(backupOps, "pruneOldBackups").mockImplementation(
  (() => {}) as never,
);
const healthSpy = spyOn(readiness, "checkHealth");
const findAssistant = spyOn(lookup, "findAssistantByName");

const source: LockfileAssistant = {
  assistantId: "source",
  cloud: "local",
  port: 7830,
};

let order: string[];
let running: Map<string, boolean>;

beforeEach(() => {
  order = [];
  running = new Map([["source", true]]);
  for (const spy of [
    sleepLeg,
    wakeLeg,
    retireLeg,
    createBackupSpy,
    healthSpy,
    findAssistant,
  ]) {
    spy.mockReset();
  }
  findAssistant.mockReturnValue(null);
  sleepLeg.mockImplementation(async (entry) => {
    order.push(`sleep:${entry.assistantId}`);
    const wasRunning = running.get(entry.assistantId) ?? false;
    running.set(entry.assistantId, false);
    return {
      ok: true,
      wasRunning,
      kind: "services",
      services: {
        assistant: wasRunning ? "stopped" : "not-running",
        gateway: wasRunning ? "stopped" : "not-running",
        ces: wasRunning ? "stopped" : "not-running",
      },
      notes: [],
    } as never;
  });
  wakeLeg.mockImplementation(async (entry) => {
    order.push(`wake:${entry.assistantId}`);
    running.set(entry.assistantId, true);
    return { ok: true };
  });
  retireLeg.mockImplementation(async (entry) => {
    order.push(`retire:${entry.assistantId}`);
    return { ok: true };
  });
  createBackupSpy.mockImplementation(async (assistantId) => {
    order.push(`backup:${assistantId}`);
    return `/backups/${assistantId}-pre-teleport.tar.gz`;
  });
  healthSpy.mockImplementation(async (entry: LockfileAssistant) =>
    running.get(entry.assistantId)
      ? ({ version: "0.0.1", status: "healthy", authenticated: true } as never)
      : ({ version: undefined, status: "unreachable", authenticated: true } as never),
  );
});
afterAll(() => {
  for (const spy of [
    sleepLeg,
    wakeLeg,
    retireLeg,
    createBackupSpy,
    pruneSpy,
    healthSpy,
    findAssistant,
  ]) {
    spy.mockRestore();
  }
});

// ---------------------------------------------------------------------------
// the ideal path: sleep -> backup -> move (retire + init) -> wake
// ---------------------------------------------------------------------------

test("a docker move sleeps, backs up, retires the source, initializes the same-named target, and wakes it", async () => {
  const dockerInit = spyOn(dockerTeleport, "initializeDockerTeleportTarget");
  const fresh = { ...source, cloud: "docker" as const };
  dockerInit.mockImplementation(async (instanceName) => {
    order.push(`init:docker:${instanceName}`);
    return fresh;
  });
  try {
    const result = await teleportAssistant({
      source,
      target: "docker",
    });

    // The assistant keeps its name across the move.
    expect(result).toEqual({
      ok: true,
      sourceId: "source",
      targetId: "source",
    });
    // The transferred archive is the exact stopped-source safety tar; the
    // source is already retired by the time the target wakes.
    expect(dockerInit).toHaveBeenCalledWith(
      "source",
      "/backups/source-pre-teleport.tar.gz",
      expect.objectContaining({ log: expect.any(Function) }),
    );
    expect(order).toEqual([
      "sleep:source",
      "backup:source",
      "retire:source",
      "init:docker:source",
      "wake:source",
    ]);
    expect(pruneSpy).toHaveBeenCalledWith("source", 3, "pre-teleport");
  } finally {
    dockerInit.mockRestore();
  }
});

test("a local move rides the local init arm", async () => {
  const localInit = spyOn(localTeleport, "initializeLocalTeleportTarget");
  const dockerSource = { ...source, cloud: "docker" as const };
  localInit.mockImplementation(async (instanceName) => {
    order.push(`init:local:${instanceName}`);
    return { ...source };
  });
  try {
    const result = await teleportAssistant({
      source: dockerSource,
      target: "local",
    });

    expect(result.ok).toBe(true);
    expect(order).toEqual([
      "sleep:source",
      "backup:source",
      "retire:source",
      "init:local:source",
      "wake:source",
    ]);
  } finally {
    localInit.mockRestore();
  }
});

// ---------------------------------------------------------------------------
// the refusals that run before anything stops
// ---------------------------------------------------------------------------

test("a cloud destination refuses before any host operation", async () => {
  const result = await teleportAssistant({
    source,
    target: "cloud",
  });
  expect(result).toEqual({
    ok: false,
    status: 400,
    error:
      "Cloud teleport is unavailable until cloud root archive transfer is supported. No installation was changed.",
  });
  expect(order).toEqual([]);
});

test("an apple-container source refuses before any host operation", async () => {
  const result = await teleportAssistant({
    source: { ...source, cloud: "apple-container" } as never,
    target: "docker",
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain(
      "Teleport is not yet supported for this remote",
    );
  }
  expect(order).toEqual([]);
});

test("the same remote refuses before any host operation", async () => {
  const result = await teleportAssistant({
    source,
    target: "local",
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("Cannot teleport between two local");
    expect(result.error).toContain("different remotes");
  }
  expect(order).toEqual([]);
});

test("a multi-patch downgrade fails before shutdown", async () => {
  healthSpy.mockImplementation(async () =>
    ({ version: "1.2.3", status: "healthy", authenticated: true }) as never,
  );
  const result = await teleportAssistant({
    source,
    target: "docker",
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

test("a source backup failure wakes the source and moves nothing", async () => {
  createBackupSpy.mockResolvedValue(null);
  const result = await teleportAssistant({
    source,
    target: "docker",
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("Could not capture 'source'");
  }
  expect(order).toEqual(["sleep:source", "wake:source"]);
});

test("a failed graceful shutdown aborts with sleep's own error", async () => {
  sleepLeg.mockImplementation(async () =>
    ({
      ok: false,
      status: 500,
      error: "the process tree refused to stop",
      wasRunning: true,
    }) as never,
  );
  const result = await teleportAssistant({
    source,
    target: "docker",
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("the process tree refused to stop");
  }
  expect(order).toEqual([]);
});

test("a failed source retirement wakes the source and moves nothing", async () => {
  retireLeg.mockImplementation(async (entry) => {
    order.push(`retire:${entry.assistantId}`);
    return { ok: false, status: 500, error: "the instance dir held on" };
  });
  const result = await teleportAssistant({
    source,
    target: "docker",
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("the instance dir held on");
  }
  expect(order).toEqual(["sleep:source", "backup:source", "retire:source", "wake:source"]);
});

test("a failed init cleans the half-built target up and reports the archive", async () => {
  const dockerInit = spyOn(dockerTeleport, "initializeDockerTeleportTarget");
  dockerInit.mockImplementation(async () => {
    throw new Error("the volumes refused to form");
  });
  try {
    const result = await teleportAssistant({
      source,
      target: "docker",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("the volumes refused to form");
    }
    // The source is already retired and nothing was built — the archive is
    // the recovery path.
    expect(order).toEqual(["sleep:source", "backup:source", "retire:source"]);
  } finally {
    dockerInit.mockRestore();
  }
});

test("an init whose save landed before the throw cleans the half-built target up", async () => {
  const dockerInit = spyOn(dockerTeleport, "initializeDockerTeleportTarget");
  dockerInit.mockImplementation(async () => {
    // The save landed (the record exists again) before the leg died.
    findAssistant.mockReturnValue({ ...source, cloud: "docker" } as never);
    throw new Error("died after the save");
  });
  try {
    const result = await teleportAssistant({
      source,
      target: "docker",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("died after the save");
    }
    expect(order).toEqual([
      "sleep:source",
      "backup:source",
      "retire:source",
      "sleep:source",
      "retire:source",
    ]);
  } finally {
    dockerInit.mockRestore();
  }
});

test("a failed wake cleans the target up", async () => {
  const dockerInit = spyOn(dockerTeleport, "initializeDockerTeleportTarget");
  dockerInit.mockImplementation(async (instanceName) => ({
    ...source,
    cloud: "docker" as const,
    assistantId: instanceName,
  }));
  wakeLeg.mockImplementation(async (entry) => {
    order.push(`wake:${entry.assistantId}`);
    return { ok: false, status: 503, error: "the gateway refused to start" };
  });
  try {
    const result = await teleportAssistant({
      source,
      target: "docker",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("the gateway refused to start");
    }
    expect(order).toEqual([
      "sleep:source",
      "backup:source",
      "retire:source",
      "wake:source",
      "sleep:source",
      "retire:source",
    ]);
  } finally {
    dockerInit.mockRestore();
  }
});

test("an originally sleeping source stays asleep on a pre-move failure", async () => {
  running.set("source", false);
  createBackupSpy.mockResolvedValue(null);
  const result = await teleportAssistant({
    source,
    target: "docker",
  });

  expect(result.ok).toBe(false);
  expect(order).toEqual(["sleep:source"]);
});
