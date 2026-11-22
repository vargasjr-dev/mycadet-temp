/**
 * Tests for gateway log-tail IPC routes.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const tailResult = {
  lines: [{ msg: "warn msg", level: 40 }],
  truncated: false,
};

const tailGatewayLogsMock = mock(
  (_params?: Record<string, unknown>): typeof tailResult => tailResult,
);

mock.module("../http/routes/log-tail.js", () => ({
  tailGatewayLogs: tailGatewayLogsMock,
}));

const { logTailRoutes } = await import("./log-tail-handlers.js");

beforeEach(() => {
  tailGatewayLogsMock.mockClear();
});

describe("logTailRoutes", () => {
  test("registers gateway_logs_tail with optional params", () => {
    const route = logTailRoutes[0];

    expect(route.method).toBe("gateway_logs_tail");
    expect(route.schema?.safeParse(undefined).success).toBe(true);
    expect(route.schema?.safeParse({ level: "INVALID" }).success).toBe(false);
  });

  test("tails gateway logs through the IPC handler", () => {
    const route = logTailRoutes[0];
    const result = route.handler({ n: 2, level: "warn", module: "mcp" });

    expect(result).toBe(tailResult);
    // Config is the handler's own business now — read at call time via
    // getConfig() inside tailGatewayLogs, not threaded through the route.
    expect(tailGatewayLogsMock).toHaveBeenCalledWith({
      n: 2,
      level: "warn",
      module: "mcp",
    });
  });
});
