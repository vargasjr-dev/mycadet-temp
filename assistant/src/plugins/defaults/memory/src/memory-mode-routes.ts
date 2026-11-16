/**
 * Per-conversation memory-mode operator routes: set/get one conversation's
 * mode and list the conversations with an explicit mode.
 *
 * The store is the memory plugin's own (`conversation-mode-store.ts`, memory
 * connection), so these routes are thin adapters — the main-agent surface
 * never touches the data.
 */

import { z } from "zod";

import {
  ACTOR_PRINCIPALS,
  type RoutePolicy,
} from "../../../../runtime/auth/route-policy.js";
import type { RouteDefinition } from "../../../../runtime/routes/types.js";
import {
  CONVERSATION_MEMORY_MODES,
  getConversationMemoryMode,
  listConversationMemoryModes,
  setConversationMemoryMode,
} from "../conversation-mode-store.js";

const ConversationMemoryModeSchema = z.enum([...CONVERSATION_MEMORY_MODES]);

const ConversationModeGetResultSchema = z.object({
  conversationId: z.string(),
  mode: ConversationMemoryModeSchema,
});
export type ConversationModeGetResult = z.infer<
  typeof ConversationModeGetResultSchema
>;

const ConversationModeSetResultSchema = z.object({
  conversationId: z.string(),
  mode: ConversationMemoryModeSchema,
  ok: z.boolean(),
});
export type ConversationModeSetResult = z.infer<
  typeof ConversationModeSetResultSchema
>;

const ConversationModeListResultSchema = z.object({
  modes: z.array(
    z.object({
      conversationId: z.string(),
      mode: ConversationMemoryModeSchema,
      updatedAt: z.number(),
    }),
  ),
});
export type ConversationModeListResult = z.infer<
  typeof ConversationModeListResultSchema
>;

const WRITE_POLICY: RoutePolicy = {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ACTOR_PRINCIPALS,
};

const READ_POLICY: RoutePolicy = {
  requiredScopes: ["settings.read"],
  allowedPrincipalTypes: ACTOR_PRINCIPALS,
};

const SetBodySchema = z.object({
  conversationId: z.string().min(1),
  mode: ConversationMemoryModeSchema,
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "memory_conversation_mode_set",
    method: "POST",
    policy: WRITE_POLICY,
    endpoint: "memory/conversation-mode/set",
    handler: (args) => {
      const body = SetBodySchema.parse(args.body);
      const ok = setConversationMemoryMode(body.conversationId, body.mode);
      return {
        conversationId: body.conversationId,
        mode: getConversationMemoryMode(body.conversationId),
        ok,
      };
    },
    summary:
      "Set a conversation's memory-injection mode ('standard' | 'off')",
    tags: ["memory"],
    requestBody: SetBodySchema,
    responseBody: ConversationModeSetResultSchema,
  },
  {
    operationId: "memory_conversation_mode_get",
    method: "POST",
    policy: READ_POLICY,
    endpoint: "memory/conversation-mode/get",
    handler: (args) => {
      const body = z
        .object({ conversationId: z.string().min(1) })
        .parse(args.body);
      return {
        conversationId: body.conversationId,
        mode: getConversationMemoryMode(body.conversationId),
      };
    },
    summary: "Read a conversation's memory-injection mode",
    tags: ["memory"],
    requestBody: z.object({ conversationId: z.string().min(1) }),
    responseBody: ConversationModeGetResultSchema,
  },
  {
    operationId: "memory_conversation_mode_list",
    method: "POST",
    policy: READ_POLICY,
    endpoint: "memory/conversation-mode/list",
    handler: () => ({ modes: listConversationMemoryModes() }),
    summary: "List conversations with an explicit memory-injection mode",
    tags: ["memory"],
    responseBody: ConversationModeListResultSchema,
  },
];
