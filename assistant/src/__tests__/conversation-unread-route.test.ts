import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { getAttentionStateByConversationIds } from "../persistence/conversation-attention-store.js";
import {
  addMessage,
  ensureConversationExists,
} from "../persistence/conversation-crud.js";
import { initializeDb } from "../persistence/db-init.js";
import { RuntimeHttpServer } from "../runtime/http-server.js";
import { ROUTES } from "../runtime/routes/index.js";

/**
 * Look up the policy on a route by endpoint+method. Returns null when
 * the route isn't found or has no policy declared — both surface as
 * test failures via the explicit assertion below.
 */
function routePolicy(endpoint: string, method?: string) {
  const route = ROUTES.find(
    (r) => r.endpoint === endpoint && (!method || r.method === method),
  );
  return route?.policy ?? null;
}

describe("POST /v1/conversations/unread", () => {
  let server: RuntimeHttpServer;
  let port: number;

  beforeAll(async () => {
    await initializeDb();
    // The HTTP adapter only serves unauthenticated local requests when HTTP
    // auth is disabled (the gateway-fronted deployment posture).
    process.env.DISABLE_HTTP_AUTH = "true";
  });

  afterAll(async () => {
    delete process.env.DISABLE_HTTP_AUTH;
    await server?.stop();
  });

  async function startServer(): Promise<void> {
    port = 20000 + Math.floor(Math.random() * 1000);
    server = new RuntimeHttpServer({ port });
    await server.start();
  }

  async function stopServer(): Promise<void> {
    await server?.stop();
  }

  function unreadUrl(): string {
    return `http://127.0.0.1:${port}/v1/conversations/unread`;
  }

  test("registers the unread route with chat.write policy", () => {
    expect(routePolicy("conversations/unread")).toEqual({
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ["actor", "svc_gateway", "svc_daemon", "local"],
    });
  });

  test("returns BAD_REQUEST when conversationId is missing", async () => {
    await startServer();

    const res = await fetch(unreadUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "BAD_REQUEST",
        message: "Missing conversationId",
      },
    });

    await stopServer();
  });

  test("marks a conversation unread", async () => {
    ensureConversationExists("conv-123", "telegram");
    addMessage("conv-123", "assistant", "the only assistant reply");

    await startServer();

    const res = await fetch(unreadUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: "conv-123" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // Unread = seen cursor behind the latest assistant message. With a single
    // assistant message there is no previous one, so the seen cursor is null.
    const state = getAttentionStateByConversationIds(["conv-123"]).get(
      "conv-123",
    );
    expect(state?.latestAssistantMessageId).not.toBeNull();
    expect(state?.lastSeenAssistantMessageId).toBeNull();

    await stopServer();
  });

  test("returns UNPROCESSABLE_ENTITY when the conversation has no assistant message", async () => {
    // Real store semantics: no assistant message means no cursor to mark
    // unread against, and markConversationUnread throws this exact UserError.
    ensureConversationExists("conv-no-assistant", "telegram");

    await startServer();

    const res = await fetch(unreadUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: "conv-no-assistant" }),
    });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: {
        code: "UNPROCESSABLE_ENTITY",
        message: "Conversation has no assistant message to mark unread",
      },
    });

    await stopServer();
  });
});
