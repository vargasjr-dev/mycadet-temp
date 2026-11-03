/**
 * The assistant's shape bridge.
 *
 * The web bundle exists only for a resolved assistant — the shell that
 * mounts it (the app bundle's iframe, the gateway-served host page) has
 * already resolved the assistant and stamped the store before the first
 * render. There is no resolution fetch to wait on and no projection to
 * run: consumers read {@link getResolvedAssistant} (or the store's hook)
 * and speak the entry directly.
 */

import { type Assistant } from "@/assistant/api";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";

export const ASSISTANT_QUERY_KEY = ["assistant", "current"] as const;

/**
 * The store's entry in the generated-Assistant shape callers still speak.
 * The store IS the resolution — this is a projection of its one entry.
 */
export function asGeneratedAssistant(entry: LockfileAssistant): Assistant {
  return {
    id: entry.assistantId,
    handle: entry.assistantId,
    name: entry.name ?? entry.assistantId,
    status: "active",
    created: entry.hatchedAt ?? "",
  } as Assistant;
}
