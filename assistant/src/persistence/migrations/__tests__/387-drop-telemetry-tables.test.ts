import {
  existsSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

// The migration resolves its target through this helper at call time — seed
// the file at the SAME resolved path so the assertions and the migration can't
// disagree about which file is the telemetry DB.
import { getTelemetryDbPath } from "../../../util/telemetry-db-path.js";
import * as schema from "../../schema/index.js";
import { migrateDropTelemetryTables } from "../387-drop-telemetry-tables.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  return drizzle(sqlite, { schema });
}

function seededFiles(): string[] {
  const base = getTelemetryDbPath();
  return [base, `${base}-wal`, `${base}-shm`];
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
  `);
  raw.close();
}

describe("migrateDropTelemetryTables", () => {
  beforeEach(() => {
    // Never let one case's seeded files leak into the next.
    for (const file of seededFiles()) {
      if (existsSync(file)) {
        unlinkSync(file);
      }
    }
  });

  test("no telemetry DB file → no-op (fresh installs never create one)", () => {
    const db = createTestDb();
    migrateDropTelemetryTables(db);
    expect(existsSync(getTelemetryDbPath())).toBe(false);
  });

  test("deletes the telemetry database file and its -wal/-shm siblings", () => {
    seedTelemetryDb();
    // Siblings as sqlite leaves them after a WAL-mode session — the migration
    // must sweep all three, since a DROP-less delete that only removed the
    // base file would still leave trace payloads in the WAL.
    writeFileSync(`${getTelemetryDbPath()}-wal`, "wal-bytes");
    writeFileSync(`${getTelemetryDbPath()}-shm`, "shm-bytes");

    const db = createTestDb();
    migrateDropTelemetryTables(db);

    for (const file of seededFiles()) {
      expect(existsSync(file)).toBe(false);
    }
  });
});
