import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

import { configureCliPaths } from "../cli-invocation";
import { FakeChild, mockChildProcessSpawn } from "./helpers/child-process-mock";

let lastChild: FakeChild;
const spawnArgs: Array<[string, string[]]> = [];
const spawnMock = mock((command: string, args: string[]) => {
  spawnArgs.push([command, args]);
  lastChild = new FakeChild();
  return lastChild;
});

await mockChildProcessSpawn(spawnMock);

let wakeLocalServices: typeof import("../remotes/local/wake").wakeLocalServices;

beforeAll(async () => {
  ({ wakeLocalServices } = await import("../remotes/local/wake"));
});

afterEach(() => {
  spawnArgs.length = 0;
  spawnMock.mockClear();
});

// The inlined resolution probes the configured dev entry: `bun run cli`,
// the same invocation shape these assertions have always expected.
configureCliPaths({ devEntry: () => "cli" });

describe("the local wake leg", () => {
  test("spawns the CLI wake command for the assistant and resolves ok on exit 0", async () => {
    const pending = wakeLocalServices({ assistantId: "asst-42", cloud: "local", port: 7830 } as never);
    // The resolution is async now: let the spawn land before driving the child.
    await new Promise((r) => setImmediate(r));
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true });
    expect(spawnArgs[0]).toEqual(["bun", ["run", "cli", "wake", "asst-42"]]);
  });

  test("a non-zero exit resolves to a failure carrying the CLI's output", async () => {
    const pending = wakeLocalServices({ assistantId: "asst-42", cloud: "local", port: 7830 } as never);
    // The resolution is async now: let the spawn land before driving the child.
    await new Promise((r) => setImmediate(r));
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

  test("a spawn failure resolves to a failure rather than rejecting", async () => {
    const pending = wakeLocalServices({ assistantId: "asst-42", cloud: "local", port: 7830 } as never);
    // The resolution is async now: let the spawn land before driving the child.
    await new Promise((r) => setImmediate(r));
    lastChild.emit("error", new Error("ENOENT"));

    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ENOENT");
    }
  });
});
