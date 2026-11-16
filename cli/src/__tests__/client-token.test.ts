/**
 * Tests for `cadet client`'s arg parsing: the assistant comes from the
 * positional name or the active assistant — there is no --url/--token escape
 * hatch. What remains overridable is the assistant id segment.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// NB: do NOT mock.module("../lib/guardian-token.js") here — that mock is
// process-global in Bun and leaks into other test files (it dropped the
// module's other exports and broke guardian-token-paths / setup suites in CI).

const testDir = mkdtempSync(join(tmpdir(), "client-token-test-"));
const ORIGINAL_XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
const ORIGINAL_ARGV = [...process.argv];

import { parseArgs } from "../commands/client.js";
import { saveLockfileAssistant } from "@mycadet/local-mode";

// A clearly non-local recorded host so getGatewayUrl yields a remote URL
// and the test pins that the runtime URL comes from the ENTRY, not flags.
const ENTRY = {
  assistantId: "remote-xyz",
  name: "Remote Pal",
  cloud: "custom" as const,
  ipAddress: "192.0.2.50",
  port: 7830,
};

describe("client arg parsing", () => {
  beforeEach(() => {
    process.env.XDG_CONFIG_HOME = testDir;
    saveLockfileAssistant(ENTRY);
  });

  afterEach(() => {
    process.argv = [...ORIGINAL_ARGV];
    if (ORIGINAL_XDG_CONFIG_HOME === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = ORIGINAL_XDG_CONFIG_HOME;
    }
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("the runtime URL and bearer come from the entry's persisted state", () => {
    process.argv = ["bun", "cadet", "client", "Remote Pal"];
    const parsed = parseArgs();

    expect(parsed.runtimeUrl).toBe("https://192.0.2.50:7830");
    expect(parsed.assistantId).toBe("remote-xyz");
    expect(parsed.assistantName).toBe("Remote Pal");
    // No stored guardian token was seeded, so no bearer is invented.
    expect(parsed.bearerToken).toBeUndefined();
    expect(parsed.cloudToken).toBeUndefined();
  });

  test("--assistant-id overrides the entry's id segment", () => {
    process.argv = [
      "bun",
      "cadet",
      "client",
      "Remote Pal",
      "--assistant-id",
      "remote-abc",
    ];
    const parsed = parseArgs();
    expect(parsed.assistantId).toBe("remote-abc");
    expect(parsed.assistantName).toBeUndefined();
  });
});
