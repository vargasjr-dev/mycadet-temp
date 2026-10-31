import { describe, expect, test } from "bun:test";

import {
  getActiveAssistantId,
  getResolvedAssistant,
  useResolvedAssistantStore,
} from "./resolved-assistant-store";

const LOCAL_ENTRY = {
  cloud: "local" as const,
  assistantId: "asst-1",
  port: 0,
};

describe("useResolvedAssistantStore", () => {
  test("the assistant is non-optional — the boot entry exists before any stamp", () => {
    expect(getResolvedAssistant()).toBeDefined();
    expect(typeof getActiveAssistantId()).toBe("string");
  });

  test("setAssistant stamps the one assistant; resetAssistant returns to the shell", () => {
    useResolvedAssistantStore.getState().setAssistant(LOCAL_ENTRY);
    expect(getResolvedAssistant()).toBe(LOCAL_ENTRY);
    expect(getActiveAssistantId()).toBe("asst-1");
    useResolvedAssistantStore.getState().resetAssistant();
    expect(getResolvedAssistant().assistantId).toBe("");
  });

  test("the store's module init rides the served synthesis", () => {
    // The test helper injects a config before import in suite setups; here we
    // only pin that the boot entry is a well-formed entry either way.
    const entry = getResolvedAssistant();
    expect(entry).toHaveProperty("assistantId");
    expect(entry).toHaveProperty("cloud");
  });
});
