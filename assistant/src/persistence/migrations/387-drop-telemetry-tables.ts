import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";

import { getTelemetryDbPath } from "../../util/telemetry-db-path.js";
import { type DrizzleDb, getTelemetrySqlite } from "../db-connection.js";

/**
 * Drop every table on the dedicated telemetry database
 * (`assistant-telemetry.db`).
 *
 * The usage-telemetry pipeline (reporter, event sources, outbox, traces, and
 * every store that fed it) is gone — nothing reads or writes this database
 * anymore, so the tables it held are dead weight:
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
 * Skipped entirely on a fresh install (no telemetry DB file): there is nothing
 * to drop and opening the file would recreate it. The (now empty) file itself
 * is left in place — nothing opens it after this migration, so it is inert.
 *
 * The `mainDb` parameter is accepted to satisfy the migration-step signature but
 * is not used — this migration operates exclusively on the telemetry DB.
 */
export function migrateDropTelemetryTables(_mainDb: DrizzleDb): void {
  if (!existsSync(getTelemetryDbPath())) {
    return;
  }
  let raw: Database | null = getTelemetrySqlite();
  if (!raw) {
    // The dedicated connection failed to open (logged by openDedicatedDb).
    // Fall back to opening the file directly so the migration still runs —
    // the singleton will pick it up on a later access. This mirrors the
    // fail-soft pattern of the other dedicated-DB migrations.
    raw = new Database(getTelemetryDbPath());
  }
  for (const table of [
    "telemetry_events",
    "flush_checkpoints",
    "config_setting_events",
    "onboarding_events",
    "auth_fallback_events",
    "lifecycle_events",
    "skill_loaded_events",
    "watchdog_events",
  ]) {
    raw.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}
