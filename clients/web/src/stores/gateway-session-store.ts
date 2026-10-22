import { create } from "zustand";

import { isCadetStaff } from "@/lib/auth/staff";
import { useAuthStore } from "@/stores/auth-store";
import {
  hasLiveCloudSession,
  isAuthenticated,
  isSessionSettled,
} from "@/stores/session-status";
import { createSelectors } from "@/utils/create-selectors";

/**
 * The gateway-session seam: the one reader of the auth store's session
 * machine outside the store itself.
 *
 * The machine speaks in enums — `"initializing" | "authenticated" |
 * "unauthenticated"` for the boot probe, `"unknown" | "absent" | "present"`
 * for the cloud probe — because the store needs those distinctions to run.
 * Consumers don't. They ask questions, and this store answers them with
 * plain words, re-projected on every machine write:
 *
 * - `settled` — the boot probe has resolved; signed-in status is known.
 * - `live` — someone is signed in, on the cloud or a local gateway.
 * - `cloudLive` — a live cloud session exists.
 * - `identityKey` — the signed-in account's stable id, opaque to consumers.
 *   Today it is the platform user's id; consumers key consent records,
 *   caches, and claims on it without knowing that, so the identity can be
 *   re-derived later without touching a single call site.
 * - `isStaff` — the one staff predicate (`lib/auth/staff`), projected once
 *   so every staff gate reads the same answer from the same place.
 *
 * `logout` passes through to the machine: the seam answers questions, the
 * store keeps the actions. Anything this file forgets to project stays
 * unreachable — that is the point.
 */

interface GatewaySessionData {
  /** The boot probe resolved — signed-in status is known. */
  settled: boolean;
  /** A user is signed in (cloud or local gateway). */
  live: boolean;
  /** A live cloud session exists (the cloud probe said "present"). */
  cloudLive: boolean;
  /** The signed-in account's stable id, opaque to consumers; null signed out. */
  identityKey: string | null;
  /** Whether the session belongs to Cadet staff (see `lib/auth/staff`). */
  isStaff: boolean;
}

interface GatewaySessionState extends GatewaySessionData {
  logout: (options?: {
    cloudAccount?: { revokeSession(): Promise<void> };
  }) => Promise<void>;
}

const projectAuthStoreOntoSeam = (): GatewaySessionData => {
  const { sessionStatus, cloudSession, user } = useAuthStore.getState();
  return {
    settled: isSessionSettled(sessionStatus),
    live: isAuthenticated(sessionStatus),
    cloudLive: hasLiveCloudSession(cloudSession),
    identityKey: user?.id ?? null,
    isStaff: isCadetStaff(user),
  };
};

const useGatewaySessionStoreBase = create<GatewaySessionState>()(() => ({
  ...projectAuthStoreOntoSeam(),
  logout: (options) => useAuthStore.getState().logout(options),
}));

// The machine is the session authority, so every write to it re-projects
// the seam. setState merges, which keeps the stable `logout` binding above
// alive across projections — consumers subscribing to it never see it move.
useAuthStore.subscribe(() => {
  useGatewaySessionStoreBase.setState(projectAuthStoreOntoSeam());
});

export const useGatewaySessionStore = createSelectors(
  useGatewaySessionStoreBase,
);
