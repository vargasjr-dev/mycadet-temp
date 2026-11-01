import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  clearRootProcess,
  readAppBuiltSha,
  readRootProcesses,
  stampAppBuiltSha,
  stampRootProcess,
} from "../lib/assistant-config.js";
import { clearAppProcessRecord } from "@mycadet/local-mode";

// Create a temp directory and set XDG_CONFIG_HOME so the real lockfile
// helpers resolve inside it (the sleep.test.ts fixture pattern).
let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "cadet-root-process-test-"));
  mkdirSync(join(testDir, "config"), { recursive: true });
  process.env.XDG_CONFIG_HOME = join(testDir, "config");
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  rmSync(testDir, { recursive: true, force: true });
});

describe("root process lockfile entries", () => {
  test("a tunnel record stamps at the root, reads back, and clears", () => {
    stampRootProcess("tunnel", {
      pid: 4242,
      provider: "ngrok",
      startedAt: "2026-10-11T00:00:00.000Z",
    });

    expect(readRootProcesses().tunnel).toMatchObject({
      pid: 4242,
      provider: "ngrok",
    });

    clearRootProcess("tunnel");
    expect(readRootProcesses().tunnel).toBeUndefined();
  });

  test("tunnel and app entries stamp and clear independently", () => {
    stampRootProcess("app", {
      pid: 77,
      port: 7841,
      startedAt: "2026-10-11T00:00:00.000Z",
    });
    stampRootProcess("tunnel", {
      pid: 78,
      provider: "cloudflare",
      startedAt: "2026-10-11T00:00:00.000Z",
    });

    expect(readRootProcesses().app?.pid).toBe(77);
    expect(readRootProcesses().tunnel?.provider).toBe("cloudflare");

    clearRootProcess("app");
    expect(readRootProcesses().app).toBeUndefined();
    // The sibling entry survives.
    expect(readRootProcesses().tunnel?.pid).toBe(78);
  });

  test("the records live at the lockfile root under their kind keys", () => {
    stampRootProcess("app", { pid: 1, port: 7841, startedAt: "t" });

    const raw = z
      .object({
        app: z.object({ pid: z.number(), startedAt: z.string() }),
      })
      .parse(
        JSON.parse(
          readFileSync(
            join(process.env.XDG_CONFIG_HOME!, "cadet", "lockfile.json"),
            "utf-8",
          ),
        ),
      );
    expect(raw.app).toEqual({ pid: 1, startedAt: "t" });
  });

  test("clearing an absent entry is a no-op", () => {
    clearRootProcess("tunnel");
    expect(readRootProcesses()).toEqual({});
  });
});

describe("the app entry's built-sha stamp", () => {
  test("a stamp with no edge record is a no-op", () => {
    stampAppBuiltSha("a".repeat(40));
    // The stamp rides the edge's record: nothing to carry it, nothing lands.
    expect(readAppBuiltSha()).toBeUndefined();
    expect(readRootProcesses()).toEqual({});
  });

  test("clearing the edge's process entry takes its built-sha stamp with it", () => {
    stampRootProcess("app", { pid: 5, port: 7841, startedAt: "t" });
    stampAppBuiltSha("b".repeat(40));
    expect(readAppBuiltSha()).toBe("b".repeat(40));

    clearAppProcessRecord();
    // Record and stamp go together: the next resolve rebuilds.
    expect(readRootProcesses()).toEqual({});
    expect(readAppBuiltSha()).toBeUndefined();
  });
});
