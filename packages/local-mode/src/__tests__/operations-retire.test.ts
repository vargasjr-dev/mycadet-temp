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
const realIngress = { ...(await import("../ingress")) };

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
const stopContainerAppServerMock = mock(async (): Promise<boolean> => false);
const stopIngressNginxMock = mock(async (): Promise<boolean> => false);

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
mock.module("../ingress", () => ({
  ...realIngress,
  stopContainerAppServer: stopContainerAppServerMock,
  stopIngressNginx: stopIngressNginxMock,
}));

// Restore the real modules once this file finishes so the mocks above do not
// leak into other test files in the same `bun test` run.
afterAll(() => {
  mock.module("../loopback-fetch", () => realLoopbackFetch);
  mock.module("../cloud-auth", () => realCloudAuth);
  mock.module("../remotes/local/retire", () => realLocalRetire);
  mock.module("../remotes/docker/retire", () => realDockerRetire);
  mock.module("../remotes/apple-container/retire", () => realAppleRetire);
  mock.module("../ingress", () => realIngress);
});

import { readLockfile } from "../lockfile";
import type { LockfileAssistant } from "../lockfile-contract";
import {
  retireAssistantEntry,
  isHostExecutableRetireEntry,
} from "../operations/retire";
import type { RetireResult } from "../operations/retire";
import {
  executeOperatorMatch,
  matchOperatorRequest,
} from "../operations/routes";

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
    stopContainerAppServerMock,
    stopIngressNginxMock,
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

describe("retireAssistantEntry — the headless dispatch", () => {
  test("local retire unregisters the cloud record straight from the lockfile entry", async () => {
    const entry = seedEntry({
      assistantId: "assistant-1",
      name: "Example Assistant",
      cloud: "local",
      port: 7830,
      cloudAssistantId: "cloud-asst-1",
      cloudOrganizationId: "org-123",
    });
    readCloudTokenMock.mockReturnValue("session-token");

    const result = await retireAssistantEntry(entry);

    expect(result).toEqual({ ok: true });
    // The cloud record resolves from the entry + env — no gateway credential
    // store is consulted.
    expect(loopbackSafeFetchMock).toHaveBeenCalledWith(
      "https://platform.example.test/v1/assistants/cloud-asst-1/retire/",
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Token": "session-token",
          "Cadet-Organization-Id": "org-123",
        },
      },
    );
    expect(retireLocalMock).toHaveBeenCalledWith("assistant-1", entry);
    expect(readLockfile().assistants).toEqual([]);
  });

  test("local retire resolves the organization via the cloud when the entry omits it", async () => {
    const entry = seedEntry({
      assistantId: "assistant-1",
      name: "Example Assistant",
      cloud: "local",
      port: 7830,
      cloudAssistantId: "cloud-asst-1",
    });
    readCloudTokenMock.mockReturnValue("session-token");

    await retireAssistantEntry(entry);

    expect(cloudAuthHeadersMock).toHaveBeenCalledWith(
      "session-token",
      "https://platform.example.test",
    );
    expect(authHeadersForKnownOrganizationMock).not.toHaveBeenCalled();
    expect(loopbackSafeFetchMock).toHaveBeenCalledWith(
      "https://platform.example.test/v1/assistants/cloud-asst-1/retire/",
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Token": "session-token",
        },
      },
    );
  });

  test("local retire skips the cloud unregister when no assistant id is bound", async () => {
    const entry = seedEntry({
      assistantId: "assistant-1",
      name: "Example Assistant",
      cloud: "local",
      port: 7830,
    });
    readCloudTokenMock.mockReturnValue("session-token");

    await retireAssistantEntry(entry);

    expect(loopbackSafeFetchMock).not.toHaveBeenCalled();
    expect(retireLocalMock).toHaveBeenCalledWith("assistant-1", entry);
  });

  test("local retire uses the injected platform token from the app host", async () => {
    const entry = seedEntry({
      assistantId: "assistant-1",
      name: "Example Assistant",
      cloud: "local",
      port: 7830,
      cloudAssistantId: "cloud-asst-1",
      cloudOrganizationId: "org-123",
    });
    process.env.CADET_PLATFORM_TOKEN = "host-session-token";
    readCloudTokenMock.mockReturnValue(null);

    await retireAssistantEntry(entry);

    expect(loopbackSafeFetchMock).toHaveBeenCalledWith(
      "https://platform.example.test/v1/assistants/cloud-asst-1/retire/",
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Token": "host-session-token",
          "Cadet-Organization-Id": "org-123",
        },
      },
    );
  });

  test("local retire continues when the cloud unregister fails", async () => {
    const entry = seedEntry({
      assistantId: "assistant-1",
      name: "Example Assistant",
      cloud: "local",
      port: 7830,
      cloudAssistantId: "cloud-asst-1",
      cloudOrganizationId: "org-123",
    });
    readCloudTokenMock.mockReturnValue("session-token");
    loopbackSafeFetchMock.mockResolvedValue(
      new Response("platform unavailable", { status: 503 }),
    );
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    };

    try {
      const result = await retireAssistantEntry(entry);
      expect(result).toEqual({ ok: true });
    } finally {
      console.warn = origWarn;
    }
    expect(retireLocalMock).toHaveBeenCalledWith("assistant-1", entry);
    expect(readLockfile().assistants).toEqual([]);
    expect(warns.join("\n")).toContain(
      "Platform self-hosted unregister failed (503): platform unavailable",
    );
    expect(warns.join("\n")).toContain("continuing local retire");
  });

  test("docker retire stops the containers then the app-server edge", async () => {
    const entry = seedEntry({
      assistantId: "asst-docker",
      cloud: "docker",
      port: 7831,
    });

    const result = await retireAssistantEntry(entry);

    expect(result).toEqual({ ok: true });
    expect(retireDockerMock).toHaveBeenCalledWith("asst-docker");
    expect(stopContainerAppServerMock).toHaveBeenCalledWith(entry);
    expect(readLockfile().assistants).toEqual([]);
  });

  test("apple-container retire sends the socket command then stops the edge", async () => {
    const entry = seedEntry({
      assistantId: "asst-apple",
      cloud: "apple-container",
      port: 7832,
      mgmtSocket: "/tmp/mgmt.sock",
    });

    const result = await retireAssistantEntry(entry);

    expect(result).toEqual({ ok: true });
    expect(retireAppleContainerMock).toHaveBeenCalledWith("asst-apple", entry);
    expect(stopContainerAppServerMock).toHaveBeenCalledWith(entry);
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

    await retireAssistantEntry(entry);

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

    await retireAssistantEntry(entry);

    expect(fs.existsSync(sentinel)).toBe(false);
  });

  test("the cloud leg without a platform credential fails structured, not by exiting", async () => {
    const entry = seedEntry({
      assistantId: "asst-cloud",
      cloud: "cloud",
    });

    const result = await retireAssistantEntry(entry);

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
  const appleEntry = {
    assistantId: "asst-apple",
    cloud: "apple-container",
    port: 7832,
    mgmtSocket: "/tmp/mgmt.sock",
  };
  const cloudEntry = { assistantId: "asst-cloud", cloud: "cloud" };
  const pairedEntry = {
    assistantId: "asst-paired",
    cloud: "custom",
    runtimeUrl: "https://gw.example.com",
  };

  const findEntry =
    (...entries: unknown[]) =>
    (assistantId: string): LockfileAssistant | undefined =>
      entries.find(
        (entry) =>
          (entry as { assistantId: string }).assistantId === assistantId,
      ) as LockfileAssistant | undefined;

  const depsWith = (
    retire: (entry: LockfileAssistant) => Promise<RetireResult>,
    ...entries: unknown[]
  ) => ({ retire, findEntry: findEntry(...entries) });

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
    const retire = mock(async (): Promise<RetireResult> => ({ ok: true }));
    const response = await executeOperatorMatch(
      matchOperatorRequest("/v1/assistants/asst-local/retire/", "DELETE")!,
      depsWith(retire as never, localEntry, dockerEntry, appleEntry),
    );
    expect(response?.status).toBe(204);
    expect(retire).toHaveBeenCalledWith(localEntry);
  });

  test("a retire failure answers the cloud error shape the dialog renders", async () => {
    const retire = mock(
      async (): Promise<RetireResult> => ({
        ok: false,
        status: 500,
        error: "no such assistant",
      }),
    );
    const response = await executeOperatorMatch(
      matchOperatorRequest("/v1/assistants/asst-local/retire/", "DELETE")!,
      depsWith(retire as never, localEntry),
    );
    expect(response?.status).toBe(500);
    expect(await response?.json()).toEqual({ detail: "no such assistant" });
  });

  test("cloud and paired entries pass through to the endpoint's forward", async () => {
    const retire = mock(async (): Promise<RetireResult> => ({ ok: true }));
    expect(
      await executeOperatorMatch(
        matchOperatorRequest("/v1/assistants/asst-cloud/retire/", "DELETE")!,
        depsWith(retire as never, cloudEntry),
      ),
    ).toBeNull();
    expect(
      await executeOperatorMatch(
        matchOperatorRequest("/v1/assistants/asst-paired/retire/", "DELETE")!,
        depsWith(retire as never, pairedEntry),
      ),
    ).toBeNull();
    expect(retire).not.toHaveBeenCalled();
  });

  test("an id the lockfile does not know passes", async () => {
    const retire = mock(async (): Promise<RetireResult> => ({ ok: true }));
    expect(
      await executeOperatorMatch(
        matchOperatorRequest("/v1/assistants/ghost/retire/", "DELETE")!,
        depsWith(retire as never, localEntry),
      ),
    ).toBeNull();
    expect(retire).not.toHaveBeenCalled();
  });
});
