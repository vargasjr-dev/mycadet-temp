/**
 * Tests for the shared CES RPC session factory used by assistant boot and
 * child-process credential resolution.
 */
import { afterAll, describe, expect, mock, test } from "bun:test";

// Socket discovery is the process manager's concern — tests stub it at the
// discovery module, not through a client-factory option.
const actualDiscovery = await import("./executable-discovery.js");
const discoverMock = mock(actualDiscovery.discoverCesWithRetry);
mock.module("./executable-discovery.js", () => ({
  ...actualDiscovery,
  discoverCesWithRetry: discoverMock,
}));

import { createCesClient } from "./client.js";

afterAll(() => {
  mock.module("./executable-discovery.js", () => actualDiscovery);
});

describe("createCesClient", () => {
  test("returns undefined when discovery fails without polling", async () => {
    discoverMock.mockImplementation(async () => ({
      mode: "unavailable" as const,
      reason: "missing test socket",
    }));
    const start = Date.now();
    const client = await createCesClient();

    expect(client).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
