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

  test("exposes session grouping to both flag stores defaulting off", () => {
    expect(CLIENT_FLAG_DEFAULTS.sessionGroups).toBe(false);
    expect(ASSISTANT_FLAG_DEFAULTS.sessionGroups).toBe(false);
    expect("sessionGroups" in CLIENT_STRING_FLAG_DEFAULTS).toBe(false);
    expect("sessionGroups" in ASSISTANT_STRING_FLAG_DEFAULTS).toBe(false);
  });

  test("does not expose GA collapsed assistant intermediates as a feature flag", () => {
    expect("collapseAssistantIntermediates" in CLIENT_FLAG_DEFAULTS).toBe(
      false,
    );
    expect("collapseAssistantIntermediates" in ASSISTANT_FLAG_DEFAULTS).toBe(
      false,
    );
  });

  test("exposes the activation checklist as a client string flag defaulted off", () => {
    expect(
      CLIENT_STRING_FLAG_DEFAULTS.experimentActivationChecklist20260910,
    ).toBe("off");
    expect(
      "experimentActivationChecklist20260910" in CLIENT_FLAG_DEFAULTS,
    ).toBe(false);
    expect(
      "experimentActivationChecklist20260910" in ASSISTANT_FLAG_DEFAULTS,
    ).toBe(false);
    expect(
      "experimentActivationChecklist20260910" in ASSISTANT_STRING_FLAG_DEFAULTS,
    ).toBe(false);
  });

  test("does not expose the GA billing CTA experiment as a feature flag", () => {
    expect("experimentBillingCta20260723" in CLIENT_STRING_FLAG_DEFAULTS).toBe(
      false,
    );
    expect("experimentBillingCta20260723" in CLIENT_FLAG_DEFAULTS).toBe(false);
    expect("experimentBillingCta20260723" in ASSISTANT_FLAG_DEFAULTS).toBe(
      false,
    );
  });

  test("does not expose retired proactive tips as a feature flag", () => {
    expect("proactiveTips" in CLIENT_STRING_FLAG_DEFAULTS).toBe(false);
    expect("proactiveTips" in CLIENT_FLAG_DEFAULTS).toBe(false);
    expect("proactiveTips" in ASSISTANT_FLAG_DEFAULTS).toBe(false);
    expect("proactiveTips" in ASSISTANT_STRING_FLAG_DEFAULTS).toBe(false);
  });

  test("does not expose GA empty-state greetings as a feature flag", () => {
    expect("emptyStateDynamicGreetings" in ASSISTANT_FLAG_DEFAULTS).toBe(false);
    expect("emptyStateDynamicGreetings" in CLIENT_FLAG_DEFAULTS).toBe(false);
  });

  test("does not expose GA quote reply as a feature flag", () => {
    expect("quoteReply" in CLIENT_FLAG_DEFAULTS).toBe(false);
    expect("quoteReply" in ASSISTANT_FLAG_DEFAULTS).toBe(false);
  });

  test("does not expose GA web remote ingress as a feature flag", () => {
    expect("webRemoteIngress" in CLIENT_FLAG_DEFAULTS).toBe(false);
    expect("webRemoteIngress" in ASSISTANT_FLAG_DEFAULTS).toBe(false);
  });

  test("does not expose the GA assistant switcher as a feature flag", () => {
    expect("assistantSwitcher" in CLIENT_FLAG_DEFAULTS).toBe(false);
    expect("assistantSwitcher" in ASSISTANT_FLAG_DEFAULTS).toBe(false);
  });

  test("does not expose a page-level MCP gate", () => {
    expect("mcpSettings" in ASSISTANT_FLAG_DEFAULTS).toBe(false);
  });

  test("does not expose the GA iOS avatar app icon as a feature flag", () => {
    expect("iosAvatarAppIcon" in CLIENT_FLAG_DEFAULTS).toBe(false);
    expect("iosAvatarAppIcon" in ASSISTANT_FLAG_DEFAULTS).toBe(false);
    expect("iosAvatarAppIcon" in CLIENT_STRING_FLAG_DEFAULTS).toBe(false);
    expect("iosAvatarAppIcon" in ASSISTANT_STRING_FLAG_DEFAULTS).toBe(false);
  });

  test("does not expose GA summarize-up-to-here as a feature flag", () => {
    expect("summarizeUpToHere" in CLIENT_FLAG_DEFAULTS).toBe(false);
    expect("summarizeUpToHere" in ASSISTANT_FLAG_DEFAULTS).toBe(false);
  });

  test("does not expose the retired balanced-model experiment as a feature flag", () => {
    expect("experimentBalancedModel20260831" in CLIENT_FLAG_DEFAULTS).toBe(
      false,
    );
    expect("experimentBalancedModel20260831" in ASSISTANT_FLAG_DEFAULTS).toBe(
      false,
    );
    expect(
      "experimentBalancedModel20260831" in CLIENT_STRING_FLAG_DEFAULTS,
    ).toBe(false);
    expect(
      "experimentBalancedModel20260831" in ASSISTANT_STRING_FLAG_DEFAULTS,
    ).toBe(false);
  });

  test("does not expose GA desktop presence suppression as a feature flag", () => {
    expect("desktopPresenceSuppression" in CLIENT_FLAG_DEFAULTS).toBe(false);
    expect("desktopPresenceSuppression" in ASSISTANT_FLAG_DEFAULTS).toBe(false);
    expect("desktopPresenceSuppression" in CLIENT_STRING_FLAG_DEFAULTS).toBe(
      false,
    );
    expect("desktopPresenceSuppression" in ASSISTANT_STRING_FLAG_DEFAULTS).toBe(
      false,
    );
  });

  test("does not expose GA Link by Stripe as a feature flag", () => {
    expect("stripeLinkOauth" in CLIENT_FLAG_DEFAULTS).toBe(false);
    expect("stripeLinkOauth" in ASSISTANT_FLAG_DEFAULTS).toBe(false);
    expect("stripeLinkOauth" in CLIENT_STRING_FLAG_DEFAULTS).toBe(false);
    expect("stripeLinkOauth" in ASSISTANT_STRING_FLAG_DEFAULTS).toBe(false);
  });

  test("does not expose the GA Assistant Inbox as a feature flag", () => {
    expect("assistantInbox" in CLIENT_FLAG_DEFAULTS).toBe(false);
    expect("assistantInbox" in ASSISTANT_FLAG_DEFAULTS).toBe(false);
    expect("assistantInbox" in CLIENT_STRING_FLAG_DEFAULTS).toBe(false);
    expect("assistantInbox" in ASSISTANT_STRING_FLAG_DEFAULTS).toBe(false);
  });

  test("does not expose GA teleport as a feature flag", () => {
    expect("teleport" in CLIENT_FLAG_DEFAULTS).toBe(false);
    expect("teleport" in ASSISTANT_FLAG_DEFAULTS).toBe(false);
    expect("teleport" in CLIENT_STRING_FLAG_DEFAULTS).toBe(false);
    expect("teleport" in ASSISTANT_STRING_FLAG_DEFAULTS).toBe(false);
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
        "experiment-activation-checklist-2026-09-10": "variant-a",
      },
    };

    const result = getEnvFlagOverridesForScope("client");
    expect(result.bool).toEqual({ velvet: true });
    expect(result.str).toEqual({
      experimentActivationChecklist20260910: "variant-a",
    });
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
