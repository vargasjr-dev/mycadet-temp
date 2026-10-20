import { describe, expect, test } from "bun:test";

import { TunnelStatusIpcResponseSchema } from "../gateway-ipc-contracts.js";

describe("gateway status IPC contracts", () => {
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
