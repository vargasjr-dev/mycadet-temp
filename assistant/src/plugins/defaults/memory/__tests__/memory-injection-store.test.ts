/**
 * Tests for `memory-injection-store.ts`, the memory plugin's per-conversation
 * memory-injection opt-out (a flag on the memory connection's
 * `activation_sessions` row):
 *   - injection defaults on for a conversation with no flag (and for a
 *     missing conversation id), so a degraded read never silences memory;
 *   - disable/enable round-trip through `isMemoryInjectionOff`;
 *   - the flag riding the host table's per-conversation row (an existing
 *     activation marker row is updated in place, not duplicated; an opt-out
 *     on a fresh conversation stamps a marker row);
 *   - `list` returning exactly the opted-out conversations;
 *   - fail-soft: an unavailable memory database resolves on-read and reports
 *     failure on write rather than throwing.
 *
 * The memory connection is stubbed to an in-memory DB wrapped in a real
 * drizzle handle exactly like `../v3/ever-injected-store.test.ts` —
 * `mock.module` is process-global, so the stub delegates to the real
 * implementation unless this test is running (`storeMockActive`, toggled in
 * beforeEach/afterAll). The store ensures its own schema idempotently, so
 * the bare in-memory db is enough.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../../../../persistence/schema/index.js";

const realDb = {
  ...(await import("../../../../persistence/db-connection.js")),
};

let storeMockActive = false;
let memoryDbAvailable = true;

let memorySqlite: Database;
function makeDb() {
  memorySqlite = new Database(":memory:");
}

mock.module("../../../../persistence/db-connection.js", () => ({
  ...realDb,
  getMemorySqlite: () =>
    storeMockActive
      ? memoryDbAvailable
        ? memorySqlite
        : null
      : realDb.getMemorySqlite(),
  getMemoryDb: () =>
    storeMockActive
      ? memoryDbAvailable
        ? drizzle(memorySqlite, { schema })
        : null
      : realDb.getMemoryDb(),
}));

const {
  isMemoryInjectionOff,
  listMemoryInjectionOffConversations,
  setMemoryInjectionOff,
} = await import("../memory-injection-store.js");

describe("memory injection store", () => {
  beforeEach(() => {
    storeMockActive = true;
    memoryDbAvailable = true;
    makeDb();
  });

  afterAll(() => {
    storeMockActive = false;
  });

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
    // The store ensures its own schema; touch it once so the bare in-memory
    // db carries the host table before the direct inserts below.
    expect(isMemoryInjectionOff("conv-a")).toBe(false);
    // A conversation that already has an activation marker row keeps it —
    // only the flag column moves.
    memorySqlite
      .query(
        "INSERT INTO activation_sessions (conversation_id, created_at) VALUES (?, ?)",
      )
      .run("conv-a", 1234);
    expect(setMemoryInjectionOff("conv-a", true)).toBe(true);
    const rows = memorySqlite
      .query(
        "SELECT conversation_id, memory_injection_off FROM activation_sessions",
      )
      .all() as Array<{
      conversation_id: string;
      memory_injection_off: number | null;
    }>;
    expect(rows).toEqual([{ conversation_id: "conv-a", memory_injection_off: 1 }]);

    // A conversation with no marker row gets one, stamped now.
    expect(setMemoryInjectionOff("conv-b", false)).toBe(true);
    const created = memorySqlite
      .query("SELECT created_at FROM activation_sessions WHERE conversation_id = ?")
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

  test("an unavailable memory database degrades: on-read, false on write", () => {
    memoryDbAvailable = false;
    expect(isMemoryInjectionOff("conv-a")).toBe(false);
    expect(setMemoryInjectionOff("conv-a", true)).toBe(false);
    expect(listMemoryInjectionOffConversations()).toEqual([]);
  });
});
