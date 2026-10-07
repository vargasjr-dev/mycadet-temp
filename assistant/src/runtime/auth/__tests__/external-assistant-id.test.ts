/**
 * Tests for getExternalAssistantId.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  getExternalAssistantId,
  resetExternalAssistantIdCache,
} from "../external-assistant-id.js";

afterEach(() => {
  resetExternalAssistantIdCache();
  delete process.env.CADET_ASSISTANT_NAME;
});

describe("getExternalAssistantId", () => {
  test("resolves from CADET_ASSISTANT_NAME env var", () => {
    process.env.CADET_ASSISTANT_NAME = "cadet-cool-eel";
    expect(getExternalAssistantId()).toBe("cadet-cool-eel");
  });

  test("caches the resolved value", () => {
    process.env.CADET_ASSISTANT_NAME = "cadet-cool-eel";
    expect(getExternalAssistantId()).toBe("cadet-cool-eel");
    // Change env var — cached value should still be returned
    process.env.CADET_ASSISTANT_NAME = "cadet-other-fox";
    expect(getExternalAssistantId()).toBe("cadet-cool-eel");
  });

  test("returns undefined when env var is not set", () => {
    expect(getExternalAssistantId()).toBe(undefined);
  });
});
