/**
 * Tests for `conversation-mode-store.ts`, the memory plugin's per-conversation
 * injection mode:
 *   - default `"standard"` for a conversation with no row (and for a missing
 *     conversation id), so a degraded read never silences memory;
 *   - `set`/`get` round-trip, re-set overwriting, and unknown-mode rejection;
 *   - `list` returning explicit rows newest-first;
 *   - fail-soft: an unavailable memory database resolves `"standard"` on read
 *     and reports failure on write rather than throwing.
 *
 * The memory connection is stubbed to an in-memory DB exactly like
 * `../v3/ever-injected-store.test.ts` — `mock.module` is process-global, so
 * the stub delegates to the real implementation unless this test is running
 * (`storeMockActive` toggled in beforeEach/afterAll).
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  CONVERSATION_MEMORY_MODES_TABLE,
  getConversationMemoryMode,
  isMemoryInjectionOff,
  listConversationMemoryModes,
  setConversationMemoryMode,
} from "../conversation-mode-store.js";
import { ensureOncePerConnection } from "../v3/plugin-schema.js";

const realDb = {
  ...(await import("../../../../persistence/db-connection.js")),
};

let storeMockActive = false;
let memoryDbAvailable = true;

let memorySqlite: Database;
function makeDb() {
  memorySqlite = new Database(":memory:");
}

// The store ensures its own schema idempotently — run the same ensure the
// production store runs so the in-memory db carries the table.
const ensureTable = ensureOncePerConnection(
  (raw) => {
    raw.run(`CREATE TABLE IF NOT EXISTS ${CONVERSATION_MEMORY_MODES_TABLE} (
      conversation_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'standard',
      updated_at INTEGER NOT NULL
    )`);
  },
  "test ensure failed",
);

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

  test("list returns the explicit rows", () => {
    setConversationMemoryMode("conv-a", "off");
    setConversationMemoryMode("conv-b", "standard");
    const rows = listConversationMemoryModes();
    // Same-millisecond writes make updated_at ties possible, so the recency
    // order between the two rows is not deterministic — compare as a set.
    expect(
      rows.map((r) => [r.conversationId, r.mode]).sort((a, b) => a[0].localeCompare(b[0])),
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
