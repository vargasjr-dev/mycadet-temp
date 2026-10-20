import { afterEach, describe, expect, test } from "bun:test";

import {
  ASSISTANT_FLAG_DEFAULTS,
  CLIENT_FLAG_DEFAULTS,
  getEnvFlagOverridesForScope,
  scopeIncludes,
} from "@/lib/feature-flags/feature-flag-catalog";

const originalWindow = (globalThis as Record<string, unknown>).window;

afterEach(() => {
  (globalThis as Record<string, unknown>).window = originalWindow;
});

describe("feature flag catalog", () => {
  test("exposes os-beta as an assistant flag defaulting off", () => {
    expect(ASSISTANT_FLAG_DEFAULTS.osBeta).toBe(false);
    expect("osBeta" in CLIENT_FLAG_DEFAULTS).toBe(false);
  });


















});

describe("getEnvFlagOverridesForScope", () => {
  test("returns empty bool and str maps when no overrides are present", () => {
    const result = getEnvFlagOverridesForScope("client");
    expect(result).toEqual({ bool: {}, str: {} });
  });

  test("filters client-scoped flags and separates bool/str", () => {
    (globalThis as Record<string, unknown>).window = {
      __CADET_FLAG_OVERRIDES__: {
        // assistant-only flag (boolean) — excluded from the client scope
        "os-beta": true,
      },
    };

    const result = getEnvFlagOverridesForScope("client");
    expect(result.bool).toEqual({});
    expect(result.str).toEqual({});
  });

  test("boolean flags keep case-insensitive env coercion", () => {
    (globalThis as Record<string, unknown>).window = undefined;
    for (const raw of ["on", "ON"]) {
      process.env.VITE_CADET_FLAG_OS_BETA = raw;
      try {
        const result = getEnvFlagOverridesForScope("assistant");
        expect(result.bool.osBeta).toBe(true);
        expect(result.str).not.toHaveProperty("osBeta");
      } finally {
        delete process.env.VITE_CADET_FLAG_OS_BETA;
      }
    }
  });
});

describe("scopeIncludes", () => {
  test("'both' includes client and assistant", () => {
    expect(scopeIncludes("both", "client")).toBe(true);
    expect(scopeIncludes("both", "assistant")).toBe(true);
  });

  test("'client' only includes client", () => {
    expect(scopeIncludes("client", "client")).toBe(true);
    expect(scopeIncludes("client", "assistant")).toBe(false);
  });

  test("'assistant' only includes assistant", () => {
    expect(scopeIncludes("assistant", "assistant")).toBe(true);
    expect(scopeIncludes("assistant", "client")).toBe(false);
  });
});
