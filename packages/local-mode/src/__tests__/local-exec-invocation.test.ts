import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ensureLocalBinShims } from "../remotes/local/common";

// The bin/ folder is the contract: exec prepends it to the child's PATH, so
// EVERY invocation shape — argv, compound commands, pipes, shell scripts —
// resolves the cadet binaries to the source build the daemons run, never a
// globally installed published build from the host PATH. These tests pin the
// shim contents: each binary's entry point must match its package's own bin.
// In a checkout with no runtime install, resolution falls through to the
// repo-root source tree — four levels up from this __tests__ dir.
const repoRoot = join(import.meta.dir, "..", "..", "..", "..");

describe("ensureLocalBinShims", () => {
  let instanceDir: string;

  beforeEach(() => {
    instanceDir = join(
      tmpdir(),
      `cadet-bin-shims-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(instanceDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(instanceDir, { recursive: true, force: true });
    } catch {
      // best-effort — a leaked temp dir is harmless
    }
  });

  function entry() {
    return {
      assistantId: "shim-test",
      cloud: "local" as const,
      port: 7821,
      instanceDir,
    };
  }

  function shimBody(name: string): string {
    return readFileSync(join(instanceDir, "bin", name), "utf-8");
  }

  test("writes executable shims for every cadet binary", () => {
    const { dir, unresolved } = ensureLocalBinShims(entry());
    expect(unresolved).toEqual([]);
    expect(dir).toBe(join(instanceDir, "bin"));
    for (const name of ["assistant", "gateway", "ces"]) {
      const mode = statSync(join(dir, name)).mode & 0o111;
      expect(mode).not.toBe(0);
    }
  });

  test("assistant shim runs its own bin entry from source", () => {
    ensureLocalBinShims(entry());
    expect(shimBody("assistant")).toContain(
      join(repoRoot, "assistant", "src", "index.ts"),
    );
  });

  test("gateway shim runs the CLI entry, not the server entry", () => {
    // `gateway`'s bin is src/cli/index.ts; src/index.ts is the server entry
    // startGateway spawns — the shim must never boot a second server.
    ensureLocalBinShims(entry());
    expect(shimBody("gateway")).toContain(
      join(repoRoot, "gateway", "src", "cli", "index.ts"),
    );
  });

  test("ces shim runs its CLI entry", () => {
    ensureLocalBinShims(entry());
    expect(shimBody("ces")).toContain(
      join(repoRoot, "credential-executor", "src", "cli.ts"),
    );
  });

  test("a runtime install outranks the source tree", () => {
    // The instance's newest self-managed runtime install is what the daemon
    // stack runs — the shims must bake THAT path, not the checkout's.
    const runtimeDir = join(instanceDir, "runtime", "001");
    const fakeIndex = join(
      runtimeDir,
      "node_modules",
      "@mycadet",
      "assistant",
      "src",
      "index.ts",
    );
    mkdirSync(
      join(runtimeDir, "node_modules", "@mycadet", "assistant", "src"),
      {
        recursive: true,
      },
    );
    writeFileSync(fakeIndex, "export {};\n");
    chmodSync(fakeIndex, 0o644);
    ensureLocalBinShims(entry());
    expect(shimBody("assistant")).toContain(fakeIndex);
  });

  test("shims exec through bun with run", () => {
    ensureLocalBinShims(entry());
    for (const name of ["assistant", "gateway", "ces"]) {
      const body = shimBody(name);
      expect(body.startsWith("#!/bin/sh")).toBe(true);
      expect(body).toContain(" run ");
      expect(body.trimEnd().endsWith('"$@"')).toBe(true);
    }
  });
});
