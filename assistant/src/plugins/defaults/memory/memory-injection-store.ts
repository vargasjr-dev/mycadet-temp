import { desc, eq } from "drizzle-orm";

import { activationSessions } from "../../../persistence/schema/index.js";
import { getLogger } from "./logging.js";
import { memoryDbOrNull, type MemorySqlite } from "./memory-db.js";

const log = getLogger("memory-injection-store");

/**
 * The memory plugin's per-conversation memory-injection opt-out: a
 * `memory_injection_off` flag on the memory connection's `activation_sessions`
 * row (schema in `persistence/schema/memory-injection.ts`). Fail-open reads,
 * fail-soft writes; the host row's purge/clear-all lifecycle applies, and
 * forks (which never copy `activation_sessions`) start with injection on.
 */

const ensuredConnections = new WeakSet<object>();

/** The flag column postdates the table (migration 339); a bare test db may
 *  lack both. */
function ensureSchema(raw: MemorySqlite): void {
  if (ensuredConnections.has(raw)) {
    return;
  }
  raw.run(`CREATE TABLE IF NOT EXISTS activation_sessions (
      conversation_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    )`);
  try {
    raw.run(
      "ALTER TABLE activation_sessions ADD COLUMN memory_injection_off INTEGER",
    );
  } catch (err) {
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

/** Whether the plugin must inject no memory for this conversation. A degraded
 *  read resolves `false` — it must never silence memory. */
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

/** Turn the conversation's memory injection off or on, stamping an
 *  `activation_sessions` row if the conversation has none yet. Reports
 *  `false` when the write failed and the flag moved nowhere. */
export function setMemoryInjectionOff(
  conversationId: string,
  off: boolean,
): boolean {
  try {
    const mdb = memoryDb("setMemoryInjectionOff");
    if (!mdb) {
      log.warn(
        { conversationId },
        "memory database unavailable; injection flag not persisted",
      );
      return false;
    }
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
    log.warn(
      { err, conversationId, off },
      "Failed to persist the injection flag",
    );
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
