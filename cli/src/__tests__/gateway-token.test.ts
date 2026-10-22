/**
 * Command-level tests for `cadet gateway token get/refresh`.
 *
 * Resolution: the assistant id is OPTIONAL — resolveTargetAssistant falls
 * back to the active (or sole) assistant, so `cadet gateway token refresh`
 * works with no arguments.
 *
 * Self-heal: a spent credential (401 — expired/revoked refresh token) or a
 * missing token file (404) triggers an in-place re-provision via the
 * gateway's bootstrap reset — the same machinery `cadet wake
 * --repair-guardian` runs. It must NEVER suggest `cadet hatch`: hatching
 * creates a different assistant.
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

import { gatewayToken } from "../commands/gateway/token.js";
import {
  saveAssistantEntry,
  setActiveAssistant,
} from "../lib/assistant-config.js";
import {
  loadGuardianToken,
  saveGuardianToken,
} from "../lib/guardian-token.js";
import { makeGuardianTokenData } from "./helpers/guardian-token.js";
import { withPreconnect } from "./helpers/http.js";

const ORIGINAL_LOCKFILE_DIR = process.env.CADET_LOCKFILE_DIR;
const ORIGINAL_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
const ORIGINAL_ENVIRONMENT = process.env.CADET_ENVIRONMENT;
const ORIGINAL_ARGV = [...process.argv];
const REAL_FETCH = globalThis.fetch;

let tempHome: string;

function seedLocalEntry(overrides: Record<string, unknown> = {}): void {
  saveAssistantEntry({
    assistantId: "px",
    name: "Prime Quail",
    runtimeUrl: "http://127.0.0.1:7830",
    localUrl: "http://127.0.0.1:7830",
    cloud: "local",
    ...overrides,
  });
}

/**
 * Run `gatewayToken()` with console.log + console.error + process.exit
 * spied; return the captured streams and whether the run exited 1.
 */
async function runGatewayToken(): Promise<{
  exited: boolean;
  logs: string;
  errors: string;
}> {
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation(
    (...a: unknown[]) => {
      logs.push(a.join(" "));
    },
  );
  const errSpy = spyOn(console, "error").mockImplementation(
    (...a: unknown[]) => {
      errors.push(a.join(" "));
    },
  );
  const exitSpy = spyOn(process, "exit").mockImplementation(
    (code?: number | string | undefined): never => {
      throw new Error(`exit:${code ?? 0}`);
    },
  );
  let exited = false;
  try {
    await gatewayToken();
  } catch (e) {
    exited = e instanceof Error && e.message === "exit:1";
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { exited, logs: logs.join("\n"), errors: errors.join("\n") };
}

/** Fetch double covering the repair choreography (readyz/reset/init). */
function mockRepairFetch(initBody: object): void {
  globalThis.fetch = withPreconnect(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/readyz")) {
      return new Response("", { status: 404 }); // no starting gate — proceed
    }
    if (url.endsWith("/v1/guardian/reset-bootstrap")) {
      return new Response("{}", { status: 200 });
    }
    if (url.endsWith("/v1/guardian/init")) {
      return new Response(JSON.stringify(initBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

const FRESH_LEASE = {
  guardianPrincipalId: "principal-new",
  accessToken: "fresh-acc",
  accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
  refreshToken: "fresh-ref",
  refreshTokenExpiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
  refreshAfter: Date.now() + 48 * 60 * 60 * 1000,
  isNew: false,
};

describe("gateway token command", () => {
  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "gateway-token-test-"));
    process.env.CADET_LOCKFILE_DIR = tempHome;
    process.env.XDG_CONFIG_HOME = tempHome;
    delete process.env.CADET_ENVIRONMENT;
  });

  afterEach(() => {
    process.argv = [...ORIGINAL_ARGV];
    globalThis.fetch = REAL_FETCH;
    if (ORIGINAL_LOCKFILE_DIR === undefined)
      delete process.env.CADET_LOCKFILE_DIR;
    else process.env.CADET_LOCKFILE_DIR = ORIGINAL_LOCKFILE_DIR;
    if (ORIGINAL_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = ORIGINAL_CONFIG_HOME;
    if (ORIGINAL_ENVIRONMENT === undefined) delete process.env.CADET_ENVIRONMENT;
    else process.env.CADET_ENVIRONMENT = ORIGINAL_ENVIRONMENT;
    rmSync(tempHome, { recursive: true, force: true });
  });

  afterAll(() => {
    globalThis.fetch = REAL_FETCH;
  });

  test("refresh without a name targets the sole assistant and prints the refreshed token", async () => {
    seedLocalEntry();
    saveGuardianToken("px", makeGuardianTokenData());
    let sawRefresh = false;
    globalThis.fetch = withPreconnect(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/guardian/refresh")) {
        sawRefresh = true;
        return new Response(JSON.stringify({ accessToken: "new-acc" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    process.argv = ["bun", "cadet", "gateway", "token", "refresh"];
    const { exited, logs, errors } = await runGatewayToken();

    expect(sawRefresh).toBe(true);
    expect(exited).toBe(false);
    expect(logs).toContain("new-acc");
    expect(loadGuardianToken("px")?.accessToken).toBe("new-acc");
    expect(`${logs}\n${errors}`).not.toContain("hatch");
  });

  test("get without a name targets the active assistant", async () => {
    seedLocalEntry();
    saveAssistantEntry({
      assistantId: "py",
      name: "Other Box",
      runtimeUrl: "http://127.0.0.1:7831",
      localUrl: "http://127.0.0.1:7831",
      cloud: "local",
    });
    setActiveAssistant("py");
    saveGuardianToken(
      "py",
      makeGuardianTokenData({ accessToken: "active-token" }),
    );

    process.argv = ["bun", "cadet", "gateway", "token", "get"];
    const { exited, logs } = await runGatewayToken();

    expect(exited).toBe(false);
    expect(logs).toContain("active-token");
  });

  test("an unknown name is a strict-match error", async () => {
    seedLocalEntry();
    saveGuardianToken("px", makeGuardianTokenData());

    process.argv = ["bun", "cadet", "gateway", "token", "get", "nope"];
    const { exited, errors } = await runGatewayToken();

    expect(exited).toBe(true);
    expect(errors).toContain("No assistant found with name or ID 'nope'");
  });

  test("refresh self-heals an expired credential via the bootstrap reset", async () => {
    seedLocalEntry({ guardianBootstrapSecret: "boot-secret-1" });
    saveGuardianToken(
      "px",
      makeGuardianTokenData({
        refreshTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    mockRepairFetch(FRESH_LEASE);

    process.argv = ["bun", "cadet", "gateway", "token", "refresh"];
    const { exited, logs, errors } = await runGatewayToken();

    expect(exited).toBe(false);
    expect(errors).toContain(
      "Re-provisioned guardian token (this revoked other devices' paired tokens).",
    );
    expect(logs).toContain("fresh-acc");
    expect(loadGuardianToken("px")?.accessToken).toBe("fresh-acc");
    expect(`${logs}\n${errors}`).not.toContain("hatch");
  });

  test("refresh reports repair failure and never suggests hatching", async () => {
    seedLocalEntry({ guardianBootstrapSecret: "boot-secret-1" });
    saveGuardianToken(
      "px",
      makeGuardianTokenData({
        refreshTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    // Malformed 200 lease → GuardianLeasePermanentError → no retries.
    mockRepairFetch({});

    process.argv = ["bun", "cadet", "gateway", "token", "refresh"];
    const { exited, logs, errors } = await runGatewayToken();

    expect(exited).toBe(true);
    expect(errors).toContain("Guardian token could not be re-provisioned.");
    expect(errors).toContain("--repair-guardian");
    expect(errors).toContain("CADET_REFRESH_ERROR=");
    expect(`${logs}\n${errors}`).not.toContain("hatch");
  });

  test("refresh re-provisions when the token file is missing entirely", async () => {
    seedLocalEntry({ guardianBootstrapSecret: "boot-secret-1" });
    mockRepairFetch(FRESH_LEASE);

    process.argv = ["bun", "cadet", "gateway", "token", "refresh"];
    const { exited, logs } = await runGatewayToken();

    expect(exited).toBe(false);
    expect(logs).toContain("fresh-acc");
    expect(loadGuardianToken("px")?.accessToken).toBe("fresh-acc");
  });
});
