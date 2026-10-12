/**
 * SQLite corruption watchdog.
 *
 * The daemon keeps all of its state — conversations, schedules, memory — in
 * `bun:sqlite` files. When one of those files is damaged (a torn write, a
 * truncated file, bad disk media) SQLite surfaces it as a `SQLITE_CORRUPT` /
 * `SQLITE_NOTADB` error ("database disk image is malformed" / "file is not a
 * database") on the next statement that touches the damaged page. Left
 * unobserved, that damage is only noticed when a user hits a broken feature.
 *
 * This watchdog makes corruption observable locally: it logs an operator-facing
 * error the moment any statement hits a damaged page.
 *
 * Detection is per-statement: the shared slow-query wrapper — which already
 * wraps every `bun:sqlite` connection (main, logs, memory — Drizzle and raw) —
 * hands every failed statement to {@link observeSqliteStatementError}. So
 * corruption is caught on *any* failing query or write, read or write, the
 * moment the workload actually hits the damaged page — no dedicated scan
 * needed. Non-corruption errors (constraint violations, syntax errors,
 * transient `SQLITE_BUSY`) are ignored.
 */

import { getLogger } from "../util/logger.js";

const log = getLogger("sqlite-corruption-watchdog");

/**
 * Whether an error is SQLite reporting structural corruption — the
 * `SQLITE_CORRUPT` / `SQLITE_NOTADB` families, by extended result code or by
 * the canonical message text ("database disk image is malformed" / "file is
 * not a database"). Deliberately distinct from `isRetryableSqliteError`: a
 * corrupt image is permanent, not transient contention, so retrying can never
 * help. Pure, so callers (and tests) can classify a synthesized error without
 * a real database.
 */
export function isSqliteCorruptionError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code ?? "";
  if (code.startsWith("SQLITE_CORRUPT") || code.startsWith("SQLITE_NOTADB")) {
    return true;
  }
  const message = (
    err instanceof Error ? err.message : String(err)
  ).toLowerCase();
  return (
    message.includes("database disk image is malformed") ||
    message.includes("file is not a database")
  );
}

/**
 * Report a corruption detection as an operator-facing error log. Fire-and-
 * forget by construction (logging never throws).
 */
function reportCorruption(
  detail: Record<string, unknown> & { database: string },
): void {
  log.error(detail, "SQLite corruption detected");
}

/** Context handed to {@link observeSqliteStatementError} for a failed execution. */
export interface StatementErrorContext {
  /** SQL preview (truncated) of the failing statement. */
  sql: string;
  /**
   * The database file's basename (e.g. `"assistant.db"` / `"assistant-logs.db"`),
   * derived from the `Database`'s own `filename`. Always set by the wrapper;
   * optional only for direct callers (tests) that construct a context by hand.
   */
  database?: string;
  /** Caller-supplied `.label()` attribution tag, when present. */
  label?: string;
}

/**
 * Called by the slow-query wrapper for every failed statement: logs corruption
 * for `SQLITE_CORRUPT` / `SQLITE_NOTADB` errors and ignores everything else
 * (constraint/syntax errors, transient `SQLITE_BUSY` / `SQLITE_IOERR`
 * contention). The wrapper calls this directly, so there is no
 * observer registration or start/stop lifecycle — a corrupt file reports the
 * moment a statement hits it.
 */
export function observeSqliteStatementError(
  err: unknown,
  context: StatementErrorContext,
): void {
  if (!isSqliteCorruptionError(err)) {
    return;
  }
  reportCorruption({
    database: context.database ?? "unknown",
    error: err instanceof Error ? err.message : String(err),
    ...(context.sql ? { sql: context.sql } : {}),
    ...(context.label ? { label: context.label } : {}),
  });
}
