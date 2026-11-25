/**
 * Tests for `cadet devices` (list) and `cadet devices revoke <hashedDeviceId>`:
 * the host-side CLI that runs the gateway's own `devices list --json` and
 * `devices revoke <id>` commands. Verifies host-gating (refuses paired
 * connections), the destructive-revoke confirmation, and that nothing goes
 * over HTTP.
 */
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

const testDir = mkdtempSync(join(tmpdir(), "devices-test-"));
const ORIGINAL_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
const ORIGINAL_ARGV = [...process.argv];
const ORIGINAL_FETCH = globalThis.fetch;

import { createHash } from "node:crypto";

import * as localMode from "@mycadet/local-mode";
import { devices } from "../commands/devices.js";
import { saveLockfileAssistant } from "@mycadet/local-mode";
import { computeDeviceId } from "@mycadet/local-mode";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

let fetchCalls: FetchCall[] = [];

/** Stub global fetch (spyOn does not intercept fetch in Bun). */
function stubFetch(
  handler: (url: string, init?: RequestInit) => Response,
): void {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
}

interface GatewayCall {
  assistantId: string;
  args: string[];
}

let gatewayCalls: GatewayCall[] = [];
let gatewaySpy: ReturnType<typeof spyOn> | undefined;

/** Stub the gateway's `devices` command: the handler returns its stdout or throws. */
function stubGateway(handler: (args: string[]) => string): void {
  gatewaySpy = spyOn(localMode, "runGatewayDevicesCommand").mockImplementation(
    async (entry, args) => {
      gatewayCalls.push({ assistantId: entry.assistantId, args });
      return handler(args);
    },
  );
}

function devicesJson(devices: unknown[]): string {
  return JSON.stringify({ devices });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface RunResult {
  exited: boolean;
  logs: string;
  errors: string;
}

/** Run devices() with console + process.exit spied. */
async function runDevices(): Promise<RunResult> {
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
  const errSpy = spyOn(console, "error").mockImplementation(
    (...a: unknown[]) => {
      errors.push(a.join(" "));
    },
  );
  const exitSpy = spyOn(process, "exit").mockImplementation(((c?: number) => {
    throw new Error(`exit:${c}`);
  }) as never);
  let exited = false;
  try {
    await devices();
  } catch (e) {
    exited = (e as Error).message?.startsWith("exit:") ?? false;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { exited, logs: logs.join("\n"), errors: errors.join("\n") };
}

describe("cadet devices", () => {
  beforeEach(() => {
    process.env.XDG_CONFIG_HOME = testDir;
    fetchCalls = [];
    gatewayCalls = [];
    // Any HTTP call is a regression: the gateway's devices routes are gone.
    stubFetch(() => jsonResponse({ error: "unexpected" }, 500));
    // Default stub: any unexpected gateway call fails.
    stubGateway(() => {
      throw new Error("unexpected gateway call");
    });
  });

  test("Docker devices list and revoke run the gateway's devices command", async () => {
    saveLockfileAssistant({
      assistantId: "docker-fixture",
      cloud: "docker",
    });
    stubGateway((args) => (args[0] === "list" ? devicesJson([]) : ""));
    process.argv = ["bun", "cadet", "devices", "docker-fixture", "--json"];
    expect((await runDevices()).exited).toBe(false);
    process.argv = [
      "bun",
      "cadet",
      "devices",
      "revoke",
      "fixture-device",
      "docker-fixture",
      "--yes",
      "--json",
    ];
    expect((await runDevices()).exited).toBe(false);
    expect(gatewayCalls).toEqual([
      { assistantId: "docker-fixture", args: ["list", "--json"] },
      {
        assistantId: "docker-fixture",
        args: ["revoke", "fixture-device"],
      },
    ]);
    expect(fetchCalls).toHaveLength(0);
  });

  test("unparseable gateway output fails the list", async () => {
    seedLocal("bad-output");
    stubGateway(() => "not json");
    process.argv = ["bun", "cadet", "devices", "bad-output", "--json"];
    const result = await runDevices();
    expect(result.exited).toBe(true);
    expect(result.errors).toContain("unexpected output");
  });

  afterEach(() => {
    gatewaySpy?.mockRestore();
    process.argv = [...ORIGINAL_ARGV];
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = ORIGINAL_CONFIG_HOME;
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function seedLocal(id: string, port = 7830): void {
    saveLockfileAssistant({
      assistantId: id,
      name: id,
      cloud: "local",
      instanceDir: testDir,
      port,
      daemonPort: 8501,
      cesPort: 9002,
    });
  }

  test("--help prints usage including Examples", async () => {
    process.argv = ["bun", "cadet", "devices", "--help"];
    const { logs } = await runDevices();
    expect(logs).toContain("USAGE:");
    expect(logs).toContain("EXAMPLES:");
    expect(logs).toContain("cadet devices revoke");
  });

  test("lists active devices from the gateway's devices command", async () => {
    seedLocal("list-host", 7833);
    stubGateway(() =>
      devicesJson([
        {
          hashedDeviceId: "hashAAA111",
          platform: "cli",
          issuedAt: 1_700_000_000_000,
          expiresAt: 1_800_000_000_000,
          lastUsedAt: 1_750_000_000_000,
          clientReportedName: "Alice's Laptop",
          pairingUserAgent: "cadet-cli/1.2.3 (darwin)",
        },
        {
          hashedDeviceId: "hashBBB222",
          platform: "webview",
          issuedAt: 1_700_000_000_000,
          expiresAt: null,
          lastUsedAt: null,
        },
      ]),
    );

    process.argv = ["bun", "cadet", "devices", "list-host"];
    const { exited, logs } = await runDevices();

    expect(exited).toBe(false);
    // Both full hashes + platforms surfaced; null lastUsedAt → "never".
    expect(logs).toContain("hashAAA111");
    expect(logs).toContain("hashBBB222");
    expect(logs).toContain("cli");
    expect(logs).toContain("webview");
    expect(logs).toContain("never");
    // Reported name + user agent print verbatim when present.
    expect(logs).toContain("Alice's Laptop");
    expect(logs).toContain("cadet-cli/1.2.3 (darwin)");
    // Missing fields print plain-word placeholders, not a dash or "undefined".
    expect(logs).toContain("not reported");
    expect(logs).toContain("not recorded");
    expect(logs).not.toContain("undefined");

    expect(gatewayCalls).toEqual([
      { assistantId: "list-host", args: ["list", "--json"] },
    ]);
    expect(fetchCalls).toHaveLength(0);
  });

  // Matches currentHostHashedDeviceId in the command: sha256 of the same
  // stable device id the host's guardian lease registered with the gateway.
  function hostHash(): string {
    return createHash("sha256").update(computeDeviceId()).digest("hex");
  }

  test("labels this machine's own host credential in the human list", async () => {
    seedLocal("host-label");
    stubGateway(() =>
      devicesJson([
        {
          hashedDeviceId: hostHash(),
          platform: "cli",
          issuedAt: 1_700_000_000_000,
          expiresAt: null,
          lastUsedAt: null,
        },
        {
          hashedDeviceId: "hashBBB222",
          platform: "ios",
          issuedAt: 1_700_000_000_000,
          expiresAt: null,
          lastUsedAt: null,
        },
      ]),
    );

    process.argv = ["bun", "cadet", "devices", "host-label"];
    const { exited, logs } = await runDevices();

    expect(exited).toBe(false);
    const label = "this machine's host credential";
    expect(logs).toContain(label);
    // Only the host record carries the label.
    expect(logs.split(label)).toHaveLength(2);
    const hostIdx = logs.indexOf(hostHash());
    const otherIdx = logs.indexOf("hashBBB222");
    const labelIdx = logs.indexOf(label);
    expect(labelIdx).toBeGreaterThan(hostIdx);
    expect(labelIdx).toBeLessThan(otherIdx);
  });

  test("list --json marks only the host credential with isCurrentHost", async () => {
    seedLocal("host-json", 7838);
    const hostRecord = {
      hashedDeviceId: hostHash(),
      platform: "cli",
      issuedAt: 1_700_000_000_000,
      expiresAt: null,
      lastUsedAt: null,
      pairingUserAgent: null,
      clientReportedName: null,
    };
    const otherRecord = {
      hashedDeviceId: "hashBBB222",
      platform: "ios",
      issuedAt: 1_700_000_000_000,
      expiresAt: null,
      lastUsedAt: null,
      pairingUserAgent: null,
      clientReportedName: null,
    };
    stubGateway(() => devicesJson([hostRecord, otherRecord]));

    process.argv = ["bun", "cadet", "devices", "host-json", "--json"];
    const { exited, logs } = await runDevices();

    expect(exited).toBe(false);
    const parsed = JSON.parse(logs) as {
      devices: Array<Record<string, unknown>>;
    };
    expect(parsed.devices[0]).toEqual({ ...hostRecord, isCurrentHost: true });
    // Non-host records omit the field entirely (lean wire).
    expect(parsed.devices[1]).toEqual(otherRecord);
    expect("isCurrentHost" in parsed.devices[1]!).toBe(false);
  });

  test("revoking the host credential warns on stderr but proceeds", async () => {
    seedLocal("host-revoke", 7839);
    stubGateway(() => `Device ${hostHash()} revoked.`);

    process.argv = [
      "bun",
      "cadet",
      "devices",
      "revoke",
      hostHash(),
      "host-revoke",
      "--yes",
    ];
    const { exited, logs, errors } = await runDevices();

    expect(exited).toBe(false);
    expect(errors).toContain("own host credential");
    expect(logs).toContain(`Revoked device ${hostHash()}`);
    expect(gatewayCalls).toHaveLength(1);
  });

  test("prints a clear message when no devices are paired", async () => {
    seedLocal("empty-host");
    stubGateway(() => devicesJson([]));

    process.argv = ["bun", "cadet", "devices", "empty-host"];
    const { exited, logs } = await runDevices();

    expect(exited).toBe(false);
    expect(logs).toContain("No devices are paired to empty-host");
  });

  test("revoke runs the gateway's revoke with --yes (no prompt)", async () => {
    seedLocal("revoke-host", 7834);
    stubGateway(() => "Device hashAAA111 revoked.");

    process.argv = [
      "bun",
      "cadet",
      "devices",
      "revoke",
      "hashAAA111",
      "revoke-host",
      "--yes",
    ];
    const { exited, logs } = await runDevices();

    expect(exited).toBe(false);
    expect(logs).toContain("Revoked device hashAAA111");

    expect(gatewayCalls).toEqual([
      { assistantId: "revoke-host", args: ["revoke", "hashAAA111"] },
    ]);
    expect(fetchCalls).toHaveLength(0);
  });

  test("revoke without a hashedDeviceId errors and makes no request", async () => {
    process.argv = ["bun", "cadet", "devices", "revoke", "--yes"];
    const { exited, errors } = await runDevices();

    expect(exited).toBe(true);
    expect(errors).toContain("hashedDeviceId is required");
    expect(gatewayCalls).toHaveLength(0);
  });

  test("revoke refuses without --yes in a non-interactive terminal", async () => {
    seedLocal("rh3");
    // process.stdin.isTTY is falsy under the test runner → not promptable.
    process.argv = ["bun", "cadet", "devices", "revoke", "hashZZZ", "rh3"];
    const { exited, errors } = await runDevices();

    expect(exited).toBe(true);
    expect(errors).toContain("--yes");
    expect(gatewayCalls).toHaveLength(0);
  });

  test("host-gates a paired connection (points to the host)", async () => {
    saveLockfileAssistant({
      assistantId: "paired-box",
      name: "Paired Box",
      cloud: "custom",
      ipAddress: "paired.example.com",
      port: 443,
    });

    process.argv = ["bun", "cadet", "devices", "paired-box"];
    const { exited, errors } = await runDevices();

    expect(exited).toBe(true);
    expect(errors).toContain("cadet devices");
    expect(gatewayCalls).toHaveLength(0);
  });

  test("list --json emits a single JSON document and no human text", async () => {
    seedLocal("json-host");
    const records = [
      {
        hashedDeviceId: "hashAAA111",
        platform: "cli",
        issuedAt: 1_700_000_000_000,
        expiresAt: 1_800_000_000_000,
        lastUsedAt: null,
        clientReportedName: "Alice's Laptop",
        pairingUserAgent: "cadet-cli/1.2.3 (darwin)",
      },
    ];
    stubGateway(() => devicesJson(records));

    process.argv = ["bun", "cadet", "devices", "json-host", "--json"];
    const { exited, logs, errors } = await runDevices();

    expect(exited).toBe(false);
    expect(errors).toBe("");
    // Exactly one line on stdout, parseable, and zero prose.
    expect(logs).not.toContain("\n");
    // Round-trips clientReportedName/pairingUserAgent with no writer change.
    expect(JSON.parse(logs)).toEqual({ devices: records });
    expect(logs).not.toContain("Devices paired to");
  });

  test('list --json with zero devices emits {"devices":[]}', async () => {
    seedLocal("json-empty-host");
    stubGateway(() => devicesJson([]));

    process.argv = ["bun", "cadet", "devices", "json-empty-host", "--json"];
    const { exited, logs } = await runDevices();

    expect(exited).toBe(false);
    expect(logs).toBe('{"devices":[]}');
  });

  test("revoke --json --yes emits one JSON line; identity preamble on stderr", async () => {
    seedLocal("json-revoke-host");
    stubGateway(() => "Device hashAAA111 revoked.");

    process.argv = [
      "bun",
      "cadet",
      "devices",
      "revoke",
      "hashAAA111",
      "json-revoke-host",
      "--yes",
      "--json",
    ];
    const { exited, logs, errors } = await runDevices();

    expect(exited).toBe(false);
    // Stdout is exactly one JSON document, no prose.
    expect(logs).not.toContain("\n");
    expect(JSON.parse(logs)).toEqual({
      ok: true,
      hashedDeviceId: "hashAAA111",
      assistantId: "json-revoke-host",
    });
    expect(logs).not.toContain("Device to revoke");
    // Destructive-identity preamble still printed, on stderr (cli/AGENTS.md).
    expect(errors).toContain("Device to revoke:");
    expect(errors).toContain("hashAAA111");
  });

  test("revoke --json without --yes exits 1 with empty stdout", async () => {
    seedLocal("json-noyes-host");

    process.argv = [
      "bun",
      "cadet",
      "devices",
      "revoke",
      "hashAAA111",
      "json-noyes-host",
      "--json",
    ];
    const { exited, logs, errors } = await runDevices();

    expect(exited).toBe(true);
    expect(logs).toBe("");
    expect(errors).toContain("--json requires --yes");
    expect(gatewayCalls).toHaveLength(0);
  });

  test("list --json still exits 1 with stderr when the gateway command fails", async () => {
    seedLocal("json-err-host");
    stubGateway(() => {
      throw new Error("gateway exited with code 1: boom");
    });

    process.argv = ["bun", "cadet", "devices", "json-err-host", "--json"];
    const { exited, logs, errors } = await runDevices();

    expect(exited).toBe(true);
    expect(logs).toBe("");
    expect(errors).toContain("boom");
  });

  test("surfaces a failed gateway command on list", async () => {
    seedLocal("err-host");
    stubGateway(() => {
      throw new Error("gateway exited with code 1: boom");
    });

    process.argv = ["bun", "cadet", "devices", "err-host"];
    const { exited, errors } = await runDevices();

    expect(exited).toBe(true);
    expect(errors).toContain("boom");
  });
});
