import { expect, test } from "bun:test";

import { shouldRetrieveTurnMemory } from "../turn-retrieval.js";

test("fresh retrieval defaults on, except for front-door and explicitly skipped turns", () => {
  expect(shouldRetrieveTurnMemory({ conversationId: "conv-a" })).toBe(true);
  expect(
    shouldRetrieveTurnMemory({
      conversationId: "conv-a",
      callSite: "callAgent",
    }),
  ).toBe(true);
  expect(
    shouldRetrieveTurnMemory({
      conversationId: "conv-a",
      callSite: "voiceFrontDoor",
    }),
  ).toBe(false);
  expect(
    shouldRetrieveTurnMemory({
      conversationId: "conv-a",
      callSite: "callAgent",
      skipMemoryRetrieval: true,
    }),
  ).toBe(false);
  expect(
    shouldRetrieveTurnMemory({
      conversationId: "conv-a",
      callSite: "callAgent",
      skipMemoryRetrieval: false,
    }),
  ).toBe(true);
});

test("a conversation without an explicit opt-out never gates retrieval", () => {
  // The opt-out resolves fail-open (`memory-injection-store.ts`): an
  // unreadable memory database or a conversation with no flag never gates,
  // so the helper's verdict is unchanged for it.
  expect(
    shouldRetrieveTurnMemory({
      conversationId: "conv-a",
      callSite: "callAgent",
    }),
  ).toBe(true);
});
