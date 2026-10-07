/**
 * Unit tests for the empty-state greeting cache
 * (runtime/routes/empty-state-greeting-cache.ts).
 *
 * Validates TTL round-tripping, expiry, and the TTL=0 "always regenerate"
 * behavior that disables caching entirely.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import {
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../persistence/checkpoints.js";
import { getSqlite } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  getCachedEmptyStateGreeting,
  setCachedEmptyStateGreeting,
} from "../runtime/routes/empty-state-greeting-cache.js";
import { setConfig } from "./helpers/set-config.js";

// The checkpoint store is real: rows live in the per-process workspace DB.
beforeAll(async () => {
  await initializeDb();
});

/** Seed the cache TTL into the real workspace config. */
function setCacheTtlMs(ttlMs: number): void {
  setConfig("ui", { emptyStateGreetingCacheTtlMs: ttlMs });
}

const TIMESTAMP_KEY = "empty_state:greeting:cached_at";

beforeEach(() => {
  setCacheTtlMs(4 * 60 * 60 * 1000);
});

afterEach(() => {
  getSqlite().run("DELETE FROM memory_checkpoints");
});

describe("empty-state greeting cache", () => {
  test("returns null when the cache is empty", () => {
    expect(getCachedEmptyStateGreeting()).toBeNull();
  });

  test("round-trips set then get within the TTL", () => {
    setCachedEmptyStateGreeting("hey there");
    expect(getCachedEmptyStateGreeting()).toBe("hey there");
  });

  test("keeps cached greetings separate by timezone scope", () => {
    setCachedEmptyStateGreeting("hey eastern", "America/New_York");
    setCachedEmptyStateGreeting("hey central", "America/Chicago");

    expect(getCachedEmptyStateGreeting("America/New_York")).toBe("hey eastern");
    expect(getCachedEmptyStateGreeting("America/Chicago")).toBe("hey central");
    expect(getCachedEmptyStateGreeting("Europe/Skopje")).toBeNull();
  });

  test("returns null once the TTL is exceeded", () => {
    setCachedEmptyStateGreeting("stale");
    setMemoryCheckpoint(
      TIMESTAMP_KEY,
      String(Date.now() - (4 * 60 + 1) * 60 * 1000),
    );
    expect(getCachedEmptyStateGreeting()).toBeNull();
  });

  test("returns the cached value just within the TTL", () => {
    setCachedEmptyStateGreeting("fresh enough");
    setMemoryCheckpoint(
      TIMESTAMP_KEY,
      String(Date.now() - (3 * 60 + 59) * 60 * 1000),
    );
    expect(getCachedEmptyStateGreeting()).toBe("fresh enough");
  });

  test("TTL of 0 disables caching: writes are skipped and reads miss", () => {
    setCacheTtlMs(0);
    setCachedEmptyStateGreeting("should not persist");
    expect(getMemoryCheckpoint(TIMESTAMP_KEY)).toBeNull();
    expect(getCachedEmptyStateGreeting()).toBeNull();
  });

  test("TTL of 0 ignores a value cached while caching was enabled", () => {
    setCachedEmptyStateGreeting("cached while on");
    setCacheTtlMs(0);
    expect(getCachedEmptyStateGreeting()).toBeNull();
  });

  test("returns null when the timestamp checkpoint is missing", () => {
    setMemoryCheckpoint("empty_state:greeting:text", "orphaned");
    expect(getCachedEmptyStateGreeting()).toBeNull();
  });
});
