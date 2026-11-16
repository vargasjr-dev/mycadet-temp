import { getLogger } from "./logging.js";
import { type MemorySqlite, memorySqliteOrNull } from "./memory-db.js";
import { ensureOncePerConnection } from "./v3/plugin-schema.js";

const log = getLogger("conversation-mode-store");

/**
 * Per-conversation memory-injection mode, owned by the memory plugin.
 *
 * Backed by `conversation_memory_modes` on the dedicated memory connection
 * (`assistant-memory.db`) — plugin storage the same way the v3 stores are:
 * created idempotently by the plugin, never by the global migration chain,
 * and read fail-open. This is deliberately NOT a column on the main
 * `conversations` table: memory settings live inside the memory plugin,
 * decoupled from main-agent infrastructure.
 *
 * Semantics of `"off"`: the plugin injects no memory for this conversation —
 * no dynamic `<memory>`/section block (both the v2 activation engine and the
 * v3 orchestrator skip fresh retrieval), no static essentials/threads block,
 * no PKB context. Prior turns' already-cached blocks ride history untouched
 * (cache-stable, forward-looking), and engine-wide jobs (consolidation,
 * filing, retrospectives) are unchanged. `"standard"` is the default for any
 * conversation without a row.
 *
 * Engine-independent by construction: every engine's gate resolves the mode
 * from this store, so a future engine inherits the opt-out by asking it.
 */

export const CONVERSATION_MEMORY_MODES = ["standard", "off"] as const;

export type ConversationMemoryMode = (typeof CONVERSATION_MEMORY_MODES)[number];

export const CONVERSATION_MEMORY_MODES_TABLE = "conversation_memory_modes";

function ensure(memoryRaw: MemorySqlite): void {
  memoryRaw.run(
    `CREATE TABLE IF NOT EXISTS ${CONVERSATION_MEMORY_MODES_TABLE} (
      conversation_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'standard',
      updated_at INTEGER NOT NULL
    )`,
  );
}

const ensureOnce = ensureOncePerConnection(
  ensure,
  "conversation_memory_modes unavailable; per-conversation memory modes degraded to 'standard'",
);

function isMode(value: string | null | undefined): value is ConversationMemoryMode {
  return value === "standard" || value === "off";
}

/**
 * The conversation's memory-injection mode. Fail-open: an unavailable memory
 * database, a missing table, or any read error resolves `"standard"` — a
 * degraded read must never silence memory.
 */
export function getConversationMemoryMode(
  conversationId: string | null | undefined,
): ConversationMemoryMode {
  if (!conversationId) {
    return "standard";
  }
  const raw = memorySqliteOrNull("getConversationMemoryMode");
  if (!raw) {
    return "standard";
  }
  try {
    ensureOnce(raw);
    const row = raw
      .query(
        `SELECT mode FROM ${CONVERSATION_MEMORY_MODES_TABLE} WHERE conversation_id = ?`,
      )
      .get(conversationId) as { mode: string } | null;
    return row?.mode === "off" ? "off" : "standard";
  } catch (err) {
    log.warn(
      { err, conversationId },
      "Failed to read conversation memory mode; treating as standard",
    );
    return "standard";
  }
}

/** Whether the plugin should inject no memory for this conversation. */
export function isMemoryInjectionOff(
  conversationId: string | null | undefined,
): boolean {
  return getConversationMemoryMode(conversationId) === "off";
}

/**
 * Persist a conversation's mode. Unknown mode values are rejected (`false`)
 * rather than coerced, so a typo cannot silently re-enable memory.
 */
export function setConversationMemoryMode(
  conversationId: string,
  mode: ConversationMemoryMode,
): boolean {
  if (!isMode(mode)) {
    return false;
  }
  const raw = memorySqliteOrNull("setConversationMemoryMode");
  if (!raw) {
    log.warn(
      { conversationId },
      "memory database unavailable; conversation memory mode not persisted",
    );
    return false;
  }
  try {
    ensureOnce(raw);
    raw
      .query(
        `INSERT INTO ${CONVERSATION_MEMORY_MODES_TABLE} (conversation_id, mode, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
      )
      .run(conversationId, mode, Date.now());
    return true;
  } catch (err) {
    log.warn({ err, conversationId, mode }, "Failed to persist conversation memory mode");
    return false;
  }
}

/** Every conversation with an explicit mode, for operator inspection. */
export function listConversationMemoryModes(): Array<{
  conversationId: string;
  mode: ConversationMemoryMode;
  updatedAt: number;
}> {
  const raw = memorySqliteOrNull("listConversationMemoryModes");
  if (!raw) {
    return [];
  }
  try {
    ensureOnce(raw);
    const rows = raw
      .query(
        `SELECT conversation_id, mode, updated_at FROM ${CONVERSATION_MEMORY_MODES_TABLE} ORDER BY updated_at DESC`,
      )
      .all() as Array<{ conversation_id: string; mode: string; updated_at: number }>;
    const modes: Array<{
      conversationId: string;
      mode: ConversationMemoryMode;
      updatedAt: number;
    }> = [];
    for (const row of rows) {
      if (!isMode(row.mode)) {
        continue;
      }
      modes.push({
        conversationId: row.conversation_id,
        mode: row.mode,
        updatedAt: row.updated_at,
      });
    }
    return modes;
  } catch (err) {
    log.warn({ err }, "Failed to list conversation memory modes");
    return [];
  }
}
