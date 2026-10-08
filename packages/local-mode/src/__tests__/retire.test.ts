import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

import type { CliInvocation } from "../util";
import { FakeChild, mockChildProcessSpawn } from "./helpers/child-process-mock";

let lastChild: FakeChild;
const spawnArgs: Array<
  [string, string[], { env?: NodeJS.ProcessEnv; stdio?: unknown; windowsHide?: boolean }]
> = [];
const spawnMock = mock(
  (
    command: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv; stdio?: unknown; windowsHide?: boolean },
  ) => {
    spawnArgs.push([command, args, options]);
    lastChild = new FakeChild();
    return lastChild;
  },
);

await mockChildProcessSpawn(spawnMock);

let runRetire: typeof import("../retire").runRetire;

beforeAll(async () => {
  ({ runRetire } = await import("../retire"));
});

afterEach(() => {
  spawnArgs.length = 0;
  spawnMock.mockClear();
  delete process.env.CADET_PLATFORM_TOKEN;
});

const invocation: CliInvocation = { command: "bun", baseArgs: ["run", "cli"] };

describe("runRetire", () => {
  test("spawns the CLI retire command", async () => {
    const pending = runRetire(invocation, "asst-42");
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true });
    expect(spawnArgs[0]).toEqual([
      "bun",
      ["run", "cli", "retire", "asst-42", "--yes"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    ]);
  });

  test("passes a host platform token to the CLI subprocess", async () => {
    const pending = runRetire(invocation, "asst-42", {
      platformToken: "session-token",
    });
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true });
    expect(spawnArgs[0]?.[2].env?.CADET_PLATFORM_TOKEN).toBe("session-token");
    expect(process.env.CADET_PLATFORM_TOKEN).toBeUndefined();
  });

  test("a non-zero exit resolves to a failure carrying the CLI output", async () => {
    const pending = runRetire(invocation, "asst-42");
    lastChild.stderr.emit("data", Buffer.from("retire failed"));
    lastChild.emit("close", 1);

    expect(await pending).toEqual({
      ok: false,
      status: 500,
      error: "retire failed",
    });
  });

  test("a non-zero exit falls back to stdout when stderr is empty", async () => {
    const pending = runRetire(invocation, "asst-42");
    lastChild.stdout.emit("data", Buffer.from("assistant not found"));
    lastChild.emit("close", 2);

    expect(await pending).toEqual({
      ok: false,
      status: 500,
      error: "assistant not found",
    });
  });

  test("a spawn failure resolves to a failure rather than rejecting", async () => {
    const pending = runRetire(invocation, "asst-42");
    lastChild.emit("error", new Error("ENOENT"));

    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.error).toContain("Failed to spawn CLI");
      expect(result.error).toContain("ENOENT");
    }
  });

  test("resolves at most once when the child emits close after error", async () => {
    const pending = runRetire(invocation, "asst-42");
    lastChild.emit("close", 0);
    lastChild.emit("error", new Error("late EPIPE"));

    expect(await pending).toEqual({ ok: true });
  });
});
