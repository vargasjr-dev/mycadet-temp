/**
 * Tests for the `gateway pairing mint <url>` CLI command, exercised against
 * a real in-process GatewayIpcServer so the NDJSON wire format, socket-path
 * resolution (CADET_WORKSPACE_DIR), and the mint-into-the-live-store behavior
 * are all real.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

const { GatewayIpcServer } = await import("../../ipc/server.js");
const { createPairingIpcRoutes } =
  await import("../../ipc/pairing-handlers.js");
const { runPairingCommand } = await import("../pairing.js");
const {
  getRemoteWebPairingChallengeForTests,
  resetRemoteWebPairingChallengesForTests,
} = await import("../../remote-web/pairing-challenge-store.js");
const { resetRemoteWebPairingChallengeRateLimiterForTests } =
  await import("../../remote-web/pairing-challenge-rate-limit-store.js");

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let workspaceDir: string;
let server: { start(): void; stop(): void };
let origWorkspaceDir: string | undefined;
let logs: string[];
let errors: string[];

beforeEach(() => {
  resetRemoteWebPairingChallengesForTests();
  resetRemoteWebPairingChallengeRateLimiterForTests();

  origWorkspaceDir = process.env.CADET_WORKSPACE_DIR;
  workspaceDir = mkdtempSync(join(tmpdir(), "gateway-pairing-cli-"));
  mkdirSync(join(workspaceDir, "workspace"), { recursive: true });
  process.env.CADET_WORKSPACE_DIR = join(workspaceDir, "workspace");

  server = new GatewayIpcServer(createPairingIpcRoutes());
  server.start();

  logs = [];
  errors = [];
  spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  server.stop();
  if (origWorkspaceDir === undefined) {
    delete process.env.CADET_WORKSPACE_DIR;
  } else {
    process.env.CADET_WORKSPACE_DIR = origWorkspaceDir;
  }
  rmSync(workspaceDir, { recursive: true, force: true });
});

function lastLoggedJson(): unknown {
  const line = logs[logs.length - 1];
  expect(line).toBeTruthy();
  return JSON.parse(line!);
}

describe("gateway pairing mint", () => {
  test("mints an approved challenge over the real IPC socket and prints it as JSON", async () => {
    const code = await runPairingCommand([
      "mint",
      "https://my-assistant.ts.net",
    ]);

    expect(code).toBe(0);
    const challenge = lastLoggedJson() as {
      deviceCode: string;
      userCode: string;
      verificationUri: string;
    };
    expect(challenge.deviceCode).toBeTruthy();
    expect(challenge.verificationUri).toBe(
      "https://my-assistant.ts.net/assistant/pair",
    );

    const stored = getRemoteWebPairingChallengeForTests(challenge.userCode);
    expect(stored?.status).toBe("approved");
  });

  test("fails with a diagnostic on an unknown subcommand", async () => {
    const code = await runPairingCommand(["exchange", "whatever"]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("unknown pairing subcommand");
  });

  test("fails with a diagnostic when the URL is missing", async () => {
    const code = await runPairingCommand(["mint"]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("requires the public base URL");
  });
});
