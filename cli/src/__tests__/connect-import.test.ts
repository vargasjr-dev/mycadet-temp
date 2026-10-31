/**
 * Tests for `cadet connect import <link-or-url>`: drive the host-side pairing
 * session (device-code exchange) and persist a lockfile entry + guardian token
 * under a unique local id.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = mkdtempSync(join(tmpdir(), "connect-import-test-"));
const ORIGINAL_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
const ORIGINAL_ARGV = [...process.argv];

import { connectImport } from "../commands/connect/import.js";
import { findAssistantByName } from "../lib/assistant-config.js";
import { saveLockfileAssistant } from "@mycadet/local-mode";
import { z } from "zod";
import { loadGuardianToken } from "../lib/guardian-token.js";
import { withPreconnect } from "./helpers/http.js";

const HOST = "https://host.example.ts.net";
const PAIRING_LINK = `${HOST}/assistant/pair#device_code=dev-code`;
const CHALLENGE_URL = `${HOST}/v1/remote-web/pairing-challenge`;
const TOKEN_URL = `${HOST}/v1/remote-web/pairing-token`;

// The gateway's own poll cadence, which is what the CLI waits between polls.
// The waits run on a virtual clock (see the `Bun.sleep` stub below), so a
// realistic cadence costs the suite nothing.
const POLL_INTERVAL_SECONDS = 5;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function challengeBody(overrides: Record<string, unknown> = {}) {
  return {
    deviceCode: "dev-code",
    userCode: "ABCD-EFGH",
    verificationUri: `${HOST}/assistant/pair`,
    publicBaseUrl: HOST,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    expiresInSeconds: 600,
    intervalSeconds: POLL_INTERVAL_SECONDS,
    ...overrides,
  };
}

function approvedBody(overrides: Record<string, unknown> = {}) {
  return {
    status: "approved",
    accessToken: "acc-tok",
    refreshToken: "refresh-tok",
    refreshTokenExpiresAt: "2030-01-01T00:00:00.000Z",
    refreshAfter: "2029-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** The commands always send flat string-keyed JSON bodies. */
const JsonRecord = z.record(z.string(), z.unknown());

interface FetchCall {
  url: string;
  body: Record<string, unknown>;
}

/** Install a fetch stub that answers from `replies`, recording every call. */
function stubFetch(
  replies: (call: FetchCall, index: number) => Response,
): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = withPreconnect(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        url: String(input),
        // The command always sends a JSON string body; anything else records
        // as an empty record.
        body: JsonRecord.parse(
          JSON.parse(typeof init?.body === "string" ? init.body : "{}"),
        ),
      };
      calls.push(call);
      return replies(call, calls.length - 1);
    },
  );
  return calls;
}

function captureLogs(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
  return { logs, restore: () => logSpy.mockRestore() };
}

/** Run the command with console.error and process.exit captured. */
async function runExpectingExit(): Promise<{ exited: boolean; out: string }> {
  const messages: string[] = [];
  const errSpy = spyOn(console, "error").mockImplementation(
    (...a: unknown[]) => {
      messages.push(a.join(" "));
    },
  );
  const logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    messages.push(a.join(" "));
  });
  const exitSpy = spyOn(process, "exit").mockImplementation(
    (c?: number | string | undefined): never => {
      throw new Error(`exit:${c}`);
    },
  );
  let exited = false;
  try {
    await connectImport();
  } catch (e) {
    exited = e instanceof Error && e.message === "exit:1";
  } finally {
    errSpy.mockRestore();
    logSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { exited, out: messages.join("\n") };
}

describe("connect import", () => {
  const originalFetch = globalThis.fetch;
  /** Every wait the command asked for, in milliseconds, in order. */
  let waits: number[];
  let sleepSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    process.env.XDG_CONFIG_HOME = testDir;
    waits = [];
    // The command turns the poll cadence straight into a `Bun.sleep`. Freeze
    // the clock and have each wait advance it by exactly what was asked for:
    // the deadlines the retry loop reads then move in step with the waits, so
    // a multi-second cadence is exercised in full without being spent, and
    // both the cadence and the backoff are assertable rather than implicit.
    setSystemTime(new Date());
    sleepSpy = spyOn(Bun, "sleep").mockImplementation(
      async (ms: number | Date) => {
        const waitMs = typeof ms === "number" ? ms : ms.getTime() - Date.now();
        waits.push(waitMs);
        setSystemTime(new Date(Date.now() + waitMs));
      },
    );
  });

  afterEach(() => {
    sleepSpy.mockRestore();
    setSystemTime();
    process.argv = [...ORIGINAL_ARGV];
    globalThis.fetch = originalFetch;
    if (ORIGINAL_CONFIG_HOME === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = ORIGINAL_CONFIG_HOME;
    }
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("a pairing link imports on the first poll, with no approval step", async () => {
    process.argv = [
      "bun",
      "cadet",
      "connect",
      "import",
      PAIRING_LINK,
      "--name",
      "link-box",
    ];
    const calls = stubFetch(() => jsonResponse(approvedBody()));
    const { logs, restore } = captureLogs();
    try {
      await connectImport();
    } finally {
      restore();
    }

    // The link carries an approved device code, so nothing is minted: one
    // exchange, and it is the import.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(TOKEN_URL);
    expect(calls[0].body.deviceCode).toBe("dev-code");
    expect(typeof calls[0].body.deviceId).toBe("string");
    expect(calls[0].body.platform).toBe("cli");

    const entry = findAssistantByName("link-box");
    expect(entry).not.toBeNull();
    expect(entry!.cloud).toBe("custom");
    expect(
      entry!.cloud === "custom" ? entry!.ipAddress : undefined,
    ).toBe(new URL(HOST).hostname);
    const token = loadGuardianToken("link-box");
    expect(token?.accessToken).toBe("acc-tok");
    expect(token?.refreshToken).toBe("refresh-tok");
    expect(token?.refreshTokenExpiresAt).toBe("2030-01-01T00:00:00.000Z");

    const output = logs.join("\n");
    expect(output).toContain("Imported paired assistant 'link-box'");
    expect(output).toContain("cadet client link-box");
    // No intermediate output: an approved link never shows an approval code.
    expect(output).not.toContain("Code:");
    expect(output).not.toContain("Waiting for approval");
  });

  test("a bare address prints the approval code and polls until approved", async () => {
    process.argv = [
      "bun",
      "cadet",
      "connect",
      "import",
      HOST,
      "--name",
      "coded-box",
    ];
    const calls = stubFetch((call, index) => {
      if (call.url === CHALLENGE_URL) {
        return jsonResponse(challengeBody());
      }
      // First exchange is still pending; the second one is approved.
      return index === 1
        ? jsonResponse(
            { status: "pending", intervalSeconds: POLL_INTERVAL_SECONDS },
            202,
          )
        : jsonResponse(
            approvedBody({
              refreshToken: undefined,
              refreshTokenExpiresAt: undefined,
            }),
          );
    });
    const { logs, restore } = captureLogs();
    try {
      await connectImport();
    } finally {
      restore();
    }

    expect(calls.map((c) => c.url)).toEqual([
      CHALLENGE_URL,
      TOKEN_URL,
      TOKEN_URL,
    ]);
    expect(calls[0].body).toEqual({});
    expect(calls[1].body.platform).toBe("cli");

    // One pending poll, waited out at exactly the cadence the gateway named.
    expect(waits).toEqual([POLL_INTERVAL_SECONDS * 1000]);

    const output = logs.join("\n");
    expect(output).toContain("Code: ABCD-EFGH");
    expect(output).toContain("cadet pair --web-approve ABCD-EFGH");
    expect(output).toContain("Imported paired assistant 'coded-box'");
    // No refresh credential came back, so the import is access-only.
    expect(output).toContain("access-only");
    expect(loadGuardianToken("coded-box")?.refreshToken).toBe("");
  });

  test("stops polling and reports expiry instead of looping", async () => {
    process.argv = ["bun", "cadet", "connect", "import", HOST];
    const calls = stubFetch((call) =>
      call.url === CHALLENGE_URL
        ? jsonResponse(challengeBody())
        : jsonResponse(
            {
              status: "pending",
              // The gateway moves the deadline into the past: the attempt is
              // over, and the next poll must report it rather than retry.
              expiresAt: new Date(Date.now() - 1000).toISOString(),
              intervalSeconds: POLL_INTERVAL_SECONDS,
            },
            202,
          ),
    );

    const { exited, out } = await runExpectingExit();

    expect(exited).toBe(true);
    expect(out).toContain("expired");
    // Challenge + one pending exchange; the expired poll never hits the wire.
    expect(calls).toHaveLength(2);
  });

  test("surfaces a denied or unknown code as an expiry", async () => {
    process.argv = ["bun", "cadet", "connect", "import", PAIRING_LINK];
    stubFetch(() => jsonResponse({ error: "expired_token" }, 410));

    const { exited, out } = await runExpectingExit();

    expect(exited).toBe(true);
    expect(out).toContain("expired or was denied");
  });

  test("refuses a non-https address before any request", async () => {
    process.argv = [
      "bun",
      "cadet",
      "connect",
      "import",
      "http://insecure.example.com",
    ];
    let fetched = false;
    globalThis.fetch = withPreconnect(async () => {
      fetched = true;
      return jsonResponse({});
    });

    const { exited, out } = await runExpectingExit();

    expect(exited).toBe(true);
    expect(out).toContain("https");
    expect(fetched).toBe(false);
  });

  test("refuses a loopback address before any request", async () => {
    process.argv = [
      "bun",
      "cadet",
      "connect",
      "import",
      "https://127.0.0.1:7830",
    ];
    let fetched = false;
    globalThis.fetch = withPreconnect(async () => {
      fetched = true;
      return jsonResponse({});
    });

    const { exited, out } = await runExpectingExit();

    expect(exited).toBe(true);
    expect(out).toContain("points back at this machine");
    expect(fetched).toBe(false);
  });

  test("a string that is neither an address nor a bundle keeps the address error", async () => {
    process.argv = ["bun", "cadet", "connect", "import", "not-a-url"];
    let fetched = false;
    globalThis.fetch = withPreconnect(async () => {
      fetched = true;
      return jsonResponse({});
    });

    const { exited, out } = await runExpectingExit();

    expect(exited).toBe(true);
    expect(out).toContain("pairing link");
    expect(fetched).toBe(false);
  });

  test("retries a transient failure and still imports", async () => {
    process.argv = [
      "bun",
      "cadet",
      "connect",
      "import",
      HOST,
      "--name",
      "flaky-box",
    ];
    let attempt = 0;
    globalThis.fetch = withPreconnect(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === CHALLENGE_URL) {
        return jsonResponse(challengeBody());
      }
      attempt += 1;
      // The first exchange dies in transport; the session stays alive.
      if (attempt === 1) {
        throw new Error("connect ECONNRESET");
      }
      return jsonResponse(approvedBody());
    });
    const { logs, restore } = captureLogs();
    try {
      await connectImport();
    } finally {
      restore();
    }

    expect(attempt).toBe(2);
    const output = logs.join("\n");
    // The stalled terminal says what it is doing, once.
    expect(output).toContain("Could not reach the assistant");
    expect(output).toContain("Still trying");
    expect(output).toContain("Imported paired assistant 'flaky-box'");
    expect(loadGuardianToken("flaky-box")?.accessToken).toBe("acc-tok");
  });

  test("retries a repairable gateway refusal and still imports", async () => {
    process.argv = [
      "bun",
      "cadet",
      "connect",
      "import",
      HOST,
      "--name",
      "repairing-box",
    ];
    let attempt = 0;
    globalThis.fetch = withPreconnect(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === CHALLENGE_URL) {
        return jsonResponse(challengeBody());
      }
      attempt += 1;
      // The gateway answers, but releases the code before a repairable
      // failure, so the session stays pollable and the code is still good.
      if (attempt === 1) {
        return jsonResponse({ error: "guardian repair required" }, 503);
      }
      return jsonResponse(approvedBody());
    });
    const { logs, restore } = captureLogs();
    try {
      await connectImport();
    } finally {
      restore();
    }

    expect(attempt).toBe(2);
    expect(logs.join("\n")).toContain(
      "Imported paired assistant 'repairing-box'",
    );
    expect(loadGuardianToken("repairing-box")?.accessToken).toBe("acc-tok");
  });

  test("reports expiry once transient failures outlast the code", async () => {
    process.argv = ["bun", "cadet", "connect", "import", HOST];
    let exchanges = 0;
    globalThis.fetch = withPreconnect(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === CHALLENGE_URL) {
        return jsonResponse(
          challengeBody({
            // A deadline the retry loop reaches within a few backoffs.
            expiresAt: new Date(Date.now() + 12_000).toISOString(),
          }),
        );
      }
      exchanges += 1;
      throw new Error("connect ECONNREFUSED");
    });

    const { exited, out } = await runExpectingExit();

    expect(exited).toBe(true);
    expect(out).toContain("expired");
    // Bounded: it backed off linearly (5s, then 10s), and the poll after that
    // landed past the deadline, so it stopped instead of looping forever. The
    // expired poll never hits the wire.
    expect(waits).toEqual([5_000, 10_000]);
    expect(exchanges).toBe(2);
  });

  test("a pairing link does not wait out an unreachable host", async () => {
    // Nothing proved this address reachable (a link opens its session without
    // a request), so the failure is reported instead of retried for the full
    // ten-minute TTL.
    process.argv = ["bun", "cadet", "connect", "import", PAIRING_LINK];
    let attempts = 0;
    globalThis.fetch = withPreconnect(async () => {
      attempts += 1;
      throw new Error("connect ECONNREFUSED");
    });

    const { exited, out } = await runExpectingExit();

    expect(exited).toBe(true);
    expect(out).toContain("Could not reach that assistant");
    expect(attempts).toBe(1);
  });

  test("missing address exits 1 with usage", async () => {
    process.argv = ["bun", "cadet", "connect", "import"];

    const { exited, out } = await runExpectingExit();

    expect(exited).toBe(true);
    expect(out).toContain("missing assistant address");
    expect(out).toContain("USAGE:");
  });

  test("rejects an unknown --flag instead of pairing against it", async () => {
    process.argv = ["bun", "cadet", "connect", "import", "--qr", HOST];
    let fetched = false;
    globalThis.fetch = withPreconnect(async () => {
      fetched = true;
      return jsonResponse({});
    });

    const { exited, out } = await runExpectingExit();

    // The flag is named and the CLI self-update path is offered. An address
    // error would be a lie: the address was never the problem.
    expect(exited).toBe(true);
    expect(out).toContain("unknown option '--qr'");
    expect(out).toContain("bun install -g cadet@latest");
    expect(out).not.toContain("pairing link");
    expect(fetched).toBe(false);
  });

  test("rejects an unknown --flag even alongside an address and --name", async () => {
    process.argv = [
      "bun",
      "cadet",
      "connect",
      "import",
      HOST,
      "--name",
      "guarded-box",
      "--frobnicate",
    ];
    let fetched = false;
    globalThis.fetch = withPreconnect(async () => {
      fetched = true;
      return jsonResponse({});
    });

    const { exited, out } = await runExpectingExit();

    // Known flags and a usable address never rescue an unknown one, and
    // nothing is registered before the refusal.
    expect(exited).toBe(true);
    expect(out).toContain("unknown option '--frobnicate'");
    expect(fetched).toBe(false);
    expect(findAssistantByName("guarded-box")).toBeNull();
  });

  test("does not overwrite an existing non-paired assistant", async () => {
    saveLockfileAssistant({
      assistantId: "desk",
      name: "Desk",
      cloud: "local",
    });
    process.argv = [
      "bun",
      "cadet",
      "connect",
      "import",
      PAIRING_LINK,
      "--name",
      "desk",
    ];
    const calls = stubFetch(() => jsonResponse(approvedBody()));

    const { exited, out } = await runExpectingExit();

    expect(exited).toBe(true);
    expect(out).toContain("Choose a different --name");
    // Refused BEFORE the exchange: the one-time code is never spent, so the
    // host records no orphaned device and the link stays usable.
    expect(calls).toHaveLength(0);
    const entry = findAssistantByName("desk");
    expect(entry!.cloud).toBe("local");
  });
});
