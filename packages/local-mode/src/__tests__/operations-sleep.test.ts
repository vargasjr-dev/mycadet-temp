import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { DrainOptions, DrainOutcome } from "../remotes/local/drain";

// Snapshot the real modules before mocking so the module-scoped `afterAll`
// below can restore them — bun runs every test file in one process with a
// shared loader, and `mock.restore()` does not undo `mock.module()`.
const realProcess = { ...(await import("../process")) };
const realDrain = { ...(await import("../remotes/local/drain")) };
const realGuardianToken = { ...(await import("../guardian-token")) };
const realDockerSleep = { ...(await import("../remotes/docker/sleep")) };

const isProcessAliveMock = mock(
  (_pidFile?: string): { alive: boolean; pid: number | null } => ({
    alive: false,
    pid: null,
  }),
);
const stopProcessByPidFileMock = mock(async () => true);
const drainAssistantMock = mock(
  async (_opts: DrainOptions): Promise<DrainOutcome> => "drained",
);
const loadGuardianTokenMock = mock((): { accessToken: string } | null => ({
  accessToken: "test-guardian-token",
}));
const getGuardianAccessTokenMock = mock(
  async (): Promise<
    | { ok: true; accessToken: string }
    | { ok: false; status: number; error: string }
  > => ({ ok: true, accessToken: "test-guardian-token" }),
);
const sleepDockerMock = mock(async (): Promise<void> => {});

mock.module("../process", () => ({
  ...realProcess,
  isProcessAlive: isProcessAliveMock,
  stopProcessByPidFile: stopProcessByPidFileMock,
}));
mock.module("../remotes/local/drain", () => ({
  ...realDrain,
  drainAssistant: drainAssistantMock,
}));
mock.module("../guardian-token", () => ({
  ...realGuardianToken,
  loadGuardianToken: loadGuardianTokenMock,
  getGuardianAccessToken: getGuardianAccessTokenMock,
}));
mock.module("../remotes/docker/sleep", () => ({
  ...realDockerSleep,
  sleepDocker: sleepDockerMock,
}));

// Restore the real modules once this file finishes so the mocks above do not
// leak into other test files in the same `bun test` run.
afterAll(() => {
  mock.module("../process", () => realProcess);
  mock.module("../remotes/local/drain", () => realDrain);
  mock.module("../guardian-token", () => realGuardianToken);
  mock.module("../remotes/docker/sleep", () => realDockerSleep);
});

import type { LockfileAssistant } from "../lockfile-contract";
import { readLockfile } from "../lockfile";
import { sleepAssistant, type SleepResult } from "../operations/sleep";
import { matchOperatorRequest } from "../operations/routes";

let tmpDir: string;
let lockfilePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cadet-sleep-op-"));
  lockfilePath = path.join(tmpDir, "cadet", "lockfile.json");
  process.env.XDG_CONFIG_HOME = tmpDir;
  for (const m of [
    isProcessAliveMock,
    stopProcessByPidFileMock,
    drainAssistantMock,
    loadGuardianTokenMock,
    getGuardianAccessTokenMock,
    sleepDockerMock,
  ]) {
    m.mockReset();
  }
  isProcessAliveMock.mockReturnValue({ alive: false, pid: null });
  stopProcessByPidFileMock.mockResolvedValue(true);
  drainAssistantMock.mockResolvedValue("drained");
  loadGuardianTokenMock.mockReturnValue({ accessToken: "test-guardian-token" });
  getGuardianAccessTokenMock.mockResolvedValue({
    ok: true,
    accessToken: "test-guardian-token",
  });
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const writeLockfile = (data: Record<string, unknown>): void => {
  fs.mkdirSync(path.dirname(lockfilePath), { recursive: true });
  fs.writeFileSync(lockfilePath, JSON.stringify(data));
};

const seedEntry = (entry: Record<string, unknown>) => {
  writeLockfile({ assistants: [entry], activeAssistant: null });
  return readLockfile().assistants[0]!;
};

const writeLeaseFile = (
  instanceDir: string,
  callSessionIds: string[],
): void => {
  fs.mkdirSync(instanceDir, { recursive: true });
  fs.writeFileSync(
    path.join(instanceDir, "active-call-leases.json"),
    JSON.stringify({
      version: 1,
      leases: callSessionIds.map((callSessionId) => ({
        callSessionId,
        providerCallSid: null,
        updatedAt: Date.now(),
      })),
    }),
  );
};

const localEntry = (overrides: Record<string, unknown> = {}) => ({
  assistantId: "asst-local",
  cloud: "local",
  port: 7830,
  instanceDir: tmpDir,
  ...overrides,
});

const stopCalls = (): Array<[string, string, unknown, number, unknown]> =>
  stopProcessByPidFileMock.mock.calls as never;

describe("sleepAssistant — the local stop core", () => {
  test("refuses without --force while an active call lease holds the assistant", async () => {
    const entry = localEntry() as LockfileAssistant;
    isProcessAliveMock.mockReturnValue({ alive: true, pid: 12345 });
    writeLeaseFile(tmpDir, ["call-active-1", "call-active-2"]);

    const result = await sleepAssistant(entry, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error).toContain("call-active-1, call-active-2");
      expect(result.error).toContain("sleep --force");
    }
    expect(stopProcessByPidFileMock).not.toHaveBeenCalled();
  });

  test("proceeds when the assistant is not running even with a stale lease file", async () => {
    const entry = localEntry() as LockfileAssistant;
    writeLeaseFile(tmpDir, ["call-stale-1"]);
    stopProcessByPidFileMock.mockResolvedValue(false);

    const result = await sleepAssistant(entry, {});

    expect(result).toEqual({
      ok: true,
      kind: "services",
      services: {
        assistant: "not-running",
        gateway: "not-running",
        ces: "not-running",
      },
      notes: [],
    });
    // assistant + gateway + CES sibling
    expect(stopProcessByPidFileMock).toHaveBeenCalledTimes(3);
  });

  test("default sleep passes the non-escalating service stopper with the right budgets", async () => {
    const entry = localEntry() as LockfileAssistant;

    await sleepAssistant(entry, {});

    expect(stopCalls()[0]).toEqual([
      path.join(tmpDir, "workspace", "cadet.pid"),
      "assistant",
      undefined,
      45_000,
      realProcess.stopProcessGracefully,
    ]);
    // The gateway's stop uses a longer timeout: it has a configurable drain
    // window (5s) before it exits.
    expect(stopCalls()[1]).toEqual([
      path.join(tmpDir, "gateway.pid"),
      "gateway",
      undefined,
      7000,
      realProcess.stopProcessGracefully,
    ]);
    // The CES sibling is stopped by its PID file; a no-op when absent.
    expect(stopCalls()[2]).toEqual([
      path.join(tmpDir, "ces.pid"),
      "credential-executor",
      undefined,
      45_000,
      realProcess.stopProcessGracefully,
    ]);
  });

  test("force stops the assistant even when an active call lease exists", async () => {
    const entry = localEntry() as LockfileAssistant;
    isProcessAliveMock.mockReturnValue({ alive: true, pid: 4321 });
    writeLeaseFile(tmpDir, ["call-active-1"]);

    const result = await sleepAssistant(entry, { force: true });

    expect(result.ok).toBe(true);
    expect(stopProcessByPidFileMock).toHaveBeenCalledTimes(3);
  });

  test("refuses the stop on windows — graceful-only shutdown is unsupported", async () => {
    const realPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const result = await sleepAssistant(
        localEntry() as LockfileAssistant,
        {},
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(400);
        expect(result.error).toContain("Windows");
      }
      expect(stopProcessByPidFileMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform });
    }
  });

  test("a failed graceful stop surfaces the stopper's message", async () => {
    const entry = localEntry() as LockfileAssistant;
    stopProcessByPidFileMock.mockRejectedValue(
      new Error("assistant did not stop gracefully."),
    );

    const result = await sleepAssistant(entry, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.error).toContain("did not stop gracefully");
    }
  });
});

describe("sleepAssistant — the --wait drain phase", () => {
  test("drains against the recorded gateway port before stopping", async () => {
    const entry = localEntry({ port: 9999 }) as LockfileAssistant;
    isProcessAliveMock.mockReturnValue({ alive: true, pid: 4321 });

    const result = await sleepAssistant(entry, { wait: true });

    expect(drainAssistantMock).toHaveBeenCalledTimes(1);
    const opts = drainAssistantMock.mock.calls[0]![0];
    expect(opts.baseUrl).toBe("http://127.0.0.1:9999");
    expect(opts.token).toBe("test-guardian-token");
    // Bare --wait waits as long as it takes.
    expect(opts.deadlineAt).toBeNull();
    expect(stopProcessByPidFileMock).toHaveBeenCalledTimes(3);
    expect(
      (result as Extract<SleepResult, { kind: "services" }>).notes,
    ).toEqual([]);
  });

  test("a duration bounds the wait with a deadline", async () => {
    const entry = localEntry() as LockfileAssistant;
    isProcessAliveMock.mockReturnValue({ alive: true, pid: 4321 });

    const before = Date.now();
    await sleepAssistant(entry, { wait: true, waitMs: 90_000 });

    const opts = drainAssistantMock.mock.calls[0]![0];
    expect(opts.deadlineAt).toBeGreaterThanOrEqual(before + 89_000);
    expect(opts.deadlineAt).toBeLessThanOrEqual(Date.now() + 91_000);
  });

  test("a cancelled drain stops nothing and reports cancelled", async () => {
    const entry = localEntry() as LockfileAssistant;
    isProcessAliveMock.mockReturnValue({ alive: true, pid: 4321 });
    drainAssistantMock.mockResolvedValue("cancelled");

    const result = await sleepAssistant(entry, { wait: true });

    expect(result).toEqual({ ok: true, cancelled: true });
    expect(stopProcessByPidFileMock).not.toHaveBeenCalled();
  });

  test("skips the drain when the assistant is not running", async () => {
    const entry = localEntry() as LockfileAssistant;

    await sleepAssistant(entry, { wait: true });

    expect(drainAssistantMock).not.toHaveBeenCalled();
    expect(stopProcessByPidFileMock).toHaveBeenCalledTimes(3);
  });

  test("skips the drain and notes it when no guardian token is available", async () => {
    const entry = localEntry() as LockfileAssistant;
    isProcessAliveMock.mockReturnValue({ alive: true, pid: 4321 });
    loadGuardianTokenMock.mockReturnValue(null);

    const result = await sleepAssistant(entry, { wait: true });

    expect(drainAssistantMock).not.toHaveBeenCalled();
    expect(stopProcessByPidFileMock).toHaveBeenCalledTimes(3);
    const notes = (result as Extract<SleepResult, { kind: "services" }>).notes;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("stopping without waiting");
  });

  test("a failed token lease degrades the same way", async () => {
    const entry = localEntry() as LockfileAssistant;
    isProcessAliveMock.mockReturnValue({ alive: true, pid: 4321 });
    getGuardianAccessTokenMock.mockResolvedValue({
      ok: false,
      status: 401,
      error: "expired",
    });

    const result = await sleepAssistant(entry, { wait: true });

    expect(drainAssistantMock).not.toHaveBeenCalled();
    const notes = (result as Extract<SleepResult, { kind: "services" }>).notes;
    expect(notes).toHaveLength(1);
  });
});

describe("sleepAssistant — the dispatch", () => {
  test("docker entries stop their containers", async () => {
    const entry = {
      assistantId: "asst-docker",
      cloud: "docker",
      port: 7831,
    } as LockfileAssistant;

    const result = await sleepAssistant(entry, {});

    expect(result).toEqual({
      ok: true,
      kind: "containers",
    });
    expect(sleepDockerMock).toHaveBeenCalledWith(
      expect.objectContaining({ assistantId: "asst-docker" }),
    );
  });

  test("entries this machine cannot stop come back structured", async () => {
    const result = await sleepAssistant(
      { assistantId: "asst-cloud", cloud: "cloud" } as LockfileAssistant,
      {},
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toBe(
        "'cadet sleep' is unsupported for a cloud assistant.",
      );
    }
  });
});

describe("the operator route table — the scoped surface's sleep arm", () => {
  test("POST matches; other methods and paths never do", () => {
    expect(
      matchOperatorRequest("/v1/assistants/a/sleep/", "POST"),
    ).not.toBeNull();
    expect(
      matchOperatorRequest("/v1/assistants/a/sleep", "POST"),
    ).not.toBeNull();
    expect(
      matchOperatorRequest("/v1/assistants/a/sleep/", "DELETE"),
    ).toBeNull();
    expect(matchOperatorRequest("/v1/assistants/a/retire/", "POST")).toBeNull();
    expect(
      matchOperatorRequest("/v1/assistants/a/conversations", "POST"),
    ).toBeNull();
  });

  test("a malformed id decode passes", () => {
    expect(
      matchOperatorRequest("/v1/assistants/%zz/sleep/", "POST"),
    ).toBeNull();
  });

  test("a host-executable entry is answered in process with a 204", async () => {
    seedEntry({
      assistantId: "asst-docker",
      cloud: "docker",
      port: 7831,
    });

    const match = matchOperatorRequest(
      "/v1/assistants/asst-docker/sleep/",
      "POST",
    );
    expect(match).not.toBeNull();
    const response = await match!.route.run(match!.assistantId);
    expect(response?.status).toBe(204);
    expect(sleepDockerMock).toHaveBeenCalledWith(
      expect.objectContaining({ assistantId: "asst-docker" }),
    );
  });

  test("a platform-hosted entry is refused with the operation's 400", async () => {
    seedEntry({ assistantId: "asst-cloud", cloud: "cloud" });

    const match = matchOperatorRequest(
      "/v1/assistants/asst-cloud/sleep/",
      "POST",
    );
    expect(match).not.toBeNull();
    const response = await match!.route.run(match!.assistantId);
    expect(response?.status).toBe(400);
    const body = (await response!.json()) as { detail: string };
    expect(body.detail).toBe(
      "'cadet sleep' is unsupported for a cloud assistant.",
    );
    expect(sleepDockerMock).not.toHaveBeenCalled();
  });

  test("an unknown id passes through to the pre-existing chain", async () => {
    const match = matchOperatorRequest(
      "/v1/assistants/no-such-assistant/sleep/",
      "POST",
    );
    expect(match).not.toBeNull();
    expect(await match!.route.run(match!.assistantId)).toBeNull();
    expect(sleepDockerMock).not.toHaveBeenCalled();
  });

  test("a refused stop carries the operation's message and status", async () => {
    const instanceDir = path.join(tmpDir, "instance");
    seedEntry({
      assistantId: "asst-local",
      cloud: "local",
      port: 7830,
      instanceDir,
    });
    isProcessAliveMock.mockReturnValue({ alive: true, pid: 12345 });
    writeLeaseFile(instanceDir, ["call-active-1"]);

    const match = matchOperatorRequest(
      "/v1/assistants/asst-local/sleep/",
      "POST",
    );
    const response = await match!.route.run(match!.assistantId);
    expect(response?.status).toBe(409);
    const body = (await response!.json()) as { detail: string };
    expect(body.detail).toContain("active phone calls");
  });
});
