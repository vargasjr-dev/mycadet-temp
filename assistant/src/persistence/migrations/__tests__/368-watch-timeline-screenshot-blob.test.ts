import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";
import { z } from "zod";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema/index.js";
import { migrateCreateWatchTimelineEntries } from "../367-create-watch-timeline-entries.js";
import { migrateWatchTimelineScreenshotBlob } from "../368-watch-timeline-screenshot-blob.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  const db = drizzle(sqlite, { schema });
  migrateCreateWatchTimelineEntries(db);
  return db;
}

function columnNames(raw: Database): string[] {
  const rows = raw
    .prepare<{ name: string }, []>("PRAGMA table_info(watch_timeline_entries)")
    .all();
  return rows.map((row) => row.name).sort();
}

function insertEntry(raw: Database, id: string, screenshot: Buffer | null) {
  raw.run(
    `INSERT INTO watch_timeline_entries
       (id, session_id, conversation_id, at_ms, kind, text, ax_tree, ax_diff, screenshot, created_at)
     VALUES (?, 'sess-1', 'conv-1', 1000, 'observation', '', NULL, NULL, ?, 1000)`,
    [id, screenshot],
  );
}

describe("migration 368: watch timeline screenshot blob", () => {
  test("adds the blob column and drops the attachment id", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    migrateWatchTimelineScreenshotBlob(db);

    expect(columnNames(raw)).toEqual([
      "at_ms",
      "ax_diff",
      "ax_tree",
      "conversation_id",
      "created_at",
      "id",
      "kind",
      "screenshot",
      "session_id",
      "text",
    ]);
  });

  test("stores frame bytes in the row and reads them back whole", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    migrateWatchTimelineScreenshotBlob(db);

    const frame = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x10]);
    insertEntry(raw, "entry-1", frame);
    insertEntry(raw, "entry-2", null);

    const rows = raw
      .prepare<
        {
          id: string;
          screenshot: unknown;
          bytes: number | null;
        },
        []
      >(
        "SELECT id, screenshot, length(screenshot) AS bytes FROM watch_timeline_entries ORDER BY id",
      )
      .all();

    expect(rows.map((row) => row.bytes)).toEqual([frame.length, null]);
    expect(
      Buffer.from(z.instanceof(Uint8Array).parse(rows[0]?.screenshot)),
    ).toEqual(frame);
  });

  test("is idempotent and preserves existing rows", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    migrateWatchTimelineScreenshotBlob(db);
    const frame = Buffer.from([1, 2, 3]);
    insertEntry(raw, "entry-1", frame);

    expect(() => migrateWatchTimelineScreenshotBlob(db)).not.toThrow();

    const rows = raw
      .prepare<
        { id: string; bytes: number },
        []
      >("SELECT id, length(screenshot) AS bytes FROM watch_timeline_entries")
      .all();
    expect(rows).toEqual([{ id: "entry-1", bytes: frame.length }]);
    expect(columnNames(raw)).toContain("screenshot");
    expect(columnNames(raw)).not.toContain("screenshot_attachment_id");
  });
});
