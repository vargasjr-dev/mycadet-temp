import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Temp dir for lockfile isolation — the detail views resolve assistant labels
// through the lockfile, which must stay empty here.
const testDir = mkdtempSync(join(tmpdir(), "cli-app-tunnel-status-test-"));
process.env.XDG_CONFIG_HOME = testDir;

import * as assistantConfig from "../lib/assistant-config.js";
import { app } from "../commands/app.js";
import { tunnel } from "../commands/tunnel.js";

// A pid no live process owns, so liveness checks deterministically report
// "not running".
const DEAD_PID = 999_999_999;

const readRootProcessesMock = spyOn(
  assistantConfig,
  "readRootProcesses",
).mockReturnValue({});

let logs: string[];
const logMock = spyOn(console, "log").mockImplementation((...parts) => {
  logs.push(parts.map(String).join(" "));
});
const errorMock = spyOn(console, "error").mockImplementation((...parts) => {
  logs.push(parts.map(String).join(" "));
});

beforeEach(() => {
  logs = [];
  readRootProcessesMock.mockReturnValue({});
});

afterAll(() => {
  logMock.mockRestore();
  errorMock.mockRestore();
  rmSync(testDir, { recursive: true, force: true });
});

describe("cadet app status", () => {
  test("reports the recorded edge's status and listen port", async () => {
    readRootProcessesMock.mockReturnValue({
      app: {
        pid: DEAD_PID,
        port: 7840,
        startedAt: "2026-10-21T12:00:00Z",
      },
    });

    process.argv = ["bun", "cadet", "app", "status"];
    await app();

    const out = logs.join("\n");
    expect(out).toContain("App edge (nginx):");
    expect(out).toContain("Status:");
    expect(out).toContain("not running");
    expect(out).toContain("http://127.0.0.1:7840");
  });

  test("reports when no edge is recorded", async () => {
    process.argv = ["bun", "cadet", "app", "status"];
    await app();

    expect(logs.join("\n")).toContain("not recorded");
  });
});

describe("cadet tunnel status", () => {
  test("reports the recorded tunnel's provider and URL", async () => {
    readRootProcessesMock.mockReturnValue({
      tunnel: {
        pid: DEAD_PID,
        provider: "ngrok",
        publicUrl: "https://example.ngrok-free.dev",
        startedAt: "2026-10-21T12:00:00Z",
      },
    });

    process.argv = ["bun", "cadet", "tunnel", "status"];
    await tunnel();

    const out = logs.join("\n");
    expect(out).toContain("Tunnel agent:");
    expect(out).toContain("not running");
    expect(out).toContain("Provider:");
    expect(out).toContain("https://example.ngrok-free.dev");
  });

  test("reports when no tunnel is recorded", async () => {
    process.argv = ["bun", "cadet", "tunnel", "status"];
    await tunnel();

    expect(logs.join("\n")).toContain("not recorded");
  });
});
