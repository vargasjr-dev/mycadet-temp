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
const realLoopbackFetch = { ...(await import("../loopback-fetch")) };
const realCloudAuth = { ...(await import("../cloud-auth")) };
const realLocalRetire = { ...(await import("../remotes/local/retire")) };
const realBasetenLifecycle = {
  ...(await import("../remotes/baseten/lifecycle")),
};
const realDockerRetire = { ...(await import("../remotes/docker/retire")) };
const realExec = { ...(await import("../exec")) };
const realAppleRetire = {
  ...(await import("../remotes/apple-container/retire")),
};

const loopbackSafeFetchMock = mock(
  async (): Promise<Response> => new Response(null, { status: 204 }),
);
const readCloudTokenMock = mock((): string | null => null);
const authHeadersForKnownOrganizationMock = mock(
  (token: string, organizationId: string) => ({
    "Content-Type": "application/json",
    "X-Session-Token": token,
    "Cadet-Organization-Id": organizationId,
  }),
);
const cloudAuthHeadersMock = mock(async () => ({
  "Content-Type": "application/json",
  "X-Session-Token": "session-token",
}));
const retireLocalMock = mock(
  async (
    entry: LockfileAssistant,
  ): Promise<{ assistantId: string; archived: boolean }> => ({
    assistantId: entry.assistantId,
    archived: false,
  }),
);
const retireDockerMock = mock(async (): Promise<void> => {});
const retireAppleContainerMock = mock(async (): Promise<void> => {});
const execMock = mock(
  (_cmd: string, _args: string[]): Promise<string> => Promise.resolve(""),
);

mock.module("../loopback-fetch", () => ({
  ...realLoopbackFetch,
  loopbackSafeFetch: loopbackSafeFetchMock,
}));
mock.module("../cloud-auth", () => ({
  ...realCloudAuth,
  readCloudToken: readCloudTokenMock,
  authHeadersForKnownOrganization: authHeadersForKnownOrganizationMock,
  cloudAuthHeaders: cloudAuthHeadersMock,
}));
mock.module("../exec", () => ({
  ...realExec,
  exec: execMock,
}));
const retireBasetenMock = mock(async (): Promise<void> => {});
mock.module("../remotes/baseten/lifecycle", () => ({
  ...realBasetenLifecycle,
  retireBaseten: retireBasetenMock,
}));
mock.module("../remotes/local/retire", () => ({
  ...realLocalRetire,
  retireLocal: retireLocalMock,
}));
mock.module("../remotes/docker/retire", () => ({
  ...realDockerRetire,
  retireDocker: retireDockerMock,
}));
mock.module("../remotes/apple-container/retire", () => ({
  ...realAppleRetire,
  retireAppleContainer: retireAppleContainerMock,
}));

// Restore the real modules once this file finishes so the mocks above do not
// leak into other test files in the same `bun test` run.
afterAll(() => {
  mock.module("../loopback-fetch", () => realLoopbackFetch);
  mock.module("../cloud-auth", () => realCloudAuth);
  mock.module("../exec", () => realExec);
  mock.module("../remotes/local/retire", () => realLocalRetire);
  mock.module("../remotes/baseten/lifecycle", () => realBasetenLifecycle);
  mock.module("../remotes/docker/retire", () => realDockerRetire);
  mock.module("../remotes/apple-container/retire", () => realAppleRetire);
});

import { readLockfile } from "../lockfile";
import type { LockfileAssistant } from "../lockfile-contract";
import { retireAssistant } from "../operations/retire";
import { forwardOperatorRequest } from "../operations/routes";

/**
 * Dispatches through the real dispatcher — the rows are its internals, so
 * the tests speak the mount's API, not the match/run seam.
 */
const dispatch = (path: string, method = "GET"): Promise<Response | null> =>
  forwardOperatorRequest(
    new Request(`http://operator.test${path}`, { method }),
  );

let tmpDir: string;
let lockfilePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cadet-retire-op-"));
  lockfilePath = path.join(tmpDir, "cadet", "lockfile.json");
  process.env.XDG_CONFIG_HOME = tmpDir;
  delete process.env.CADET_CLOUD_TOKEN;
  // The cloud URL rides the shared seeds' CADET_CLOUD_URL override.
  process.env.CADET_CLOUD_URL = "https://platform.example.test";
  for (const m of [
    loopbackSafeFetchMock,
    readCloudTokenMock,
    authHeadersForKnownOrganizationMock,
    cloudAuthHeadersMock,
    retireLocalMock,
    retireDockerMock,
    retireAppleContainerMock,
    execMock,
  ]) {
    m.mockReset();
  }
  loopbackSafeFetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  execMock.mockResolvedValue("");
  readCloudTokenMock.mockReturnValue(null);
  authHeadersForKnownOrganizationMock.mockImplementation(
    (token: string, organizationId: string) => ({
      "Content-Type": "application/json",
      "X-Session-Token": token,
      "Cadet-Organization-Id": organizationId,
    }),
  );
  cloudAuthHeadersMock.mockResolvedValue({
    "Content-Type": "application/json",
    "X-Session-Token": "session-token",
  });
});

afterEach(() => {
  delete process.env.CADET_CLOUD_URL;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.CADET_CLOUD_TOKEN;
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

describe("retireAssistant — the headless dispatch", () => {
  test("docker retire stops the containers", async () => {
    const entry = seedEntry({
      assistantId: "asst-docker",
      cloud: "docker",
      port: 7831,
    });

    const result = await retireAssistant(entry);

    expect(result).toEqual({ ok: true });
    // The dispatch hands the whole lockfile entry to the docker leg.
    expect(retireDockerMock).toHaveBeenCalledWith(
      expect.objectContaining({ assistantId: "asst-docker" }),
    );
    expect(readLockfile().assistants).toEqual([]);
  });

  test("apple-container retire sends the socket command", async () => {
    const entry = seedEntry({
      assistantId: "asst-apple",
      cloud: "apple-container",
      port: 7832,
      mgmtSocket: "/tmp/mgmt.sock",
    });

    const result = await retireAssistant(entry);

    expect(result).toEqual({ ok: true });
    expect(retireAppleContainerMock).toHaveBeenCalledWith("asst-apple", entry);
  });

  test("retiring the active assistant reassigns the active pointer", async () => {
    writeLockfile({
      assistants: [
        { assistantId: "a1", cloud: "local", port: 7830 },
        { assistantId: "a2", cloud: "local", port: 7831 },
      ],
      activeAssistant: "a1",
    });
    const entry = readLockfile().assistants[0]!;

    await retireAssistant(entry);

    const after = readLockfile();
    expect(after.assistants.map((a) => a.assistantId)).toEqual(["a2"]);
    expect(after.activeAssistant).toBe("a2");
  });

  test("retiring the last assistant clears the dock-display-name sentinel", async () => {
    const entry = seedEntry({
      assistantId: "assistant-1",
      cloud: "local",
      port: 7830,
    });
    const sentinel = path.join(tmpDir, "cadet", "dock-display-name");
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, "assistant-1");

    await retireAssistant(entry);

    expect(fs.existsSync(sentinel)).toBe(false);
  });

  test("the cloud leg without a platform credential fails structured, not by exiting", async () => {
    const entry = seedEntry({
      assistantId: "asst-cloud",
      cloud: "cloud",
    });

    const result = await retireAssistant(entry);

    expect(result.ok).toBe(false);
    expect(
      (result as { ok: false; status: number; error: string }).error,
    ).toContain("Not logged in");
  });
});

describe("the operator route table — the scoped surface's retire arm", () => {
  const localEntry = { assistantId: "asst-local", cloud: "local", port: 7830 };
  const dockerEntry = {
    assistantId: "asst-docker",
    cloud: "docker",
    port: 7831,
  };
  const cloudEntry = { assistantId: "asst-cloud", cloud: "cloud" };
  const pairedEntry = {
    assistantId: "asst-paired",
    cloud: "custom",
    ipAddress: "gw.example.com",
    port: 7830,
  };

  test("foreign methods and paths never run the retire operation", async () => {
    // The retire row is DELETE-only; other methods on its path (and other
    // paths on DELETE) ride the ALL proxy row to the gateway — dialing,
    // not retiring. The bare unscoped form has no tail, so it genuinely
    // passes.
    writeLockfile({ assistants: [localEntry], activeAssistant: null });
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock(
      async (input: unknown, init?: unknown) => new Response("gateway"),
    ) as unknown as typeof fetch;
    try {
      for (const [path, method] of [
        ["/v1/assistants/asst-local/retire/", "POST"],
        ["/v1/assistants/asst-local/retire/", "GET"],
        ["/v1/assistants/asst-local/conversations", "DELETE"],
        ["/v1/assistants/", "DELETE"],
        ["/v1/assistants/%zz/retire/", "DELETE"],
      ] as const) {
        await dispatch(path, method);
        expect(retireLocalMock).not.toHaveBeenCalled();
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("retiring the last local assistant leaves startup empty without probing health", async () => {
    writeLockfile({
      assistants: [localEntry],
      activeAssistant: localEntry.assistantId,
    });

    const response = await dispatch(
      "/v1/assistants/asst-local/retire/",
      "DELETE",
    );

    expect(response?.status).toBe(204);
    // The dispatch hands the whole lockfile entry to the local leg.
    expect(retireLocalMock).toHaveBeenCalledWith(
      expect.objectContaining({ assistantId: "asst-local" }),
    );
    expect(readLockfile()).toMatchObject({
      assistants: [],
      activeAssistant: null,
    });

    const startup = await dispatch("/v1/assistant");
    expect(startup?.status).toBe(200);
    expect(await startup?.json()).toEqual({ status: "empty" });
    expect(loopbackSafeFetchMock).not.toHaveBeenCalled();
  });

  test("dev startup ignores the cadet-local lockfile", async () => {
    const previousEnvironment = process.env.CADET_ENVIRONMENT;
    const localLockfile = path.join(tmpDir, "cadet-local", "lockfile.json");
    fs.mkdirSync(path.dirname(localLockfile), { recursive: true });
    const localState = JSON.stringify({
      assistants: [localEntry],
      activeAssistant: localEntry.assistantId,
    });
    fs.writeFileSync(localLockfile, localState);

    process.env.CADET_ENVIRONMENT = "dev";
    try {
      const startup = await dispatch("/v1/assistant");
      expect(startup?.status).toBe(200);
      expect(await startup?.json()).toEqual({ status: "empty" });
      expect(loopbackSafeFetchMock).not.toHaveBeenCalled();
      expect(fs.readFileSync(localLockfile, "utf8")).toBe(localState);
    } finally {
      if (previousEnvironment === undefined) {
        delete process.env.CADET_ENVIRONMENT;
      } else {
        process.env.CADET_ENVIRONMENT = previousEnvironment;
      }
    }
  });

  test("a retire failure answers the cloud error shape the dialog renders", async () => {
    writeLockfile({ assistants: [dockerEntry], activeAssistant: null });
    retireDockerMock.mockRejectedValueOnce(new Error("no such assistant"));

    const response = await dispatch(
      "/v1/assistants/asst-docker/retire/",
      "DELETE",
    );

    expect(response?.status).toBe(500);
    expect(await response?.json()).toEqual({ detail: "no such assistant" });
  });

  test("a platform-hosted entry passes through to the session-carrying forward", async () => {
    writeLockfile({ assistants: [cloudEntry], activeAssistant: null });
    readCloudTokenMock.mockReturnValue("platform-token");

    // The host holds no machine token for a platform entry — running the
    // cloud leg here could only fail. The pass lets the pre-existing chain's
    // forward carry the bundle's session to the platform instead.
    expect(
      await dispatch("/v1/assistants/asst-cloud/retire/", "DELETE"),
    ).toBeNull();
    expect(retireLocalMock).not.toHaveBeenCalled();
    expect(retireDockerMock).not.toHaveBeenCalled();
  });

  test("a paired entry retires through its ssh leg", async () => {
    writeLockfile({ assistants: [pairedEntry], activeAssistant: null });

    const response = await dispatch(
      "/v1/assistants/asst-paired/retire/",
      "DELETE",
    );

    expect(response?.status).toBe(204);
    expect(execMock.mock.calls[0]![0]).toBe("ssh");
    expect(readLockfile().assistants.map((a) => a.assistantId)).toEqual([]);
  });

  test("an id the lockfile does not know answers 404", async () => {
    writeLockfile({ assistants: [localEntry], activeAssistant: null });

    const response = await dispatch("/v1/assistants/ghost/retire/", "DELETE");
    expect(response?.status).toBe(404);
    expect(retireLocalMock).not.toHaveBeenCalled();
  });
});

describe("retireAssistant — the baseten arm", () => {
  test("the leg tears the sandbox down and the entry leaves the lockfile", async () => {
    retireBasetenMock.mockImplementation(async () => {});
    const entry = seedEntry({
      assistantId: "asst-baseten",
      cloud: "baseten",
      name: "sbx-abc123",
      sandboxUrl: "https://sbx-abc123.b10.co",
      port: 7830,
    });

    const result = await retireAssistant(entry);

    expect(result).toEqual({ ok: true });
    expect(retireBasetenMock).toHaveBeenCalledWith(
      expect.objectContaining({ cloud: "baseten", name: "sbx-abc123" }),
    );
    expect(readLockfile().assistants).toEqual([]);
  });

  test("a leg failure keeps the entry and reports the teardown error", async () => {
    retireBasetenMock.mockImplementation(async () => {
      throw new Error("The sandbox delete failed: boom");
    });
    const entry = seedEntry({
      assistantId: "asst-baseten",
      cloud: "baseten",
      name: "sbx-abc123",
      sandboxUrl: "https://sbx-abc123.b10.co",
      port: 7830,
    });
    const result = await retireAssistant(entry);

    expect(result).toEqual({
      ok: false,
      status: 500,
      error: "The sandbox delete failed: boom",
    });
    expect(readLockfile().assistants.map((a) => a.assistantId)).toEqual([
      "asst-baseten",
    ]);
  });
});
