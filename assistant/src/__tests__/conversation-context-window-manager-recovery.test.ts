/**
 * Recovery for the eviction race that killed turns with
 * "ContextWindowManager missing for conversation … — the compaction store
 * entry was released while the conversation is still live".
 *
 * A message accepted but not yet running reports no in-flight work, so the
 * memory-pressure eviction sweep can dispose the conversation between
 * acceptance and the turn's first manager touch. The run path rehydrates
 * history from the DB after such a teardown; the manager is the one piece the
 * turn cannot recover on its own. These tests pin that the accessor rebuilds
 * and re-registers the manager instead of failing the turn.
 */
import { describe, expect, test } from "bun:test";

import { setConfig } from "./helpers/set-config.js";

setConfig("memory", { enabled: false });

import { Conversation } from "../daemon/conversation.js";
import { createConversation } from "../persistence/conversation-crud.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  disposeContextWindowManager,
  getContextWindowManager,
} from "../plugins/defaults/compaction/manager-store.js";
import { createMockProvider } from "./helpers/mock-provider.js";

await initializeDb();

setConfig("llm", {
  default: { speed: "standard" },
  callSites: {
    mainAgent: {
      contextWindow: { maxInputTokens: 100000 },
    },
  },
});

/** A registered conversation row plus the live instance over it. */
function makeConversation(id: string): Conversation {
  createConversation(id);
  const { provider } = createMockProvider([]);
  return new Conversation(id, provider, "system prompt", () => {}, "/tmp");
}

describe("contextWindowManager accessor after a store release", () => {
  test("resolves the manager registered at construction", () => {
    const conversation = makeConversation("conv-cwm-registered");

    const registered = getContextWindowManager("conv-cwm-registered");
    expect(registered !== undefined).toBe(true);
    expect(registered === conversation.contextWindowManager).toBe(true);
  });

  test("rebuilds and re-registers instead of throwing after eviction", () => {
    const conversation = makeConversation("conv-cwm-rebuild");
    const original = conversation.contextWindowManager;

    disposeContextWindowManager("conv-cwm-rebuild");
    expect(getContextWindowManager("conv-cwm-rebuild")).toBeUndefined();

    const rebuilt = conversation.contextWindowManager;

    expect(rebuilt).toBeDefined();
    expect(rebuilt === original).toBe(false);
    const registered = getContextWindowManager("conv-cwm-rebuild");
    expect(registered !== undefined).toBe(true);
    expect(registered === rebuilt).toBe(true);
  });

  test("serves the rebuilt manager on subsequent accesses", () => {
    const conversation = makeConversation("conv-cwm-stable");
    const rebuilt = conversation.contextWindowManager;

    expect(conversation.contextWindowManager === rebuilt).toBe(true);
  });
});
