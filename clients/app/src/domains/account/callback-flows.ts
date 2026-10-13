export type CallbackOutcome =
  | { kind: "authenticated" }
  | { kind: "provider_signup" }
  | { kind: "error"; message: string };

/**
 * After a provider callback, classify the session state so the callback page
 * knows where to redirect.
 */
export function classifyCallbackFlows(
  isAuthenticated: boolean,
  pendingFlows: readonly { id: string; is_pending?: boolean }[],
): CallbackOutcome {
  if (isAuthenticated) {
    return { kind: "authenticated" };
  }

  if (pendingFlows.some((f) => f.id === "provider_signup" && f.is_pending)) {
    return { kind: "provider_signup" };
  }

  return { kind: "error", message: "Unexpected authentication state." };
}
