/**
 * Tests for the `gateway pair` CLI command. The command executes the
 * device-bound guardian mint DIRECTLY in this process — process execution
 * is the presence proof, no HTTP, no loopback check. These tests run the
 * real command against the temp security dir (the same harness the
 * bootstrap tests use) and pin the printed single-line JSON payload.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import { testSecurityDir } from "../../__tests__/test-preload.js";
import { join } from "node:path";

// Swappable assistant-DB backend — the guardian mint reads the assistant
// mirror through the proxy; give it a minimal in-memory schema.
type AssistantBackend = {
  query: (sql: string, params?: unknown[]) => unknown[];
  run: (sql: string, params?: unknown[]) => { changes: number };
  exec: (sql: string) => void;
};

let assistantBackend: AssistantBackend = {
  query: () => [],
  run: () => ({ changes: 0 }),
  exec: () => {},
};

mock.module("../../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: mock(async (sql: string, params?: unknown[]) =>
    assistantBackend.query(sql, params),
  ),
  assistantDbRun: mock(async (sql: string, params?: unknown[]) =>
    assistantBackend.run(sql, params),
  ),
  assistantDbExec: mock(async (sql: string) => assistantBackend.exec(sql)),
}));

import { initSigningKey } from "../../auth/token-service.js";

// Initialize signing key before any module that mints tokens is imported.
initSigningKey(Buffer.from("test-signing-key-at-least-32-bytes-long-xx"));

const { runPairCommand, parsePairArgs } = await import("../pair.js");
const { initGatewayDb, getGatewayDb, resetGatewayDb } =
  await import("../../db/connection.js");
const {
  contacts,
  contactChannels,
  actorTokenRecords,
  actorRefreshTokenRecords,
} = await import("../../db/schema.js");
import { bustGuardianIntegrityCache } from "../../auth/guardian-integrity.js";

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  const db = getGatewayDb();
  db.delete(contactChannels).run();
  db.delete(contacts).run();
  db.delete(actorTokenRecords).run();
  db.delete(actorRefreshTokenRecords).run();
  bustGuardianIntegrityCache();
});

afterAll(() => {
  resetGatewayDb();
});

let logs: string[];
let errors: string[];
let logSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  logs = [];
  errors = [];
  logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  errorSpy = spyOn(console, "error").mockImplementation(
    (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    },
  );
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

function lastLoggedPayload(): Record<string, unknown> {
  const line = logs[logs.length - 1];
  expect(line).toBeTruthy();
  return JSON.parse(line!);
}

describe("parsePairArgs", () => {
  test("parses the device identity flags", () => {
    expect(
      parsePairArgs([
        "--platform",
        "cli",
        "--device-id",
        "device-1",
        "--client-reported-name",
        "box",
      ]),
    ).toEqual({
      platform: "cli",
      deviceId: "device-1",
      clientReportedName: "box",
    });
  });

  test("defaults the platform to cli", () => {
    expect(parsePairArgs(["--device-id", "device-2"])?.platform).toBe("cli");
  });

  test("a missing device id is not a parse failure — the command refuses", () => {
    expect(parsePairArgs(["--platform", "cli"])?.deviceId).toBeNull();
  });
});

describe("gateway pair", () => {
  test("mints the device-bound credential in-process and prints it as JSON", async () => {
    const code = await runPairCommand([
      "--platform",
      "cli",
      "--device-id",
      "device-1",
      "--client-reported-name",
      "box",
    ]);

    expect(code).toBe(0);
    const payload = lastLoggedPayload();
    expect(typeof payload.token).toBe("string");
    expect(typeof payload.refreshToken).toBe("string");
    expect(payload.guardianId).toBeTruthy();
    expect(payload.assistantId).toBeTruthy();
    expect(payload.isNew).toBe(true);
    // The mint landed in the gateway DB the running server reads.
    const rows = getGatewayDb()
      .select({ id: actorTokenRecords.id })
      .from(actorTokenRecords)
      .all();
    expect(rows.length).toBeGreaterThan(0);
  });

  test("refuses without a device id", async () => {
    const code = await runPairCommand(["--platform", "cli"]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("--device-id is required");
    expect(logs).toHaveLength(0);
  });

  test("prints usage on --help", async () => {
    const code = await runPairCommand(["--help"]);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("Usage: gateway pair");
  });
});
