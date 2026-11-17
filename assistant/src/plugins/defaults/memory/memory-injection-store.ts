import { desc, eq } from "drizzle-orm";

import { activationSessions } from "../../../persistence/schema/index.js";
import { getLogger } from "./logging.js";
import { memoryDbOrNull,type MemorySqlite } from "./memory-db.js";

const log = getLogger("memory-injection-store");

/**
 * The memory plugin's per-conversation memory-injection opt-out.
 *
 * State is a single boolean on the memory connection's per-conversation
 * `activation_sessions` row (the activation-rail marker table — see the
 * `activationSessions` schema object in `persistence/schema/memory-injection.ts`):
 * injection is ON for every conversation by default, and a row flagged
 * `memory_injection_off = 1` turns it OFF for that conversation — no dynamic
 * `<memory>`/section block (both the v2 activation engine and the v3
 * orchestrator skip fresh retrieval), no static essentials/threads block, no
 * PKB context. Prior turns' already-cached blocks ride history untouched
 * (cache-stable, forward-looking), and engine-wide jobs (consolidation,
 * filing, retrospectives) are unchanged.
 *
 * The flag lives on the memory connection's own table — deliberately NOT a
 * column on the main `conversations` table (memory settings stay inside the
 * memory plugin, decoupled from main-agent infrastructure) — and inherits the
 * host table's lifecycle for free: the conversation-delete purge and the
 * clear-all reset sweep `activation_sessions`, so deleting a conversation
 * deletes its flag and clearing all memory re-enables injection everywhere.
 * Fork copies never touch `activation_sessions`, so a fork starts ON.
 *
 * Engine-independent by construction: every engine's gate asks this store, so
 * a future engine inherits the opt-out by asking it.
 *
 * Fail-open reads / fail-soft writes: an unavailable memory database or a
 * failed statement only logs a warning — a degraded read must never silence
 * memory, and a failed write must never abort a turn.
 */

/** The schema ensure, once per raw connection: the host table exists on every
 *  migrated memory database (migration 339), but the flag column may predate
 *  this build, and a bare test database may lack both. */
const ensuredConnections = new WeakSet<object>();

function ensureSchema(raw: MemorySqlite): void {
  if (ensuredConnections.has(raw)) {
    return;
  }
  raw.run(`CREATE TABLE IF NOT EXISTS activation_sessions (
      conversation_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    )`);
  try {
    raw.run("ALTER TABLE activation_sessions ADD COLUMN memory_injection_off INTEGER");
  } catch (err) {
    // The column already exists on a database written by an earlier ensure —
    // the only tolerated failure; anything else is a real schema error.
    if (!/duplicate column name/i.test(String(err))) {
      throw err;
    }
  }
  ensuredConnections.add(raw);
}

function memoryDb(context: string): ReturnType<typeof memoryDbOrNull> {
  const mdb = memoryDbOrNull(context);
  if (mdb) {
    ensureSchema(mdb.$client);
  }
  return mdb;
}

/**
 * Whether the plugin must inject no memory for this conversation. Fail-open:
 * an unavailable memory database, a missing table, or any read error resolves
 * `false` (injection on) — a degraded read must never silence memory.
 */
export function isMemoryInjectionOff(
  conversationId: string | null | undefined,
): boolean {
  if (!conversationId) {
    return false;
  }
  try {
    return (
      memoryDb("isMemoryInjectionOff")
        ?.select({ off: activationSessions.memoryInjectionOff })
        .from(activationSessions)
        .where(eq(activationSessions.conversationId, conversationId))
        .get()?.off === 1
    );
  } catch (err) {
    log.warn(
      { err, conversationId },
      "Failed to read the injection flag; treating as on",
    );
    return false;
  }
}

/**
 * Turn the conversation's memory injection off or on. A conversation with an
 * existing activation marker row keeps it — only the flag column moves; a
 * conversation without one gets a marker row stamped now (its `created_at`
 * is the activation funnel's first-seen time, and an opt-out row simply
 * first appears when the flag is set). Best-effort: an unavailable memory
 * database or a failed statement reports `false` and leaves the flag as it
 * was.
 */
export function setMemoryInjectionOff(
  conversationId: string,
  off: boolean,
): boolean {
  const mdb = memoryDb("setMemoryInjectionOff");
  if (!mdb) {
    log.warn(
      { conversationId },
      "memory database unavailable; injection flag not persisted",
    );
    return false;
  }
  try {
    mdb
      .insert(activationSessions)
      .values({
        conversationId,
        createdAt: Date.now(),
        memoryInjectionOff: off ? 1 : 0,
      })
      .onConflictDoUpdate({
        target: activationSessions.conversationId,
        set: { memoryInjectionOff: off ? 1 : 0 },
      })
      .run();
    return true;
  } catch (err) {
    log.warn({ err, conversationId, off }, "Failed to persist the injection flag");
    return false;
  }
}

/** Every conversation with injection turned off, for operator inspection. */
export function listMemoryInjectionOffConversations(): string[] {
  try {
    return (
      memoryDb("listMemoryInjectionOffConversations")
        ?.select({ conversationId: activationSessions.conversationId })
        .from(activationSessions)
        .where(eq(activationSessions.memoryInjectionOff, 1))
        .orderBy(desc(activationSessions.createdAt))
        .all()
        .map((row) => row.conversationId) ?? []
    );
  } catch (err) {
    log.warn({ err }, "Failed to list injection-off conversations");
    return [];
  }
}
