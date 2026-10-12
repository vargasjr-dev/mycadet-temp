import { existsSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

// The migration resolves its target through this helper at call time — seed
// the file at the SAME resolved path so the assertions and the migration can't
// disagree about which file is the telemetry DB.
import { getTelemetryDbPath } from "../../../util/telemetry-db-path.js";
import * as schema from "../../schema.js";
import { migrateDropTelemetryTables } from "../387-drop-telemetry-tables.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  return drizzle(sqlite, { schema });
}

function seedTelemetryDb(): void {
  const path = getTelemetryDbPath();
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  const raw = new Database(path);
  raw.exec(`
    CREATE TABLE IF NOT EXISTS telemetry_events (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL,
      conversation_id TEXT, payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS flush_checkpoints (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS watchdog_events (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, payload TEXT NOT NULL
    );
  `);
  raw.close();
}

describe("migrateDropTelemetryTables", () => {
  beforeEach(() => {
    // Never let one case's seeded file leak into the next.
    if (existsSync(getTelemetryDbPath())) {
      unlinkSync(getTelemetryDbPath());
    }
  });

  test("no telemetry DB file → no-op (fresh installs never create one)", () => {
    const db = createTestDb();
    migrateDropTelemetryTables(db);
    expect(existsSync(getTelemetryDbPath())).toBe(false);
  });

  test("drops the telemetry tables", () => {
    seedTelemetryDb();

    const db = createTestDb();
    migrateDropTelemetryTables(db);

    const check = new Database(getTelemetryDbPath());
    try {
      const tables = (
        check
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(tables).toEqual([]);
    } finally {
      check.close();
    }
  });
});
