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
const realDockerRetire = { ...(await import("../remotes/docker/retire")) };
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
const resolveCloudUrlMock = mock(() => "https://platform.example.test");
const retireLocalMock = mock(
  async (
    assistantId: string,
  ): Promise<{ assistantId: string; archived: boolean }> => ({
    assistantId,
    archived: false,
  }),
);
const retireDockerMock = mock(async (): Promise<void> => {});
const retireAppleContainerMock = mock(async (): Promise<void> => {});

mock.module("../loopback-fetch", () => ({
  ...realLoopbackFetch,
  loopbackSafeFetch: loopbackSafeFetchMock,
}));
mock.module("../cloud-auth", () => ({
  ...realCloudAuth,
  readCloudToken: readCloudTokenMock,
  authHeadersForKnownOrganization: authHeadersForKnownOrganizationMock,
  cloudAuthHeaders: cloudAuthHeadersMock,
  resolveCloudUrl: resolveCloudUrlMock,
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
  mock.module("../remotes/local/retire", () => realLocalRetire);
  mock.module("../remotes/docker/retire", () => realDockerRetire);
  mock.module("../remotes/apple-container/retire", () => realAppleRetire);
});

import { readLockfile } from "../lockfile";
import type { LockfileAssistant } from "../lockfile-contract";
import {
  retireAssistant,
  isHostExecutableRetireEntry,
} from "../operations/retire";
import { matchOperatorRequest } from "../operations/routes";

let tmpDir: string;
let lockfilePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cadet-retire-op-"));
  lockfilePath = path.join(tmpDir, "cadet", "lockfile.json");
  process.env.XDG_CONFIG_HOME = tmpDir;
  delete process.env.CADET_PLATFORM_TOKEN;
  delete process.env.CADET_CLOUD_TOKEN;
  for (const m of [
    loopbackSafeFetchMock,
    readCloudTokenMock,
    authHeadersForKnownOrganizationMock,
    cloudAuthHeadersMock,
    resolveCloudUrlMock,
    retireLocalMock,
    retireDockerMock,
    retireAppleContainerMock,
  ]) {
    m.mockReset();
  }
  loopbackSafeFetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  readCloudTokenMock.mockReturnValue(null);
  resolveCloudUrlMock.mockReturnValue("https://platform.example.test");
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
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.CADET_PLATFORM_TOKEN;
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
  test("docker retire stops the containers then the app-server edge", async () => {
    const entry = seedEntry({
      assistantId: "asst-docker",
      cloud: "docker",
      port: 7831,
    });

    const result = await retireAssistant(entry);

    expect(result).toEqual({ ok: true });
    expect(retireDockerMock).toHaveBeenCalledWith("asst-docker");
    expect(readLockfile().assistants).toEqual([]);
  });

  test("apple-container retire sends the socket command then stops the edge", async () => {
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

describe("isHostExecutableRetireEntry", () => {
  test("loopback and apple-container entries are host-executable", () => {
    expect(
      isHostExecutableRetireEntry({
        assistantId: "a",
        cloud: "local",
        port: 7830,
      } as never),
    ).toBe(true);
    expect(
      isHostExecutableRetireEntry({
        assistantId: "a",
        cloud: "docker",
        port: 7830,
      } as never),
    ).toBe(true);
    expect(
      isHostExecutableRetireEntry({
        assistantId: "a",
        cloud: "apple-container",
        port: 7830,
        mgmtSocket: "/tmp/mgmt.sock",
      } as never),
    ).toBe(true);
  });

  test("platform-hosted and paired entries are not", () => {
    expect(
      isHostExecutableRetireEntry({
        assistantId: "a",
        cloud: "cloud",
      } as never),
    ).toBe(false);
    expect(
      isHostExecutableRetireEntry({
        assistantId: "a",
        cloud: "baseten",
      } as never),
    ).toBe(false);
    expect(
      isHostExecutableRetireEntry({
        assistantId: "a",
        cloud: "custom",
      } as never),
    ).toBe(false);
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
    runtimeUrl: "https://gw.example.com",
  };

  test("non-DELETE methods and non-retire paths never match", () => {
    expect(matchOperatorRequest("/v1/assistants/a/retire/", "POST")).toBeNull();
    expect(matchOperatorRequest("/v1/assistants/a/retire/", "GET")).toBeNull();
    expect(
      matchOperatorRequest("/v1/assistants/a/conversations", "DELETE"),
    ).toBeNull();
    expect(matchOperatorRequest("/v1/assistants/", "DELETE")).toBeNull();
  });

  test("a malformed id decode passes", () => {
    expect(
      matchOperatorRequest("/v1/assistants/%zz/retire/", "DELETE"),
    ).toBeNull();
  });

  test("a host-executable entry's DELETE runs the retire operation", async () => {
    writeLockfile({ assistants: [localEntry], activeAssistant: null });

    const response = await matchOperatorRequest(
      "/v1/assistants/asst-local/retire/",
      "DELETE",
    )!.route.run("asst-local");

    expect(response?.status).toBe(204);
    expect(retireLocalMock).toHaveBeenCalledWith(
      "asst-local",
      expect.objectContaining({ assistantId: "asst-local" }),
    );
  });

  test("a retire failure answers the cloud error shape the dialog renders", async () => {
    writeLockfile({ assistants: [dockerEntry], activeAssistant: null });
    retireDockerMock.mockRejectedValueOnce(new Error("no such assistant"));

    const response = await matchOperatorRequest(
      "/v1/assistants/asst-docker/retire/",
      "DELETE",
    )!.route.run("asst-docker");

    expect(response?.status).toBe(500);
    expect(await response?.json()).toEqual({ detail: "no such assistant" });
  });

  test("cloud and custom entries pass through to the endpoint's forward", async () => {
    writeLockfile({
      assistants: [cloudEntry, pairedEntry],
      activeAssistant: null,
    });

    expect(
      await matchOperatorRequest(
        "/v1/assistants/asst-cloud/retire/",
        "DELETE",
      )!.route.run("asst-cloud"),
    ).toBeNull();
    expect(
      await matchOperatorRequest(
        "/v1/assistants/asst-paired/retire/",
        "DELETE",
      )!.route.run("asst-paired"),
    ).toBeNull();
    expect(retireLocalMock).not.toHaveBeenCalled();
    expect(retireDockerMock).not.toHaveBeenCalled();
  });

  test("an id the lockfile does not know passes", async () => {
    writeLockfile({ assistants: [localEntry], activeAssistant: null });

    expect(
      await matchOperatorRequest(
        "/v1/assistants/ghost/retire/",
        "DELETE",
      )!.route.run("ghost"),
    ).toBeNull();
    expect(retireLocalMock).not.toHaveBeenCalled();
  });
});
