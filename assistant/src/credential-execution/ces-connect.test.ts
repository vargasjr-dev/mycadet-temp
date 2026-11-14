/**
 * Tests for the shared CES RPC session helper used by assistant boot and
 * child-process credential resolution.
 */
import { describe, expect, test } from "bun:test";

import { openCesRpcSession } from "./ces-connect.js";

describe("openCesRpcSession", () => {
  test("returns undefined when discovery fails without polling", async () => {
    const start = Date.now();
    const client = await openCesRpcSession({
      discover: async () => ({
        mode: "unavailable",
        reason: "missing test socket",
      }),
    });

    expect(client).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  test("returns undefined when the abort signal is already fired", async () => {
    const abort = new AbortController();
    abort.abort();
    const client = await openCesRpcSession({
      discover: async () => {
        throw new Error("discover should not run after abort");
      },
      signal: abort.signal,
    });

    expect(client).toBeUndefined();
  });
});
