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

let runWake: typeof import("../wake").runWake;

beforeAll(async () => {
  ({ runWake } = await import("../wake"));
});

afterEach(() => {
  spawnArgs.length = 0;
  spawnMock.mockClear();
});

// The inlined resolution probes the configured dev entry: `bun run cli`,
// the same invocation shape these assertions have always expected.
configureCliPaths({ devEntry: () => "cli" });

describe("runWake", () => {
  test("spawns the CLI wake command for the assistant and resolves ok on exit 0", async () => {
    const pending = runWake("asst-42");
    // The resolution is async now: let the spawn land before driving the child.
    await new Promise((r) => setImmediate(r));
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true });
    expect(spawnArgs[0]).toEqual(["bun", ["run", "cli", "wake", "asst-42"]]);
  });

  test("repairGuardian: true chains the gateway's own token re-lease after the wake", async () => {
    const pending = runWake("asst-42", { repairGuardian: true });
    // The resolution is async now: let the spawn land before driving the child.
    await new Promise((r) => setImmediate(r));
    lastChild.emit("close", 0); // wake completes...
    await Promise.resolve(); // the chain spawns the re-lease
    expect(spawnArgs[0]).toEqual(["bun", ["run", "cli", "wake", "asst-42"]]);

    lastChild.emit("close", 0); // the re-lease completes
    expect(await pending).toEqual({ ok: true });
    expect(spawnArgs[1]).toEqual([
      "bun",
      ["run", "cli", "gateway", "token", "refresh", "asst-42"],
    ]);
  });

  test("repairGuardian: false ends at the wake", async () => {
    const pending = runWake("asst-42", { repairGuardian: false });
    // The resolution is async now: let the spawn land before driving the child.
    await new Promise((r) => setImmediate(r));
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true });
    expect(spawnArgs[0]).toEqual(["bun", ["run", "cli", "wake", "asst-42"]]);
  });

  test("a non-zero exit resolves to a failure carrying the CLI's output", async () => {
    const pending = runWake("asst-42");
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
    const pending = runWake("asst-42");
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
