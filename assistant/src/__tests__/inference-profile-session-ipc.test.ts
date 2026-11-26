/**
 * Round-trip tests for the three inference-profile session IPC ops:
 * inference_profile_open, inference_profile_close, inference_profile_list.
 *
 * These tests exercise the route handler functions (the IPC-facing entry
 * points) rather than the shared helper directly.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { inferenceProfileSessionResponseSchema } from "../runtime/routes/inference-profile-session-schema.js";

setHubPublishOverrideForTesting(async () => {});

mock.module("../runtime/assistant-event.js", () => ({
  buildAssistantEvent: (event: unknown) => event,
}));

// "balanced"/"cost-optimized" route through the Cadet Cloud connection, and
// the open handler's availability guard judges that route for real. Stand in
// for a signed-in platform session so these tests exercise the healthy path.
mock.module("../providers/cloud-proxy/context.js", () => ({
  resolveCloudProxyContext: async () => ({
    enabled: true,
    cloudBaseUrl: "https://test-cloud.mycadet.ai",
    assistantApiKey: "key",
  }),
}));

// The handler resolves "balanced"/"cost-optimized" through the code-defined
// default profile catalog and reads `llm.profileSession` schema defaults
// (1800/43200), so real config with no seeding covers these tests.

import { createConversation } from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  conversationAssistantAttentionState,
  conversationKeys,
  conversations,
  externalConversationBindings,
  messages,
} from "../persistence/schema/index.js";
import { providerConnections } from "../persistence/schema/inference.js";
import { setHubPublishOverrideForTesting } from "../runtime/assistant-event-hub.js";
import {
  closeInferenceProfileSessionResponseSchema,
  listInferenceProfileSessionsResponseSchema,
  ROUTES,
} from "../runtime/routes/inference-profile-session-routes.js";
import { resetDbForTesting } from "./db-test-helpers.js";

await initializeDb();

// The Cadet Cloud connection row the default profiles resolve to.
getDb()
  .insert(providerConnections)
  .values({
    name: "cadet",
    provider: "cadet",
    auth: JSON.stringify({ type: "platform" }),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  .onConflictDoNothing()
  .run();

const openRoute = ROUTES.find(
  (r) => r.operationId === "inference_profile_open",
)!;
const closeRoute = ROUTES.find(
  (r) => r.operationId === "inference_profile_close",
)!;
const listRoute = ROUTES.find(
  (r) => r.operationId === "inference_profile_list",
)!;

function clearTables(): void {
  const db = getDb();
  db.delete(conversationAssistantAttentionState).run();
  db.delete(externalConversationBindings).run();
  db.delete(conversationKeys).run();
  db.delete(messages).run();
  db.delete(conversations).run();
}

describe("inference_profile_open IPC op", () => {
  beforeEach(clearTables);
  afterAll(() => {
    resetDbForTesting();
    mock.restore();
  });

  test("opens a session with TTL and returns sessionId + expiresAt", async () => {
    const conv = createConversation("ipc-open-ttl");

    const result = inferenceProfileSessionResponseSchema.parse(
      await openRoute.handler({
        body: { conversationId: conv.id, profile: "balanced", ttlSeconds: 300 },
        headers: {},
      }),
    );

    expect(result).toMatchObject({
      conversationId: conv.id,
      profile: "balanced",
      replaced: null,
    });
    expect(result.sessionId).not.toBeNull();
    if (result.expiresAt === null) {
      throw new Error("Expected the session to expire");
    }
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  test("opens a sticky session (no ttlSeconds) — sessionId=null, expiresAt=null", async () => {
    const conv = createConversation("ipc-open-sticky");

    const result = await openRoute.handler({
      body: { conversationId: conv.id, profile: "balanced" },
      headers: {},
    });

    expect(result).toMatchObject({
      conversationId: conv.id,
      profile: "balanced",
      sessionId: null,
      expiresAt: null,
      replaced: null,
    });
  });

  test("rejects profile=null with BadRequestError", async () => {
    const conv = createConversation("ipc-open-null-profile");

    await expect(
      openRoute.handler({
        body: { conversationId: conv.id, profile: null },
        headers: {},
      }),
    ).rejects.toThrow("profile must be a non-empty string");
  });

  test("replaced carries prior session when opening over an active session", async () => {
    const conv = createConversation("ipc-open-replace");

    const first = inferenceProfileSessionResponseSchema.parse(
      await openRoute.handler({
        body: { conversationId: conv.id, profile: "balanced", ttlSeconds: 300 },
        headers: {},
      }),
    );

    const second = inferenceProfileSessionResponseSchema.parse(
      await openRoute.handler({
        body: {
          conversationId: conv.id,
          profile: "cost-optimized",
          ttlSeconds: 600,
        },
        headers: {},
      }),
    );

    expect(second.replaced).not.toBeNull();
    expect(second.replaced!.profile).toBe("balanced");
    expect(second.replaced!.sessionId).toBe(first.sessionId);
  });
});

describe("inference_profile_close IPC op", () => {
  beforeEach(clearTables);

  test("closes an active session — noop=false, closed carries profile and sessionId", async () => {
    const conv = createConversation("ipc-close-active");

    const opened = inferenceProfileSessionResponseSchema.parse(
      await openRoute.handler({
        body: { conversationId: conv.id, profile: "balanced", ttlSeconds: 300 },
        headers: {},
      }),
    );

    const result = closeInferenceProfileSessionResponseSchema.parse(
      await closeRoute.handler({
        body: { conversationId: conv.id },
        headers: {},
      }),
    );

    expect(result.noop).toBe(false);
    expect(result.closed).not.toBeNull();
    expect(result.closed!.profile).toBe("balanced");
    expect(result.closed!.sessionId).toBe(opened.sessionId);
  });

  test("close with no active session — noop=true, closed=null", async () => {
    const conv = createConversation("ipc-close-noop");

    const result = closeInferenceProfileSessionResponseSchema.parse(
      await closeRoute.handler({
        body: { conversationId: conv.id },
        headers: {},
      }),
    );

    expect(result.noop).toBe(true);
    expect(result.closed).toBeNull();
  });
});

describe("inference_profile_list IPC op", () => {
  beforeEach(clearTables);

  test("lists active sessions across all conversations when no filter", async () => {
    const conv1 = createConversation("ipc-list-all-1");
    const conv2 = createConversation("ipc-list-all-2");

    await openRoute.handler({
      body: { conversationId: conv1.id, profile: "balanced", ttlSeconds: 300 },
      headers: {},
    });
    await openRoute.handler({
      body: {
        conversationId: conv2.id,
        profile: "cost-optimized",
        ttlSeconds: 600,
      },
      headers: {},
    });

    const result = listInferenceProfileSessionsResponseSchema.parse(
      await listRoute.handler({
        queryParams: {},
        headers: {},
      }),
    );

    expect(result.sessions.length).toBeGreaterThanOrEqual(2);
    const ids = result.sessions.map((s) => s.conversationId);
    expect(ids).toContain(conv1.id);
    expect(ids).toContain(conv2.id);
  });

  test("scopes to a single conversation when conversationId filter is provided", async () => {
    const conv1 = createConversation("ipc-list-filter-1");
    const conv2 = createConversation("ipc-list-filter-2");

    await openRoute.handler({
      body: { conversationId: conv1.id, profile: "balanced", ttlSeconds: 300 },
      headers: {},
    });
    await openRoute.handler({
      body: {
        conversationId: conv2.id,
        profile: "cost-optimized",
        ttlSeconds: 600,
      },
      headers: {},
    });

    const result = listInferenceProfileSessionsResponseSchema.parse(
      await listRoute.handler({
        queryParams: { conversationId: conv1.id },
        headers: {},
      }),
    );

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].conversationId).toBe(conv1.id);
  });

  test("returns empty list when no active session for the given conversationId", async () => {
    const conv = createConversation("ipc-list-empty");

    const result = listInferenceProfileSessionsResponseSchema.parse(
      await listRoute.handler({
        queryParams: { conversationId: conv.id },
        headers: {},
      }),
    );

    expect(result.sessions).toHaveLength(0);
  });
});
