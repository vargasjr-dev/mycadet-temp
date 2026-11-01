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

// Snapshot the real modules before mocking so the module-scoped `afterAll`
// below can restore them — bun runs every test file in one process with a
// shared loader, and `mock.restore()` does not undo `mock.module()`.
const realLocalWake = {
  ...(await import("../remotes/local/wake")),
};
const realDockerWake = {
  ...(await import("../remotes/docker/wake")),
};
const realExecModule = { ...(await import("../exec")) };

/**
 * The docker/Colima toolchain fake: `docker info` succeeds only while
 * `daemonUp`; a `colima start` heals the daemon (unless the fake models the
 * zombie state — Colima's state file says "already running, ignoring" while
 * the daemon inside stays dead; only stop → start recovers). Dispatched
 * through the module-level exec mock so the daemon-ensure cases need no real
 * Docker/Colima subprocesses.
 */
let currentExecFake:
  | { exec: (cmd: string, args?: string[]) => Promise<void>; ran: (cmd: string, sub: string) => boolean }
  | undefined;

const execModuleMock = mock(
  async (cmd: string, args: string[] = []): Promise<void> => {
    if (!currentExecFake) {
      throw new Error("unexpected real exec in the wake suite");
    }
    return currentExecFake.exec(cmd, args);
  },
);

const makeExecFake = (
  opts: {
    /** Daemon already reachable when the test starts. */
    daemonUpAtStart?: boolean;
    /** `colima start` exits nonzero instead of healing. */
    startFails?: boolean;
    /** First `colima start` is a zombie no-op that does NOT heal the daemon. */
    zombieFirstStart?: boolean;
  } = {},
) => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  let daemonUp = opts.daemonUpAtStart ?? false;
  let starts = 0;
  const exec = async (
    cmd: string,
    args: string[] = [],
  ): Promise<void> => {
    calls.push({ cmd, args });
    if (cmd === "docker" && args[0] === "info") {
      if (!daemonUp) throw new Error("Cannot connect to the Docker daemon");
      return;
    }
    if (cmd === "colima" && args[0] === "start") {
      starts++;
      if (opts.startFails) throw new Error("colima start exited 1");
      if (!opts.zombieFirstStart || starts > 1) daemonUp = true;
      return;
    }
    if (cmd === "colima" && args[0] === "stop") {
      daemonUp = false;
      return;
    }
  };
  const ran = (cmd: string, sub: string): boolean =>
    calls.some((c) => c.cmd === cmd && c.args[0] === sub);
  return { exec, ran };
};

mock.module("../exec", () => ({
  ...realExecModule,
  exec: execModuleMock,
}));

const wakeLocalServicesMock = mock<
  (entry: unknown) => Promise<
    { ok: true } | { ok: false; status: number; error: string }
  >
>(async () => ({ ok: true }));
const wakeDockerMock = mock(async (): Promise<void> => {});

mock.module("../remotes/local/wake", () => ({
  ...realLocalWake,
  wakeLocalServices: wakeLocalServicesMock,
}));
mock.module("../remotes/docker/wake", () => ({
  ...realDockerWake,
  wakeDocker: wakeDockerMock,
  isNoSuchContainerError: realDockerWake.isNoSuchContainerError,
}));

afterAll(() => {
  mock.module("../remotes/local/wake", () => realLocalWake);
  mock.module("../remotes/docker/wake", () => realDockerWake);
  mock.module("../exec", () => realExecModule);
});

import type { LockfileAssistant } from "../lockfile-contract";
import { readLockfile } from "../lockfile";
import { wakeAssistant } from "../operations/wake";
import { matchOperatorRequest } from "../operations/routes";

let tmpDir: string;
let lockfilePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cadet-wake-op-"));
  lockfilePath = path.join(tmpDir, "cadet", "lockfile.json");
  process.env.XDG_CONFIG_HOME = tmpDir;
  wakeLocalServicesMock.mockReset();
  wakeLocalServicesMock.mockResolvedValue({ ok: true });
  wakeDockerMock.mockReset();
  wakeDockerMock.mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("wakeAssistant — the dispatch", () => {
  test("a local entry rides the local wake leg and reports services", async () => {
    const result = await wakeAssistant({
      assistantId: "asst-local",
      cloud: "local",
      port: 7830,
    } as LockfileAssistant);

    expect(result).toEqual({ ok: true, kind: "services" });
    expect(wakeLocalServicesMock).toHaveBeenCalledTimes(1);
    expect(
      (wakeLocalServicesMock.mock.calls[0]![0] as LockfileAssistant).assistantId,
    ).toBe("asst-local");
  });

  test("a failed local wake carries the structured failure through", async () => {
    wakeLocalServicesMock.mockResolvedValue({
      ok: false,
      status: 500,
      error: "the assistant exited during startup",
    });
    const result = await wakeAssistant({
      assistantId: "asst-local",
      cloud: "local",
      port: 7830,
    } as LockfileAssistant);
    expect(result).toEqual({
      ok: false,
      status: 500,
      error: "the assistant exited during startup",
    });
  });

  test("docker entries start their containers and report containers", async () => {
    const result = await wakeAssistant({
      assistantId: "asst-docker",
      cloud: "docker",
      port: 7831,
    } as LockfileAssistant);

    expect(result).toEqual({ ok: true, kind: "containers" });
    expect(wakeDockerMock).toHaveBeenCalledWith(
      expect.objectContaining({ assistantId: "asst-docker" }),
    );
  });

  test("a docker entry with no containers to start refuses with the recreate pointer", async () => {
    wakeDockerMock.mockRejectedValue(
      new Error(
        "Error response from daemon: No such container: asst-docker-gateway",
      ),
    );
    const result = await wakeAssistant({
      assistantId: "asst-docker",
      cloud: "docker",
      port: 7831,
    } as LockfileAssistant);
    expect(result.ok).toBe(false);
    expect((result as { status: number }).status).toBe(404);
    expect((result as { error: string }).error).toContain(
      "run `cadet wake` once to recreate",
    );
  });

  test("a docker wake failure carries the docker error", async () => {
    wakeDockerMock.mockRejectedValue(new Error("daemon not reachable"));
    const result = await wakeAssistant({
      assistantId: "asst-docker",
      cloud: "docker",
      port: 7831,
    } as LockfileAssistant);
    expect(result).toEqual({
      ok: false,
      status: 500,
      error: "daemon not reachable",
    });
  });

  test("an apple-container entry refuses with the macOS-app pointer", async () => {
    const result = await wakeAssistant({
      assistantId: "asst-apple",
      cloud: "apple-container",
      port: 7830,
      mgmtSocket: "/tmp/socket",
    } as LockfileAssistant);
    expect(result.ok).toBe(false);
    expect((result as { status: number }).status).toBe(400);
    expect((result as { error: string }).error).toContain(
      "managed by the macOS app",
    );
  });

  test("platform-hosted entries are a benign nothing-to-start", async () => {
    for (const cloud of ["cloud", "custom", "baseten"]) {
      const result = await wakeAssistant(
        {
          assistantId: "asst-remote",
          cloud,
          ...(cloud === "custom"
            ? { ipAddress: "gw.example.com", port: 7830 }
            : {}),
          ...(cloud === "baseten"
            ? { sandboxUrl: "https://x.baseten.co", port: 7830 }
            : {}),
        } as LockfileAssistant,
      );
      expect(result).toEqual({ ok: true, kind: "remote" });
    }
    expect(wakeLocalServicesMock).not.toHaveBeenCalled();
    expect(wakeDockerMock).not.toHaveBeenCalled();
  });
});

describe("the operator route table — the scoped surface's wake arm", () => {
  const writeLockfile = (data: Record<string, unknown>): void => {
    fs.mkdirSync(path.dirname(lockfilePath), { recursive: true });
    fs.writeFileSync(lockfilePath, JSON.stringify(data));
  };
  const seedEntry = (entry: Record<string, unknown>) => {
    writeLockfile({ assistants: [entry], activeAssistant: null });
    return readLockfile().assistants[0]!;
  };

  test("POST wake matches the table and answers 204 on success", async () => {
    seedEntry({ assistantId: "asst-local", cloud: "local", port: 7830 });
    const match = matchOperatorRequest("/v1/assistants/asst-local/wake/", "POST");
    expect(match).not.toBeNull();
    const response = await match!.route.run(match!.assistantId);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(204);
  });

  test("a wake for an unknown id passes through untouched", async () => {
    seedEntry({ assistantId: "asst-local", cloud: "local", port: 7830 });
    const match = matchOperatorRequest("/v1/assistants/nobody/wake/", "POST");
    expect(match).not.toBeNull();
    const response = await match!.route.run(match!.assistantId);
    expect(response).toBeNull();
  });

  test("a failed wake surfaces the operation's error as the cloud detail shape", async () => {
    seedEntry({ assistantId: "asst-local", cloud: "local", port: 7830 });
    wakeLocalServicesMock.mockResolvedValue({
      ok: false,
      status: 500,
      error: "wake blew up",
    });
    const match = matchOperatorRequest("/v1/assistants/asst-local/wake/", "POST");
    const response = (await match!.route.run(match!.assistantId))!;
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ detail: "wake blew up" });
  });

  test("the wake route does not answer GET or the retire path", () => {
    expect(
      matchOperatorRequest("/v1/assistants/a/wake/", "GET"),
    ).toBeNull();
    expect(
      matchOperatorRequest("/v1/assistants/a/wake/", "DELETE"),
    ).toBeNull();
    expect(
      matchOperatorRequest("/v1/assistants/a/retire/", "POST"),
    ).toBeNull();
  });
});

describe("ensureDockerDaemonRunning", () => {
  // Regression: waking an instance hatched under Docker Desktop must NOT start
  // Colima, because that switches the active `docker context` and points
  // `docker start` at a VM that never held the instance's containers.
  test("reuses an already-reachable daemon (e.g. Docker Desktop) and never touches Colima", async () => {
    const fake = makeExecFake({ daemonUpAtStart: true });
    currentExecFake = fake;

    await realDockerWake.ensureDockerDaemonRunning({ settleTimeoutMs: 0 });

    expect(fake.ran("docker", "info")).toBe(true);
    expect(fake.ran("colima", "start")).toBe(false);
    expect(fake.ran("colima", "stop")).toBe(false);
  });

  test("starts Colima when no daemon is reachable and confirms the daemon answered", async () => {
    const fake = makeExecFake();
    currentExecFake = fake;

    await realDockerWake.ensureDockerDaemonRunning({ settleTimeoutMs: 0 });

    expect(fake.ran("docker", "info")).toBe(true);
    expect(fake.ran("colima", "start")).toBe(true);
    expect(fake.ran("colima", "stop")).toBe(false);
  });

  // Regression (v0.12.8 release feedback): a zombie Colima — stale state file
  // saying "already running" while the daemon inside is dead — used to sail
  // through wake (no `colima status` oracle anymore) and leave every later
  // docker command dying on the unreachable socket.
  test("recovers a zombie Colima: start no-ops, daemon stays dead → stop --force → start → daemon up", async () => {
    const fake = makeExecFake({ zombieFirstStart: true });
    currentExecFake = fake;

    await realDockerWake.ensureDockerDaemonRunning({ settleTimeoutMs: 0 });

    expect(fake.ran("colima", "start")).toBe(true);
    expect(fake.ran("colima", "stop")).toBe(true);
  });

  test("never deletes the Colima VM — the VM disk holds every image and volume", async () => {
    const fake = makeExecFake({ zombieFirstStart: true });
    currentExecFake = fake;

    await realDockerWake.ensureDockerDaemonRunning({ settleTimeoutMs: 0 });

    expect(fake.ran("colima", "delete")).toBe(false);
  });

  test("throws an actionable error when even the restart cannot bring the daemon up", () => {
    // A start that always exits nonzero: the first failure surfaces its
    // output, the recovery stop+start runs, and the final wait still finds
    // no daemon → the helper throws instead of letting the wake proceed.
    const fake = makeExecFake({ startFails: true });
    currentExecFake = fake;
    expect(
      realDockerWake.ensureDockerDaemonRunning({ settleTimeoutMs: 0 }),
    ).rejects.toThrow(/Failed to restart Colima/);
  });

  afterEach(() => {
    currentExecFake = undefined;
  });
});
