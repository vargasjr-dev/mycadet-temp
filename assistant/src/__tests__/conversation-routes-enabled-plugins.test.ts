/**
 * Tests for per-conversation `enabledPlugins` wiring in the POST /v1/messages
 * handler.
 *
 * Validates that when a message mints/targets a conversation:
 * - `enabledPlugins: [...]` is applied to the live conversation via
 *   `setEnabledPlugins`, which persists to the row (setConversationEnabledPlugins)
 *   under the hood, observable via getEffectiveEnabledPluginSet.
 * - `[]` scopes the chat to no plugins (empty set).
 * - explicit `null` clears to the default (no per-chat restriction).
 * - omitting the field leaves the stored value untouched (no persist call).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { Message } from "../providers/types.js";
import { AssistantEventHub } from "../runtime/assistant-event-hub.js";
import { jsonObjectSchema } from "./helpers/json-object-schema.js";

process.env.DISABLE_HTTP_AUTH = "true";

const addMessageMock = mock(async (_conversationId: string, role: string) => ({
  id: role === "user" ? "persisted-user-id" : "persisted-assistant-id",
  deduplicated: false,
}));

const setConversationEnabledPluginsMock = mock(
  (_conversationId: string, _plugins: string[] | null) => {},
);

mock.module("../persistence/conversation-key-store.js", () => ({
  getOrCreateConversation: () => ({ conversationId: "conv-plugins-test" }),
  getConversationByKey: () => null,
}));

mock.module("../runtime/guardian-reply-router.js", () => ({
  routeGuardianReply: async () => ({
    consumed: false,
    decisionApplied: false,
    type: "not_consumed",
  }),
}));

mock.module("../channels/gateway-guardian-requests.js", () => ({
  createGuardianRequest: async (params: Record<string, unknown>) => ({
    ...params,
    requestCode: "ABC123",
  }),
}));

mock.module("../runtime/confirmation-request-guardian-bridge.js", () => ({
  bridgeConfirmationRequestToGuardian: async () => undefined,
}));

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  addMessage: (conversationId: string, role: string) =>
    addMessageMock(conversationId, role),
  extractImageSourcePaths: () => undefined,
  getConversation: () => null,
  getConversationOverrideProfile: () => undefined,
  getMessages: () => [],
  provenanceFromTrustContext: (ctx: unknown) =>
    ctx
      ? { provenanceTrustClass: jsonObjectSchema.parse(ctx).trustClass }
      : { provenanceTrustClass: "unknown" },
  setConversationOriginChannelIfUnset: () => {},
  setConversationOriginInterfaceIfUnset: () => {},
  setConversationInferenceProfile: () => {},
  setConversationEnabledPlugins: (
    conversationId: string,
    plugins: string[] | null,
  ) => setConversationEnabledPluginsMock(conversationId, plugins),
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
  recordConversationPersistedSeq: () => {},
}));

mock.module("../persistence/conversation-disk-view.js", () => ({
  syncMessageToDisk: () => {},
  updateMetaFile: () => {},
}));

mock.module("../persistence/attachments-store.js", () => ({
  getAttachmentsByIds: () => [],
  resolveAttachmentsForPersist: () => [],
  attachmentExists: () => false,
  linkAttachmentToMessage: () => {},
  attachInlineAttachmentToMessage: () => {},
  validateAttachmentUpload: () => ({ ok: true }),
}));

mock.module("../daemon/conversation-process.js", () => ({
  buildModelInfoEvent: () => ({
    type: "model_info",
    model: "claude-opus-4-7",
    provider: "anthropic",
    configuredProviders: ["anthropic"],
  }),
  isModelSlashCommand: () => false,
  formatCompactResult: () => "",
}));

const realLocalActorIdentity =
  await import("../runtime/local-actor-identity.js");
mock.module("../runtime/local-actor-identity.js", () => ({
  ...realLocalActorIdentity,
}));

mock.module("../runtime/trust-context-resolver.js", () => ({
  resolveTrustContext: () => ({
    trustClass: "guardian",
    sourceChannel: "cadet",
  }),
  withSourceChannel: (sourceChannel: unknown, ctx: unknown) => ({
    ...jsonObjectSchema.parse(ctx),
    sourceChannel,
  }),
}));

mock.module("../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: async () => [
    {
      channelType: "cadet",
      contactId: "guardian-contact",
      principalId: "test-user",
      address: "test-user",
      status: "active",
    },
  ],
}));

const ipcCallMock = mock(
  async (): Promise<Record<string, unknown> | undefined> => ({ ok: true }),
);
mock.module("../ipc/gateway-client.js", () => ({
  ipcCall: ipcCallMock,
}));

import { getEffectiveEnabledPluginSet } from "../daemon/conversation-tool-setup.js";
import { handleSendMessage } from "../runtime/routes/conversation-routes.js";
import { callHandler } from "./helpers/call-route-handler.js";
import {
  asConversation,
  mockMessageQueue,
  mockUnownedModeSessions,
} from "./helpers/mock-conversation.js";

function makeConversation() {
  const runAgentLoop = mock(async () => undefined);
  const persistUserMessage = mock(async () => ({
    id: "persisted-user-id",
    deduplicated: false,
  }));
  const messages: Message[] = [];
  let processing = false;
  const conversation = asConversation({
    conversationId: "conv-plugins-test",
    messages,
    abortController: null,
    currentRequestId: undefined,
    modeSessions: mockUnownedModeSessions(),
    queue: mockMessageQueue({ length: 0 }),
    setTrustContext: () => {},
    replayActivityState: () => {},
    emitConfirmationStateChanged: () => {},
    emitActivityState: () => {},
    setTurnChannelContext: () => {},
    setTurnInterfaceContext: () => {},
    getTurnChannelContext: () => null,
    getTurnInterfaceContext: () => null,
    ensureActorScopedHistory: async () => {},
    isProcessing: () => processing,
    setProcessing: (value: boolean) => {
      processing = value;
    },
    // Mirrors the real Conversation.setEnabledPlugins, which persists to the
    // row via setConversationEnabledPlugins as it updates the live instance.
    setEnabledPlugins: (plugins: string[] | null): void => {
      conversation.enabledPlugins = plugins;
      setConversationEnabledPluginsMock("conv-plugins-test", plugins);
    },
    hasAnyPendingConfirmation: () => false,
    denyAllPendingConfirmations: () => {},
    enqueueMessage: () => ({ queued: true, requestId: "queued-id" }),
    persistUserMessage,
    runAgentLoop,
    setPreactivatedSkillIds: () => {},
    drainQueue: async (_reason?: string) => {},
    kickDrainQueue(
      this: { drainQueue: (reason?: string) => Promise<void> },
      reason: string = "loop_complete",
      _origin?: string,
    ) {
      return this.drainQueue(reason);
    },
    warmPromptCache: async () => {},
    getMessages: () => messages,
    assistantId: "self",
    trustContext: undefined,
    hasPendingConfirmation: () => false,
    setHostBrowserProxy: () => {},
    setHostCuProxy: () => {},
    addPreactivatedSkillId: () => {},
    usageStats: { inputTokens: 1000, outputTokens: 500, estimatedCost: 0.05 },
  });
  conversation.enabledPlugins = null;
  return { conversation, runAgentLoop };
}

function makeRequest(extras: Record<string, unknown> = {}) {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-cadet-actor-principal-id": "test-user",
      "x-cadet-principal-type": "actor",
    },
    body: JSON.stringify({
      conversationKey: "plugins-test-key",
      content: "hello there",
      sourceChannel: "cadet",
      interface: "macos",
      ...extras,
    }),
  });
}

function makeDeps(
  conversation: import("../daemon/conversation.js").Conversation,
) {
  return {
    sendMessageDeps: {
      getOrCreateConversation: async () => conversation,
      assistantEventHub: Object.assign(new AssistantEventHub(), {
        publish: async () => {},
      }),
      resolveAttachments: () => [],
    },
  };
}

describe("handleSendMessage enabledPlugins", () => {
  beforeEach(() => {
    addMessageMock.mockClear();
    setConversationEnabledPluginsMock.mockClear();
    ipcCallMock.mockClear();
  });

  afterEach(() => {
    setConversationEnabledPluginsMock.mockClear();
  });

  test("persists and applies enabledPlugins when minting a conversation", async () => {
    const { conversation } = makeConversation();
    const res = await callHandler(
      (args) => handleSendMessage(args, makeDeps(conversation)),
      makeRequest({ enabledPlugins: ["a", "b"] }),
      undefined,
      202,
    );

    expect(res.status).toBe(202);

    // Persisted to the conversation row.
    expect(setConversationEnabledPluginsMock).toHaveBeenCalledTimes(1);
    expect(setConversationEnabledPluginsMock).toHaveBeenCalledWith(
      "conv-plugins-test",
      ["a", "b"],
    );

    // Applied to the live conversation instance: the user's selection, unioned
    // with the always-on first-party defaults (which the pills never list).
    const effective = getEffectiveEnabledPluginSet(conversation);
    expect(effective?.has("a")).toBe(true);
    expect(effective?.has("b")).toBe(true);
    expect(effective?.has("default-memory")).toBe(true);
  });

  test("empty array scopes the chat to no plugins", async () => {
    const { conversation } = makeConversation();
    const res = await callHandler(
      (args) => handleSendMessage(args, makeDeps(conversation)),
      makeRequest({ enabledPlugins: [] }),
      undefined,
      202,
    );

    expect(res.status).toBe(202);
    expect(setConversationEnabledPluginsMock).toHaveBeenCalledWith(
      "conv-plugins-test",
      [],
    );
    // No user plugins are in scope, but the always-on first-party defaults are
    // never filtered out — core runtime infra must keep running.
    const effective = getEffectiveEnabledPluginSet(conversation);
    expect(effective).not.toBeNull();
    expect(effective?.has("default-memory")).toBe(true);
    expect(effective?.has("a")).toBe(false);
  });

  test("explicit null clears to the default (no per-chat restriction)", async () => {
    const { conversation } = makeConversation();
    conversation.enabledPlugins = ["pre-existing"];
    const res = await callHandler(
      (args) => handleSendMessage(args, makeDeps(conversation)),
      makeRequest({ enabledPlugins: null }),
      undefined,
      202,
    );

    expect(res.status).toBe(202);
    expect(setConversationEnabledPluginsMock).toHaveBeenCalledWith(
      "conv-plugins-test",
      null,
    );
    expect(getEffectiveEnabledPluginSet(conversation)).toBeNull();
  });

  test("omitting the field leaves the stored value untouched", async () => {
    const { conversation } = makeConversation();
    const res = await callHandler(
      (args) => handleSendMessage(args, makeDeps(conversation)),
      makeRequest(),
      undefined,
      202,
    );

    expect(res.status).toBe(202);
    expect(setConversationEnabledPluginsMock).not.toHaveBeenCalled();
    expect(getEffectiveEnabledPluginSet(conversation)).toBeNull();
  });

  test("rejects non-array, non-null enabledPlugins values", async () => {
    const { conversation } = makeConversation();
    const res = await callHandler(
      (args) => handleSendMessage(args, makeDeps(conversation)),
      makeRequest({ enabledPlugins: "not-an-array" }),
      undefined,
      202,
    );

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("enabledPlugins");
    expect(setConversationEnabledPluginsMock).not.toHaveBeenCalled();
  });
});
