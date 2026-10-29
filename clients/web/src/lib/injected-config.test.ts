import { afterEach, describe, expect, test } from "bun:test";

import { InjectedConfigSchema } from "@mycadet/local-mode/contract";
import { readInjectedConfig } from "./injected-config";

const originalConfig =
  typeof window === "undefined" ? undefined : window.__CADET_CONFIG__;

afterEach(() => {
  if (typeof window !== "undefined") {
    window.__CADET_CONFIG__ = originalConfig;
  }
});

describe("injected config", () => {
  test("uses the existing remote field for the assistant topology", () => {
    expect(
      InjectedConfigSchema.parse({ remote: "docker", assistantId: "example" })
        .remote,
    ).toBe("docker");
  });

  test("an unknown topology preserves the rest of a newer host's stamp", () => {
    const config = InjectedConfigSchema.parse({
      remote: "future-topology",
      assistantId: "example",
      assistantName: "Example Assistant",
    });
    expect(config.remote).toBe("local");
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
