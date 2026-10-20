import { expect, test } from "bun:test";
import {
  assistantSelectionState,
  selectedAssistantId,
} from "./assistant-selection";

test("selection state carries just the assistant id", () => {
  const state = assistantSelectionState("assistant-2");
  expect(state.assistantSelection.id).toBe("assistant-2");
  expect(selectedAssistantId(state)).toBe("assistant-2");
});

test("legacy state carrying an old api-base tag still resolves", () => {
  // Selections written before the same-origin flip tagged the api base;
  // zod strips unknown keys, so stale tags resolve like any other state.
  expect(
    selectedAssistantId({
      assistantSelection: {
        id: "assistant-2",
        apiBaseUrl: "https://cloud.mycadet.ai",
      },
    }),
  ).toBe("assistant-2");
});

test("malformed browser history never supplies an assistant selection", () => {
  for (const value of [
    null,
    {},
    { assistantSelection: null },
    { assistantSelection: { id: 123 } },
    { assistantSelection: { id: "" } },
  ]) {
    expect(selectedAssistantId(value)).toBeUndefined();
  }
});
