import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { isLoopbackAddr, resolveDevCliInvocation, stripSensitiveFields } from "../util";

describe("stripSensitiveFields", () => {
  test("drops sensitive keys from assistants and their resources", () => {
    const data: Record<string, unknown> = {
      assistants: [
        {
          assistantId: "a-1",
          signingKey: "secret",
          bearerToken: "secret",
          guardianBootstrapSecret: "secret",
          resources: { instanceDir: "/x", signingKey: "secret" },
        },
      ],
    };
    stripSensitiveFields(data);
    const entry = (data.assistants as Array<Record<string, unknown>>)[0]!;
    for (const key of ["signingKey", "bearerToken", "guardianBootstrapSecret"]) {
      expect(key in entry).toBe(false);
      expect(key in (entry.resources as Record<string, unknown>)).toBe(false);
    }
    expect(entry.assistantId).toBe("a-1");
    expect(entry.resources).toEqual({ instanceDir: "/x" });
  });

  test("leaves non-array or absent assistants untouched", () => {
    const weird: Record<string, unknown> = { assistants: "not-an-array" };
    stripSensitiveFields(weird);
    expect(weird.assistants).toBe("not-an-array");

    const empty: Record<string, unknown> = {};
    stripSensitiveFields(empty);
    expect(empty).toEqual({});
  });

  test("skips non-object assistant entries without throwing", () => {
    const data: Record<string, unknown> = { assistants: [null, "x", 3] };
    expect(() => stripSensitiveFields(data)).not.toThrow();
  });
});

describe("isLoopbackAddr", () => {
  test.each(["127.0.0.1", "127.255.0.9", "::1"])(
    "accepts loopback address %p",
    (addr) => {
      expect(isLoopbackAddr(addr)).toBe(true);
    },
  );

  test.each(["::ffff:127.0.0.1"])(
    "accepts a v4-mapped loopback address (%p)",
    (addr) => {
      expect(isLoopbackAddr(addr)).toBe(true);
    },
  );

  test.each([
    "192.168.1.4",
    "10.0.0.3",
    "0.0.0.0",
    "::2",
    "::ffff:192.168.0.9",
    "::ffff:10.0.0.3",
    "example.com",
  ])("rejects non-loopback address %p", (addr) => {
    expect(isLoopbackAddr(addr)).toBe(false);
  });
});

describe("resolveDevCliInvocation", () => {
  test("runs the CLI from the monorepo source tree via bun", () => {
    const repoRoot = join(import.meta.dirname, "../../../..");
    const invocation = resolveDevCliInvocation(repoRoot, import.meta.url);
    expect(invocation.command).toBe("bun");
    expect(invocation.baseArgs[0]).toBe("run");
    expect(invocation.baseArgs[1]?.endsWith("cli/src/index.ts")).toBe(true);
  });

  test("resolves once per process — later calls return the same invocation", () => {
    // The module caches its resolution (documented in resolveCliPath), so a
    // second call with an unrelated baseDir must not re-resolve or throw.
    const invocation = resolveDevCliInvocation("/definitely/not/a/repo");
    expect(invocation.command).toBe("bun");
    expect(invocation.baseArgs[1]?.endsWith("cli/src/index.ts")).toBe(true);
  });
});
