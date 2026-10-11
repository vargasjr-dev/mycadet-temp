import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, test, expect } from "bun:test";

import { testWorkspaceDir } from "./test-preload.js";
import { loadConfig } from "../config.js";

describe("config: hardcoded defaults", () => {
  test("GATEWAY_PORT defaults to 7830", () => {
    const saved = process.env.GATEWAY_PORT;
    delete process.env.GATEWAY_PORT;
    try {
      const config = loadConfig();
      expect(config.port).toBe(7830);
    } finally {
      if (saved !== undefined) process.env.GATEWAY_PORT = saved;
    }
  });

  test("GATEWAY_PORT is configurable via env var", () => {
    const saved = process.env.GATEWAY_PORT;
    process.env.GATEWAY_PORT = "9090";
    try {
      const config = loadConfig();
      expect(config.port).toBe(9090);
    } finally {
      if (saved !== undefined) process.env.GATEWAY_PORT = saved;
      else delete process.env.GATEWAY_PORT;
    }
  });

  test("trustProxy is opt-in via GATEWAY_TRUST_PROXY", () => {
    const saved = process.env.GATEWAY_TRUST_PROXY;
    try {
      process.env.GATEWAY_TRUST_PROXY = "true";
      expect(loadConfig().trustProxy).toBe(true);

      process.env.GATEWAY_TRUST_PROXY = "1";
      expect(loadConfig().trustProxy).toBe(true);

      process.env.GATEWAY_TRUST_PROXY = "false";
      expect(loadConfig().trustProxy).toBe(false);

      process.env.GATEWAY_TRUST_PROXY = "anything-else";
      expect(loadConfig().trustProxy).toBe(false);
    } finally {
      if (saved !== undefined) process.env.GATEWAY_TRUST_PROXY = saved;
      else delete process.env.GATEWAY_TRUST_PROXY;
    }
  });

  test("runtimeProxyRequireAuth is disabled only by RUNTIME_PROXY_REQUIRE_AUTH", () => {
    const saved = process.env.RUNTIME_PROXY_REQUIRE_AUTH;
    try {
      process.env.RUNTIME_PROXY_REQUIRE_AUTH = "false";
      expect(loadConfig().runtimeProxyRequireAuth).toBe(false);

      process.env.RUNTIME_PROXY_REQUIRE_AUTH = "true";
      expect(loadConfig().runtimeProxyRequireAuth).toBe(true);
    } finally {
      if (saved !== undefined) {
        process.env.RUNTIME_PROXY_REQUIRE_AUTH = saved;
      } else {
        delete process.env.RUNTIME_PROXY_REQUIRE_AUTH;
      }
    }
  });

  test("runtimeProxyRequireAuth ignores workspace config", () => {
    const saved = process.env.RUNTIME_PROXY_REQUIRE_AUTH;
    delete process.env.RUNTIME_PROXY_REQUIRE_AUTH;
    writeFileSync(
      join(testWorkspaceDir, "config.json"),
      JSON.stringify({ gateway: { runtimeProxyRequireAuth: false } }),
    );

    try {
      expect(loadConfig().runtimeProxyRequireAuth).toBe(true);
    } finally {
      if (saved !== undefined) {
        process.env.RUNTIME_PROXY_REQUIRE_AUTH = saved;
      }
      writeFileSync(join(testWorkspaceDir, "config.json"), "{}");
    }
  });

  test("assistantRuntimeBaseUrl derives from RUNTIME_HTTP_PORT", () => {
    const saved = process.env.RUNTIME_HTTP_PORT;
    process.env.RUNTIME_HTTP_PORT = "9999";
    try {
      const config = loadConfig();
      expect(config.assistantRuntimeBaseUrl).toBe("http://localhost:9999");
    } finally {
      if (saved !== undefined) process.env.RUNTIME_HTTP_PORT = saved;
      else delete process.env.RUNTIME_HTTP_PORT;
    }
  });

  test("runtimeTimeoutMs is configurable via env var", () => {
    const saved = process.env.RUNTIME_TIMEOUT_MS;
    process.env.RUNTIME_TIMEOUT_MS = "300000";
    try {
      const config = loadConfig();
      expect(config.runtimeTimeoutMs).toBe(300000);
    } finally {
      if (saved !== undefined) process.env.RUNTIME_TIMEOUT_MS = saved;
      else delete process.env.RUNTIME_TIMEOUT_MS;
    }
  });

  test("runtimeTimeoutMs rejects invalid env var", () => {
    const saved = process.env.RUNTIME_TIMEOUT_MS;
    process.env.RUNTIME_TIMEOUT_MS = "0";
    try {
      expect(() => loadConfig()).toThrow(
        "RUNTIME_TIMEOUT_MS must be a positive integer",
      );
    } finally {
      if (saved !== undefined) process.env.RUNTIME_TIMEOUT_MS = saved;
      else delete process.env.RUNTIME_TIMEOUT_MS;
    }
  });

  test("runtimeTimeoutMs rejects non-numeric workspace config values", () => {
    const saved = process.env.RUNTIME_TIMEOUT_MS;
    delete process.env.RUNTIME_TIMEOUT_MS;
    writeFileSync(
      join(testWorkspaceDir, "config.json"),
      JSON.stringify({ gateway: { runtimeTimeoutMs: true } }),
    );

    try {
      expect(() => loadConfig()).toThrow(
        "gateway.runtimeTimeoutMs must be a positive integer",
      );
    } finally {
      if (saved !== undefined) process.env.RUNTIME_TIMEOUT_MS = saved;
      else delete process.env.RUNTIME_TIMEOUT_MS;
      writeFileSync(join(testWorkspaceDir, "config.json"), "{}");
    }
  });

  test("gatewayInternalBaseUrl derives from port", () => {
    const saved = process.env.GATEWAY_PORT;
    process.env.GATEWAY_PORT = "8080";
    try {
      const config = loadConfig();
      expect(config.gatewayInternalBaseUrl).toBe("http://127.0.0.1:8080");
    } finally {
      if (saved !== undefined) process.env.GATEWAY_PORT = saved;
      else delete process.env.GATEWAY_PORT;
    }
  });
});
