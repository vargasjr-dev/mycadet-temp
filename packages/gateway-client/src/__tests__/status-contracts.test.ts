import { describe, expect, test } from "bun:test";

import {
  FeatureFlagsIpcResponseSchema,
  TunnelStatusIpcResponseSchema,
} from "../gateway-ipc-contracts.js";

describe("gateway status IPC contracts", () => {
  test("filters unsupported feature flag values independently", () => {
    expect(
      FeatureFlagsIpcResponseSchema.parse({
        enabled: true,
        model: "balanced",
        count: 3,
        nested: { enabled: true },
      }),
    ).toEqual({ enabled: true, model: "balanced" });
  });

  test("rejects non-record feature flag responses", () => {
    expect(FeatureFlagsIpcResponseSchema.safeParse([]).success).toBe(false);
    expect(FeatureFlagsIpcResponseSchema.safeParse(null).success).toBe(false);
  });

  test("normalizes a malformed Tunnel public URL to null", () => {
    expect(
      TunnelStatusIpcResponseSchema.parse({
        connected: false,
        publicUrl: 42,
      }),
    ).toEqual({ connected: false, publicUrl: null });
  });

  test("requires a boolean Tunnel connection state", () => {
    expect(
      TunnelStatusIpcResponseSchema.safeParse({ connected: "yes" }).success,
    ).toBe(false);
  });
});
