/**
 * Tests for the shared CES RPC session factory used by assistant boot and
 * child-process credential resolution.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

import { createCesClient } from "./client.js";

// Socket discovery is the process manager's concern, and it reads
// `CES_SOCKET_DIR` — an empty socket dir makes the real discovery exhaust
// its poll budget and come back unavailable, no module mocking needed.
const socketDir = mkdtempSync(join(tmpdir(), "ces-no-socket-"));
const prevSocketDir = process.env["CES_SOCKET_DIR"];
process.env["CES_SOCKET_DIR"] = socketDir;

afterAll(() => {
  if (prevSocketDir === undefined) {
    delete process.env["CES_SOCKET_DIR"];
  } else {
    process.env["CES_SOCKET_DIR"] = prevSocketDir;
  }
});

describe("createCesClient", () => {
  test("returns undefined when discovery finds no socket", async () => {
    const start = Date.now();
    const client = await createCesClient();

    expect(client).toBeUndefined();
    // The discovery poll budget (3s) is the dominant cost — the point is
    // that the factory settles on its own rather than hanging.
    expect(Date.now() - start).toBeLessThan(10_000);
  });
});
