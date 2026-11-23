import assert from "node:assert/strict";
import { describe, expect, test } from "bun:test";

import {
  IpcCallError,
  IpcConnectError,
} from "@mycadet/gateway-client/ipc-client";

import {
  RouteError,
  ServiceUnavailableError,
} from "../../runtime/routes/errors.js";
import {
  mapGatewayIpcConnectError,
  rethrowGatewayIpcFailure,
} from "../gateway-ipc-errors.js";

describe("mapGatewayIpcConnectError", () => {
  test("maps IpcConnectError to ServiceUnavailableError", () => {
    const mapped = mapGatewayIpcConnectError(
      new IpcConnectError("connect ENOENT", "ENOENT"),
    );
    assert(
      mapped instanceof ServiceUnavailableError,
      "Expected ServiceUnavailableError",
    );
    expect(mapped.statusCode).toBe(503);
    expect(mapped.message).toContain("Gateway is not reachable over IPC");
  });

  test("leaves other errors unchanged", () => {
    const err = new Error("boom");
    expect(mapGatewayIpcConnectError(err)).toBe(err);
  });
});

describe("rethrowGatewayIpcFailure", () => {
  test("maps IpcCallError onto RouteError with the gateway status", () => {
    try {
      rethrowGatewayIpcFailure(
        new IpcCallError("Invite not found", {
          statusCode: 404,
          errorCode: "NOT_FOUND",
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      assert(err instanceof RouteError, "Expected RouteError");
      expect(err.statusCode).toBe(404);
      expect(err.code).toBe("NOT_FOUND");
    }
  });
});
