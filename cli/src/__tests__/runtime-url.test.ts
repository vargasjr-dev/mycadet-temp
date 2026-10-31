import { describe, expect, test } from "bun:test";

import { GATEWAY_PORT } from "../lib/constants.js";
import { getGatewayUrl } from "@mycadet/local-mode/contract";
import type { LockfileAssistant } from "../lib/assistant-config.js";

const entry = (overrides: Partial<LockfileAssistant>): LockfileAssistant =>
  ({
    assistantId: "asst_1",
    ...overrides,
  }) as LockfileAssistant;

describe("getGatewayUrl", () => {
  test("custom remotes derive from their recorded host and port", () => {
    expect(
      getGatewayUrl(
        entry({ cloud: "custom", ipAddress: "203.0.113.7", port: 7830 }),
      ),
    ).toBe("https://203.0.113.7:7830");
  });

  test("custom remotes dial their recorded host and port", () => {
    expect(
      getGatewayUrl(
        entry({ cloud: "custom", ipAddress: "203.0.113.7", port: 9000 }),
      ),
    ).toBe("https://203.0.113.7:9000");
  });

  test("cloud-managed entries resolve through the cloud-url stack", () => {
    expect(getGatewayUrl(entry({ cloud: "cloud" }))).toMatch(/^https?:\/\//);
  });

  test("loopback topologies derive from the recorded gateway port", () => {
    expect(
      getGatewayUrl(
        entry({
          cloud: "local",
          port: 7900,
          daemonPort: 7901,
        }),
      ),
    ).toBe("http://127.0.0.1:7900");
  });

  test("a recorded default port dials the gateway default", () => {
    expect(
      getGatewayUrl(entry({ cloud: "local", port: GATEWAY_PORT })),
    ).toBe(`http://127.0.0.1:${GATEWAY_PORT}`);
  });
});
