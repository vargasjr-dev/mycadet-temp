import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LocalAssistant, LockfileAssistant } from "../lockfile-contract";
import {
  getGuardianAccessToken,
  loadFreshGuardianToken,
  saveGuardianToken,
  type GuardianTokenData,
} from "../guardian-token";
import { saveLockfileAssistant } from "../lockfile";
import type {
  PairDeviceIdentity,
  PairOperationResult,
} from "../operations/pair";

// Snapshot the real modules before mocking so the module-scoped `afterAll`
// below can restore them — bun runs every test file in one process with a
// shared loader, and `mock.restore()` does not undo `mock.module()`.
const realLocalPair = { ...(await import("../remotes/local/pair")) };
const realDockerPair = { ...(await import("../remotes/docker/pair")) };

/** A minimal valid GuardianTokenData — the router test cares about routing. */
const fakeToken = (origin: string): GuardianTokenData => ({
  guardianPrincipalId: `guardian-${origin}`,
  accessToken: `access-${origin}`,
  accessTokenExpiresAt: 0,
  refreshToken: `refresh-${origin}`,
  refreshTokenExpiresAt: 0,
  refreshAfter: "1970-01-01T00:00:00.000Z",
  deviceId: "device-test",
  leasedAt: "1970-01-01T00:00:00.000Z",
});

const pairLocalMock = mock<
  (
    entry: LocalAssistant,
    device?: PairDeviceIdentity,
  ) => Promise<string | PairOperationResult<GuardianTokenData>>
>(async () => ({
  ok: true,
  response: fakeToken("local"),
}));
const pairDockerMock = mock<
  (
    entry: LockfileAssistant,
    device?: PairDeviceIdentity,
  ) => Promise<string | PairOperationResult<GuardianTokenData>>
>(async () => ({
  ok: true,
  response: fakeToken("docker"),
}));

mock.module("../remotes/local/pair", () => ({
  ...realLocalPair,
  pairLocal: pairLocalMock,
}));
mock.module("../remotes/docker/pair", () => ({
  ...realDockerPair,
  pairDocker: pairDockerMock,
}));

const { pairDevice } = await import("../operations/pair");

const localEntry = (overrides: Record<string, unknown> = {}) =>
  ({
    assistantId: "asst-local",
    cloud: "local",
    port: 7830,
    ...overrides,
  }) as unknown as LocalAssistant;

const dockerEntry = localEntry({ cloud: "docker" }) as LockfileAssistant;

afterAll(() => {
  mock.module("../remotes/local/pair", () => realLocalPair);
  mock.module("../remotes/docker/pair", () => realDockerPair);
});

afterEach(() => {
  pairLocalMock.mockReset();
  pairDockerMock.mockReset();
});

describe("pairDevice — the credential door routes by remote", () => {
  beforeEach(() => {
    pairLocalMock.mockResolvedValue({ ok: true, response: fakeToken("local") });
    pairDockerMock.mockResolvedValue({
      ok: true,
      response: fakeToken("docker"),
    });
  });

  test("routes a local entry to the local leg and hands it the device identity", async () => {
    const entry = localEntry();
    const device = {
      platform: "cli",
      deviceId: "device-1",
      clientReportedName: "box",
    };
    const result = await pairDevice(entry, device);
    expect(pairLocalMock).toHaveBeenCalledTimes(1);
    const [entryArg, deviceArg] = pairLocalMock.mock.calls[0]!;
    expect(entryArg).toBe(entry);
    expect(deviceArg).toEqual(device);
    expect(result).toEqual({ ok: true, response: fakeToken("local") });
    expect(pairDockerMock).not.toHaveBeenCalled();
  });

  test("routes a docker entry to the docker leg by entry", async () => {
    const device = { platform: "cli", deviceId: "device-2" };
    const result = await pairDevice(dockerEntry, device);
    expect(pairDockerMock).toHaveBeenCalledTimes(1);
    const [entryArg, deviceArg] = pairDockerMock.mock.calls[0]!;
    expect(entryArg).toBe(dockerEntry);
    expect(deviceArg).toEqual(device);
    expect(result).toEqual({ ok: true, response: fakeToken("docker") });
    expect(pairLocalMock).not.toHaveBeenCalled();
  });

  test("refuses remotes without a host-side pair transport", async () => {
    const result = await pairDevice(localEntry({ cloud: "cloud" }), {
      platform: "cli",
      deviceId: "device-4",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.status).toBe(400);
    expect(result.error).toContain("cloud");
    expect(pairLocalMock).not.toHaveBeenCalled();
    expect(pairDockerMock).not.toHaveBeenCalled();
  });

  test("wraps a refused leg in the guardian-pair failure shape", async () => {
    pairLocalMock.mockResolvedValue({
      ok: false,
      status: 403,
      error: "denied",
    });
    const result = await pairDevice(localEntry(), {
      platform: "cli",
      deviceId: "device-5",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.status).toBe(403);
    expect(result.error).toBe("guardian pair failed (403): denied");
  });

  test("a status-less failure reads as no response", async () => {
    pairDockerMock.mockResolvedValue({
      ok: false,
      status: 0,
      error: "gateway vanished",
    });
    const result = await pairDevice(dockerEntry, {
      platform: "cli",
      deviceId: "device-6",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.error).toBe(
      "guardian pair failed (no response): gateway vanished",
    );
  });
});

/**
 * The ONE renewal door: a due or expired stored lease re-invokes the pair
 * flow (the transport mocks above answer in the transports' stead), a fresh
 * lease comes back untouched, and a failed re-pair degrades to the stored
 * token. Co-located with the transport mocks so the shared-loader's
 * module-mock lifetime can't hijack the lease seam mid-run.
 */
describe("loadFreshGuardianToken — the one renewal door", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-door-test-"));
    process.env.XDG_CONFIG_HOME = home;
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, "XDG_CONFIG_HOME");
    fs.rmSync(home, { recursive: true, force: true });
  });

  const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const PAST = new Date(Date.now() - 60_000).toISOString();

  const storedToken = (
    over: Partial<GuardianTokenData>,
  ): GuardianTokenData => ({
    guardianPrincipalId: "principal-stored",
    accessToken: "stored-access",
    accessTokenExpiresAt: FUTURE,
    refreshToken: "stored-refresh",
    refreshTokenExpiresAt: FUTURE,
    refreshAfter: FUTURE,
    deviceId: "device-stored",
    leasedAt: new Date().toISOString(),
    ...over,
  });

  const freshPair = {
    ok: true as const,
    response: {
      guardianPrincipalId: "principal-fresh",
      accessToken: "fresh-access",
      accessTokenExpiresAt: FUTURE,
      refreshToken: "fresh-refresh",
      refreshTokenExpiresAt: FUTURE,
      refreshAfter: FUTURE,
      deviceId: "device-fresh",
      leasedAt: new Date().toISOString(),
    },
  };

  function seedEntry(): void {
    saveLockfileAssistant({
      assistantId: "asst-door",
      cloud: "local",
      instanceDir: path.join(home, "instance"),
      port: 7830,
      daemonPort: 7821,
      cesPort: 7822,
    } as unknown as LocalAssistant);
  }

  test("the holder refreshes a due token by re-pairing, not by calling a refresh API", async () => {
    seedEntry();
    saveGuardianToken(
      "asst-door",
      storedToken({ accessTokenExpiresAt: PAST, refreshAfter: PAST }),
    );
    pairLocalMock.mockResolvedValue(freshPair);

    const result = await getGuardianAccessToken("asst-door");

    expect(pairLocalMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, accessToken: "fresh-access" });
  });

  test("a failed re-pair degrades to the stored token", async () => {
    seedEntry();
    saveGuardianToken(
      "asst-door",
      storedToken({ accessTokenExpiresAt: PAST, refreshAfter: PAST }),
    );
    pairLocalMock.mockResolvedValue({
      ok: false,
      status: 503,
      error: "gateway unreachable",
    });

    const degraded = await loadFreshGuardianToken("asst-door");

    expect(degraded?.accessToken).toBe("stored-access");
  });

  test("a fresh stored lease never triggers a pair", async () => {
    seedEntry();
    saveGuardianToken("asst-door", storedToken({}));

    const fresh = await loadFreshGuardianToken("asst-door");

    expect(fresh?.accessToken).toBe("stored-access");
    expect(pairLocalMock).not.toHaveBeenCalled();
  });
});
