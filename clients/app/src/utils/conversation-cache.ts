/**
 * The app twin of web's `utils/conversation-cache`.
 *
 * The app owns no chat surface yet — the framed `/assistant` runs web's chat
 * with its own query cache in a separate JS context, so there is nothing to
 * invalidate here after a research turn. When the chat domain rehomes, this
 * becomes its real cache invalidation.
 */
import type { QueryClient } from "@tanstack/react-query";

export function invalidateConversationQueries(
  _queryClient: QueryClient,
  _assistantId?: string,
): void {}
