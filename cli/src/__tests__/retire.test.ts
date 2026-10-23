import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LockfileAssistant } from "../lib/assistant-config.js";
import { loadAllAssistants } from "../lib/assistant-config.js";
import * as loopbackFetchModule from "../lib/loopback-fetch.js";
import * as cloudClientModule from "../lib/cloud-client.js";
import * as retireLocalModule from "../lib/retire-local.js";

const testDir = mkdtempSync(join(tmpdir(), "cli-retire-test-"));
const originalArgv = [...process.argv];
const originalExit = process.exit;
const originalLockfileDir = process.env.CADET_LOCKFILE_DIR;
const originalPlatformToken = process.env.CADET_PLATFORM_TOKEN;
const originalStdinIsTTY = process.stdin.isTTY;
const originalStdoutIsTTY = process.stdout.isTTY;
const originalStdinIsRaw = process.stdin.isRaw;
const originalSetRawMode = process.stdin.setRawMode;
const originalStdoutWrite = process.stdout.write;
const realRetireLocalModule = { ...retireLocalModule };
const realCloudClientModule = { ...cloudClientModule };
const realLoopbackFetchModule = { ...loopbackFetchModule };

const retireLocalMock = mock(async () => {});
const readCloudTokenMock = mock((): string | null => null);
const authHeadersMock = mock(async () => ({
  "Content-Type": "application/json",
  "X-Session-Token": "session-token",
}));
const authHeadersForKnownOrganizationMock = mock(
  (token: string, organizationId: string) => ({
    "Content-Type": "application/json",
    "X-Session-Token": token,
    "Cadet-Organization-Id": organizationId,
  }),
);
const getCloudUrlMock = mock(() => "https://platform.example.com");
const readGatewayCredentialMock = mock(
  async (
    _gatewayUrl: string,
    _name: string,
    _bearerToken?: string,
  ): Promise<{ value: string | null; unreachable: boolean }> => ({
    value: null,
    unreachable: false,
  }),
);
const loopbackSafeFetchMock = mock(
  async (): Promise<Response> => new Response(null, { status: 204 }),
);

mock.module("../lib/retire-local.js", () => ({
  ...realRetireLocalModule,
  retireLocal: retireLocalMock,
}));

mock.module("../lib/cloud-client.js", () => ({
  authHeaders: authHeadersMock,
  authHeadersForKnownOrganization: authHeadersForKnownOrganizationMock,
  getCloudUrl: getCloudUrlMock,
  readGatewayCredential: readGatewayCredentialMock,
  readCloudToken: readCloudTokenMock,
}));

mock.module("../lib/loopback-fetch.js", () => ({
  loopbackSafeFetch: loopbackSafeFetchMock,
}));

import { retire } from "../commands/retire.js";

let consoleLogSpy: ReturnType<typeof spyOn>;
let consoleErrorSpy: ReturnType<typeof spyOn>;
let consoleWarnSpy: ReturnType<typeof spyOn>;

function makeEntry(
  assistantId: string,
  extra: Partial<LockfileAssistant> = {},
): LockfileAssistant {
  return {
    assistantId,
    runtimeUrl: `http://127.0.0.1:${7800 + assistantId.length}`,
    cloud: "local",
    resources: {
      instanceDir: join(testDir, assistantId),
      daemonPort: 7801,
      gatewayPort: 7831,
      qdrantPort: 6334,
      cesPort: 7790,
    },
    ...extra,
  };
}

function writeLockfile(entries: LockfileAssistant[]): void {
  mkdirSync(testDir, { recursive: true });
  writeFileSync(
    join(testDir, "lockfile.json"),
    JSON.stringify({ assistants: entries }, null, 2) + "\n",
  );
}

function readLockfile(): string {
  return readFileSync(join(testDir, "lockfile.json"), "utf-8");
}

function setTerminalMode(isTTY: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: isTTY,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: isTTY,
  });
}

function setInteractiveTerminal(): void {
  setTerminalMode(true);
  Object.defineProperty(process.stdin, "isRaw", {
    configurable: true,
    value: false,
  });
  Object.defineProperty(process.stdin, "setRawMode", {
    configurable: true,
    value: mock(() => process.stdin),
  });
  process.stdout.write = (() => true) as typeof process.stdout.write;
}

function restoreTerminal(): void {
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: originalStdinIsTTY,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: originalStdoutIsTTY,
  });
  Object.defineProperty(process.stdin, "isRaw", {
    configurable: true,
    value: originalStdinIsRaw,
  });
  Object.defineProperty(process.stdin, "setRawMode", {
    configurable: true,
    value: originalSetRawMode,
  });
  process.stdout.write = originalStdoutWrite;
}

describe("cadet retire", () => {
  beforeEach(() => {
    process.env.CADET_LOCKFILE_DIR = testDir;
    delete process.env.CADET_PLATFORM_TOKEN;
    for (const name of [
      "lockfile.json",
      ".cadet.lock.json",
      ".cadet.lockfile.json",
    ]) {
      rmSync(join(testDir, name), { force: true });
    }
    process.argv = ["bun", "cadet", "retire"];
    process.exit = ((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit;
    retireLocalMock.mockReset();
    retireLocalMock.mockResolvedValue(undefined);
    readCloudTokenMock.mockReset();
    readCloudTokenMock.mockReturnValue(null);
    authHeadersMock.mockReset();
    authHeadersMock.mockResolvedValue({
      "Content-Type": "application/json",
      "X-Session-Token": "session-token",
    });
    authHeadersForKnownOrganizationMock.mockReset();
    authHeadersForKnownOrganizationMock.mockImplementation(
      (token: string, organizationId: string) => ({
        "Content-Type": "application/json",
        "X-Session-Token": token,
        "Cadet-Organization-Id": organizationId,
      }),
    );
    getCloudUrlMock.mockReset();
    getCloudUrlMock.mockReturnValue("https://platform.example.com");
    readGatewayCredentialMock.mockReset();
    readGatewayCredentialMock.mockResolvedValue({
      value: null,
      unreachable: false,
    });
    loopbackSafeFetchMock.mockReset();
    loopbackSafeFetchMock.mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    setTerminalMode(false);
    consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;
    restoreTerminal();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  afterAll(() => {
    mock.module("../lib/retire-local.js", () => realRetireLocalModule);
    mock.module("../lib/cloud-client.js", () => realCloudClientModule);
    mock.module("../lib/loopback-fetch.js", () => realLoopbackFetchModule);
    if (originalLockfileDir === undefined) {
      delete process.env.CADET_LOCKFILE_DIR;
    } else {
      process.env.CADET_LOCKFILE_DIR = originalLockfileDir;
    }
    if (originalPlatformToken === undefined) {
      delete process.env.CADET_PLATFORM_TOKEN;
    } else {
      process.env.CADET_PLATFORM_TOKEN = originalPlatformToken;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  test("--yes retires by unquoted display name and removes by assistant ID", async () => {
    const entry = makeEntry("assistant-1", { name: "Example Assistant" });
    writeLockfile([entry]);
    process.argv = ["bun", "cadet", "retire", "Example", "Assistant", "--yes"];

    await retire();

    expect(retireLocalMock).toHaveBeenCalledWith("assistant-1", entry);
    expect(loadAllAssistants()).toEqual([]);
    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Name: Example Assistant");
    expect(output).toContain("ID: assistant-1");
    expect(output).toContain("Removed Example Assistant from config.");
  });

  test("local retire unregisters the cloud record straight from the lockfile entry", async () => {
    const entry = makeEntry("assistant-1", {
      name: "Example Assistant",
      cloudAssistantId: "cloud-asst-1",
      cloudOrganizationId: "org-123",
    });
    writeLockfile([entry]);
    readCloudTokenMock.mockReturnValue("session-token");
    getCloudUrlMock.mockReturnValue("https://platform.example.test");
    process.argv = ["bun", "cadet", "retire", "assistant-1", "--yes"];

    await retire();

    // The cloud record resolves from the entry + env — the local gateway
    // credential store is never consulted.
    expect(readGatewayCredentialMock).not.toHaveBeenCalled();
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
    expect(loadAllAssistants()).toEqual([]);
  });

  test("local retire resolves the organization via the cloud when the entry omits it", async () => {
    const entry = makeEntry("assistant-1", {
      name: "Example Assistant",
      cloudAssistantId: "cloud-asst-1",
    });
    writeLockfile([entry]);
    readCloudTokenMock.mockReturnValue("session-token");
    getCloudUrlMock.mockReturnValue("https://platform.example.test");
    process.argv = ["bun", "cadet", "retire", "assistant-1", "--yes"];

    await retire();

    expect(authHeadersMock).toHaveBeenCalledWith(
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
    expect(retireLocalMock).toHaveBeenCalledWith("assistant-1", entry);
    expect(loadAllAssistants()).toEqual([]);
  });

  test("local retire skips the cloud unregister when no assistant id is bound", async () => {
    const entry = makeEntry("assistant-1", { name: "Example Assistant" });
    writeLockfile([entry]);
    readCloudTokenMock.mockReturnValue("session-token");
    getCloudUrlMock.mockReturnValue("https://platform.example.test");
    process.argv = ["bun", "cadet", "retire", "assistant-1", "--yes"];

    await retire();

    expect(loopbackSafeFetchMock).not.toHaveBeenCalled();
    expect(retireLocalMock).toHaveBeenCalledWith("assistant-1", entry);
    expect(loadAllAssistants()).toEqual([]);
  });

  test("local retire uses injected platform token from the app host", async () => {
    const entry = makeEntry("assistant-1", {
      name: "Example Assistant",
      cloudAssistantId: "cloud-asst-1",
      cloudOrganizationId: "org-123",
    });
    writeLockfile([entry]);
    process.env.CADET_PLATFORM_TOKEN = "host-session-token";
    readCloudTokenMock.mockReturnValue(null);
    getCloudUrlMock.mockReturnValue("https://platform.example.test");
    process.argv = ["bun", "cadet", "retire", "assistant-1", "--yes"];

    await retire();

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
    expect(retireLocalMock).toHaveBeenCalledWith("assistant-1", entry);
  });

  test("local retire continues when the cloud unregister fails", async () => {
    const entry = makeEntry("assistant-1", {
      name: "Example Assistant",
      cloudAssistantId: "cloud-asst-1",
      cloudOrganizationId: "org-123",
    });
    writeLockfile([entry]);
    readCloudTokenMock.mockReturnValue("session-token");
    getCloudUrlMock.mockReturnValue("https://platform.example.test");
    loopbackSafeFetchMock.mockResolvedValue(
      new Response("platform unavailable", { status: 503 }),
    );
    process.argv = ["bun", "cadet", "retire", "assistant-1", "--yes"];

    await retire();

    expect(retireLocalMock).toHaveBeenCalledWith("assistant-1", entry);
    expect(loadAllAssistants()).toEqual([]);
    expect(consoleWarnSpy.mock.calls.flat().join("\n")).toContain(
      "Platform self-hosted unregister failed (503): platform unavailable",
    );
  });

  test("non-interactive retire without --yes fails before deleting", async () => {
    const entry = makeEntry("assistant-1", { name: "Example Assistant" });
    writeLockfile([entry]);
    const before = readLockfile();
    process.argv = ["bun", "cadet", "retire", "Example", "Assistant"];

    await expect(retire()).rejects.toThrow("process.exit:1");

    expect(retireLocalMock).not.toHaveBeenCalled();
    expect(readLockfile()).toBe(before);
    const output = consoleErrorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Refusing to retire without confirmation");
    expect(output).toContain("--yes");
  });

  test("interactive cancel leaves the assistant untouched", async () => {
    const entry = makeEntry("assistant-1", { name: "Example Assistant" });
    writeLockfile([entry]);
    const before = readLockfile();
    setInteractiveTerminal();
    process.argv = ["bun", "cadet", "retire", "Example", "Assistant"];

    const pending = retire();
    queueMicrotask(() => {
      process.stdin.emit("data", Buffer.from("q"));
    });

    await expect(pending).rejects.toThrow("process.exit:1");
    expect(retireLocalMock).not.toHaveBeenCalled();
    expect(readLockfile()).toBe(before);
    expect(consoleLogSpy.mock.calls.flat().join("\n")).toContain(
      "Retire cancelled.",
    );
  });

  test("interactive confirmation retires the assistant", async () => {
    const entry = makeEntry("assistant-1", { name: "Example Assistant" });
    writeLockfile([entry]);
    setInteractiveTerminal();
    process.argv = ["bun", "cadet", "retire", "Example", "Assistant"];

    const pending = retire();
    queueMicrotask(() => {
      process.stdin.emit("data", Buffer.from([13]));
    });

    await pending;
    expect(retireLocalMock).toHaveBeenCalledWith("assistant-1", entry);
    expect(loadAllAssistants()).toEqual([]);
  });

  test("ambiguous display names fail before deleting", async () => {
    writeLockfile([
      makeEntry("assistant-1", { name: "Example Assistant" }),
      makeEntry("assistant-2", { name: "Example Assistant" }),
    ]);
    const before = readLockfile();
    process.argv = ["bun", "cadet", "retire", "Example", "Assistant", "--yes"];

    await expect(retire()).rejects.toThrow("process.exit:1");

    expect(retireLocalMock).not.toHaveBeenCalled();
    expect(readLockfile()).toBe(before);
    const output = consoleErrorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Multiple assistants match 'Example Assistant'");
    expect(output).toContain("assistant-1");
    expect(output).toContain("assistant-2");
  });
});
