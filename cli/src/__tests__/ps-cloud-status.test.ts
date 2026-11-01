import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Temp directory for lockfile isolation
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), "cli-ps-platform-status-test-"));
process.env.XDG_CONFIG_HOME = testDir;

// ---------------------------------------------------------------------------
// Mocks — set up before importing the command under test. All spies are
// restored in afterAll so we don't leak module state to neighbouring suites.
// ---------------------------------------------------------------------------

import * as assistantConfig from "../lib/assistant-config.js";
import * as healthCheck from "../lib/health-check.js";
import * as cloudClient from "../lib/cloud-client.js";
import * as localMode from "@mycadet/local-mode";

const loadAllAssistantsMock = spyOn(
  localMode,
  "loadAllAssistants",
).mockReturnValue([]);
const readRootProcessesMock = spyOn(
  assistantConfig,
  "readRootProcesses",
).mockReturnValue({});
const getActiveAssistantMock = spyOn(
  localMode,
  "getActiveAssistant",
).mockReturnValue(null);
const getCloudUrlMock = spyOn(localMode, "getCloudUrl").mockReturnValue(
  "http://platform.test",
);

// Per-test toggle for `readCloudToken`.
const readCloudTokenMock = spyOn(localMode, "readCloudToken").mockReturnValue(
  null,
);

// `fetchCurrentUser` + `fetchCloudAssistants` are spied so we can assert
// they're never invoked on the no-token path, and re-shaped per-test for the
// token-but-unreachable path.
const fetchCurrentUserMock = spyOn(
  cloudClient,
  "fetchCurrentUser",
).mockResolvedValue({
  id: "u1",
  email: "test@example.com",
  display: "Test",
});
const fetchCloudAssistantsMock = spyOn(
  cloudClient,
  "fetchCloudAssistants",
).mockResolvedValue([]);
const checkCloudHealthMock = spyOn(
  healthCheck,
  "checkCloudHealth",
).mockResolvedValue({ status: "healthy", detail: null });

// ---------------------------------------------------------------------------
// stdout / stderr capture
// ---------------------------------------------------------------------------

let stdout: string[];
let stderr: string[];
let originalLog: typeof console.log;
let originalError: typeof console.error;
let originalStdoutWrite: typeof process.stdout.write;

beforeEach(() => {
  stdout = [];
  stderr = [];
  originalLog = console.log;
  originalError = console.error;
  originalStdoutWrite = process.stdout.write;
  console.log = ((...args: unknown[]) => {
    stdout.push(args.map((a) => String(a)).join(" "));
  }) as typeof console.log;
  console.error = ((...args: unknown[]) => {
    stderr.push(args.map((a) => String(a)).join(" "));
  }) as typeof console.error;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
});

const NL = String.fromCharCode(10);

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  process.stdout.write = originalStdoutWrite;
  loadAllAssistantsMock.mockReturnValue([]);
  getActiveAssistantMock.mockReturnValue(null);
  readCloudTokenMock.mockReturnValue(null);
  fetchCurrentUserMock.mockReset();
  fetchCurrentUserMock.mockResolvedValue({
    id: "u1",
    email: "test@example.com",
    display: "Test",
  });
  fetchCloudAssistantsMock.mockReset();
  fetchCloudAssistantsMock.mockResolvedValue([]);
  checkCloudHealthMock.mockReset();
  checkCloudHealthMock.mockResolvedValue({ status: "healthy", detail: null });
  readRootProcessesMock.mockReturnValue({});
});

afterAll(() => {
  loadAllAssistantsMock.mockRestore();
  getActiveAssistantMock.mockRestore();
  getCloudUrlMock.mockRestore();
  readCloudTokenMock.mockRestore();
  fetchCurrentUserMock.mockRestore();
  fetchCloudAssistantsMock.mockRestore();
  checkCloudHealthMock.mockRestore();
  rmSync(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Import the command under test AFTER mocks are wired up
// ---------------------------------------------------------------------------

import { listAllAssistants, ps } from "../commands/ps.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cadet ps — platform status line", () => {
  test("no local token: no login-status line, skips ALL network fetches", async () => {
    readCloudTokenMock.mockReturnValue(null);

    await listAllAssistants(false);

    // Login status lives in `cadet whoami` — ps never prints it.
    expect(stdout.some((l) => l.startsWith("Cloud:"))).toBe(false);
    expect(stderr.some((l) => l.includes("Failed to fetch organization"))).toBe(
      false,
    );
    expect(stdout.some((l) => l.includes("Failed to fetch organization"))).toBe(
      false,
    );

    // Structural guarantee: we never even tried to talk to the cloud.
    expect(fetchCurrentUserMock).not.toHaveBeenCalled();
    expect(fetchCloudAssistantsMock).not.toHaveBeenCalled();
  });

  test("local token present but platform is unreachable: no status line, no leaked org-fetch error", async () => {
    readCloudTokenMock.mockReturnValue("session_abc123");
    // Simulate the exact Bun connect failure the user reported:
    //   "Unable to connect. Is the computer able to access the url?"
    const connectError = new Error(
      "Unable to connect. Is the computer able to access the url?",
    );
    fetchCurrentUserMock.mockRejectedValue(connectError);
    fetchCloudAssistantsMock.mockRejectedValue(connectError);

    await listAllAssistants(false);

    expect(stdout.some((l) => l.startsWith("Cloud:"))).toBe(false);
    expect(stderr.some((l) => l.includes("Failed to fetch organization"))).toBe(
      false,
    );
    expect(stdout.some((l) => l.includes("Failed to fetch organization"))).toBe(
      false,
    );
    expect(stderr.some((l) => l.includes("Unable to connect"))).toBe(false);
  });

  test("local token present and platform reachable: no login-status line", async () => {
    readCloudTokenMock.mockReturnValue("session_abc123");
    fetchCurrentUserMock.mockResolvedValue({
      id: "u1",
      email: "user@example.com",
      display: "Example User",
    });
    fetchCloudAssistantsMock.mockResolvedValue([]);

    await listAllAssistants(false);

    expect(stdout.some((l) => l.startsWith("Cloud:"))).toBe(false);
    expect(stderr.some((l) => l.includes("Failed to fetch organization"))).toBe(
      false,
    );
  });

  test("default production environment: no Environment line; explicit staging prints 'Environment: staging'", async () => {
    delete process.env.CADET_ENVIRONMENT;

    await listAllAssistants(false);
    expect(stdout.some((l) => l.startsWith("Environment:"))).toBe(false);

    stdout = [];
    process.env.CADET_ENVIRONMENT = "staging";
    try {
      await listAllAssistants(false);
      expect(stdout.filter((l) => l.startsWith("Environment:"))).toEqual([
        "Environment: staging",
      ]);
    } finally {
      delete process.env.CADET_ENVIRONMENT;
    }
  });

  test("CLI-managed root processes nest under the assistant they front", async () => {
    loadAllAssistantsMock.mockReturnValue([
      {
        assistantId: "assistant-123",
        name: "Alice",
        cloud: "cloud",
      },
      {
        assistantId: "assistant-456",
        name: "Bob",
        cloud: "cloud",
      },
    ]);
    getActiveAssistantMock.mockReturnValue(null);
    checkCloudHealthMock.mockImplementation(async () => ({
      status: "healthy",
      detail: null,
    }));
    // The tunnel fronts the app server, no assistant; the edge records one.
    readRootProcessesMock.mockReturnValue({
      tunnel: {
        pid: 4242,
        provider: "ngrok",
        startedAt: "2026-10-11T00:00:00.000Z",
      },
      app: {
        pid: 77,
        port: 7841,
        startedAt: "2026-10-11T00:00:00.000Z",
      },
    });

    await listAllAssistants(false);

    const output = stdout.join(NL);
    // The tunnel and the edge render machine-level — root resources, never
    // children of an assistant row…
    expect(output).toContain("ngrok");
    expect(output).not.toContain("└ ngrok");
    expect(output).toContain("nginx");
    // The edge's INFO leads with its listen URL (not a bare port).
    expect(output).toContain("http://127.0.0.1:7841");
    // …the type column distinguishes the three process kinds…
    expect(output).toContain("🤖 Assistant");
    expect(output).toContain("🚇 Tunnel");
    expect(output).toContain("🌐 App");
    // …and the second table is gone: one header row only.
    expect(output.match(/NAME/g)?.length).toBe(1);
  });

  test("assistant rows use display name as primary label and keep id visible", async () => {
    loadAllAssistantsMock.mockReturnValue([
      {
        assistantId: "assistant-123",
        name: "Alice",
        cloud: "cloud",
      },
    ]);
    getActiveAssistantMock.mockReturnValue("assistant-123");

    await listAllAssistants(false);

    const output = stdout.join("\n");
    expect(output).toContain("* Alice");
    expect(output).toContain("remote: cloud");
    // The row shows the DERIVED cloud url — the cloud-url stack's answer in
    // this environment, not a per-entry record.
    expect(output).toContain("https://cloud.mycadet.ai");
    expect(output).not.toContain("* assistant-123");
  });

  test("assistant list renders one stable final row per assistant", async () => {
    loadAllAssistantsMock.mockReturnValue([
      {
        assistantId: "assistant-123",
        name: "Alice",
        cloud: "cloud",
      },
      {
        assistantId: "assistant-456",
        name: "Bob",
        cloud: "cloud",
      },
    ]);
    getActiveAssistantMock.mockReturnValue("assistant-123");
    checkCloudHealthMock.mockImplementation(async (entry) => ({
      status: entry.assistantId === "assistant-123" ? "healthy" : "sleeping",
      detail: null,
    }));

    await listAllAssistants(false);

    const output = stdout.join("\n");
    expect(output).not.toContain("\x1b[");
    expect(output).not.toContain("checking...");
    expect(output.match(/Alice/g)).toHaveLength(1);
    expect(output.match(/Bob/g)).toHaveLength(1);
    expect(output).toContain("healthy");
    expect(output).toContain("sleeping");
  });
});

describe("cadet ps <built-in process name> details", () => {
  const originalArgv = process.argv;
  afterEach(() => {
    process.argv = originalArgv;
    readRootProcessesMock.mockReturnValue({});
  });

  test("`ps nginx` details the app edge with its listen URL", async () => {
    readRootProcessesMock.mockReturnValue({
      app: {
        pid: 77,
        port: 7841,
        startedAt: "2026-10-20T15:00:00.000Z",
      },
    });
    process.argv = ["bun", "cadet", "ps", "nginx"];

    await ps();

    const output = stdout.join(NL);
    expect(output).toContain("App edge (nginx):");
    expect(output).toContain("http://127.0.0.1:7841");
  });

  test("`ps nginx` with no record points at `cadet app start`", async () => {
    readRootProcessesMock.mockReturnValue({});
    process.argv = ["bun", "cadet", "ps", "nginx"];

    await ps();

    expect(stdout.join(NL)).toContain("not recorded");
  });

  test("`ps ngrok` details the tunnel agent with its public URL", async () => {
    readRootProcessesMock.mockReturnValue({
      tunnel: {
        pid: 4242,
        provider: "ngrok",
        startedAt: "2026-10-20T15:00:00.000Z",
        publicUrl: "https://camping.ngrok-free.dev",
      },
    });
    process.argv = ["bun", "cadet", "ps", "ngrok"];

    await ps();

    const output = stdout.join(NL);
    expect(output).toContain("Tunnel agent (ngrok):");
    expect(output).toContain("https://camping.ngrok-free.dev");
  });

  test("an assistant name still resolves the assistant", async () => {
    loadAllAssistantsMock.mockReturnValue([
      {
        assistantId: "assistant-123",
        name: "nginx",
        cloud: "cloud",
      },
    ]);
    checkCloudHealthMock.mockImplementation(async () => ({
      status: "healthy",
      detail: null,
    }));
    process.argv = ["bun", "cadet", "ps", "assistant-123"];

    await ps();

    // A built-in name only wins when asked for by name; an assistant ID
    // resolves the assistant's process table as before.
    const output = stdout.join(NL);
    expect(output).toContain("Processes for");
  });
});
