import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { DockerAssistant } from "../lockfile-contract";

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

const entry: DockerAssistant = {
  assistantId: "assistant-123",
  cloud: "docker",
  port: 7831,
};

afterAll(() => {
  mock.module("../exec", () => realExec);
});

describe("pairDocker — the in-container gateway CLI is the docker presence proof", () => {
  beforeEach(() => {
    execOutputMock.mockResolvedValue("");
  });

  test("docker-execs `gateway pairing mint` with the device identity as flags", async () => {
    execOutputMock.mockResolvedValue(JSON.stringify({ token: "t" }));
    const result = await pairDocker(entry, {
      platform: "cli",
      deviceId: "device-1",
      clientReportedName: "box",
    });
    expect(execOutputMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = execOutputMock.mock.calls[0]!;
    expect(command).toBe("docker");
    // `bun run gateway` resolves the gateway package's own bin
    // (node_modules/.bin) from the container's WORKDIR.
    expect(args).toEqual([
      "exec",
      "assistant-123-gateway",
      "bun",
      "run",
      "gateway",
      "pairing",
      "mint",
      "--platform",
      "cli",
      "--device-id",
      "device-1",
      "--client-reported-name",
      "box",
    ]);
    expect(options?.timeoutMs).toBe(30_000);
    expect(result).toEqual({ ok: true, response: { token: "t" } });
  });

  test("parses the LAST stdout line of the mint", async () => {
    execOutputMock.mockResolvedValue(
      `warn\n${JSON.stringify({ token: "t", isNew: true })}`,
    );
    const result = await pairDocker(entry, {
      platform: "cli",
      deviceId: "device-2",
    });
    expect(result).toEqual({ ok: true, response: { token: "t", isNew: true } });
  });

  test("an exec failure (container gone) comes back structured", async () => {
    execOutputMock.mockRejectedValue(new Error("docker exited with code 1"));
    const result = await pairDocker(entry, {
      platform: "cli",
      deviceId: "device-3",
    });
    expect(result).toEqual({
      ok: false,
      status: 0,
      error: "docker exited with code 1",
    });
  });
});
