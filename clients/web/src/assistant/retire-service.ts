import type { QueryClient } from "@tanstack/react-query";

import {
  type RetireAssistantOptions,
  retireAssistantById,
} from "@/assistant/api";
import { forgetAssistantAvatar } from "@/hooks/use-chooser-row-avatar";
import {
  getLockfile,
  isLocalAssistant,
  isLocalClient,
  retireLocalAssistant,
} from "@/lib/local-mode";
import { resolveNavigation } from "@/lib/navigation/navigation-resolver";
import { buildNavigationState } from "@/lib/navigation/build-state";
import { forgetAssistantOnboarded } from "@/domains/onboarding/onboarded-assistant-record";
import { removeLocalSetting } from "@/utils/local-settings";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { routes } from "@/utils/routes";

/**
 * localStorage key the cloud marketing site (`web/src/lib/hooks/
 * use-navbar-auth.ts`, `ASSISTANT_NAME_CACHE_KEY`) uses to cache the assistant
 * name for its nav/CTA. Same-origin on the assistant host, so retire clears it
 * here — the two sides must agree on this string.
 */
const MARKETING_ASSISTANT_NAME_CACHE_KEY = "cadet_assistant_name";

/**
 * Outcome of a retire attempt. On success carries the route the caller should
 * navigate to; navigation and toasts are left to the caller (a hook-free
 * service can't own routing). On failure carries a user-facing message.
 */
export type RetireOutcome =
  | { ok: true; nextRoute: string }
  | { ok: false; error: string };

/**
 * Resolve where to send the user after a retire. Reads `hasAssistants`
 * from the resolved assistants store (already updated via `remove()`
 * before this runs) and delegates to the navigation resolver.
 */
function getPostRetireRoute(): string {
  const decision = resolveNavigation(buildNavigationState(), {
    kind: "post-retire",
  });
  return decision.action === "redirect" ? decision.to : routes.welcome;
}

/**
 * Retire the assistant identified by `assistantId`.
 *
 * Routes local vs platform by the **target** assistant's type — the entry in
 * the lockfile with this id — rather than the currently selected assistant.
 * This is what lets a caller (e.g. the tray "Retire <assistant>…" command)
 * retire a cloud assistant by id correctly, where the previous settings-only
 * flow always assumed the target was the active assistant.
 *
 * On success performs the shared post-retire cleanup (onboarding flags, and a
 * best-effort lockfile platform-sync in local mode) and returns the route the
 * caller should navigate to. Never throws — failures come back as
 * `{ ok: false, error }`.
 */
export async function retireAssistant(
  queryClient: QueryClient,
  assistantId: string,
  options: RetireAssistantOptions = {},
): Promise<RetireOutcome> {
  try {
    const target = getLockfile().assistants.find(
      (a) => a.assistantId === assistantId,
    );
    const useLocal = isLocalClient() && !!target && isLocalAssistant(target);

    // Only the cloud delete can hand OAuth connections to a successor. The
    // local path retires through the host CLI, and a local→platform import
    // already clones connections on the cloud side.
    if (useLocal) {
      const result = await retireLocalAssistant(assistantId);
      if (!result.ok) {
        return {
          ok: false,
          error: result.error || "Failed to retire assistant.",
        };
      }
    } else {
      const result = await retireAssistantById(assistantId, options);
      // A 404 means the assistant is already gone — treat as success so the
      // local lockfile and onboarding flags still get reconciled.
      if (!(result.ok || result.status === 404)) {
        const detail =
          typeof result.error?.detail === "string"
            ? result.error.detail
            : "Failed to retire assistant.";
        return { ok: false, error: detail };
      }
    }

    useResolvedAssistantsStore.getState().remove(assistantId);
    forgetAssistantAvatar(queryClient, assistantId);
    // The completion record goes with it, so a reused id is never pre-marked.
    forgetAssistantOnboarded(assistantId);
    // Drop the marketing nav's cached assistant name (same-origin localStorage,
    // written by the cloud's `useNavbarAuth`). Otherwise the marketing site
    // keeps optimistically showing "My Assistant" after a retire until its own
    // list fetch resolves — and the plugin install button mistakes the stale
    // name for an existing assistant.
    removeLocalSetting(MARKETING_ASSISTANT_NAME_CACHE_KEY);
    return { ok: true, nextRoute: getPostRetireRoute() };
  } catch {
    return { ok: false, error: "Failed to retire assistant." };
  }
}
