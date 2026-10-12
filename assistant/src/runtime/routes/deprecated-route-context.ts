/**
 * Deprecated `/x/*` route context — a compatibility shim.
 *
 * Route handlers now reach daemon capabilities through `@mycadet/plugin-api`
 * (`publishEvent`, `runConversationTurn`), which work identically in-process and
 * in the route-host subprocess. Installed route files written against the older
 * `(request, context)` signature keep working: each `context` field delegates
 * to its plugin-api equivalent.
 *
 * The handler's second parameter is deprecated — prefer importing from
 * `@mycadet/plugin-api` directly in new handlers.
 */

import { runConversationTurn } from "../../plugin-api/conversation-turn.js";
import { publishEvent } from "../../plugin-api/publish-event.js";

/**
 * The deprecated second argument passed to `/x/*` route handlers. Every member
 * is a thin shim over `@mycadet/plugin-api`; prefer importing from there
 * directly in new handlers.
 */
export interface UserRouteContext {
  /**
   * @deprecated Import `publishEvent` from `@mycadet/plugin-api` instead.
   * `publish` forwards to it verbatim.
   */
  readonly assistantEventHub: { publish: typeof publishEvent };
  /**
   * @deprecated Import `runConversationTurn` from `@mycadet/plugin-api`
   * instead. `postMessage` runs a turn with the text as a single content block.
   */
  readonly conversations: {
    postMessage(
      conversationId: string,
      text: string,
    ): Promise<{ messageId: string }>;
  };
}

/**
 * Build the deprecated `context` argument for a handler serving `routePath`.
 * The route path is captured so a use signal can be attributed to the specific
 * route that must migrate. The object is frozen so a handler cannot corrupt the
 * shared shim by reassigning its members.
 */
export function buildDeprecatedRouteContext(): UserRouteContext {
  return Object.freeze({
    assistantEventHub: Object.freeze({
      publish: (
        event: Parameters<typeof publishEvent>[0],
        options?: Parameters<typeof publishEvent>[1],
      ): ReturnType<typeof publishEvent> => {
        return publishEvent(event, options);
      },
    }),
    conversations: Object.freeze({
      postMessage: async (
        conversationId: string,
        text: string,
      ): Promise<{ messageId: string }> => {
        const { userMessageId } = await runConversationTurn({
          conversationId,
          content: [{ type: "text", text }],
        });
        return { messageId: userMessageId };
      },
    }),
  });
}
