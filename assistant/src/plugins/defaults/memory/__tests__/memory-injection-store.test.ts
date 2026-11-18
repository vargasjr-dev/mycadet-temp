/**
 * Tests for `memory-injection-store.ts`, the memory plugin's per-conversation
 * memory-injection opt-out. They run on the REAL memory connection — each
 * test points `CADET_WORKSPACE_DIR` at a fresh tmp dir (the same seam the
 * lint pin asks for instead of `mock.module`), so the store opens its own
 * `assistant-memory.db` and exercises its real ensure, reads, and writes.
 *
 *   - injection defaults on for a conversation with no flag (and for a
 *     missing conversation id), so a degraded read never silences memory;
 *   - disable/enable round-trip through `isMemoryInjectionOff`;
 *   - the flag riding the host table's per-conversation row (an existing
 *     activation marker row is updated in place, not duplicated; an opt-out
 *     on a fresh conversation stamps a marker row);
 *   - `list` returning exactly the opted-out conversations;
 *   - fail-soft: an unopenable memory database resolves on-read and reports
 *     failure on write rather than throwing.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  getMemorySqlite,
  resetDb,
} from "../../../../persistence/db-connection.js";
import {
  isMemoryInjectionOff,
  listMemoryInjectionOffConversations,
  setMemoryInjectionOff,
} from "../memory-injection-store.js";

let testDir: string;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `memory-injection-store-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  process.env.CADET_WORKSPACE_DIR = testDir;
});

afterEach(() => {
  // Drop the memoized memory connection before its file goes away.
  resetDb();
  rmSync(testDir, { recursive: true, force: true });
});

describe("memory injection store", () => {
  test("injection defaults on for unknown conversations and missing ids", () => {
    expect(isMemoryInjectionOff("conv-a")).toBe(false);
    expect(isMemoryInjectionOff(undefined)).toBe(false);
    expect(isMemoryInjectionOff(null)).toBe(false);
  });

  test("disable/enable round-trip", () => {
    expect(setMemoryInjectionOff("conv-a", true)).toBe(true);
    expect(isMemoryInjectionOff("conv-a")).toBe(true);

    expect(setMemoryInjectionOff("conv-a", false)).toBe(true);
    expect(isMemoryInjectionOff("conv-a")).toBe(false);
  });

  test("the flag rides the host activation-sessions row, not a table of its own", () => {
    // The store ensures its own schema; touch it once so the db carries the
    // host table before the direct inserts below.
    expect(isMemoryInjectionOff("conv-a")).toBe(false);
    // A conversation that already has an activation marker row keeps it —
    // only the flag column moves.
    getMemorySqlite()
      ?.query(
        "INSERT INTO activation_sessions (conversation_id, created_at) VALUES (?, ?)",
      )
      .run("conv-a", 1234);
    expect(setMemoryInjectionOff("conv-a", true)).toBe(true);
    const rows = getMemorySqlite()
      ?.query(
        "SELECT conversation_id, memory_injection_off FROM activation_sessions",
      )
      .all() as Array<{
      conversation_id: string;
      memory_injection_off: number | null;
    }>;
    expect(rows).toEqual([
      { conversation_id: "conv-a", memory_injection_off: 1 },
    ]);

    // A conversation with no marker row gets one, stamped now.
    expect(setMemoryInjectionOff("conv-b", false)).toBe(true);
    const created = getMemorySqlite()
      ?.query(
        "SELECT created_at FROM activation_sessions WHERE conversation_id = ?",
      )
      .get("conv-b") as { created_at: number };
    expect(created.created_at).toBeGreaterThan(0);
  });

  test("list returns exactly the opted-out conversations", () => {
    setMemoryInjectionOff("conv-a", true);
    setMemoryInjectionOff("conv-b", false);
    setMemoryInjectionOff("conv-c", true);
    expect(listMemoryInjectionOffConversations().sort()).toEqual([
      "conv-a",
      "conv-c",
    ]);
  });

  test("an unopenable memory database degrades: on-read, false on write", () => {
    // Point the workspace under a regular file, so opening
    // `<workspace>/data/db/assistant-memory.db` fails with ENOTDIR and the
    // connection resolves null — the real degraded path.
    const blocker = join(
      tmpdir(),
      `memory-injection-blocker-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    writeFileSync(blocker, "not a directory");
    process.env.CADET_WORKSPACE_DIR = join(blocker, "workspace");
    try {
      expect(isMemoryInjectionOff("conv-x")).toBe(false);
      expect(setMemoryInjectionOff("conv-x", true)).toBe(false);
      expect(listMemoryInjectionOffConversations()).toEqual([]);
    } finally {
      rmSync(blocker, { force: true });
    }
  });
});
