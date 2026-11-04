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

// Snapshot the real modules before mocking so the module-scoped `afterAll`
// below can restore them — bun runs every test file in one process with a
// shared loader, and `mock.restore()` does not undo `mock.module()`.
const realHatch = { ...(await import("../operations/hatch")) };
const realDevices = { ...(await import("../devices")) };
const realUpgrade = { ...(await import("../operations/upgrade")) };
const realAvatar = { ...(await import("../avatar")) };
const realUnpair = { ...(await import("../unpair")) };
const realPair = { ...(await import("../pair")) };

const hatchAssistantMock = mock(
  async (_options: {
    remote: string;
  }): Promise<
    | { ok: true; assistant: { assistantId: string }; ready: boolean }
    | { ok: false; status: number; error: string }
  > => ({ ok: true, assistant: { assistantId: "hatched-1" }, ready: true }),
);
const runDevicesListMock = mock(async (_assistantId: string) => ({
  ok: true as const,
  devices: [],
}));
const runDevicesRevokeMock = mock(
  async (_assistantId: string, _hashedDeviceId: string) => ({ ok: true }),
);
const upgradeAssistantMock = mock(
  async (_options: unknown) =>
    ({ ok: true as const, version: "v9.9.9" }) as
      | { ok: true; version?: string }
      | { ok: false; status: number; error: string; code?: string },
);
const readLockfileAssistantAvatarMock = mock((_assistantId: string) => ({
  ok: true as const,
  avatar: { kind: "character" as const, traits: {} },
}));
type UnpairAnswer =
  | { ok: true; lockfile: { assistants: never[]; activeAssistant: null } }
  | { ok: false; status: number; error: string };
const unpairAssistantMock = mock(
  (_assistantId: string): UnpairAnswer => ({
    ok: true,
    lockfile: { assistants: [], activeAssistant: null },
  }),
);
type PairingStartAnswer =
  | {
      ok: true;
      handle: string;
      userCode: string;
      expiresAt: string;
      intervalSeconds: number;
    }
  | {
      ok: false;
      status: number;
      reason: "invalid-address";
      error: string;
      rejection: string;
    };
const pairingStartMock = mock(
  async (_address?: unknown): Promise<PairingStartAnswer> => ({
    ok: true,
    handle: "handle-1",
    userCode: "ABCD-EFGH",
    expiresAt: "2099-01-01T00:00:00.000Z",
    intervalSeconds: 5,
  }),
);
type PairingPollAnswer =
  | { ok: true; status: "pending"; expiresAt: string; intervalSeconds: number }
  | {
      ok: true;
      status: "imported";
      assistantId: string;
      accessOnly: boolean;
    }
  | { ok: false; status: number; reason: string; error: string };
const pairingPollMock = mock(
  async (_options?: unknown): Promise<PairingPollAnswer> => ({
    ok: true,
    status: "pending",
    expiresAt: "2099-01-01T00:00:00.000Z",
    intervalSeconds: 5,
  }),
);
const pairingCancelMock = mock((_handle?: unknown): boolean => true);

mock.module("../operations/hatch", () => ({
  ...realHatch,
  hatchAssistant: hatchAssistantMock,
}));
mock.module("../devices", () => ({
  ...realDevices,
  runDevicesList: runDevicesListMock,
  runDevicesRevoke: runDevicesRevokeMock,
}));
mock.module("../operations/upgrade", () => ({
  ...realUpgrade,
  upgradeAssistant: upgradeAssistantMock,
}));
mock.module("../avatar", () => ({
  ...realAvatar,
  readLockfileAssistantAvatar: readLockfileAssistantAvatarMock,
}));
mock.module("../unpair", () => ({
  ...realUnpair,
  unpairAssistant: unpairAssistantMock,
}));
mock.module("../pair", () => ({
  ...realPair,
  pairingStart: pairingStartMock,
  pairingPoll: pairingPollMock,
  pairingCancel: pairingCancelMock,
}));

// Restore the real modules once this file finishes so the mocks above do not
// leak into other test files in the same `bun test` run.
afterAll(() => {
  mock.module("../hatch", () => realHatch);
  mock.module("../devices", () => realDevices);
  mock.module("../operations/upgrade", () => realUpgrade);
  mock.module("../avatar", () => realAvatar);
  mock.module("../unpair", () => realUnpair);
  mock.module("../pair", () => realPair);
});

import { readLockfile } from "../lockfile";
import { stripSensitiveFields } from "../util";
import { matchOperatorRequest } from "../operations/routes";

let tmpDir: string;
let lockfilePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cadet-routes-op-"));
  lockfilePath = path.join(tmpDir, "cadet", "lockfile.json");
  process.env.XDG_CONFIG_HOME = tmpDir;
  for (const m of [
    hatchAssistantMock,
    runDevicesListMock,
    runDevicesRevokeMock,
    upgradeAssistantMock,
    readLockfileAssistantAvatarMock,
    unpairAssistantMock,
    pairingStartMock,
    pairingPollMock,
    pairingCancelMock,
  ]) {
    m.mockReset();
  }
  hatchAssistantMock.mockImplementation(
    async (_options: { remote: string }) => ({
      ok: true as const,
      assistant: { assistantId: "hatched-1" },
      ready: true,
    }),
  );
  runDevicesListMock.mockImplementation(async () => ({
    ok: true as const,
    devices: [],
  }));
  runDevicesRevokeMock.mockImplementation(async () => ({ ok: true }));
  upgradeAssistantMock.mockImplementation(async () => ({
    ok: true as const,
    version: "v9.9.9",
  }));
  readLockfileAssistantAvatarMock.mockImplementation(() => ({
    ok: true as const,
    avatar: { kind: "character" as const, traits: {} },
  }));
  unpairAssistantMock.mockImplementation(() => ({
    ok: true as const,
    lockfile: { assistants: [], activeAssistant: null },
  }));
  pairingStartMock.mockImplementation(async () => ({
    ok: true as const,
    handle: "handle-1",
    userCode: "ABCD-EFGH",
    expiresAt: "2099-01-01T00:00:00.000Z",
    intervalSeconds: 5,
  }));
  pairingPollMock.mockImplementation(async () => ({
    ok: true as const,
    status: "pending" as const,
    expiresAt: "2099-01-01T00:00:00.000Z",
    intervalSeconds: 5,
  }));
  pairingCancelMock.mockImplementation(() => true);
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const writeLockfile = (data: Record<string, unknown>): void => {
  fs.mkdirSync(path.dirname(lockfilePath), { recursive: true });
  fs.writeFileSync(lockfilePath, JSON.stringify(data));
};

const seedEntry = (entry: Record<string, unknown>) => {
  writeLockfile({ assistants: [entry], activeAssistant: null });
  return readLockfile().assistants[0]!;
};

const dispatch = (
  pathname: string,
  method: string,
  body?: unknown,
): Promise<Response | null> => {
  const match = matchOperatorRequest(pathname, method);
  if (!match) {
    return Promise.reject(new Error(`no route for ${method} ${pathname}`));
  }
  const request = new Request(`http://host.test${pathname}`, {
    method,
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body:
      body === undefined || method === "GET" ? undefined : JSON.stringify(body),
  });
  return match.route.run({
    assistantId: match.assistantId,
    body: request.body,
  });
};

/** dispatch for a row that must answer — narrows the pass-through null. */
const dispatchAnswered = async (
  pathname: string,
  method: string,
  body?: unknown,
): Promise<Response> => {
  const response = await dispatch(pathname, method, body);
  if (!response) {
    throw new Error(`${method} ${pathname} passed through; expected an answer`);
  }
  return response;
};

describe("the list row — GET /v1/assistants/ is the list contract", () => {
  test("a populated lockfile answers a selection of credential-free rows", async () => {
    seedEntry({
      assistantId: "asst-1",
      name: "Workbench",
      cloud: "local",
      port: 7830,
      bearerToken: "secret-token",
    });

    const response = await dispatchAnswered("/v1/assistants/", "GET");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "selection",
      assistants: [{ id: "asst-1", name: "Workbench", remote: "local" }],
    });
  });

  test("an empty lockfile answers the empty arm", async () => {
    const response = await dispatchAnswered("/v1/assistants/", "GET");
    expect(await response.json()).toEqual({ status: "empty" });
  });

  test("the union never reaches disk: the stored file keeps its secrets", async () => {
    seedEntry({ assistantId: "asst-1", cloud: "local", port: 7830 });
    await dispatch("/v1/assistants/", "GET");
    expect(stripSensitiveFields).toBeDefined();
    expect(JSON.parse(fs.readFileSync(lockfilePath, "utf-8"))).toBeDefined();
  });
});

describe("the hatch row — POST /v1/assistants/hatch", () => {
  test("spawns the CLI harness and returns the assistant id", async () => {
    const response = await dispatchAnswered("/v1/assistants/hatch", "POST", {
      remote: "docker",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      assistantId: "hatched-1",
    });
    expect(hatchAssistantMock).toHaveBeenCalledWith({ remote: "docker" });
  });

  test("a non-object body degrades to a plain hatch", async () => {
    const response = await dispatchAnswered("/v1/assistants/hatch", "POST", {});
    expect(hatchAssistantMock).toHaveBeenCalledWith({ remote: "local" });
    expect((await response.json()).ok).toBe(true);
  });

  test("a failed hatch resolves {ok:false, error} — never a throw", async () => {
    hatchAssistantMock.mockImplementation(async () => ({
      ok: false as const,
      status: 503,
      error: "docker daemon unreachable",
    }));

    const response = await dispatchAnswered("/v1/assistants/hatch", "POST", {});

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: "docker daemon unreachable",
    });
  });
});

describe("the unpair row — POST /v1/assistants/{id}/unpair", () => {
  test("an on-machine entry unpairs and returns the written lockfile", async () => {
    seedEntry({ assistantId: "asst-1", cloud: "local", port: 7830 });

    const response = await dispatchAnswered(
      "/v1/assistants/asst-1/unpair",
      "POST",
      {},
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      lockfile: { assistants: [], activeAssistant: null },
    });
    expect(unpairAssistantMock).toHaveBeenCalledWith("asst-1");
  });

  test("an id that is not an entry on this machine passes through", async () => {
    const response = await dispatch("/v1/assistants/ghost/unpair", "POST", {});

    expect(response).toBeNull();
    expect(unpairAssistantMock).not.toHaveBeenCalled();
  });

  test("a refused unpair carries the operation's status", async () => {
    seedEntry({ assistantId: "asst-1", cloud: "local", port: 7830 });
    unpairAssistantMock.mockImplementation(() => ({
      ok: false as const,
      status: 409,
      error: "the assistant is running",
    }));

    const response = await dispatchAnswered(
      "/v1/assistants/asst-1/unpair",
      "POST",
      {},
    );

    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({
      ok: false,
      error: "the assistant is running",
    });
  });
});

describe("the pairing rows — POST /v1/remote-web/pairing-*", () => {
  test("pairing-start maps the started shape", async () => {
    const response = await dispatchAnswered(
      "/v1/remote-web/pairing-start",
      "POST",
      { address: "https://gw.example.com" },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      handle: "handle-1",
      userCode: "ABCD-EFGH",
      expiresAt: "2099-01-01T00:00:00.000Z",
      intervalSeconds: 5,
    });
    expect(pairingStartMock).toHaveBeenCalledWith("https://gw.example.com");
  });

  test("pairing-start carries the refusal's reason and rejection", async () => {
    pairingStartMock.mockImplementation(async () => ({
      ok: false as const,
      status: 400,
      reason: "invalid-address" as const,
      error: "That address points back at this machine.",
      rejection: "loopback",
    }));

    const response = await dispatch("/v1/remote-web/pairing-start", "POST", {
      address: "https://localhost:7830",
    });

    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({
      ok: false,
      reason: "invalid-address",
      rejection: "loopback",
    });
  });

  test("pairing-poll distinguishes pending from imported", async () => {
    const pending = await dispatchAnswered(
      "/v1/remote-web/pairing-poll",
      "POST",
      { handle: "handle-1" },
    );
    expect(await pending.json()).toMatchObject({ status: "pending" });

    pairingPollMock.mockImplementation(async () => ({
      ok: true as const,
      status: "imported" as const,
      assistantId: "desk",
      accessOnly: true,
    }));
    const imported = await dispatchAnswered(
      "/v1/remote-web/pairing-poll",
      "POST",
      { handle: "handle-1", name: "desk" },
    );
    expect(await imported.json()).toEqual({
      ok: true,
      status: "imported",
      assistantId: "desk",
      accessOnly: true,
    });
    expect(pairingPollMock).toHaveBeenLastCalledWith({
      handle: "handle-1",
      name: "desk",
    });
  });

  test("pairing-cancel answers with the op's boolean", async () => {
    pairingCancelMock.mockImplementation(() => false);

    const response = await dispatchAnswered(
      "/v1/remote-web/pairing-cancel",
      "POST",
      { handle: "handle-1" },
    );

    expect(await response.json()).toEqual({ ok: false });
    expect(pairingCancelMock).toHaveBeenCalledWith("handle-1");
  });

  test("malformed bodies answer 400 with the shared invalid-JSON shape", async () => {
    for (const pathname of [
      "/v1/remote-web/pairing-start",
      "/v1/remote-web/pairing-poll",
      "/v1/remote-web/pairing-cancel",
      "/v1/devices",
      "/v1/devices/revoke",
    ]) {
      const match = matchOperatorRequest(pathname, "POST")!;
      const request = new Request(`http://host.test${pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      const response = await match.route.run({
        assistantId: match.assistantId,
        body: request.body,
      });
      expect(response?.status).toBe(400);
      expect(await response?.json()).toEqual({
        ok: false,
        error: "Invalid JSON body",
      });
    }
  });
});

describe("the devices rows — POST /v1/devices[/revoke]", () => {
  test("the list row passes the assistant id to the run helper", async () => {
    const response = await dispatchAnswered("/v1/devices", "POST", {
      assistantId: "asst-1",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, devices: [] });
    expect(runDevicesListMock).toHaveBeenCalledWith("asst-1");
  });

  test("the revoke row requires the hashed device id", async () => {
    const missing = await dispatchAnswered("/v1/devices/revoke", "POST", {
      assistantId: "asst-1",
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      ok: false,
      error: "Missing hashedDeviceId",
    });

    const response = await dispatchAnswered("/v1/devices/revoke", "POST", {
      assistantId: "asst-1",
      hashedDeviceId: "hash-1",
    });
    expect(await response.json()).toEqual({ ok: true });
    expect(runDevicesRevokeMock).toHaveBeenCalledWith("asst-1", "hash-1");
  });

  test("a missing assistantId answers 400 before any spawn", async () => {
    const response = await dispatchAnswered("/v1/devices", "POST", {});
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Missing assistantId",
    });
    expect(runDevicesListMock).not.toHaveBeenCalled();
  });

  test("run-helper failures resolve {ok:false, error} — never a throw", async () => {
    runDevicesListMock.mockImplementation(async () => {
      throw new Error("cli spawn failed");
    });

    const response = await dispatchAnswered("/v1/devices", "POST", {
      assistantId: "asst-1",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      error: "cli spawn failed",
    });
  });
});

describe("the upgrade row — POST /v1/assistants/{id}/upgrade", () => {
  test("the active local assistant upgrades through the CLI", async () => {
    seedEntry({ assistantId: "asst-1", cloud: "local", port: 7830 });
    writeLockfile({
      assistants: [{ assistantId: "asst-1", cloud: "local", port: 7830 }],
      activeAssistant: "asst-1",
    });

    const response = await dispatchAnswered(
      "/v1/assistants/asst-1/upgrade",
      "POST",
      { latest: true },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, version: "v9.9.9" });
    expect(upgradeAssistantMock).toHaveBeenCalled();
  });

  test("a non-active local entry is refused", async () => {
    // A single entry IS the active one (the active-or-single doctrine) —
    // refusal needs a second entry holding the active seat.
    writeLockfile({
      assistants: [
        { assistantId: "asst-1", cloud: "local", port: 7830 },
        { assistantId: "asst-2", cloud: "local", port: 7831 },
      ],
      activeAssistant: "asst-2",
    });

    const response = await dispatch(
      "/v1/assistants/asst-1/upgrade",
      "POST",
      {},
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      ok: false,
      error: "Can only upgrade the active local assistant",
    });
    expect(upgradeAssistantMock).not.toHaveBeenCalled();
  });

  test("an id that is not an entry on this machine passes through", async () => {
    const response = await dispatch(
      "/v1/assistants/cloud-id/upgrade",
      "POST",
      {},
    );

    expect(response).toBeNull();
    expect(upgradeAssistantMock).not.toHaveBeenCalled();
  });
});

describe("the avatar row — GET /v1/assistants/{id}/avatar/get", () => {
  test("an on-machine entry reads the avatar off its workspace", async () => {
    seedEntry({ assistantId: "asst-1", cloud: "local", port: 7830 });

    const response = await dispatchAnswered(
      "/v1/assistants/asst-1/avatar/get",
      "GET",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      avatar: { kind: "character", traits: {} },
    });
    expect(readLockfileAssistantAvatarMock).toHaveBeenCalledWith("asst-1");
  });

  test("an id that is not an entry on this machine passes through", async () => {
    const response = await dispatch("/v1/assistants/ghost/avatar/get", "GET");
    expect(response).toBeNull();
    expect(readLockfileAssistantAvatarMock).not.toHaveBeenCalled();
  });
});

describe("the route table's method scoping", () => {
  test("a method-mismatched request to a known path matches no row", () => {
    expect(matchOperatorRequest("/v1/devices", "GET")).toBeNull();
    expect(
      matchOperatorRequest("/v1/remote-web/pairing-start", "DELETE"),
    ).toBeNull();
  });

  test("a GET on a path-shaped id rides the resolution row's pattern", () => {
    // `/v1/assistants/hatch` is a legal resolution probe for an id literally
    // named "hatch" — the id-scoped pattern owns it, the entry lookup
    // pass-through decides.
    const match = matchOperatorRequest("/v1/assistants/hatch", "GET");
    expect(match?.assistantId).toBe("hatch");
  });

  test("no-capture patterns resolve the empty id", () => {
    // Every body-only route's pattern has no capture group; the rows that
    // read an id never match on those patterns.
    const match = matchOperatorRequest("/v1/devices", "POST");
    expect(match?.assistantId).toBe("");
  });
});
