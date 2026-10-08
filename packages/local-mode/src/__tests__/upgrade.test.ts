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

let runUpgrade: typeof import("../upgrade").runUpgrade;
let isValidReleaseVersion: typeof import("../upgrade").isValidReleaseVersion;

beforeAll(async () => {
  ({ runUpgrade, isValidReleaseVersion } = await import("../upgrade"));
});

afterEach(() => {
  spawnArgs.length = 0;
  spawnMock.mockClear();
});

const invocation: CliInvocation = { command: "bun", baseArgs: ["run", "cli"] };

describe("isValidReleaseVersion", () => {
  test("accepts release tags, staying lenient about semver shape", () => {
    for (const version of [
      "latest",
      "v1.2.3",
      "V1.2.3", // uppercase prefix
      "1.2.3",
      "1.2", // two-part
      "1.2.3.4", // four-part
      "0.6.0-staging.5",
      "1.2.3-rc.1+build.7",
    ]) {
      expect(isValidReleaseVersion(version)).toBe(true);
    }
  });

  test("rejects package specs and path-traversal input", () => {
    for (const version of [
      "npm:@attacker/evil@1.0.0",
      "https://evil.example/x.tgz",
      "git+https://evil.example/x.git",
      "github:attacker/cadet",
      "file:/tmp/evil",
      "../../../../tmp/evil",
      "1.2.3-..", // no consecutive dots (would be a traversal segment)
      "1.2.3-a..b",
      "..",
      "",
      "cadet@1.2.3",
    ]) {
      expect(isValidReleaseVersion(version)).toBe(false);
    }
  });
});

describe("runUpgrade", () => {
  test("spawns the CLI upgrade command for a release tag", async () => {
    const pending = runUpgrade(invocation, "asst-42", { version: "v1.2.3" });
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true });
    expect(spawnArgs[0]).toEqual([
      "bun",
      ["run", "cli", "upgrade", "asst-42", "--version", "v1.2.3"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    ]);
  });

  test("spawns the CLI upgrade command for --latest", async () => {
    const pending = runUpgrade(invocation, "asst-42", { latest: true });
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true });
    expect(spawnArgs[0]?.[1]).toEqual([
      "run",
      "cli",
      "upgrade",
      "asst-42",
      "--latest",
    ]);
  });

  test("rejects a malicious version without spawning", async () => {
    const result = await runUpgrade(invocation, "asst-42", {
      version: "npm:@attacker/evil@1.0.0",
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      error:
        "Invalid upgrade version 'npm:@attacker/evil@1.0.0': expected a release tag like v1.2.3 or 'latest'.",
    });
    expect(spawnArgs.length).toBe(0);
  });

  test("rejects a path-traversal version without spawning", async () => {
    const result = await runUpgrade(invocation, "asst-42", {
      version: "../../../../tmp/evil",
    });

    expect(result.ok).toBe(false);
    expect(spawnArgs.length).toBe(0);
  });

  test("parses an 'upgraded to' line from the CLI output into the result version", async () => {
    const pending = runUpgrade(invocation, "asst-42", { latest: true });
    lastChild.stdout.emit(
      "data",
      Buffer.from("Upgrading...\nUpgraded to v0.13.0 successfully"),
    );
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true, version: "v0.13.0" });
  });

  test("parses an 'Already on' line as the current version", async () => {
    const pending = runUpgrade(invocation, "asst-42", { latest: true });
    lastChild.stdout.emit("data", Buffer.from("Already on v0.13.0"));
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true, version: "v0.13.0" });
  });

  test("a clean exit without a parseable version still resolves ok", async () => {
    const pending = runUpgrade(invocation, "asst-42", { latest: true });
    lastChild.stdout.emit("data", Buffer.from("some unrelated output"));
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true });
  });

  test("a failed upgrade prefers stderr, then stdout, then a generic message", async () => {
    const pending = runUpgrade(invocation, "asst-42", { latest: true });
    lastChild.stderr.emit("data", Buffer.from("install failed"));
    lastChild.emit("close", 1);
    expect(await pending).toEqual({ ok: false, status: 500, error: "install failed" });

    const stdoutOnly = runUpgrade(invocation, "asst-42", { latest: true });
    lastChild.stdout.emit("data", Buffer.from("from stdout"));
    lastChild.emit("close", 1);
    expect(await stdoutOnly).toEqual({ ok: false, status: 500, error: "from stdout" });

    const silent = runUpgrade(invocation, "asst-42", { latest: true });
    lastChild.emit("close", null);
    expect(await silent).toEqual({
      ok: false,
      status: 500,
      error: "Upgrade failed: the CLI exited with code unknown and produced no output.",
    });
  });

  test("a spawn failure resolves to a failure rather than rejecting", async () => {
    const pending = runUpgrade(invocation, "asst-42");
    lastChild.emit("error", new Error("ENOENT"));

    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.error).toContain("Failed to spawn CLI");
    }
  });

  test("--force appends the flag to the CLI args", async () => {
    const pending = runUpgrade(invocation, "asst-42", { force: true });
    lastChild.emit("close", 0);

    await pending;
    expect(spawnArgs[0]?.[1]).toContain("--force");
  });
});
