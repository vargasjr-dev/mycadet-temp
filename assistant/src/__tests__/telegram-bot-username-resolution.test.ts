/**
 * Tests for `ensureTelegramBotUsernameResolved()`.
 *
 * This function fills the bot-username gap when the token was configured
 * without a `getMe` call (e.g. via `credential set` or ingress secret
 * redirect). Each branch is exercised in isolation by controlling the
 * bot-username mock and registering the fetch responses each test assumes
 * (requests-mock).
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { loadRawConfig } from "../config/loader.js";
import { ensureTelegramBotUsernameResolved } from "../runtime/channel-invite-transports/telegram.js";
import { credentialKey } from "../security/credential-key.js";
import { useMemorySecureKeyMap } from "./helpers/secure-keys.js";
import { setConfig } from "./helpers/set-config.js";
import { type HttpMockController, mockHttp } from "./requests-mock.js";

// The REAL secure-keys module pinned to a live memory backend, seeded under
// the credential key the telegram transport reads.
const secureKeys = useMemorySecureKeyMap();
const TELEGRAM_BOT_TOKEN = credentialKey("telegram", "bot_token");

// ---------------------------------------------------------------------------
// Real-config seam — the old env stub for the bot-username reader is gone:
// the username/id the resolver reads ride the workspace config, the same
// place the function under test persists them.
// ---------------------------------------------------------------------------

function setBotUsername(username: string | undefined): void {
  setConfig(
    "telegram",
    username ? { botUsername: username, botId: "123456" } : {},
  );
}

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
// HTTP mock — per-test requests-mock registrations; the preload's afterEach
// restores the real fetch after every test
// ---------------------------------------------------------------------------

let http: HttpMockController;

beforeEach(() => {
  setBotUsername(undefined);
  secureKeys.delete(TELEGRAM_BOT_TOKEN);
  // Clear any username a prior test persisted; all tests share one workspace
  // config.json, and the file is the write target under test.
  setConfig("telegram", {});
  http = mockHttp();
  http.on("GET", "api.telegram.org", {
    status: 200,
    body: { ok: true, result: { username: "ResolvedBot" } },
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ensureTelegramBotUsernameResolved", () => {
  test("(a) early-returns when bot username is already cached in config", async () => {
    setBotUsername("CachedBot");
    secureKeys.set(TELEGRAM_BOT_TOKEN, "some-token");

    await ensureTelegramBotUsernameResolved();

    expect(http.callCount()).toBe(0);
    // The cached username came FROM config, so it stays — the early return
    // must not rewrite it. (Under the old module stub this read undefined;
    // the stub's seed never touched the config file the real seam uses.)
    expect(readResolvedBotUsername()).toBe("CachedBot");
  });

  test("(b) fetches getMe and writes username to config on success", async () => {
    setBotUsername(undefined);
    secureKeys.set(TELEGRAM_BOT_TOKEN, "bot-token-123");
    http.on("GET", "api.telegram.org", {
      status: 200,
      body: { ok: true, result: { username: "MyNewBot" } },
    });

    await ensureTelegramBotUsernameResolved();

    expect(http.callCount()).toBe(1);
    expect(readResolvedBotUsername()).toBe("MyNewBot");
  });

  test("(c) handles non-200 response gracefully without writing to config", async () => {
    setBotUsername(undefined);
    secureKeys.set(TELEGRAM_BOT_TOKEN, "bot-token-123");
    http.on("GET", "api.telegram.org", {
      status: 401,
      body: { ok: false, description: "Unauthorized" },
    });

    await ensureTelegramBotUsernameResolved();

    expect(http.callCount()).toBe(1);
    expect(readResolvedBotUsername()).toBeUndefined();
  });

  test("(d) handles missing username in response gracefully", async () => {
    setBotUsername(undefined);
    secureKeys.set(TELEGRAM_BOT_TOKEN, "bot-token-123");
    http.on("GET", "api.telegram.org", {
      status: 200,
      body: { ok: true, result: {} },
    });

    await ensureTelegramBotUsernameResolved();

    expect(http.callCount()).toBe(1);
    expect(readResolvedBotUsername()).toBeUndefined();
  });

  test("(e) handles network errors (fetch throws) gracefully", async () => {
    setBotUsername(undefined);
    secureKeys.set(TELEGRAM_BOT_TOKEN, "bot-token-123");
    http.on("GET", "api.telegram.org", new Error("ECONNREFUSED"));

    await ensureTelegramBotUsernameResolved();

    expect(http.callCount()).toBe(1);
    expect(readResolvedBotUsername()).toBeUndefined();
  });

  test("(f) no-ops when no bot token is configured", async () => {
    setBotUsername(undefined);
    secureKeys.delete(TELEGRAM_BOT_TOKEN);

    await ensureTelegramBotUsernameResolved();

    expect(http.callCount()).toBe(0);
    expect(readResolvedBotUsername()).toBeUndefined();
  });

  test("writes to config when bot username not in config", async () => {
    setBotUsername(undefined);
    secureKeys.set(TELEGRAM_BOT_TOKEN, "bot-token-123");
    http.on("GET", "api.telegram.org", {
      status: 200,
      body: { ok: true, result: { username: "FreshBot" } },
    });

    await ensureTelegramBotUsernameResolved();

    expect(http.callCount()).toBe(1);
    expect(readResolvedBotUsername()).toBe("FreshBot");
  });

  test("writes to config when bot username resolved from API", async () => {
    setBotUsername(undefined);
    secureKeys.set(TELEGRAM_BOT_TOKEN, "bot-token-456");
    http.on("GET", "api.telegram.org", {
      status: 200,
      body: { ok: true, result: { username: "AnotherBot" } },
    });

    await ensureTelegramBotUsernameResolved();

    expect(http.callCount()).toBe(1);
    expect(readResolvedBotUsername()).toBe("AnotherBot");
  });
});
