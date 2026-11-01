import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import type { LockfileAssistant } from "../lockfile-contract";

// Snapshot the real modules before mocking so the module-scoped `afterAll`
// below can restore them — bun runs every test file in one process with a
// shared loader, and `mock.restore()` does not undo `mock.module()`.
const realLocalPair = { ...(await import("../remotes/local/pair")) };
const realDockerPair = { ...(await import("../remotes/docker/pair")) };

const pairLocalMock = mock<typeof realLocalPair.pairLocal>(async () => ({
  ok: true,
  response: { token: "local" },
}));
const pairDockerMock = mock<typeof realDockerPair.pairDocker>(async () => ({
  ok: true,
  response: { token: "docker" },
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
  }) as unknown as LockfileAssistant;

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
    pairLocalMock.mockResolvedValue({ ok: true, response: { token: "local" } });
    pairDockerMock.mockResolvedValue({
      ok: true,
      response: { token: "docker" },
    });
  });

  test("routes a local entry to the loopback leg and hands it the entry", async () => {
    const entry = localEntry();
    const result = await pairDevice(entry, {
      platform: "cli",
      deviceId: "device-1",
      clientReportedName: "box",
    });
    expect(pairLocalMock).toHaveBeenCalledTimes(1);
    const [entryArg, body] = pairLocalMock.mock.calls[0]!;
    expect(entryArg).toBe(entry);
    expect(JSON.parse(body)).toEqual({
      platform: "cli",
      deviceId: "device-1",
      clientReportedName: "box",
    });
    expect(result).toEqual({ ok: true, response: { token: "local" } });
    expect(pairDockerMock).not.toHaveBeenCalled();
  });

  test("routes a docker entry to the exec leg by instance id", async () => {
    const result = await pairDevice(dockerEntry, {
      platform: "cli",
      deviceId: "device-2",
    });
    expect(pairDockerMock).toHaveBeenCalledTimes(1);
    const [assistantId, body] = pairDockerMock.mock.calls[0]!;
    expect(assistantId).toBe("asst-local");
    expect(JSON.parse(body)).toEqual({
      platform: "cli",
      deviceId: "device-2",
    });
    expect(result).toEqual({ ok: true, response: { token: "docker" } });
    expect(pairLocalMock).not.toHaveBeenCalled();
  });

  test("omits clientReportedName from the body when absent", async () => {
    await pairDevice(localEntry(), {
      platform: "chrome-extension",
      deviceId: "device-3",
    });
    expect(JSON.parse(pairLocalMock.mock.calls[0]![1])).toEqual({
      platform: "chrome-extension",
      deviceId: "device-3",
    });
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
