/**
 * Tests for the SQLite corruption watchdog.
 *
 * The watchdog turns a `SQLITE_CORRUPT` / `SQLITE_NOTADB` error thrown by any
 * statement into a direct `sqlite_corrupted` telemetry emit (bypassing the
 * SQLite watchdog buffer). It must ignore non-corruption errors, debounce per
 * database, and — wired straight into the slow-query wrapper — fire the moment
 * a wrapped connection hits corruption. The direct emit itself (opt-out gate,
 * POST payload) is covered in `../telemetry/watchdog-direct-emit.test.ts`.
 */
import { describe, expect, test } from "bun:test";

import { isSqliteCorruptionError } from "./sqlite-corruption-watchdog.js";

/** A synthetic `bun:sqlite`-style error carrying a `code`. */
function sqliteError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("isSqliteCorruptionError", () => {
  test("matches the SQLITE_CORRUPT / SQLITE_NOTADB families by code", () => {
    expect(
      isSqliteCorruptionError(
        sqliteError("SQLITE_CORRUPT", "database disk image is malformed"),
      ),
    ).toBe(true);
    expect(
      isSqliteCorruptionError(
        sqliteError("SQLITE_CORRUPT_VTAB", "corrupt virtual table"),
      ),
    ).toBe(true);
    expect(
      isSqliteCorruptionError(
        sqliteError("SQLITE_NOTADB", "file is not a database"),
      ),
    ).toBe(true);
  });

  test("matches the canonical corruption messages even without a code", () => {
    expect(
      isSqliteCorruptionError(new Error("database disk image is malformed")),
    ).toBe(true);
    expect(isSqliteCorruptionError(new Error("file is not a database"))).toBe(
      true,
    );
  });

  test("does not match transient contention or unrelated errors", () => {
    expect(
      isSqliteCorruptionError(sqliteError("SQLITE_BUSY", "database is locked")),
    ).toBe(false);
    expect(
      isSqliteCorruptionError(sqliteError("SQLITE_IOERR", "disk I/O error")),
    ).toBe(false);
    expect(
      isSqliteCorruptionError(
        sqliteError("SQLITE_CONSTRAINT", "UNIQUE constraint failed"),
      ),
    ).toBe(false);
    expect(isSqliteCorruptionError(new Error("no such table: foo"))).toBe(
      false,
    );
  });
});
