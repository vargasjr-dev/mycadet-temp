import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

import type { CliInvocation } from "../util";
import { FakeChild, mockChildProcessSpawn } from "./helpers/child-process-mock";

let lastChild: FakeChild;
const spawnArgs: Array<[string, string[]]> = [];
const spawnMock = mock((command: string, args: string[]) => {
  spawnArgs.push([command, args]);
  lastChild = new FakeChild();
  return lastChild;
});

await mockChildProcessSpawn(spawnMock);

let runSleep: typeof import("../sleep").runSleep;

beforeAll(async () => {
  ({ runSleep } = await import("../sleep"));
});

afterEach(() => {
  spawnArgs.length = 0;
  spawnMock.mockClear();
});

const invocation: CliInvocation = { command: "bun", baseArgs: ["run", "cli"] };

describe("runSleep", () => {
  test("spawns the CLI sleep command with --force and resolves ok on exit 0", async () => {
    const pending = runSleep(invocation, "asst-42");
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true });
    expect(spawnArgs[0]).toEqual([
      "bun",
      ["run", "cli", "sleep", "asst-42", "--force"],
    ]);
  });

  test("spawns the assistant's own sleep command, not another entry's", async () => {
    const pending = runSleep(invocation, "local-1");
    lastChild.emit("close", 0);

    await pending;
    expect(spawnArgs[0]?.[1]).toContain("local-1");
    expect(spawnArgs.filter(([, args]) => args.includes("asst-42"))).toEqual(
      [],
    );
  });

  test("a non-zero exit resolves to a failure carrying the CLI's stderr", async () => {
    const pending = runSleep(invocation, "asst-42");
    lastChild.stderr.emit(
      "data",
      Buffer.from("no sibling environment to seed from"),
    );
    lastChild.emit("close", 1);

    expect(await pending).toEqual({
      ok: false,
      status: 500,
      error: "no sibling environment to seed from",
    });
  });

  test("a non-zero exit falls back to stdout when stderr is empty", async () => {
    const pending = runSleep(invocation, "asst-42");
    lastChild.stdout.emit("data", Buffer.from("daemon stop failed"));
    lastChild.emit("close", 3);

    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.error).toBe("daemon stop failed");
    }
  });

  test("a spawn failure resolves to a failure rather than rejecting", async () => {
    const pending = runSleep(invocation, "asst-42");
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
    const pending = runSleep(invocation, "asst-42");
    lastChild.emit("close", 0);
    lastChild.emit("error", new Error("late EPIPE"));

    expect(await pending).toEqual({ ok: true });
  });

  test("passes the invocation through untouched so hosts keep their own entry", async () => {
    const custom: CliInvocation = { command: "node", baseArgs: ["cli.mjs"] };
    const pending = runSleep(custom, "asst-42");
    lastChild.emit("close", 0);

    await pending;
    expect(spawnArgs[0]).toEqual([
      "node",
      ["cli.mjs", "sleep", "asst-42", "--force"],
    ]);
  });
});
