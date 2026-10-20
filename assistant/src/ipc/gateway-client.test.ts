/**
 * Tests for the assistant's gateway IPC wrapper layer.
 *
 * Transport-level behavior (NDJSON framing, reconnection, timeout) is
 * covered by the @mycadet/gateway-client package tests. These tests
 * verify the assistant-specific wrapper: singleton lifecycle, feature
 * flag parsing, and socket path resolution.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { mockIpc } from "../__tests__/requests-mock.js";
import {
  ipcCall,
  ipcClassifyRisk,
  ipcGetTunnelStatus,
  resetPersistentClient,
} from "./gateway-client.js";

afterEach(() => {
  resetPersistentClient();
});

// ---------------------------------------------------------------------------
// ipcCall wrapper
// ---------------------------------------------------------------------------

describe("ipcCall", () => {
  test("delegates to package ipcCall and returns result", async () => {
    const gateway = await mockIpc("gateway");
    gateway.setDefaults({ test_method: { key: "value" } });

    const result = await ipcCall("test_method");
    expect(result).toEqual({ key: "value" });
  });

  test("returns undefined when mock simulates error", async () => {
    const gateway = await mockIpc("gateway");
    gateway.failConnect();

    const result = await ipcCall("test_method");
    expect(result).toBeUndefined();
  });

  test("returns undefined for unconfigured methods", async () => {
    await mockIpc("gateway");

    const result = await ipcCall("unconfigured_method");
    expect(result).toBeUndefined();
  });
});

describe("ipcGetTunnelStatus", () => {
  test("parses the shared Tunnel status response", async () => {
    const gateway = await mockIpc("gateway");
    gateway.setDefaults({
      get_tunnel_status: {
        connected: true,
        publicUrl: "https://example.test",
      },
    });

    expect(await ipcGetTunnelStatus()).toEqual({
      connected: true,
      publicUrl: "https://example.test",
    });
  });

  test("keeps connected status when publicUrl is malformed", async () => {
    const gateway = await mockIpc("gateway");
    gateway.setDefaults({
      get_tunnel_status: { connected: false, publicUrl: 42 },
    });

    expect(await ipcGetTunnelStatus()).toEqual({
      connected: false,
      publicUrl: null,
    });
  });

  test("returns null when connected is missing or malformed", async () => {
    const gateway = await mockIpc("gateway");
    gateway.setDefaults({ get_tunnel_status: { connected: "yes" } });

    expect(await ipcGetTunnelStatus()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ipcClassifyRisk retry semantics
// ---------------------------------------------------------------------------

describe("ipcClassifyRisk retry", () => {
  const CLASSIFY_OK = {
    risk: "low",
    reason: "safe",
    matchType: "registry",
    scopeOptions: [],
  };
  const emptyParams = {} as unknown as Parameters<typeof ipcClassifyRisk>[0];

  test("retries a transient failure and then succeeds", async () => {
    const gateway = await mockIpc("gateway");
    gateway.failFirstN(1);
    gateway.setDefaults({ classify_risk: CLASSIFY_OK });

    const result = await ipcClassifyRisk(emptyParams);
    expect(result?.risk).toBe("low");
    expect(gateway.persistentCallCount("classify_risk")).toBe(2);
  });

  test("returns undefined after exhausting retries (3 attempts)", async () => {
    const gateway = await mockIpc("gateway");
    gateway.failConnect();

    const result = await ipcClassifyRisk(emptyParams);
    expect(result).toBeUndefined();
    expect(gateway.persistentCallCount("classify_risk")).toBe(3);
  });

  test("does NOT retry a structured IpcCallError (fails after 1 attempt)", async () => {
    const gateway = await mockIpc("gateway");
    gateway.failFirstN(3, { ipcCallError: true });
    gateway.setDefaults({ classify_risk: CLASSIFY_OK });

    const result = await ipcClassifyRisk(emptyParams);
    expect(result).toBeUndefined();
    expect(gateway.persistentCallCount("classify_risk")).toBe(1);
  });

  test("stops retrying once the signal is aborted", async () => {
    const gateway = await mockIpc("gateway");
    gateway.failConnect();
    const controller = new AbortController();
    controller.abort();

    const result = await ipcClassifyRisk(emptyParams, controller.signal);
    expect(result).toBeUndefined();
    // An already-aborted signal short-circuits the retry loop after the first
    // failed attempt rather than exhausting all three.
    expect(gateway.persistentCallCount("classify_risk")).toBe(1);
  });
});
