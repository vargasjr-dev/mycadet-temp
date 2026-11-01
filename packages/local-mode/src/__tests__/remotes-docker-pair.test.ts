import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// Snapshot the real modules before mocking so the module-scoped `afterAll`
// below can restore them — bun runs every test file in one process with a
// shared loader, and `mock.restore()` does not undo `mock.module()`.
const realExec = { ...(await import("../exec")) };

const execOutputMock = mock<typeof realExec.execOutput>(async () => "");

mock.module("../exec", () => ({
  ...realExec,
  execOutput: execOutputMock,
}));

const { pairDocker } = await import("../remotes/docker/pair");

const body = JSON.stringify({ platform: "cli", deviceId: "device-1" });

afterAll(() => {
  mock.module("../exec", () => realExec);
});

describe("pairDocker — the in-container exec is the docker presence proof", () => {
  beforeEach(() => {
    execOutputMock.mockResolvedValue("");
  });

  test("docker-execs the gateway's own loopback with the pair body", async () => {
    execOutputMock.mockResolvedValue(`200\n${JSON.stringify({ token: "t" })}`);
    const result = await pairDocker("assistant-123", body);
    expect(execOutputMock).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = execOutputMock.mock.calls[0]!;
    expect(cmd).toBe("docker");
    expect(args.slice(0, 4)).toEqual([
      "exec",
      "assistant-123-gateway",
      "bun",
      "-e",
    ]);
    const script = String(args[4]);
    expect(script).toContain("/v1/pair");
    expect(script).toContain("127.0.0.1");
    expect(script).toContain(JSON.stringify(body));
    expect(options?.timeoutMs).toBe(30_000);
    expect(result).toEqual({ ok: true, response: { token: "t" } });
  });

  test("a refused in-container pair comes back structured", async () => {
    execOutputMock.mockResolvedValue(`403\nloopback only`);
    const result = await pairDocker("assistant-123", body);
    expect(result).toEqual({
      ok: false,
      status: 403,
      error: "loopback only",
    });
  });

  test("a malformed status line reads as no response", async () => {
    execOutputMock.mockResolvedValue(`not-a-status\n{"err":true}`);
    const result = await pairDocker("assistant-123", body);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.status).toBe(0);
    expect(result.error).toBe('{"err":true}');
  });
});
