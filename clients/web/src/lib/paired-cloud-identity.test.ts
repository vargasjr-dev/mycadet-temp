/**
 * Tests for `resolvePairedAssistantCloudId`: the paired-proxy status read,
 * the lockfile persist, and the per-session cache (hits and misses alike).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { LockfileAssistant } from "@/lib/local-mode";

const UUID = "0f7c8b3e-2a41-4c1d-9b6e-1d2f3a4b5c6d";

const pairedEntry: LockfileAssistant = {
  assistantId: "paired-remote",
  cloud: "local",
  paired: true,
  runtimeUrl: "https://remote.example",
  hatchedAt: "2024-01-01T00:00:00Z",
};

let lockfileEntry: LockfileAssistant | undefined = pairedEntry;
let pairedGatewayUrl: string | undefined = "/assistant/__gateway/paired-remote";
mock.module("@/lib/local-mode", () => ({
  getLockfileAssistant: () => lockfileEntry,
  getPairedGatewayUrl: () => pairedGatewayUrl,
}));

const fetchCloudStatus = mock(
  async (
    _gateway: { gatewayUrl: string; actorToken: string | null },
    _id: string,
  ) => ({ assistantId: UUID }) as { assistantId: string | null } | null,
);
mock.module("@/lib/local-cloud-identity", () => ({
  fetchCloudStatus,
  isUuid: (value: string) => /^[0-9a-f-]{36}$/i.test(value),
}));

const {
  resetPairedCloudIdentityCacheForTesting,
  resolvePairedAssistantCloudId,
} = await import("@/lib/paired-cloud-identity");

beforeEach(() => {
  lockfileEntry = pairedEntry;
  pairedGatewayUrl = "/assistant/__gateway/paired-remote"; // the unscoped /readyz probe still rides it
  fetchCloudStatus.mockResolvedValue({ assistantId: UUID });
});

afterEach(() => {
  resetPairedCloudIdentityCacheForTesting();
  fetchCloudStatus.mockReset();
});

describe("resolvePairedAssistantCloudId", () => {
  test("reads the paired daemon's status through the proxy and persists the UUID", async () => {
    await expect(resolvePairedAssistantCloudId("paired-remote")).resolves.toBe(
      UUID,
    );
    expect(fetchCloudStatus).toHaveBeenCalledWith(
      {
        gatewayUrl: window.location.origin,
        actorToken: null,
      },
      "paired-remote",
    );
  });

  test("a re-pair to another gateway probes again", async () => {
    await resolvePairedAssistantCloudId("paired-remote");
    lockfileEntry = { ...pairedEntry, runtimeUrl: "https://new.example.com" };
    await resolvePairedAssistantCloudId("paired-remote");
    expect(fetchCloudStatus).toHaveBeenCalledTimes(2);
  });

  test("resolves once per id per session", async () => {
    await resolvePairedAssistantCloudId("paired-remote");
    await resolvePairedAssistantCloudId("paired-remote");
    expect(fetchCloudStatus).toHaveBeenCalledTimes(1);
  });

  test("a miss is not cached, so a recovered daemon is asked again", async () => {
    fetchCloudStatus.mockResolvedValueOnce(null);
    await expect(
      resolvePairedAssistantCloudId("paired-remote"),
    ).resolves.toBeNull();
    await expect(resolvePairedAssistantCloudId("paired-remote")).resolves.toBe(
      UUID,
    );
    expect(fetchCloudStatus).toHaveBeenCalledTimes(2);
  });

  test("concurrent asks share one in-flight probe", async () => {
    await Promise.all([
      resolvePairedAssistantCloudId("paired-remote"),
      resolvePairedAssistantCloudId("paired-remote"),
    ]);
    expect(fetchCloudStatus).toHaveBeenCalledTimes(1);
  });

  test("returns the persisted id without a daemon read", async () => {
    lockfileEntry = { ...pairedEntry, cloudAssistantId: UUID };
    await expect(resolvePairedAssistantCloudId("paired-remote")).resolves.toBe(
      UUID,
    );
    expect(fetchCloudStatus).not.toHaveBeenCalled();
  });

  test.each([
    ["no lockfile entry", () => (lockfileEntry = undefined)],
    ["no usable paired proxy", () => (pairedGatewayUrl = undefined)],
  ])("resolves null with %s", async (_l, arrange) => {
    arrange();
    await expect(
      resolvePairedAssistantCloudId("paired-remote"),
    ).resolves.toBeNull();
    expect(fetchCloudStatus).not.toHaveBeenCalled();
  });

  test("rejects a status id that is not a UUID", async () => {
    fetchCloudStatus.mockResolvedValue({ assistantId: "self" });
    await expect(
      resolvePairedAssistantCloudId("paired-remote"),
    ).resolves.toBeNull();
  });

  test("resolves the UUID even when a rename lands mid-request", async () => {
    fetchCloudStatus.mockImplementation(async () => {
      lockfileEntry = { ...pairedEntry, name: "Renamed" };
      return { assistantId: UUID };
    });
    await expect(resolvePairedAssistantCloudId("paired-remote")).resolves.toBe(
      UUID,
    );
  });

  test.each([
    ["removed", () => (lockfileEntry = undefined)],
    [
      "no longer paired",
      () => (lockfileEntry = { ...pairedEntry, paired: false }),
    ],
    [
      "retargeted",
      () =>
        (lockfileEntry = {
          ...pairedEntry,
          runtimeUrl: "https://other.example",
        }),
    ],
  ])("resolves null when the entry is %s mid-request", async (_l, arrange) => {
    fetchCloudStatus.mockImplementation(async () => {
      arrange();
      return { assistantId: UUID };
    });
    await expect(
      resolvePairedAssistantCloudId("paired-remote"),
    ).resolves.toBeNull();
  });
});
