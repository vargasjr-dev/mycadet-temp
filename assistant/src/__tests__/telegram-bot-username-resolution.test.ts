/**
 * Tests for `ensureTelegramBotUsernameResolved()`.
 *
 * This function fills the bot-username gap when the token was configured
 * without a `getMe` call (e.g. via `credential set` or ingress secret
 * redirect). Each branch is exercised in isolation by controlling the
 * mutable mock variables below.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { loadRawConfig } from "../config/loader.js";
import { credentialKey } from "../security/credential-key.js";
import { useMemorySecureKeyMap } from "./helpers/secure-keys.js";
import { setConfig } from "./helpers/set-config.js";

// The REAL secure-keys module pinned to a live memory backend, seeded under
// the credential key the telegram transport reads.
const secureKeys = useMemorySecureKeyMap();
const TELEGRAM_BOT_TOKEN = credentialKey("telegram", "bot_token");

// ---------------------------------------------------------------------------
// Mutable mock state — tests toggle these before each call
// ---------------------------------------------------------------------------

let mockBotUsername: string | undefined;

mock.module("../telegram/bot-username.js", () => ({
  getTelegramBotUsername: () => mockBotUsername,
  getTelegramBotId: () => (mockBotUsername ? "123456" : undefined),
}));

// ---------------------------------------------------------------------------
// Real-config assertion helper — the function under test persists the
// resolved username via the real loader (`loadRawConfig` → `setNestedValue`
// → `saveRawConfig`), so tests assert against the workspace config file.
// ---------------------------------------------------------------------------

function readResolvedBotUsername(): unknown {
  const raw = loadRawConfig() as { telegram?: { botUsername?: unknown } };
  return raw.telegram?.botUsername;
}

// ---------------------------------------------------------------------------
// Global fetch mock — swapped per test
// ---------------------------------------------------------------------------

let mockFetchResponse: {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};
let mockFetchThrows: Error | undefined;
let fetchCallCount = 0;

beforeEach(() => {
  mockBotUsername = undefined;
  secureKeys.delete(TELEGRAM_BOT_TOKEN);
  // Clear any username a prior test persisted; all tests share one workspace
  // config.json, and the file is the write target under test.
  setConfig("telegram", {});
  mockFetchThrows = undefined;
  mockFetchResponse = {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: { username: "ResolvedBot" } }),
  };
  fetchCallCount = 0;

  globalThis.fetch = (async (..._args: unknown[]) => {
    fetchCallCount++;
    if (mockFetchThrows) {
      throw mockFetchThrows;
    }
    return mockFetchResponse;
  }) as typeof globalThis.fetch;
});

// ---------------------------------------------------------------------------
// Import under test — AFTER mocks are registered
// ---------------------------------------------------------------------------

const { ensureTelegramBotUsernameResolved } =
  await import("../runtime/channel-invite-transports/telegram.js");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ensureTelegramBotUsernameResolved", () => {
  test("(a) early-returns when bot username is already cached in config", async () => {
    mockBotUsername = "CachedBot";
    secureKeys.set(TELEGRAM_BOT_TOKEN, "some-token");

    await ensureTelegramBotUsernameResolved();

    expect(fetchCallCount).toBe(0);
    expect(readResolvedBotUsername()).toBeUndefined();
  });

  test("(b) fetches getMe and writes username to config on success", async () => {
    mockBotUsername = undefined;
    secureKeys.set(TELEGRAM_BOT_TOKEN, "bot-token-123");
    mockFetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { username: "MyNewBot" } }),
    };

    await ensureTelegramBotUsernameResolved();

    expect(fetchCallCount).toBe(1);
    expect(readResolvedBotUsername()).toBe("MyNewBot");
  });

  test("(c) handles non-200 response gracefully without writing to config", async () => {
    mockBotUsername = undefined;
    secureKeys.set(TELEGRAM_BOT_TOKEN, "bot-token-123");
    mockFetchResponse = {
      ok: false,
      status: 401,
      json: async () => ({ ok: false, description: "Unauthorized" }),
    };

    await ensureTelegramBotUsernameResolved();

    expect(fetchCallCount).toBe(1);
    expect(readResolvedBotUsername()).toBeUndefined();
  });

  test("(d) handles missing username in response gracefully", async () => {
    mockBotUsername = undefined;
    secureKeys.set(TELEGRAM_BOT_TOKEN, "bot-token-123");
    mockFetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };

    await ensureTelegramBotUsernameResolved();

    expect(fetchCallCount).toBe(1);
    expect(readResolvedBotUsername()).toBeUndefined();
  });

  test("(e) handles network errors (fetch throws) gracefully", async () => {
    mockBotUsername = undefined;
    secureKeys.set(TELEGRAM_BOT_TOKEN, "bot-token-123");
    mockFetchThrows = new Error("ECONNREFUSED");

    await ensureTelegramBotUsernameResolved();

    expect(fetchCallCount).toBe(1);
    expect(readResolvedBotUsername()).toBeUndefined();
  });

  test("(f) no-ops when no bot token is configured", async () => {
    mockBotUsername = undefined;
    secureKeys.delete(TELEGRAM_BOT_TOKEN);

    await ensureTelegramBotUsernameResolved();

    expect(fetchCallCount).toBe(0);
    expect(readResolvedBotUsername()).toBeUndefined();
  });

  test("writes to config when bot username not in config", async () => {
    mockBotUsername = undefined;
    secureKeys.set(TELEGRAM_BOT_TOKEN, "bot-token-123");
    mockFetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { username: "FreshBot" } }),
    };

    await ensureTelegramBotUsernameResolved();

    expect(fetchCallCount).toBe(1);
    expect(readResolvedBotUsername()).toBe("FreshBot");
  });

  test("writes to config when bot username resolved from API", async () => {
    mockBotUsername = undefined;
    secureKeys.set(TELEGRAM_BOT_TOKEN, "bot-token-456");
    mockFetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { username: "AnotherBot" } }),
    };

    await ensureTelegramBotUsernameResolved();

    expect(fetchCallCount).toBe(1);
    expect(readResolvedBotUsername()).toBe("AnotherBot");
  });
});
