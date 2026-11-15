import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { LocalAssistant } from "../lockfile-contract";
import type { GuardianTokenData } from "../guardian-token";

/** A minimal valid guardian token payload — these tests exercise the door. */
const fakeToken = (token: string): GuardianTokenData => ({
  guardianPrincipalId: "guardian-1",
  accessToken: token,
  accessTokenExpiresAt: 0,
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: 0,
  refreshAfter: "1970-01-01T00:00:00.000Z",
  deviceId: "device-1",
  leasedAt: "1970-01-01T00:00:00.000Z",
});

// Snapshot the real module before mocking so the module-scoped `afterAll`
// below can restore it — bun runs every test file in one process with a
// shared loader, and `mock.restore()` does not undo `mock.module()`.
const realExec = { ...(await import("../exec")) };

const execOutputMock = mock<typeof realExec.execOutput>(async () => "");

mock.module("../exec", () => ({
  ...realExec,
  execOutput: execOutputMock,
}));

const { pairLocal } = await import("../remotes/local/pair");

// The invocation context derives from the entry's recorded instanceDir —
// recorded paths keep the assertions free of XDG resolution.
const entry: LocalAssistant = {
  assistantId: "asst-local",
  cloud: "local",
  instanceDir: "/data/assistants/asst-local",
  port: 7830,
};

afterAll(() => {
  mock.module("../exec", () => realExec);
});

describe("pairLocal — running the gateway's own CLI is the local presence proof", () => {
  beforeEach(() => {
    execOutputMock.mockClear();
    execOutputMock.mockResolvedValue("");
  });

  test("runs the instance's `gateway pairing mint` shim with the device identity as flags", async () => {
    execOutputMock.mockResolvedValue(JSON.stringify(fakeToken("t")));
    const result = await pairLocal(entry, {
      platform: "cli",
      deviceId: "device-1",
      clientReportedName: "box",
    });
    expect(execOutputMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = execOutputMock.mock.calls[0]!;
    // The bare command resolves through the instance's bin/ shim (put
    // first on PATH) — a layer removed from bun.
    expect(command).toBe("gateway");
    expect(args).toEqual([
      "pairing",
      "mint",
      "--platform",
      "cli",
      "--device-id",
      "device-1",
      "--client-reported-name",
      "box",
    ]);
    // The same geography `cadet exec --service gateway` uses: cwd is the
    // instance's gateway-security dir, and the workspace/security dirs are
    // pinned to the instance so the pairing store resolves identically to
    // the server's.
    expect(options?.cwd).toBe("/data/assistants/asst-local/gateway-security");
    expect(options?.env?.CADET_WORKSPACE_DIR).toBe(
      "/data/assistants/asst-local/workspace",
    );
    expect(options?.env?.GATEWAY_SECURITY_DIR).toBe(
      "/data/assistants/asst-local/gateway-security",
    );
    expect(
      options?.env?.PATH?.startsWith("/data/assistants/asst-local/bin:"),
    ).toBe(true);
    expect(options?.timeoutMs).toBe(30_000);
    expect(result).toEqual({ ok: true, response: fakeToken("t") });
  });

  test("omits the name flag when the device reports none", async () => {
    execOutputMock.mockResolvedValue(JSON.stringify(fakeToken("t")));
    await pairLocal(entry, { platform: "cli", deviceId: "device-2" });
    expect(execOutputMock.mock.calls[0]![1]).toEqual([
      "pairing",
      "mint",
      "--platform",
      "cli",
      "--device-id",
      "device-2",
    ]);
  });

  test("parses the LAST stdout line — earlier lines are warnings", async () => {
    execOutputMock.mockResolvedValue(
      `warning: cache cold\n${JSON.stringify(fakeToken("t"))}`,
    );
    const result = await pairLocal(entry, {
      platform: "cli",
      deviceId: "device-3",
    });
    expect(result).toEqual({ ok: true, response: fakeToken("t") });
  });

  test("a malformed payload names the shape refusal and is structured", async () => {
    // Valid JSON, wrong shape — the schema arm of the door's parser.
    execOutputMock.mockResolvedValue(
      JSON.stringify({ guardianPrincipalId: "guardian-1", accessToken: 42 }),
    );
    const result = await pairLocal(entry, {
      platform: "cli",
      deviceId: "device-shape",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.status).toBe(0);
    expect(result.error).toBe(
      'the gateway\'s pair output did not match the expected payload shape (stdout tail: {"guardianPrincipalId":"guardian-1","accessToken":42})',
    );
  });

  test("an unparseable answer comes back structured", async () => {
    execOutputMock.mockResolvedValue("not json at all");
    const result = await pairLocal(entry, {
      platform: "cli",
      deviceId: "device-4",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.status).toBe(0);
    expect(result.error).toBe(
      "could not parse the gateway's pair output (stdout tail: not json at all)",
    );
  });

  test("an exec failure (gateway down) comes back structured", async () => {
    execOutputMock.mockRejectedValue(
      new Error("gateway-cli exited with code 1"),
    );
    const result = await pairLocal(entry, {
      platform: "cli",
      deviceId: "device-5",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.status).toBe(0);
    expect(result.error).toBe("gateway-cli exited with code 1");
  });
});
