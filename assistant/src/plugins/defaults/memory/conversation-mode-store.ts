import { getLogger } from "./logging.js";
import { type MemorySqlite, memorySqliteOrNull } from "./memory-db.js";

const log = getLogger("conversation-mode-store");

/**
 * Per-conversation memory-injection mode, owned by the memory plugin.
 *
 * The mode rides the `activation_sessions` table's per-conversation row on
 * the dedicated memory connection (`assistant-memory.db`) as a nullable
 * `memory_mode` column — NOT a table of its own (a new conversation-keyed
 * table would need its own purge/clear-all wiring) and NOT a column on the
 * main `conversations` table (memory settings live inside the memory plugin,
 * decoupled from main-agent infrastructure). `activation_sessions` is the
 * memory connection's per-conversation marker table, already swept by the
 * conversation-delete purge and the clear-all reset, so the mode inherits
 * that lifecycle for free: deleting a conversation deletes its mode, and
 * clearing all memory resets every mode to the default.
 *
 * Fork semantics follow the host table's: fork copies never touch
 * `activation_sessions`, so a fork starts `"standard"` — the opt-out is a
 * per-conversation setting, not an inherited one.
 *
 * Semantics of `"off"`: the plugin injects no memory for this conversation —
 * no dynamic `<memory>`/section block (both the v2 activation engine and the
 * v3 orchestrator skip fresh retrieval), no static essentials/threads block,
 * no PKB context. Prior turns' already-cached blocks ride history untouched
 * (cache-stable, forward-looking), and engine-wide jobs (consolidation,
 * filing, retrospectives) are unchanged. `"standard"` is the default for any
 * conversation whose row has no mode (or an unrecognized one).
 *
 * Engine-independent by construction: every engine's gate resolves the mode
 * from this store, so a future engine inherits the opt-out by asking it.
 */

export const CONVERSATION_MEMORY_MODES = ["standard", "off"] as const;

export type ConversationMemoryMode = (typeof CONVERSATION_MEMORY_MODES)[number];

/** The host table's per-conversation mode column (`NULL` = the default). */
const MODE_COLUMN = "memory_mode";

const HOST_TABLE = "activation_sessions";

/** Schema ensure, once per raw connection: the host table exists on every
 *  migrated memory database (migration 339), but the mode column may predate
 *  this build, and a bare test database may lack both. */
const ensuredConnections = new WeakSet<object>();

function ensure(raw: MemorySqlite): void {
  if (ensuredConnections.has(raw)) {
    return;
  }
  raw.run(`CREATE TABLE IF NOT EXISTS ${HOST_TABLE} (
      conversation_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    )`);
  try {
    raw.run(`ALTER TABLE ${HOST_TABLE} ADD COLUMN ${MODE_COLUMN} TEXT`);
  } catch (err) {
    // The column already exists on a database written by an earlier ensure —
    // the only tolerated failure; anything else is a real schema error.
    if (!/duplicate column name/i.test(String(err))) {
      throw err;
    }
  }
  ensuredConnections.add(raw);
}

function isMode(
  value: string | null | undefined,
): value is ConversationMemoryMode {
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
    ensure(raw);
    const row = raw
      .query(
        `SELECT ${MODE_COLUMN} FROM ${HOST_TABLE} WHERE conversation_id = ?`,
      )
      .get(conversationId) as { memory_mode: string | null } | null;
    return row?.memory_mode === "off" ? "off" : "standard";
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
 * rather than coerced, so a typo cannot silently re-enable memory. A
 * conversation with an existing activation marker row keeps it — only the
 * mode column moves; a conversation without one gets a marker row stamped
 * now (its `created_at` is the activation funnel's first-seen time, and a
 * mode-only row simply first appears when the mode is set).
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
    ensure(raw);
    raw
      .query(
        `INSERT INTO ${HOST_TABLE} (conversation_id, created_at, ${MODE_COLUMN})
         VALUES (?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET ${MODE_COLUMN} = excluded.${MODE_COLUMN}`,
      )
      .run(conversationId, Date.now(), mode);
    return true;
  } catch (err) {
    log.warn(
      { err, conversationId, mode },
      "Failed to persist conversation memory mode",
    );
    return false;
  }
}

/** Every conversation with an explicit mode, for operator inspection. */
export function listConversationMemoryModes(): Array<{
  conversationId: string;
  mode: ConversationMemoryMode;
}> {
  const raw = memorySqliteOrNull("listConversationMemoryModes");
  if (!raw) {
    return [];
  }
  try {
    ensure(raw);
    const rows = raw
      .query(
        `SELECT conversation_id, ${MODE_COLUMN} FROM ${HOST_TABLE} WHERE ${MODE_COLUMN} IS NOT NULL ORDER BY created_at DESC`,
      )
      .all() as Array<{ conversation_id: string; memory_mode: string }>;
    const modes: Array<{
      conversationId: string;
      mode: ConversationMemoryMode;
    }> = [];
    for (const row of rows) {
      if (!isMode(row.memory_mode)) {
        continue;
      }
      modes.push({ conversationId: row.conversation_id, mode: row.memory_mode });
    }
    return modes;
  } catch (err) {
    log.warn({ err }, "Failed to list conversation memory modes");
    return [];
  }
}
