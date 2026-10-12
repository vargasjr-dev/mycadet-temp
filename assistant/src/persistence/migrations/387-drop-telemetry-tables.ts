import { existsSync, unlinkSync } from "node:fs";

import { getTelemetryDbPath } from "../../util/telemetry-db-path.js";
import { closeTelemetryDb, type DrizzleDb } from "../db-connection.js";

/**
 * Delete the dedicated telemetry database (`assistant-telemetry.db`, plus its
 * `-wal` and `-shm` siblings).
 *
 * The usage-telemetry pipeline (reporter, event sources, outbox, traces, and
 * every store that fed it) is gone — nothing reads or writes this database
 * anymore. It held:
 *
 *   - `watchdog_events` (migration 301)
 *   - `config_setting_events` (325)
 *   - `flush_checkpoints` (327) — the reporter's watermark cursors
 *   - `onboarding_events` (moved here by 329)
 *   - `auth_fallback_events` (moved here by 330)
 *   - `lifecycle_events` (moved here by 331)
 *   - `skill_loaded_events` (moved here by 332)
 *   - `telemetry_events` — the generic outbox (333)
 *
 * Deleting the FILES rather than DROP TABLE: a dropped table leaves its
 * payloads recoverable in the file's freelist and WAL pages, and this
 * database's last contents include the consented turn traces — unlinking is
 * what actually destroys them on disk.
 *
 * Skipped entirely on a fresh install (no telemetry DB file): there is
 * nothing to delete. The live connection is closed first so platforms that
 * lock open files can complete the unlink; a failed unlink is logged and
 * leaves the file in place, where it is inert — nothing opens it after this
 * migration (the export route's checkpoint list no longer includes it).
 *
 * The `mainDb` parameter is accepted to satisfy the migration-step signature but
 * is not used — this migration operates exclusively on the telemetry DB.
 */
export function migrateDropTelemetryTables(_mainDb: DrizzleDb): void {
  closeTelemetryDb();
  const base = getTelemetryDbPath();
  for (const file of [base, `${base}-wal`, `${base}-shm`]) {
    try {
      if (existsSync(file)) {
        unlinkSync(file);
      }
    } catch (error) {
      console.warn(
        `[migrate-387] could not delete ${file}: ${error instanceof Error ? error.message : String(error)} — leaving the inert file in place.`,
      );
    }
  }
}
