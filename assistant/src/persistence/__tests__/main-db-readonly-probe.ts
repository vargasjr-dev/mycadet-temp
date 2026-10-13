/**
 * Subprocess probe for the main DB's read-only connection posture — the
 * resource monitor's shape: reads through the dedicated read-only connection
 * work, writes through it fail loudly instead of contending for the write
 * lock. Spawned by `main-db-readonly.test.ts` with CADET_WORKSPACE_DIR
 * pointing at a fresh temp workspace, so the process-scoped posture and
 * connection singletons never leak into the test runner process.
 *
 * Exits 0 and prints READONLY_PROBE_OK when every assertion holds; any
 * failure throws and exits non-zero.
 */

import { getMainDbReadOnly } from "../db-connection.js";
import { initializeDb } from "../db-init.js";
import { conversations } from "../schema/index.js";

// Create the schema over the normal read-write connection, then exercise the
// monitor's separate read-only connection against the same file.
await initializeDb();

const readOnlyDb = getMainDbReadOnly();
if (!readOnlyDb) {
  throw new Error("read-only main DB connection unavailable");
}

// Reads work over the read-only connection.
const rows = readOnlyDb.select().from(conversations).all();
if (!Array.isArray(rows) || rows.length !== 0) {
  throw new Error(
    `expected empty conversations read, got ${JSON.stringify(rows)}`,
  );
}

// Writes through the read-only connection fail loudly.
let writeError: unknown;
try {
  readOnlyDb
    .insert(conversations)
    .values({
      id: "readonly-probe",
      title: "readonly probe",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
} catch (err) {
  writeError = err;
}
if (!writeError || !/readonly/i.test(String(writeError))) {
  throw new Error(
    `expected a readonly write failure, got: ${String(writeError)}`,
  );
}

console.log("READONLY_PROBE_OK");
