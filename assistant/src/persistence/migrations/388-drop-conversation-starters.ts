import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Drop the conversation-starters feature's storage.
 *
 * The starter chips on the empty conversation page are removed outright —
 * the generating job handler, the serving routes, and the web dock are
 * all gone — so the table and its generation checkpoints are dead weight.
 * This drops:
 *
 *   - `conversation_starters` (migrations 170 → 174 → 181 rename chain)
 *   - every `memory_checkpoints` row under the `conversation_starters:`
 *     prefix (generation bookkeeping from
 *     `home/conversation-starter-checkpoints.ts`)
 *
 * Nothing reads either after this migration: the feature's last readers
 * were removed in the same change.
 */
export function migrateDropConversationStarters(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS conversation_starters`);
  raw.exec(
    /*sql*/ `DELETE FROM memory_checkpoints WHERE key LIKE 'conversation_starters:%'`,
  );
}
