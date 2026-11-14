/**
 * Tests for the shared CES RPC session factory used by assistant boot and
 * child-process credential resolution.
 */
import { describe, expect, test } from "bun:test";

import { createCesClient } from "./client.js";

describe("createCesClient", () => {
  test("returns undefined when discovery fails without polling", async () => {
    const start = Date.now();
    const client = await createCesClient({
      discover: async () => ({
        mode: "unavailable",
        reason: "missing test socket",
      }),
    });

    expect(client).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
