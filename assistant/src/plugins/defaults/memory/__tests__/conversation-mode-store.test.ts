/**
 * Tests for `conversation-mode-store.ts`, the memory plugin's per-conversation
 * injection mode (a `memory_mode` column on the memory connection's
 * `activation_sessions` row):
 *   - default `"standard"` for a conversation with no row (and for a missing
 *     conversation id), so a degraded read never silences memory;
 *   - `set`/`get` round-trip, re-set overwriting, and unknown-mode rejection;
 *   - the mode riding the host table's per-conversation row (an existing
 *     activation marker row is updated in place, not duplicated);
 *   - `list` returning explicit rows;
 *   - fail-soft: an unavailable memory database resolves `"standard"` on read
 *     and reports failure on write rather than throwing.
 *
 * The memory connection is stubbed to an in-memory DB exactly like
 * `../v3/ever-injected-store.test.ts` — `mock.module` is process-global, so
 * the stub delegates to the real implementation unless this test is running
 * (`storeMockActive` toggled in beforeEach/afterAll). The store ensures its
 * own schema idempotently, so the bare in-memory db is enough.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  getConversationMemoryMode,
  isMemoryInjectionOff,
  listConversationMemoryModes,
  setConversationMemoryMode,
} from "../conversation-mode-store.js";

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
        ? memorySqlite
        : null
      : realDb.getMemoryDb(),
}));

describe("conversation memory mode store", () => {
  beforeEach(() => {
    storeMockActive = true;
    memoryDbAvailable = true;
    makeDb();
  });

  afterAll(() => {
    storeMockActive = false;
  });

  test("defaults to standard for unknown conversations and missing ids", () => {
    expect(getConversationMemoryMode("conv-a")).toBe("standard");
    expect(isMemoryInjectionOff("conv-a")).toBe(false);
    expect(getConversationMemoryMode(undefined)).toBe("standard");
    expect(getConversationMemoryMode(null)).toBe("standard");
  });

  test("set/get round-trip and re-set overwrite", () => {
    expect(setConversationMemoryMode("conv-a", "off")).toBe(true);
    expect(getConversationMemoryMode("conv-a")).toBe("off");
    expect(isMemoryInjectionOff("conv-a")).toBe(true);

    expect(setConversationMemoryMode("conv-a", "standard")).toBe(true);
    expect(getConversationMemoryMode("conv-a")).toBe("standard");
    expect(isMemoryInjectionOff("conv-a")).toBe(false);
  });

  test("rejects unknown mode values without writing a row", () => {
    expect(
      setConversationMemoryMode(
        "conv-a",
        "silenced" as ConversationMemoryModeLike,
      ),
    ).toBe(false);
    expect(listConversationMemoryModes()).toEqual([]);
  });

  test("the mode rides the host activation-sessions row, not a table of its own", () => {
    // The store ensures its own schema; touch it once so the bare in-memory
    // db carries the host table before the direct inserts below.
    expect(getConversationMemoryMode("conv-a")).toBe("standard");
    // A conversation that already has an activation marker row keeps it —
    // only the mode column moves.
    memorySqlite
      .query(
        "INSERT INTO activation_sessions (conversation_id, created_at) VALUES (?, ?)",
      )
      .run("conv-a", 1234);
    expect(setConversationMemoryMode("conv-a", "off")).toBe(true);
    const rows = memorySqlite
      .query("SELECT conversation_id, memory_mode FROM activation_sessions")
      .all() as Array<{ conversation_id: string; memory_mode: string | null }>;
    expect(rows).toEqual([{ conversation_id: "conv-a", memory_mode: "off" }]);

    // A conversation with no marker row gets one, stamped now.
    expect(setConversationMemoryMode("conv-b", "standard")).toBe(true);
    const created = memorySqlite
      .query("SELECT created_at FROM activation_sessions WHERE conversation_id = ?")
      .get("conv-b") as { created_at: number };
    expect(created.created_at).toBeGreaterThan(0);
  });

  test("list returns the explicit rows", () => {
    setConversationMemoryMode("conv-a", "off");
    setConversationMemoryMode("conv-b", "standard");
    // Same-millisecond writes make created_at ties possible, so the recency
    // order between the two rows is not deterministic — compare as a set.
    expect(
      listConversationMemoryModes()
        .map((r) => [r.conversationId, r.mode])
        .sort((a, b) => a[0].localeCompare(b[0])),
    ).toEqual([
      ["conv-a", "off"],
      ["conv-b", "standard"],
    ]);
  });

  test("an unavailable memory database degrades: standard on read, false on write", () => {
    memoryDbAvailable = false;
    expect(getConversationMemoryMode("conv-a")).toBe("standard");
    expect(isMemoryInjectionOff("conv-a")).toBe(false);
    expect(setConversationMemoryMode("conv-a", "off")).toBe(false);
    expect(listConversationMemoryModes()).toEqual([]);
  });
});

// A type-only alias so the unknown-mode rejection test can pass an invalid
// value without widening the store's public signature.
type ConversationMemoryModeLike = Parameters<typeof setConversationMemoryMode>[1];
