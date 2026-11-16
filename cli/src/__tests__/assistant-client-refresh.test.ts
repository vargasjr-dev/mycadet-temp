/**
 * Tests for AssistantClient's reactive 401 → renew → retry: a paired/local
 * guardian access token that 401s is renewed through the one door
 * (`loadFreshGuardianToken`) and the request retried. The renewal re-invokes
 * the PAIR flow — no refresh endpoint is called and no long-lived credential
 * is ever sent — and a still-fresh stored token comes back unchanged, so a
 * forged 401 moves nothing. Self-gating (no stored lease => no retry) and
 * never applied to the cloud session-auth path.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = mkdtempSync(join(tmpdir(), "client-refresh-test-"));
const ORIGINAL_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
const ORIGINAL_FETCH = globalThis.fetch;

import { AssistantClient } from "../lib/assistant-client.js";
import {
  loadGuardianToken,
  saveGuardianToken,
  saveLockfileAssistant,
} from "@mycadet/local-mode";

const FUTURE = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();

/**
 * Seed a paired assistant + guardian token. `due` (default false) controls
 * whether the access token has reached its renewal point — only a due token
 * renews. `withEntry` (default false) leaves the lockfile bare, so a due
 * token cannot even attempt a re-pair (the door needs the persisted entry).
 */
function seedPaired(
  accessToken: string,
  opts?: { due?: boolean; withEntry?: boolean },
): void {
  const due = opts?.due ?? false;
  if (opts?.withEntry) {
    saveLockfileAssistant({
      assistantId: "px",
      name: "Paired",
      cloud: "local",
    });
  }
  saveGuardianToken("px", {
    guardianPrincipalId: "imported",
    accessToken,
    accessTokenExpiresAt: due ? PAST : FUTURE,
    refreshToken: "refresh-tok",
    refreshTokenExpiresAt: FUTURE,
    refreshAfter: due ? PAST : FUTURE,
    deviceId: "dev",
    leasedAt: new Date().toISOString(),
  });
}

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** Replace global fetch with a URL-routed stub; returns the call log. */
function stubFetch(handler: (url: string, calls: Call[]) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return handler(url, calls);
  }) as typeof fetch;
  return calls;
}

describe("AssistantClient 401 -> renew -> retry", () => {
  beforeEach(() => {
    process.env.XDG_CONFIG_HOME = testDir;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = ORIGINAL_CONFIG_HOME;
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("adopts a token re-paired by another process on a 401 (no credential sent)", async () => {
    // Construct the client capturing the current ("old-acc") token, then
    // simulate a concurrent process (e.g. `cadet events`) re-pairing and
    // persisting a fresh, not-due lease. A 401 must pick up the fresh local
    // token and retry WITHOUT sending any credential.
    seedPaired("old-acc", { withEntry: true });
    const client = new AssistantClient({ assistantId: "px" });
    saveGuardianToken("px", {
      guardianPrincipalId: "imported",
      accessToken: "fresh-acc",
      accessTokenExpiresAt: FUTURE,
      refreshToken: "refresh-tok",
      refreshTokenExpiresAt: FUTURE,
      refreshAfter: FUTURE, // fresh — not due for renewal
      deviceId: "dev",
      leasedAt: new Date().toISOString(),
    });

    const calls = stubFetch((_url, log) => {
      const auth = log[log.length - 1].headers["Authorization"];
      return new Response("", {
        status: auth === "Bearer fresh-acc" ? 200 : 401,
      });
    });

    const res = await client.get("/messages/");

    expect(res.status).toBe(200);
    // The renewal never calls a refresh endpoint — the credential pair
    // comes from the local token file, not from any HTTP exchange.
    expect(
      calls.filter((c) => c.url.includes("/guardian/refresh")),
    ).toHaveLength(0);
    const assistantCalls = calls;
    expect(assistantCalls[1].headers["Authorization"]).toBe("Bearer fresh-acc");
  });

  test("does not retry when a due lease cannot re-pair (no persisted entry)", async () => {
    seedPaired("old-acc", { due: true }); // no lockfile entry
    let assistantAttempts = 0;
    stubFetch(() => {
      assistantAttempts++;
      return new Response("", { status: 401 });
    });

    const client = new AssistantClient({ assistantId: "px" });
    const res = await client.get("/messages/");

    expect(res.status).toBe(401);
    expect(assistantAttempts).toBe(1); // no retry
  });

  test("does not retry when the stored token is not due for renewal", async () => {
    // A forged/synthetic 401 on a still-valid token must not move anything:
    // the door hands the unchanged token back, so there is no retry.
    seedPaired("old-acc", { due: false });
    let assistantAttempts = 0;
    stubFetch(() => {
      assistantAttempts++;
      return new Response("", { status: 401 });
    });

    const client = new AssistantClient({ assistantId: "px" });
    const res = await client.get("/messages/");

    expect(res.status).toBe(401);
    expect(assistantAttempts).toBe(1); // no retry
  });

  test("never renews on the cloud session-auth path", async () => {
    seedPaired("old-acc", { withEntry: true }); // entry must exist; session auth ignores it
    let assistantAttempts = 0;
    const calls = stubFetch(() => {
      assistantAttempts++;
      return new Response("", { status: 401 });
    });

    const client = new AssistantClient({
      assistantId: "px",
      sessionToken: "sess-tok",
      orgId: "org-1",
    });
    const res = await client.get("/messages/");

    expect(res.status).toBe(401);
    expect(assistantAttempts).toBe(1);
    expect(
      calls.filter((c) => c.url.includes("/guardian/refresh")),
    ).toHaveLength(0);
  });

  test("retries at most once (a second 401 is not renewed again)", async () => {
    seedPaired("old-acc", { withEntry: true });
    // Construct first so the client captures "old-acc"; the persisted
    // "fresh-acc" then reads as a concurrent re-pair's artifact.
    const constructed = new AssistantClient({ assistantId: "px" });
    saveGuardianToken("px", {
      guardianPrincipalId: "imported",
      accessToken: "fresh-acc",
      accessTokenExpiresAt: FUTURE,
      refreshToken: "refresh-tok",
      refreshTokenExpiresAt: FUTURE,
      refreshAfter: FUTURE,
      deviceId: "dev",
      leasedAt: new Date().toISOString(),
    });
    void constructed;
    let assistantAttempts = 0;
    stubFetch(() => {
      assistantAttempts++;
      return new Response("", { status: 401 }); // always 401
    });

    const res = await constructed.get("/messages/");

    expect(res.status).toBe(401);
    expect(assistantAttempts).toBe(2); // original + one retry, no more
    expect(loadGuardianToken("px")?.accessToken).toBe("fresh-acc");
  });
});
