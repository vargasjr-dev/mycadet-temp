/**
 * Tests for the `gateway pairing mint <url>` CLI command. The mint executes
 * the pairing logic DIRECTLY against the file-backed challenge store — no
 * IPC (the assistant daemon shares the gateway's socket, so an IPC-exposed
 * mint would let the assistant approve pairings for itself). These tests run
 * the real command and pin both the printed challenge and its landing in
 * the on-disk store the running gateway reads.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod";

const { parsePairingArgs, runPairingCommand } = await import("../pairing.js");
const {
  getRemoteWebPairingChallengeForTests,
  resetRemoteWebPairingChallengesForTests,
  setRemoteWebPairingChallengeNowForTests,
} = await import("../../remote-web/pairing-challenge-store.js");
const { resetRemoteWebPairingChallengeRateLimiterForTests } =
  await import("../../remote-web/pairing-challenge-rate-limit-store.js");
const { testSecurityDir } = await import("../../__tests__/test-preload.js");

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const PrintedChallengeSchema = z.object({
  deviceCode: z.string().min(1),
  userCode: z.string().regex(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/),
  verificationUri: z.string(),
  expiresAt: z.string(),
  expiresInSeconds: z.number(),
  intervalSeconds: z.number(),
});

let logs: string[];
let errors: string[];
let logSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  resetRemoteWebPairingChallengesForTests();
  resetRemoteWebPairingChallengeRateLimiterForTests();

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

function lastLoggedChallenge() {
  const line = logs[logs.length - 1];
  expect(line).toBeTruthy();
  return PrintedChallengeSchema.parse(JSON.parse(line!));
}

describe("gateway pairing mint", () => {
  test("mints an approved challenge directly against the file-backed store", async () => {
    const code = await runPairingCommand([
      "mint",
      "https://my-assistant.ts.net",
    ]);

    expect(code).toBe(0);
    const challenge = lastLoggedChallenge();
    expect(challenge.verificationUri).toBe(
      "https://my-assistant.ts.net/assistant/pair",
    );
    expect(challenge.intervalSeconds).toBe(5);

    // Approved on the spot: the CLI invocation IS the approval.
    const stored = getRemoteWebPairingChallengeForTests(challenge.userCode);
    expect(stored?.status).toBe("approved");
  });

  test("persists the challenge to the store the running gateway reads", async () => {
    const code = await runPairingCommand([
      "mint",
      "https://my-assistant.ts.net",
    ]);
    expect(code).toBe(0);

    const storePath = join(
      testSecurityDir,
      "remote-web-pairing-challenges.json",
    );
    expect(existsSync(storePath)).toBe(true);
    const raw = readFileSync(storePath, "utf-8");
    expect(raw).toContain('"status":"approved"');
    expect(raw).toContain('"requesterIp":"cli"');
  });

  test("rejects an unparseable public base URL", async () => {
    const code = await runPairingCommand(["mint", "not-a-url"]);

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("publicBaseUrl is required");
  });

  test("requires the public base URL argument", async () => {
    const code = await runPairingCommand(["mint"]);

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("mint requires the public base URL");
  });
});

describe("parsePairingArgs", () => {
  test("splits the subcommand and positional", () => {
    expect(parsePairingArgs(["mint", "https://x.example"])).toEqual({
      subcommand: "mint",
      positional: "https://x.example",
    });
    expect(parsePairingArgs([])).toEqual({
      subcommand: null,
      positional: null,
    });
  });
});

// ---------------------------------------------------------------------------
// `gateway pairing list`
// ---------------------------------------------------------------------------

const ListChallengeSchema = z.object({
  id: z.string(),
  userCode: z.string(),
  publicBaseUrl: z.string(),
  verificationUri: z.string(),
  status: z.enum(["pending", "approved", "exchanging", "consumed"]),
  createdAtMs: z.number(),
  expiresAtMs: z.number(),
  requesterIp: z.string(),
  requesterUserAgent: z.string().nullable(),
  viaEdgeProxy: z.boolean(),
  expired: z.boolean(),
});

function lastLoggedChallenges() {
  const line = logs[logs.length - 1];
  expect(line).toBeTruthy();
  const parsed = z
    .object({ ok: z.literal(true), challenges: z.array(ListChallengeSchema) })
    .parse(JSON.parse(line!));
  return parsed.challenges;
}

describe("gateway pairing list", () => {
  test("empty store prints a no-results line and exits 0", async () => {
    const code = await runPairingCommand(["list"]);

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("No pairing challenges found.");
  });

  test("--json lists every persisted challenge newest-first", async () => {
    // Both mints land inside the last minute so their 10-minute TTL keeps
    // them active against the real wall clock the CLI checks with, while
    // the frozen seam still pins deterministic createdAtMs values.
    const older = Date.now() - 60_000;
    const newer = Date.now() - 30_000;
    setRemoteWebPairingChallengeNowForTests(() => older);
    await runPairingCommand(["mint", "https://older.example.com"]);
    setRemoteWebPairingChallengeNowForTests(() => newer);
    await runPairingCommand(["mint", "https://newer.example.com"]);
    setRemoteWebPairingChallengeNowForTests(() => Date.now());

    const code = await runPairingCommand(["list", "--json"]);
    expect(code).toBe(0);

    const challenges = lastLoggedChallenges();
    expect(challenges).toHaveLength(2);
    expect(challenges[0]!.publicBaseUrl).toBe("https://newer.example.com");
    expect(challenges[1]!.publicBaseUrl).toBe("https://older.example.com");
    expect(challenges[1]!.createdAtMs).toBe(older);
    expect(challenges[1]!.status).toBe("approved");
    expect(challenges[1]!.expired).toBe(false);
    expect(challenges[1]!.requesterIp).toBe("cli");
    expect(challenges[1]!.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  test("expired challenges still list, flagged expired", async () => {
    // Mint at a frozen time an hour ago: the challenge's persisted expiry
    // (mint + 10-minute TTL) is then in the past of the real wall clock the
    // CLI checks against, without the store's own expiry paths deleting it.
    setRemoteWebPairingChallengeNowForTests(() => Date.now() - 3_600_000);
    await runPairingCommand(["mint", "https://stale.example.com"]);
    setRemoteWebPairingChallengeNowForTests(() => Date.now());

    const code = await runPairingCommand(["list", "--json"]);
    expect(code).toBe(0);

    const challenges = lastLoggedChallenges();
    expect(challenges).toHaveLength(1);
    expect(challenges[0]!.expired).toBe(true);
    expect(challenges[0]!.status).toBe("approved");
    expect(challenges[0]!.publicBaseUrl).toBe("https://stale.example.com");
  });

  test("human output shows user code, status, liveness, and timestamps", async () => {
    await runPairingCommand(["mint", "https://shown.example.com"]);

    const code = await runPairingCommand(["list"]);
    expect(code).toBe(0);

    const output = logs.join("\n");
    expect(output).toContain("approved");
    expect(output).toContain("active");
    expect(output).toContain("minted ");
    expect(output).toContain("expires ");
    expect(output).toContain("https://shown.example.com/assistant/pair");
  });
});
