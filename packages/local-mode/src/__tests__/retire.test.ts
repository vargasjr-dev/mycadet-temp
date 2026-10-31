import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

import { configureCliPaths } from "../cli-invocation";
import { FakeChild, mockChildProcessSpawn } from "./helpers/child-process-mock";

let lastChild: FakeChild;
const spawnArgs: Array<
  [
    string,
    string[],
    { env?: NodeJS.ProcessEnv; stdio?: unknown; windowsHide?: boolean },
  ]
> = [];
const spawnMock = mock(
  (
    command: string,
    args: string[],
    options: {
      env?: NodeJS.ProcessEnv;
      stdio?: unknown;
      windowsHide?: boolean;
    },
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

// The inlined resolution probes the configured dev entry: `bun run cli`,
// the same invocation shape these assertions have always expected.
configureCliPaths({ devEntry: () => "cli" });

describe("runRetire", () => {
  test("spawns the CLI retire command", async () => {
    const pending = runRetire("asst-42");
    // The resolution is async now: let the spawn land before driving the child.
    await new Promise((r) => setImmediate(r));
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true });
    expect(spawnArgs[0]).toEqual([
      "bun",
      ["run", "cli", "retire", "asst-42", "--yes"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    ]);
  });

  test("passes a host platform token to the CLI subprocess", async () => {
    const pending = runRetire("asst-42", {
      cloudToken: "session-token",
    });
    // The resolution is async now: let the spawn land before driving the child.
    await new Promise((r) => setImmediate(r));
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true });
    expect(spawnArgs[0]?.[2].env?.CADET_PLATFORM_TOKEN).toBe("session-token");
    expect(process.env.CADET_PLATFORM_TOKEN).toBeUndefined();
  });

  test("a non-zero exit resolves to a failure carrying the CLI output", async () => {
    const pending = runRetire("asst-42");
    // The resolution is async now: let the spawn land before driving the child.
    await new Promise((r) => setImmediate(r));
    lastChild.stderr.emit("data", Buffer.from("retire failed"));
    lastChild.emit("close", 1);

    expect(await pending).toEqual({
      ok: false,
      status: 500,
      error: "retire failed",
    });
  });
});
