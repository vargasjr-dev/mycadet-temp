import { afterEach, describe, expect, test } from "bun:test";

import {
  ASSISTANT_FLAG_DEFAULTS,
  ASSISTANT_STRING_FLAG_DEFAULTS,
  CLIENT_FLAG_DEFAULTS,
  CLIENT_STRING_FLAG_DEFAULTS,
  getEnvFlagOverridesForScope,
  scopeIncludes,
} from "@/lib/feature-flags/feature-flag-catalog";

const originalWindow = (globalThis as Record<string, unknown>).window;

afterEach(() => {
  (globalThis as Record<string, unknown>).window = originalWindow;
});

describe("feature flag catalog", () => {
  test("exposes self-intro greeting to client and assistant flag stores", () => {
    expect(CLIENT_FLAG_DEFAULTS.selfIntroGreeting).toBe(false);
    expect(ASSISTANT_FLAG_DEFAULTS.selfIntroGreeting).toBe(false);
  });

  test("exposes cadet hosted inference as an assistant flag defaulting off", () => {
    expect(ASSISTANT_FLAG_DEFAULTS.cadetHostedInference).toBe(false);
    expect("cadetHostedInference" in CLIENT_FLAG_DEFAULTS).toBe(false);
  });

  test("exposes the send-user-message tool gate to both flag stores", () => {
    expect(CLIENT_FLAG_DEFAULTS.sendUserMessage).toBe(false);
    expect(ASSISTANT_FLAG_DEFAULTS.sendUserMessage).toBe(false);
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
        // client-only flag (boolean)
        velvet: true,
        // assistant-only flag (boolean) — should be excluded from client scope
        "cadet-hosted-inference": true,
        // client-visible flag (string)
        "vision-mode": "on",
      },
    };

    const result = getEnvFlagOverridesForScope("client");
    expect(result.bool).toEqual({ velvet: true });
    expect(result.str).toEqual({ visionMode: "on" });
    expect(result.bool).not.toHaveProperty("cadetHostedInference");
  });

  test("keeps booleanish Vite env values as strings for string-valued flags", () => {
    (globalThis as Record<string, unknown>).window = undefined;
    process.env.VITE_CADET_FLAG_VISION_MODE = "on";
    try {
      const result = getEnvFlagOverridesForScope("client");
      expect(result.str.visionMode).toBe("on");
      expect(result.bool).not.toHaveProperty("visionMode");

      process.env.VITE_CADET_FLAG_VISION_MODE = "off";
      expect(getEnvFlagOverridesForScope("client").str.visionMode).toBe("off");
    } finally {
      delete process.env.VITE_CADET_FLAG_VISION_MODE;
    }
  });

  test("matches string-flag env arms case-insensitively and stores the canonical arm", () => {
    (globalThis as Record<string, unknown>).window = undefined;
    process.env.VITE_CADET_FLAG_VISION_MODE = "ON";
    try {
      expect(getEnvFlagOverridesForScope("client").str.visionMode).toBe("on");

      process.env.VITE_CADET_FLAG_VISION_MODE = "On";
      expect(getEnvFlagOverridesForScope("client").str.visionMode).toBe("on");
    } finally {
      delete process.env.VITE_CADET_FLAG_VISION_MODE;
    }
  });

  test("drops string-flag env values that match no declared arm", () => {
    (globalThis as Record<string, unknown>).window = undefined;
    process.env.VITE_CADET_FLAG_VISION_MODE = "bogus";
    try {
      const result = getEnvFlagOverridesForScope("client");
      expect(result.str).not.toHaveProperty("visionMode");
      expect(result.bool).not.toHaveProperty("visionMode");
    } finally {
      delete process.env.VITE_CADET_FLAG_VISION_MODE;
    }
  });

  test("boolean flags keep case-insensitive env coercion", () => {
    (globalThis as Record<string, unknown>).window = undefined;
    for (const raw of ["on", "ON"]) {
      process.env.VITE_CADET_FLAG_VELVET = raw;
      try {
        const result = getEnvFlagOverridesForScope("client");
        expect(result.bool.velvet).toBe(true);
        expect(result.str).not.toHaveProperty("velvet");
      } finally {
        delete process.env.VITE_CADET_FLAG_VELVET;
      }
    }
  });

  test("maps boolean-coerced window overrides back onto on/off string flags", () => {
    (globalThis as Record<string, unknown>).window = {
      __CADET_FLAG_OVERRIDES__: { "vision-mode": true },
    };
    expect(getEnvFlagOverridesForScope("client").str.visionMode).toBe("on");

    (globalThis as Record<string, unknown>).window = {
      __CADET_FLAG_OVERRIDES__: { "vision-mode": false },
    };
    expect(getEnvFlagOverridesForScope("client").str.visionMode).toBe("off");
  });

  test("drops boolean-coerced window overrides for string flags without on/off arms", () => {
    (globalThis as Record<string, unknown>).window = {
      __CADET_FLAG_OVERRIDES__: {
        "pre-chat-onboarding-experiment-2026-06-06": true,
      },
    };

    const result = getEnvFlagOverridesForScope("client");
    expect(result.str).not.toHaveProperty(
      "preChatOnboardingExperiment20260606",
    );
    expect(result.bool).not.toHaveProperty(
      "preChatOnboardingExperiment20260606",
    );
  });

  test("flags with scope 'both' appear for both client and assistant scopes", () => {
    (globalThis as Record<string, unknown>).window = {
      __CADET_FLAG_OVERRIDES__: {
        "self-intro-greeting": true,
      },
    };

    const clientResult = getEnvFlagOverridesForScope("client");
    const assistantResult = getEnvFlagOverridesForScope("assistant");

    expect(clientResult.bool).toEqual({ selfIntroGreeting: true });
    expect(assistantResult.bool).toEqual({ selfIntroGreeting: true });
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
