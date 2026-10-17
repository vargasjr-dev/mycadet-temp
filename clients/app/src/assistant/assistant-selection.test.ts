import { expect, test } from "bun:test";
import {
  assistantSelectionState,
  selectedAssistantId,
} from "./assistant-selection";

test("route selection is scoped to its API base", () => {
  const host = {
    cloudUrl: "https://host.example/admin/",
  };
  const state = assistantSelectionState("assistant-2", host);
  expect(selectedAssistantId(state, host)).toBe("assistant-2");
  expect(
    selectedAssistantId(state, { ...host, cloudUrl: "/" }),
  ).toBeUndefined();
  expect(
    selectedAssistantId(assistantSelectionState("assistant-1", {}), {}),
  ).toBe("assistant-1");
});

test("malformed browser history never supplies an assistant selection", () => {
  for (const value of [
    null,
    {},
    { assistantSelection: null },
    { assistantSelection: { id: 123, apiBaseUrl: "/" } },
    { assistantSelection: { id: "", apiBaseUrl: "/" } },
  ]) {
    expect(selectedAssistantId(value, {})).toBeUndefined();
  }
});
