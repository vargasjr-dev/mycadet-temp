import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { LocalAssistant } from "../lockfile-contract";

// Snapshot the real modules before mocking so the module-scoped `afterAll`
// below can restore them — bun runs every test file in one process with a
// shared loader, and `mock.restore()` does not undo `mock.module()`.
const realExec = { ...(await import("../exec")) };
const realCommon = { ...(await import("../remotes/local/common")) };

const execOutputMock = mock<typeof realExec.execOutput>(async () => "");
const gatewayCliInvocationMock = mock<typeof realCommon.gatewayCliInvocation>(
  () => ({
    command: "/fake/bun",
    args: ["run", "/fake/gateway/src/cli/index.ts"],
    cwd: "/fake/state-root",
    env: {},
  }),
);

mock.module("../exec", () => ({
  ...realExec,
  execOutput: execOutputMock,
}));
mock.module("../remotes/local/common", () => ({
  ...realCommon,
  gatewayCliInvocation: gatewayCliInvocationMock,
}));

const { pairLocal } = await import("../remotes/local/pair");

const entry: LocalAssistant = {
  assistantId: "asst-local",
  cloud: "local",
  port: 7830,
};

afterAll(() => {
  mock.module("../exec", () => realExec);
  mock.module("../remotes/local/common", () => realCommon);
});

describe("pairLocal — running the gateway's own CLI is the local presence proof", () => {
  beforeEach(() => {
    execOutputMock.mockClear();
    execOutputMock.mockResolvedValue("");
    gatewayCliInvocationMock.mockClear();
    gatewayCliInvocationMock.mockReturnValue({
      command: "/fake/bun",
      args: ["run", "/fake/gateway/src/cli/index.ts"],
      cwd: "/fake/state-root",
      env: {},
    });
  });

  test("runs `gateway pairing mint` with the device identity as flags", async () => {
    execOutputMock.mockResolvedValue(JSON.stringify({ token: "t" }));
    const result = await pairLocal(entry, {
      platform: "cli",
      deviceId: "device-1",
      clientReportedName: "box",
    });
    expect(execOutputMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = execOutputMock.mock.calls[0]!;
    expect(command).toBe("/fake/bun");
    expect(args).toEqual([
      "run",
      "/fake/gateway/src/cli/index.ts",
      "pairing",
      "mint",
      "--platform",
      "cli",
      "--device-id",
      "device-1",
      "--client-reported-name",
      "box",
    ]);
    expect(options?.cwd).toBe("/fake/state-root");
    expect(options?.env).toEqual({});
    expect(options?.timeoutMs).toBe(30_000);
    expect(result).toEqual({ ok: true, response: { token: "t" } });
  });

  test("omits the name flag when the device reports none", async () => {
    execOutputMock.mockResolvedValue(JSON.stringify({ token: "t" }));
    await pairLocal(entry, { platform: "cli", deviceId: "device-2" });
    expect(execOutputMock.mock.calls[0]![1]).toEqual([
      "run",
      "/fake/gateway/src/cli/index.ts",
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
      `warning: cache cold\n${JSON.stringify({ token: "t", guardianId: "g" })}`,
    );
    const result = await pairLocal(entry, {
      platform: "cli",
      deviceId: "device-3",
    });
    expect(result).toEqual({
      ok: true,
      response: { token: "t", guardianId: "g" },
    });
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
    expect(result.error).toBe("could not parse the gateway's pair output");
  });

  test("an exec failure (gateway down) comes back structured", async () => {
    execOutputMock.mockRejectedValue(
      new Error("gateway-cli exited with code 1"),
    );
    const result = await pairLocal(entry, {
      platform: "cli",
      deviceId: "device-5",
    });
    expect(result).toEqual({
      ok: false,
      status: 0,
      error: "gateway-cli exited with code 1",
    });
  });
});
