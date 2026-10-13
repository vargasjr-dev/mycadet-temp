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
