import { describe, expect, test } from "bun:test";

import {
  getActiveAssistantId,
  getResolvedAssistant,
  platformIdFor,
  resolveCloudAssistantId,
  useResolvedAssistantStore,
} from "./resolved-assistant-store";

const LOCAL_ENTRY = {
  cloud: "local" as const,
  assistantId: "asst-1",
  cloudAssistantId: "11111111-2222-4333-8444-555555555555",
};

describe("useResolvedAssistantStore", () => {
  test("starts empty — nothing is served until the shell stamps", () => {
    expect(getResolvedAssistant()).toBeNull();
    expect(getActiveAssistantId()).toBeNull();
  });

  test("setAssistant stamps the one assistant", () => {
    useResolvedAssistantStore.getState().setAssistant(LOCAL_ENTRY);
    expect(getResolvedAssistant()).toBe(LOCAL_ENTRY);
    expect(getActiveAssistantId()).toBe("asst-1");
    useResolvedAssistantStore.getState().setAssistant(null);
    expect(getActiveAssistantId()).toBeNull();
  });
});

describe("platformIdFor", () => {
  test("prefers the lockfile's registration id for a local instance", () => {
    expect(platformIdFor(LOCAL_ENTRY)).toBe(
      "11111111-2222-4333-8444-555555555555",
    );
  });

  test("an unregistered entry is its own platform id", () => {
    expect(platformIdFor({ cloud: "cloud", assistantId: "asst-2" })).toBe(
      "asst-2",
    );
  });
});

describe("resolveCloudAssistantId", () => {
  test("resolves the served assistant through its registration", () => {
    useResolvedAssistantStore.getState().setAssistant(LOCAL_ENTRY);
    expect(resolveCloudAssistantId("asst-1")).toBe(
      "11111111-2222-4333-8444-555555555555",
    );
    useResolvedAssistantStore.getState().setAssistant(null);
  });

  test("an id other than the served assistant is its own platform id", () => {
    useResolvedAssistantStore.getState().setAssistant(LOCAL_ENTRY);
    expect(resolveCloudAssistantId("asst-other")).toBe("asst-other");
    useResolvedAssistantStore.getState().setAssistant(null);
  });
});
