import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { guardianTokenPath, resolveConfigDir } from "@mycadet/local-mode";

import {
  getOrCreatePersistedDeviceId,
  guardianTokenDueForRenewal,
  leaseGuardianToken,
  loadGuardianToken,
  refreshGuardianToken,
  refreshGuardianTokenResult,
  saveGuardianToken,
  seedGuardianTokenFromSiblingEnv,
  type GuardianTokenData,
} from "../lib/guardian-token.js";
import { getConfigDir } from "../lib/environments/paths.js";
import { getCurrentEnvironment } from "../lib/environments/resolve.js";

/** bun-types' fetch requires a preconnect member; the SUT never calls it. */
function withPreconnect(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  return Object.assign(impl, { preconnect: () => {} });
}

function makeTokenData(suffix: string): GuardianTokenData {
  const now = new Date().toISOString();
  const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  return {
    guardianPrincipalId: `principal-${suffix}`,
    accessToken: `access-${suffix}`,
    accessTokenExpiresAt: oneHourFromNow,
    refreshToken: `refresh-${suffix}`,
    refreshTokenExpiresAt: oneHourFromNow,
    refreshAfter: oneHourFromNow,
    isNew: true,
    deviceId: `device-${suffix}`,
    leasedAt: now,
  };
}

describe("guardian-token paths are env-scoped", () => {
  let tempHome: string;
  let savedXdg: string | undefined;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedXdg = process.env.XDG_CONFIG_HOME;
    savedEnv = process.env.CADET_ENVIRONMENT;
    tempHome = mkdtempSync(join(tmpdir(), "cli-guardian-token-test-"));
    process.env.XDG_CONFIG_HOME = tempHome;
    delete process.env.CADET_ENVIRONMENT;
  });

  afterEach(() => {
    if (savedXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = savedXdg;
    }
    if (savedEnv === undefined) {
      delete process.env.CADET_ENVIRONMENT;
    } else {
      process.env.CADET_ENVIRONMENT = savedEnv;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("prod: guardian token lands at $XDG_CONFIG_HOME/cadet/assistants/<id>/guardian-token.json", () => {
    const data = makeTokenData("prod");
    saveGuardianToken("alpha", data);

    const prodPath = join(
      tempHome,
      "cadet",
      "assistants",
      "alpha",
      "guardian-token.json",
    );
    expect(existsSync(prodPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(prodPath, "utf-8"));
    expect(parsed.guardianPrincipalId).toBe("principal-prod");

    const loaded = loadGuardianToken("alpha");
    expect(loaded).not.toBeNull();
    expect(loaded!.guardianPrincipalId).toBe("principal-prod");
  });

  test("dev: guardian token lands at $XDG_CONFIG_HOME/cadet-dev/assistants/<id>/guardian-token.json", () => {
    process.env.CADET_ENVIRONMENT = "dev";
    const data = makeTokenData("dev");
    saveGuardianToken("alpha", data);

    const devPath = join(
      tempHome,
      "cadet-dev",
      "assistants",
      "alpha",
      "guardian-token.json",
    );
    expect(existsSync(devPath)).toBe(true);

    // Prod directory must NOT have this token
    const prodPath = join(
      tempHome,
      "cadet",
      "assistants",
      "alpha",
      "guardian-token.json",
    );
    expect(existsSync(prodPath)).toBe(false);

    const loaded = loadGuardianToken("alpha");
    expect(loaded).not.toBeNull();
    expect(loaded!.guardianPrincipalId).toBe("principal-dev");
  });

  test("same assistant id in prod and dev is isolated on disk", () => {
    // Write prod token for assistant 'alpha'
    delete process.env.CADET_ENVIRONMENT;
    saveGuardianToken("alpha", makeTokenData("prod"));

    // Write dev token for assistant 'alpha'
    process.env.CADET_ENVIRONMENT = "dev";
    saveGuardianToken("alpha", makeTokenData("dev"));

    // Dev load returns dev
    expect(loadGuardianToken("alpha")!.guardianPrincipalId).toBe(
      "principal-dev",
    );

    // Back to prod — prod token is unchanged
    delete process.env.CADET_ENVIRONMENT;
    expect(loadGuardianToken("alpha")!.guardianPrincipalId).toBe(
      "principal-prod",
    );

    // Both files exist at distinct paths
    const prodPath = join(
      tempHome,
      "cadet",
      "assistants",
      "alpha",
      "guardian-token.json",
    );
    const devPath = join(
      tempHome,
      "cadet-dev",
      "assistants",
      "alpha",
      "guardian-token.json",
    );
    expect(existsSync(prodPath)).toBe(true);
    expect(existsSync(devPath)).toBe(true);
    expect(prodPath).not.toBe(devPath);
  });

  test("prod: persisted device id lands at $XDG_CONFIG_HOME/cadet/device-id", () => {
    const id = getOrCreatePersistedDeviceId();
    expect(id.length).toBeGreaterThan(0);

    const prodPath = join(tempHome, "cadet", "device-id");
    expect(existsSync(prodPath)).toBe(true);
    expect(readFileSync(prodPath, "utf-8").trim()).toBe(id);
  });

  test("dev: persisted device id lands at $XDG_CONFIG_HOME/cadet-dev/device-id", () => {
    process.env.CADET_ENVIRONMENT = "dev";
    const id = getOrCreatePersistedDeviceId();
    expect(id.length).toBeGreaterThan(0);

    const devPath = join(tempHome, "cadet-dev", "device-id");
    expect(existsSync(devPath)).toBe(true);
    expect(readFileSync(devPath, "utf-8").trim()).toBe(id);

    const prodPath = join(tempHome, "cadet", "device-id");
    expect(existsSync(prodPath)).toBe(false);
  });

  test("device id is stable across repeated calls in the same env", () => {
    delete process.env.CADET_ENVIRONMENT;
    const first = getOrCreatePersistedDeviceId();
    const second = getOrCreatePersistedDeviceId();
    expect(first).toBe(second);
  });

  test("seedGuardianTokenFromSiblingEnv copies a dev token into the current local env", () => {
    // Write a token under the dev env.
    process.env.CADET_ENVIRONMENT = "dev";
    saveGuardianToken("alpha", makeTokenData("dev"));

    // Switch to local env — no token present yet.
    process.env.CADET_ENVIRONMENT = "local";
    expect(loadGuardianToken("alpha")).toBeNull();

    const seeded = seedGuardianTokenFromSiblingEnv("alpha");
    expect(seeded).toBe(true);

    const localPath = join(
      tempHome,
      "cadet-local",
      "assistants",
      "alpha",
      "guardian-token.json",
    );
    expect(existsSync(localPath)).toBe(true);
    const loaded = loadGuardianToken("alpha");
    expect(loaded).not.toBeNull();
    expect(loaded!.guardianPrincipalId).toBe("principal-dev");

    // Idempotent — second call is a no-op.
    expect(seedGuardianTokenFromSiblingEnv("alpha")).toBe(false);
  });

  test("seedGuardianTokenFromSiblingEnv returns false when no sibling token exists", () => {
    process.env.CADET_ENVIRONMENT = "local";
    expect(seedGuardianTokenFromSiblingEnv("nonexistent")).toBe(false);
    expect(loadGuardianToken("nonexistent")).toBeNull();
  });

  test("seedGuardianTokenFromSiblingEnv does not overwrite an existing token", () => {
    // Token already present in the current env.
    process.env.CADET_ENVIRONMENT = "local";
    saveGuardianToken("alpha", makeTokenData("local"));

    // And a different sibling token in dev.
    process.env.CADET_ENVIRONMENT = "dev";
    saveGuardianToken("alpha", makeTokenData("dev"));

    // Back to local — seed should no-op because a token is already present.
    process.env.CADET_ENVIRONMENT = "local";
    expect(seedGuardianTokenFromSiblingEnv("alpha")).toBe(false);
    expect(loadGuardianToken("alpha")!.guardianPrincipalId).toBe(
      "principal-local",
    );
  });
});

describe("refreshGuardianToken", () => {
  let tempHome: string;
  let savedXdg: string | undefined;
  let savedEnv: string | undefined;
  const ORIGINAL_FETCH = globalThis.fetch;

  const future = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

  function lockPath(id: string): string {
    return join(tempHome, "cadet", "assistants", id, "refresh.lock");
  }

  function seed(refreshExpiresAt: string | number): void {
    saveGuardianToken("px", {
      guardianPrincipalId: "imported",
      accessToken: "old-acc",
      accessTokenExpiresAt: future(),
      refreshToken: "old-ref",
      refreshTokenExpiresAt: refreshExpiresAt,
      refreshAfter: "",
      isNew: false,
      deviceId: "dev",
      leasedAt: new Date().toISOString(),
      pairedGatewayUrl: "https://gw.example.com",
    });
  }

  beforeEach(() => {
    savedXdg = process.env.XDG_CONFIG_HOME;
    savedEnv = process.env.CADET_ENVIRONMENT;
    tempHome = mkdtempSync(join(tmpdir(), "cli-refresh-test-"));
    process.env.XDG_CONFIG_HOME = tempHome;
    delete process.env.CADET_ENVIRONMENT;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    if (savedEnv === undefined) delete process.env.CADET_ENVIRONMENT;
    else process.env.CADET_ENVIRONMENT = savedEnv;
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("refreshes, persists the rotated token, sends an abort signal, releases the lock", async () => {
    seed(future());
    let sawSignal = false;
    globalThis.fetch = withPreconnect(
      async (_url: unknown, init?: RequestInit) => {
        sawSignal = init?.signal instanceof AbortSignal;
        return new Response(
          JSON.stringify({
            accessToken: "new-acc",
            refreshToken: "new-ref",
            accessTokenExpiresAt: future(),
            refreshTokenExpiresAt: future(),
            refreshAfter: "",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );

    const result = await refreshGuardianToken("https://gw.example.com", "px");

    expect(result?.accessToken).toBe("new-acc");
    expect(loadGuardianToken("px")?.accessToken).toBe("new-acc");
    expect(loadGuardianToken("px")?.pairedGatewayUrl).toBe(
      "https://gw.example.com",
    );
    expect(sawSignal).toBe(true); // fetch carries a timeout AbortSignal
    expect(existsSync(lockPath("px"))).toBe(false); // lock released
  });

  test("leases against the gateway's real init shape — refreshAfter arrives as a number", async () => {
    // The gateway's GuardianBootstrapResult serializes refreshAfter as a
    // NUMBER of ms (mintRefreshToken), and the strict lease check rejects a
    // response missing any field. A string-only schema read that number as
    // malformed, so every real hatch failed its lease while the ISO-string
    // test doubles here stayed green.
    globalThis.fetch = withPreconnect(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/readyz")) {
        return new Response("", { status: 404 }); // no starting gate — proceed
      }
      return new Response(
        JSON.stringify({
          guardianPrincipalId: "principal-lease",
          accessToken: "access-lease",
          accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
          refreshToken: "refresh-lease",
          refreshTokenExpiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
          refreshAfter: Date.now() + 48 * 60 * 60 * 1000,
          isNew: true,
          mintedOverPriorEvidence: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const leased = await leaseGuardianToken("https://gw.example.com", "px");

    expect(leased.accessToken).toBe("access-lease");
    expect(leased.refreshAfter).toBeDefined();
    const stored = loadGuardianToken("px");
    expect(stored?.accessToken).toBe("access-lease");
    expect(stored?.refreshAfter).toBe(leased.refreshAfter);
  });

  test("returns null without calling the gateway when the refresh token is expired", async () => {
    seed(new Date(Date.now() - 1000).toISOString());
    let called = false;
    globalThis.fetch = withPreconnect(
      async (_url: unknown, _init?: RequestInit) => {
        called = true;
        return new Response("", { status: 200 });
      },
    );

    expect(
      await refreshGuardianToken("https://gw.example.com", "px"),
    ).toBeNull();
    expect(called).toBe(false);
  });

  test("returns null when there is no stored token", async () => {
    let called = false;
    globalThis.fetch = withPreconnect(
      async (_url: unknown, _init?: RequestInit) => {
        called = true;
        return new Response("", { status: 200 });
      },
    );

    expect(
      await refreshGuardianToken("https://gw.example.com", "missing"),
    ).toBeNull();
    expect(called).toBe(false);
  });

  test("steals a stale lock and still refreshes", async () => {
    seed(future());
    // Pre-create a stale lock (mtime well in the past) as if a crashed holder
    // left it behind; the refresh must steal it rather than block.
    const lp = lockPath("px");
    mkdirSync(dirname(lp), { recursive: true });
    writeFileSync(lp, "99999");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lp, old, old);

    globalThis.fetch = withPreconnect(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(JSON.stringify({ accessToken: "new-acc" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await refreshGuardianToken("https://gw.example.com", "px");
    expect(result?.accessToken).toBe("new-acc");
    expect(existsSync(lp)).toBe(false); // stolen lock cleaned up after release
  });

  // The refresh token is long-lived and replayable, so it must only travel over
  // a confidential channel: https, or a loopback host. These guard the
  // plaintext-interception vector flagged in the security review.

  test("sends the refresh token over loopback http (127.0.0.1 / localhost / [::1])", async () => {
    for (const url of [
      "http://127.0.0.1:7830",
      "http://localhost:7830",
      "http://[::1]:7830",
    ]) {
      seed(future());
      let called = false;
      globalThis.fetch = withPreconnect(
        async (_url: unknown, _init?: RequestInit) => {
          called = true;
          return new Response(JSON.stringify({ accessToken: "new-acc" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      );

      expect(await refreshGuardianToken(url, "px")).not.toBeNull();
      expect(called).toBe(true); // loopback http is allowed
    }
  });

  test("refuses a non-loopback plaintext http URL: no fetch, returns null, warns", async () => {
    seed(future());
    let called = false;
    globalThis.fetch = withPreconnect(
      async (_url: unknown, _init?: RequestInit) => {
        called = true;
        return new Response("", { status: 200 });
      },
    );

    const origWarn = console.warn;
    let warned = false;
    console.warn = () => {
      warned = true;
    };
    try {
      expect(
        await refreshGuardianToken("http://10.0.0.5:7830", "px"),
      ).toBeNull();
    } finally {
      console.warn = origWarn;
    }
    expect(called).toBe(false); // the refresh token is never sent
    expect(warned).toBe(true);
  });

  test("refuses a malformed gateway URL: no fetch, returns null", async () => {
    seed(future());
    let called = false;
    globalThis.fetch = withPreconnect(
      async (_url: unknown, _init?: RequestInit) => {
        called = true;
        return new Response("", { status: 200 });
      },
    );

    const origWarn = console.warn;
    console.warn = () => {};
    try {
      expect(await refreshGuardianToken("not-a-url", "px")).toBeNull();
    } finally {
      console.warn = origWarn;
    }
    expect(called).toBe(false);
  });

  test("an unreachable gateway is a 503, not a 401", async () => {
    seed(future());
    globalThis.fetch = withPreconnect(
      async (_url: unknown, _init?: RequestInit) => {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ECONNREFUSED" },
        });
      },
    );

    const result = await refreshGuardianTokenResult(
      "http://127.0.0.1:59999",
      "px",
    );

    expect(result).toEqual({
      ok: false,
      status: 503,
      error: "Assistant gateway is unreachable",
    });
    expect(
      await refreshGuardianToken("http://127.0.0.1:59999", "px"),
    ).toBeNull();
  });

  test("an HTTP 401 from the gateway is a spent credential", async () => {
    seed(future());
    globalThis.fetch = withPreconnect(
      async (_url: unknown, _init?: RequestInit) =>
        new Response("", { status: 401 }),
    );

    expect(
      await refreshGuardianTokenResult("https://gw.example.com", "px"),
    ).toEqual({
      ok: false,
      status: 401,
      error: "Failed to refresh guardian token",
    });
  });

  test("an HTTP 403 from the refresh route is a spent credential, not a loopback refusal", async () => {
    seed(future());
    globalThis.fetch = withPreconnect(
      async (_url: unknown, _init?: RequestInit) =>
        new Response("", { status: 403 }),
    );

    expect(
      await refreshGuardianTokenResult("https://gw.example.com", "px"),
    ).toEqual({
      ok: false,
      status: 401,
      error: "Failed to refresh guardian token",
    });
  });

  test("an insecure gateway URL is a local 403, not a spent credential", async () => {
    seed(future());
    let called = false;
    globalThis.fetch = withPreconnect(
      async (_url: unknown, _init?: RequestInit) => {
        called = true;
        return new Response("", { status: 200 });
      },
    );

    const origWarn = console.warn;
    console.warn = () => {};
    try {
      expect(
        await refreshGuardianTokenResult("http://10.0.0.5:7830", "px"),
      ).toEqual({
        ok: false,
        status: 403,
        error: "Refusing to refresh the guardian token over an insecure URL",
      });
    } finally {
      console.warn = origWarn;
    }
    expect(called).toBe(false);
  });

  test("an HTTP 503 from a still-starting gateway is retryable", async () => {
    seed(future());
    globalThis.fetch = withPreconnect(
      async (_url: unknown, _init?: RequestInit) =>
        new Response("", { status: 503 }),
    );

    const result = await refreshGuardianTokenResult(
      "https://gw.example.com",
      "px",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
    }
  });
});

describe("guardianTokenDueForRenewal", () => {
  const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const PAST = new Date(Date.now() - 60_000).toISOString();

  function token(over: Partial<GuardianTokenData>): GuardianTokenData {
    return {
      guardianPrincipalId: "p",
      accessToken: "a",
      accessTokenExpiresAt: FUTURE,
      refreshToken: "r",
      refreshTokenExpiresAt: FUTURE,
      refreshAfter: "",
      isNew: false,
      deviceId: "d",
      leasedAt: new Date().toISOString(),
      ...over,
    };
  }

  test("past refreshAfter → due", () => {
    expect(guardianTokenDueForRenewal(token({ refreshAfter: PAST }))).toBe(
      true,
    );
  });

  test("future refreshAfter → not due", () => {
    expect(guardianTokenDueForRenewal(token({ refreshAfter: FUTURE }))).toBe(
      false,
    );
  });

  test("empty refreshAfter falls back to accessTokenExpiresAt (past → due)", () => {
    expect(
      guardianTokenDueForRenewal(
        token({ refreshAfter: "", accessTokenExpiresAt: PAST }),
      ),
    ).toBe(true);
  });

  test("empty refreshAfter falls back to accessTokenExpiresAt (future → not due)", () => {
    expect(
      guardianTokenDueForRenewal(
        token({ refreshAfter: "", accessTokenExpiresAt: FUTURE }),
      ),
    ).toBe(false);
  });

  test("unparseable timestamp → not due", () => {
    expect(
      guardianTokenDueForRenewal(
        token({ refreshAfter: "not-a-date", accessTokenExpiresAt: "nope" }),
      ),
    ).toBe(false);
  });
});

// Drift guard between the guardian-token WRITE path (CLI: getGuardianTokenPath
// → getConfigDir(getCurrentEnvironment())) and the READ path used by every
// host-seam reader (getGuardianAccessToken → resolveConfigDir(env) from
// @mycadet/local-mode). A divergence here writes a freshly leased token where
// the connect can't read it, bricking local-assistant connect. saveGuardianToken
// already resolves through the shared resolver; this asserts the two resolvers
// stay in lockstep so a future change to either can't silently relocate tokens.
describe("guardian-token path resolver parity (CLI ↔ shared)", () => {
  let tempHome: string;
  let savedXdg: string | undefined;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedXdg = process.env.XDG_CONFIG_HOME;
    savedEnv = process.env.CADET_ENVIRONMENT;
    tempHome = mkdtempSync(join(tmpdir(), "cli-guardian-parity-test-"));
    process.env.XDG_CONFIG_HOME = tempHome;
    delete process.env.CADET_ENVIRONMENT;
  });

  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    if (savedEnv === undefined) delete process.env.CADET_ENVIRONMENT;
    else process.env.CADET_ENVIRONMENT = savedEnv;
    rmSync(tempHome, { recursive: true, force: true });
  });

  // The CLI's own resolver and the shared @mycadet/local-mode resolver must
  // agree on the config dir for every environment source.
  const expectResolversAgree = () => {
    expect(getConfigDir(getCurrentEnvironment())).toBe(
      resolveConfigDir(process.env),
    );
  };

  test("unset → production: resolvers agree and saveGuardianToken lands there", () => {
    expectResolversAgree();
    saveGuardianToken("alpha", makeTokenData("prod"));
    expect(
      existsSync(guardianTokenPath(resolveConfigDir(process.env), "alpha")),
    ).toBe(true);
  });

  test("CADET_ENVIRONMENT=dev: resolvers agree and token lands there", () => {
    process.env.CADET_ENVIRONMENT = "dev";
    expectResolversAgree();
    saveGuardianToken("alpha", makeTokenData("dev"));
    expect(
      existsSync(guardianTokenPath(resolveConfigDir(process.env), "alpha")),
    ).toBe(true);
  });

  test("CADET_ENVIRONMENT=local: resolvers agree and token lands there", () => {
    process.env.CADET_ENVIRONMENT = "local";
    expectResolversAgree();
    saveGuardianToken("alpha", makeTokenData("local"));
    expect(
      existsSync(guardianTokenPath(resolveConfigDir(process.env), "alpha")),
    ).toBe(true);
  });

  test("stale persisted default env file is ignored — version wins", () => {
    mkdirSync(join(tempHome, "cadet"), { recursive: true });
    writeFileSync(join(tempHome, "cadet", "environment"), "dev\n");
    expect(getCurrentEnvironment().name).toBe("production");
    saveGuardianToken("alpha", makeTokenData("prod"));
    expect(
      existsSync(guardianTokenPath(resolveConfigDir(process.env), "alpha")),
    ).toBe(true);
  });
});
