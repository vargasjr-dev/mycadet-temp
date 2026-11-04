import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getAssistantDisplayName } from "@/stores/resolved-assistant-store";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

beforeEach(() => {
  window.__CADET_CONFIG__ = { remote: "local" };
});

afterEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("getAssistantDisplayName", () => {
  test("prefers the live identity-store name over the injected config", () => {
    window.__CADET_CONFIG__ = {
      remote: "docker",
      assistantName: "cadet-deep-hare-ww1iw1",
    };
    useAssistantIdentityStore.getState().setIdentity("Credence", "1.0.0");

    expect(getAssistantDisplayName()).toBe("Credence");
  });

  test("falls back to the injected config for a whitespace-only live name", () => {
    window.__CADET_CONFIG__ = {
      remote: "docker",
      assistantName: "cadet-deep-hare-ww1iw1",
    };
    useAssistantIdentityStore.getState().setIdentity("   ", "1.0.0");

    expect(getAssistantDisplayName()).toBe("cadet-deep-hare-ww1iw1");
  });

  test("is undefined when neither source carries a name", () => {
    window.__CADET_CONFIG__ = { remote: "docker" };

    expect(getAssistantDisplayName()).toBeUndefined();
  });
});
