import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { resolveLocalCommandInvocation } from "../remotes/local/common";

// These tests run from a source checkout, where the resolvers fall through
// to the repo-root candidates — so the assertions pin the exact entry
// points each package's own bin uses. That mapping is the contract: exec
// must run the same build the daemon stack runs, never a host-PATH shim.
const repoRoot = join(import.meta.dir, "..", "..", "..", "..");

function expectSource(name: string, entryPath: string): void {
  const resolution = resolveLocalCommandInvocation(name);
  expect(resolution.kind).toBe("source");
  if (resolution.kind !== "source") return;
  expect(resolution.command.endsWith("bun")).toBe(true);
  expect(resolution.args[0]).toBe("run");
  expect(resolution.args[1]).toBe(join(repoRoot, entryPath));
}

describe("resolveLocalCommandInvocation", () => {
  test("assistant runs its own bin entry from source", () => {
    expectSource("assistant", "assistant/src/index.ts");
  });

  test("gateway runs the CLI entry, not the server entry", () => {
    // `gateway`'s bin is src/cli/index.ts; src/index.ts is the server entry
    // startGateway spawns — exec must not boot a second server.
    expectSource("gateway", "gateway/src/cli/index.ts");
  });

  test("ces runs its CLI entry from source", () => {
    expectSource("ces", "credential-executor/src/cli.ts");
  });

  test("credential-executor runs its main entry from source", () => {
    expectSource("credential-executor", "credential-executor/src/main.ts");
  });

  test("non-cadet commands stay on the host PATH", () => {
    expect(resolveLocalCommandInvocation("ls").kind).toBe("path");
    expect(resolveLocalCommandInvocation("cat").kind).toBe("path");
    expect(resolveLocalCommandInvocation("git").kind).toBe("path");
  });
});
