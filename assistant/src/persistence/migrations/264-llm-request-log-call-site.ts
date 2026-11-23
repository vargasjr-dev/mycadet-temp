import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Adds `call_site` (nullable TEXT) to the `llm_request_logs` table.
 *
 * Records the logical call site that produced the row — `mainAgent`,
 * `compactionAgent`, etc. (string values from `LLMCallSite` in
 * `config/schemas/llm.ts`). Lets the LLM Context Inspector and other
 * observability tools filter "show me only compaction calls" without
 * having to infer from request payload shape.
 *
 * No backfill — historical rows stay NULL ("we don't know"). New rows
 * stamped at insertion time by callers of `recordRequestLog`.
 *
 * Idempotent — re-running is a no-op once the column exists. Modeled on
 * migration 252 (`llm-request-log-agent-loop-exit-reason`).
 */
export function migrateLlmRequestLogCallSite(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  const columns = raw
    .query<{ name: string }, []>(`PRAGMA table_info(llm_request_logs)`)
    .all();
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has("call_site")) {
    raw.exec(`ALTER TABLE llm_request_logs ADD COLUMN call_site TEXT`);
  }
}
