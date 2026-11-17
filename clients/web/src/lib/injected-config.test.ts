import { afterEach, describe, expect, test } from "bun:test";

import { InjectedConfigSchema, readInjectedConfig } from "./injected-config";

const originalConfig =
  typeof window === "undefined" ? undefined : window.__CADET_CONFIG__;

afterEach(() => {
  if (typeof window !== "undefined") {
    window.__CADET_CONFIG__ = originalConfig;
  }
});

describe("injected config", () => {
  test("parses the identity a host stamps", () => {
    const config = InjectedConfigSchema.parse({
      assistantId: "example",
      assistantName: "Example Assistant",
    });
    expect(config.assistantId).toBe("example");
    expect(config.assistantName).toBe("Example Assistant");
  });

  test("an unknown field from a newer host's stamp is dropped, the rest preserved", () => {
    const config = InjectedConfigSchema.parse({
      futureField: "whatever",
      assistantId: "example",
      assistantName: "Example Assistant",
    });
    expect(config.assistantId).toBe("example");
    expect(config.assistantName).toBe("Example Assistant");
  });

  test("an invalid config is rejected at the window boundary", () => {
    if (typeof window === "undefined") {
      expect(readInjectedConfig()).toBeUndefined();
      return;
    }
    window.__CADET_CONFIG__ = { assistantId: 42 };
    expect(readInjectedConfig()).toBeUndefined();
  });
});
