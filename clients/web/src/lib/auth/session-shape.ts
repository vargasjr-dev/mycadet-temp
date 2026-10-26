/**
 * The session facts UI reads, as a shape the session owner pushes.
 *
 * UI gates on WHAT the session is (authenticated? live cloud session? still
 * settling?), never on the lifecycle machinery that produces it. That split is
 * the session handoff (the auth-store audit, #554): today the web auth store
 * is the machinery — it probes allauth, restores offline, revalidates on
 * resume — and this module subscribes to it to expose just the facts. When the
 * app bundle owns the session, its push becomes the source and only this
 * module's backing changes; the read sites keep their imports.
 *
 * Machinery (boot, interceptors, middleware, logout, connect seams) is NOT a
 * consumer of this module — it works for the owner and moves with the
 * handoff (#554, triage A).
 */

import { useSyncExternalStore } from "react";

import { useAuthStore } from "@/stores/auth-store";
import {
  hasLiveCloudSession,
  isAuthenticated,
  isCloudSessionSettled,
  isSessionSettled,
  type CloudSessionStatus,
  type SessionStatus,
} from "@/stores/session-status";

function subscribe(onChange: () => void): () => void {
  return useAuthStore.subscribe(onChange);
}

// Server renders have no live store to differ from — the same synchronous
// read serves both snapshots.
function useShapeValue<T>(read: () => T): T {
  return useSyncExternalStore(subscribe, read, read);
}

/** Reactive: the session's lifecycle status. */
export function useSessionStatus(): SessionStatus {
  return useShapeValue(() => useAuthStore.getState().sessionStatus);
}

/** Reactive: is the user signed in (any hosting). */
export function useIsAuthenticated(): boolean {
  return isAuthenticated(useSessionStatus());
}

/** Reactive: the session probe has not settled yet (boot / revalidation). */
export function useIsSessionInitializing(): boolean {
  return !isSessionSettled(useSessionStatus());
}

/** Reactive: a live cloud session exists (platform or cadet-cloud). */
export function useHasCloudSession(): boolean {
  return useShapeValue(() =>
    hasLiveCloudSession(useAuthStore.getState().cloudSession),
  );
}

/**
 * Reactive: the cloud-session probe has settled (`cloudSession` is no longer
 * `"unknown"`). Gate behavior that must not act on the pre-settle window —
 * where {@link useHasCloudSession} still reads `false` for a session that will
 * resolve to `"present"` — on this rather than on
 * {@link useIsSessionInitializing}, which can clear first.
 */
export function useIsCloudSessionSettled(): boolean {
  return useShapeValue(() =>
    isCloudSessionSettled(useAuthStore.getState().cloudSession),
  );
}

/** Non-reactive read for callbacks and effects outside the React tree. */
export function getSessionStatus(): SessionStatus {
  return useAuthStore.getState().sessionStatus;
}

/** Non-reactive read for callbacks and effects outside the React tree. */
export function getCloudSession(): CloudSessionStatus {
  return useAuthStore.getState().cloudSession;
}

/** Observe the shape from outside the React tree (waiters, sync pumps). */
export function subscribeSessionShape(onChange: () => void): () => void {
  return subscribe(onChange);
}
