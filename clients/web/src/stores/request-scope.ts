/**
 * The identity a cloud response was produced under, read the two ways
 * consumers need it: imperatively for sequences that run outside React, and
 * reactively for components.
 *
 * `AppProviders` keys the request-scoped `QueryClient` on this string, so
 * anything that outlives a render and later writes into that cache (a redirect
 * return resolving across a full page load, say) can compare the scope it
 * started under against the scope in hand and drop a result the assistant now
 * on screen never asked for.
 */
import { getActiveAssistantId } from "@/stores/resolved-assistant-store";
import { requestScopeKey } from "@/utils/request-scope-key";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";

/**
 * The scope a request made right now would carry.
 *
 * Cloud responses are assistant-scoped — the gateway answers for the assistant
 * the session selected — so the assistant is the identity that can invalidate
 * cached data. An organization switch rides an assistant switch (the selection
 * is what resolves an org), so the assistant key covers it.
 */
export function currentRequestScopeKey(): string {
  return requestScopeKey({ assistantId: getActiveAssistantId() });
}

/** Subscribe to {@link currentRequestScopeKey}. */
export function useRequestScopeKey(): string {
  const activeAssistantId = useActiveAssistantId();
  return requestScopeKey({ assistantId: activeAssistantId });
}
