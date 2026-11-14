/**
 * Pins the local hatch leg's config handoff: the provider the caller picked
 * reaches the assistant's public config API (`POST /v1/config/set`) after
 * wake — the same route the docker leg, the web client, and
 * `assistant config set` use. When this leg skipped the pick the daemon
 * booted on the schema's anthropic fallback and every send died 422 for a
 * connection the user never picked ("anthropic-personal has no API key
 * stored") while the fireworks key they did store sat unused.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  mock,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

interface CapturedApply {
  gatewayUrl: string;
  bearerToken?: string;
  configValues: Record<string, string>;
}

let capturedApply: CapturedApply | undefined;

// Spread the actual module under the override — mocking without the spread
// replaces the whole module record for every file that runs later in the
// same bun test process.
const actualLocalWake = await import("../remotes/local/wake");
const wakeMock = mock(
  async (_entry: unknown, _opts?: { watch?: boolean }) =>
    ({ ok: true }) as never,
);
mock.module("../remotes/local/wake", () => ({
  ...actualLocalWake,
  wakeLocal: wakeMock,
}));

const actualHatchConfig = await import("../remotes/local/hatch-config");
mock.module("../remotes/local/hatch-config", () => ({
  ...actualHatchConfig,
  applyHatchConfig: async (options: CapturedApply) => {
    capturedApply = options;
  },
}));

// Spread the actual modules under the overrides — other modules in the
// import graph need the exports this test doesn't touch.
const actualGuardianToken = await import("../guardian-token");
mock.module("../guardian-token", () => ({
  ...actualGuardianToken,
  // A valid-shaped token: the lease succeeding keeps the leg's post-hatch
  // steps instant (a failing lease retries with sleeps), and this test is
  // about the config handoff, not the lease.
  leaseGuardianToken: async () => ({
    guardianPrincipalId: "principal-test",
    accessToken: "test-token",
    accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
    refreshToken: "test-refresh",
    refreshTokenExpiresAt: "2099-01-01T00:00:00.000Z",
    refreshAfter: "2099-01-01T00:00:00.000Z",
    deviceId: "device-test",
    leasedAt: "2020-01-01T00:00:00.000Z",
  }),
}));

const actualProviderCredentials = await import("../provider-credentials");
mock.module("../provider-credentials", () => ({
  ...actualProviderCredentials,
  configureHatchProviderApiKey: async () => {},
}));

const actualCloudAuth = await import("../cloud-auth");
mock.module("../cloud-auth", () => ({
  ...actualCloudAuth,
  readCloudToken: () => null,
}));

const { hatchLocal } = await import("../remotes/local/hatch");

afterAll(() => {
  mock.module("../remotes/local/wake", () => actualLocalWake);
  mock.module("../remotes/local/hatch-config", () => actualHatchConfig);
  mock.module("../guardian-token", () => actualGuardianToken);
  mock.module("../provider-credentials", () => actualProviderCredentials);
  mock.module("../cloud-auth", () => actualCloudAuth);
});

let home: string;
const ENV_KEYS = ["XDG_CONFIG_HOME", "XDG_DATA_HOME"] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "hatch-local-config-api-"));
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    process.env[key] = path.join(home, key.toLowerCase());
  }
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

describe("hatchLocal's config API handoff", () => {
  test("the picked provider rides the config API as llm.default.provider", async () => {
    const result = await hatchLocal({
      name: "config-api-probe",
      provider: "fireworks",
      reporter: {
        progress: () => {},
        log: () => {},
        warn: () => {},
        error: () => {},
      },
    });
    expect(result.ok).toBe(true);
    expect(capturedApply).toBeDefined();
    expect(capturedApply?.bearerToken).toBe("test-token");
    expect(capturedApply?.gatewayUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(capturedApply?.configValues).toMatchObject({
      "llm.default.provider": "fireworks",
    });
  });

  test("explicit config wins over the pick", async () => {
    const result = await hatchLocal({
      name: "config-api-probe-2",
      provider: "fireworks",
      configValues: { "llm.default.provider": "openai" },
      reporter: {
        progress: () => {},
        log: () => {},
        warn: () => {},
        error: () => {},
      },
    });
    expect(result.ok).toBe(true);
    expect(capturedApply).toBeDefined();
    expect(capturedApply?.configValues).toMatchObject({
      "llm.default.provider": "openai",
    });
  });
});
