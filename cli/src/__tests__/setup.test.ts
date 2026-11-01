import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
  type Mock,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LockfileAssistant } from "@mycadet/local-mode/contract";
import { loadGuardianToken, saveGuardianToken } from "../lib/guardian-token.js";
import type { GuardianTokenData } from "@mycadet/local-mode";
import { setup } from "../commands/setup.js";
import * as stepRunnerModule from "../lib/step-runner.js";

// The docker lease's pair rides the docker-exec seam — capture-spread the
// real module so `exec` stays live and `execOutput` is observable.
const execOutputMock = mock<typeof stepRunnerModule.execOutput>(async () => "");
mock.module("../lib/step-runner.js", () => ({
  ...stepRunnerModule,
  execOutput: execOutputMock,
}));

interface RecordedFetchCall {
  url: string;
  method?: string;
  headers: Headers;
  body: unknown;
}

const originalArgv = [...process.argv];
const originalFetch = globalThis.fetch;
const originalEnv = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  openaiApiKey: process.env.OPENAI_API_KEY,
  xdgConfigHome: process.env.XDG_CONFIG_HOME,
  xdgDataHome: process.env.XDG_DATA_HOME,
  cadetEnvironment: process.env.CADET_ENVIRONMENT,
};

let testDir = "";
let fetchCalls: RecordedFetchCall[] = [];
let consoleLogSpy: Mock<(...args: unknown[]) => void>;
let consoleErrorSpy: Mock<(...args: unknown[]) => void>;

function guardianTokenFixture(
  overrides: Partial<GuardianTokenData> = {},
): GuardianTokenData {
  return {
    guardianPrincipalId: "guardian-principal-123",
    accessToken: "guardian-token",
    accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    refreshToken: "refresh-token",
    refreshTokenExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    refreshAfter: new Date(Date.now() + 30_000).toISOString(),
    isNew: false,
    deviceId: "device-123",
    leasedAt: new Date().toISOString(),
    ...overrides,
  };
}

function writeLockfile(entry: LockfileAssistant): void {
  const lockfileDir = join(process.env.XDG_CONFIG_HOME!, "cadet");
  mkdirSync(lockfileDir, { recursive: true });
  writeFileSync(
    join(lockfileDir, "lockfile.json"),
    JSON.stringify(
      {
        assistants: [entry],
        activeAssistant: entry.assistantId,
      },
      null,
      2,
    ),
  );
}

/** A full-lockfile seed for tests that need root fields (the platform base
 * lives at the lockfile root, not on the entry). */
function writeFullLockfile(data: Record<string, unknown>): void {
  const lockfileDir = join(process.env.XDG_CONFIG_HOME!, "cadet");
  mkdirSync(lockfileDir, { recursive: true });
  writeFileSync(
    join(lockfileDir, "lockfile.json"),
    JSON.stringify(data, null, 2),
  );
}

function installFetchStub(
  options: {
    leasedToken?: GuardianTokenData;
    refreshedToken?: GuardianTokenData;
  } = {},
) {
  fetchCalls = [];
  globalThis.fetch = (async (input, init) => {
    const headers = new Headers(init?.headers);
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    const url = String(input);
    fetchCalls.push({
      url,
      method: init?.method,
      headers,
      body,
    });

    if (url.endsWith("/v1/guardian/refresh")) {
      if (!options.refreshedToken) {
        return new Response(JSON.stringify({ error: "expired" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(options.refreshedToken), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.endsWith("/v1/pair")) {
      if (!options.leasedToken) {
        return new Response(JSON.stringify({ error: "not allowed" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      // The pair route's device-bound response shape (token/guardianId names).
      const t = options.leasedToken;
      return new Response(
        JSON.stringify({
          token: t.accessToken,
          expiresAt: t.accessTokenExpiresAt,
          refreshToken: t.refreshToken,
          refreshTokenExpiresAt: t.refreshTokenExpiresAt,
          refreshAfter: t.refreshAfter,
          guardianId: t.guardianPrincipalId,
          isNew: t.isNew,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (url.endsWith("/v1/config/llm/default-provider")) {
      return Response.json({ provider: "anthropic" });
    }

    if (url.endsWith("/v1/secrets/read")) {
      return new Response(JSON.stringify({ found: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.endsWith("/v1/secrets")) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unexpected URL" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function secretWriteCall(): RecordedFetchCall {
  const call = fetchCalls.find((record) => record.url.endsWith("/v1/secrets"));
  if (!call) {
    throw new Error("Expected /v1/secrets call.");
  }
  return call;
}

describe("setup command", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cadet-setup-test-"));
    process.argv = ["bun", "cadet", "setup"];
    process.env.XDG_CONFIG_HOME = join(testDir, "config");
    process.env.XDG_DATA_HOME = join(testDir, "data");
    delete process.env.CADET_ENVIRONMENT;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
    installFetchStub();
  });

  afterEach(() => {
    process.argv = originalArgv;
    globalThis.fetch = originalFetch;
    execOutputMock.mockReset();
    setOptionalEnv("ANTHROPIC_API_KEY", originalEnv.anthropicApiKey);
    setOptionalEnv("OPENAI_API_KEY", originalEnv.openaiApiKey);
    setOptionalEnv("XDG_CONFIG_HOME", originalEnv.xdgConfigHome);
    setOptionalEnv("XDG_DATA_HOME", originalEnv.xdgDataHome);
    setOptionalEnv("CADET_ENVIRONMENT", originalEnv.cadetEnvironment);
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    rmSync(testDir, { recursive: true, force: true });
  });

  test("configures the default provider through the active assistant gateway", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    writeLockfile({
      assistantId: "assistant-123",
      cloud: "local",
      instanceDir: testDir,
      port: 3000,
      daemonPort: 8501,
      cesPort: 9002,
    });
    saveGuardianToken("assistant-123", guardianTokenFixture());

    await setup();

    expect(fetchCalls[0].url).toBe(
      "http://127.0.0.1:3000/v1/config/llm/default-provider",
    );
    expect(fetchCalls[0].headers.get("Authorization")).toBe(
      "Bearer guardian-token",
    );
    expect(secretWriteCall().body).toEqual({
      type: "api_key",
      name: "anthropic",
      value: "test-anthropic-key",
    });
    expect(consoleLogSpy.mock.calls.flat().join("\n")).toContain(
      "Anthropic API key saved to assistant from the environment.",
    );
  });

  test("honors an explicit provider option", async () => {
    process.argv = ["bun", "cadet", "setup", "--provider", "openai"];
    process.env.OPENAI_API_KEY = "test-openai-key";
    writeLockfile({
      assistantId: "assistant-123",
      cloud: "local",
      instanceDir: testDir,
      port: 3000,
      daemonPort: 8501,
      cesPort: 9002,
    });
    saveGuardianToken("assistant-123", guardianTokenFixture());

    await setup();

    expect(secretWriteCall().body).toEqual({
      type: "api_key",
      name: "openai",
      value: "test-openai-key",
    });
    expect(consoleLogSpy.mock.calls.flat().join("\n")).toContain(
      "OpenAI API key saved to assistant from the environment.",
    );
  });

  test("leases a guardian token for local assistants when no token exists", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    writeLockfile({
      assistantId: "assistant-123",
      cloud: "local",
      instanceDir: testDir,
      port: 3000,
      daemonPort: 8501,
      cesPort: 9002,
    });
    installFetchStub({
      leasedToken: guardianTokenFixture({
        accessToken: "leased-guardian-token",
      }),
    });

    await setup();

    // The lease probes /readyz first to wait out the gateway's "starting"
    // gate instead of burning retry attempts against it.
    expect(fetchCalls[0].url).toBe("http://127.0.0.1:3000/readyz");
    expect(fetchCalls[1].url).toBe("http://127.0.0.1:3000/v1/pair");
    expect(fetchCalls[2].url).toBe(
      "http://127.0.0.1:3000/v1/config/llm/default-provider",
    );
    expect(fetchCalls[2].headers.get("Authorization")).toBe(
      "Bearer leased-guardian-token",
    );
  });

  test("leases a Docker guardian token via the pairing flow", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    writeLockfile({
      assistantId: "assistant-123",
      cloud: "docker",
      port: 7831,
      daemonPort: 7821,
    });
    // The docker lease pairs from INSIDE the gateway container (docker-exec
    // presence proof), so the fetch stub never sees it — the exec boundary is
    // the seam. Answer it with /v1/pair's device-bound response shape.
    const t = guardianTokenFixture({ accessToken: "leased-docker-token" });
    execOutputMock.mockResolvedValue(
      `200\n${JSON.stringify({
        token: t.accessToken,
        expiresAt: t.accessTokenExpiresAt,
        refreshToken: t.refreshToken,
        refreshTokenExpiresAt: t.refreshTokenExpiresAt,
        refreshAfter: t.refreshAfter,
        guardianId: t.guardianPrincipalId,
        isNew: t.isNew,
      })}`,
    );

    await setup();

    expect(fetchCalls[0].url).toBe("http://127.0.0.1:7831/readyz");
    expect(execOutputMock).toHaveBeenCalledTimes(1);
    const call = execOutputMock.mock.calls[0];
    if (!call) throw new Error("expected one docker-exec call");
    const [cmd, args] = call;
    expect(cmd).toBe("docker");
    expect(args.slice(0, 4)).toEqual([
      "exec",
      "assistant-123-gateway",
      "bun",
      "-e",
    ]);
    expect(String(args[4])).toContain("/v1/pair");
    // The leased token is persisted and rides the following setup calls.
    expect(loadGuardianToken("assistant-123")?.accessToken).toBe(
      "leased-docker-token",
    );
  });

  test("derives the cloud address from the lockfile's platform base", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    // The platform base lives at the lockfile ROOT (not the entry) — the
    // cloud address derives from it.
    writeFullLockfile({
      cloudBaseUrl: "https://assistant.example",
      assistants: [
        {
          assistantId: "assistant-123",
          cloud: "cloud",
        },
      ],
      activeAssistant: "assistant-123",
    });
    saveGuardianToken(
      "assistant-123",
      guardianTokenFixture({ accessToken: "guardian-token" }),
    );

    await setup();

    expect(fetchCalls[0].url).toBe(
      "https://assistant.example/v1/config/llm/default-provider",
    );
    expect(fetchCalls[0].headers.get("Authorization")).toBe(
      "Bearer guardian-token",
    );
  });

  test("refreshes an expired guardian token before the setup request", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    // The platform base lives at the lockfile ROOT (not the entry) — the
    // cloud address derives from it.
    writeFullLockfile({
      cloudBaseUrl: "https://assistant.example",
      assistants: [
        {
          assistantId: "assistant-123",
          cloud: "cloud",
        },
      ],
      activeAssistant: "assistant-123",
    });
    saveGuardianToken(
      "assistant-123",
      guardianTokenFixture({
        accessToken: "expired-guardian-token",
        accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    installFetchStub({
      refreshedToken: guardianTokenFixture({
        accessToken: "fresh-guardian-token",
      }),
    });

    await setup();

    expect(fetchCalls[0].url).toBe(
      "https://assistant.example/v1/guardian/refresh",
    );
    expect(fetchCalls[0].headers.get("Authorization")).toBe(
      "Bearer expired-guardian-token",
    );
    expect(fetchCalls[1].headers.get("Authorization")).toBe(
      "Bearer fresh-guardian-token",
    );
  });

  test("uses a refreshed guardian token before lockfile fallback", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    // The platform base lives at the lockfile ROOT (not the entry) — the
    // cloud address derives from it.
    writeFullLockfile({
      cloudBaseUrl: "https://assistant.example",
      assistants: [
        {
          assistantId: "assistant-123",
          cloud: "cloud",
        },
      ],
      activeAssistant: "assistant-123",
    });
    saveGuardianToken(
      "assistant-123",
      guardianTokenFixture({
        accessToken: "expired-guardian-token",
        accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    installFetchStub({
      refreshedToken: guardianTokenFixture({
        accessToken: "fresh-guardian-token",
      }),
    });

    await setup();

    expect(fetchCalls[0].url).toBe(
      "https://assistant.example/v1/guardian/refresh",
    );
    expect(fetchCalls[1].headers.get("Authorization")).toBe(
      "Bearer fresh-guardian-token",
    );
  });
});

function setOptionalEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
