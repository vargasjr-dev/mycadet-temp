import { useSyncExternalStore } from "react";
import type { AccountAuthSnapshot } from "@app/stores/auth-state";
import { accountAuthSource } from "@app/stores/web-auth-source";

/** Select a primitive or stable reference; account state remains sourced from the existing boot. */
function useAccountAuth<T>(selector: (state: AccountAuthSnapshot) => T): T {
  const getSnapshot = () => selector(accountAuthSource.getSnapshot());
  return useSyncExternalStore(
    accountAuthSource.subscribe,
    getSnapshot,
    getSnapshot,
  );
}
export const useAuthStore = Object.assign(useAccountAuth, {
  getState: accountAuthSource.getSnapshot,
  use: {
    user: () => useAccountAuth((state) => state.user),
    logout: () => useAccountAuth((state) => state.logout),
    refreshSession: () => useAccountAuth((state) => state.refreshSession),
  },
});
export function useIsAuthenticated(): boolean {
  return useAccountAuth((state) => state.sessionStatus === "authenticated");
}
export function useIsSessionInitializing(): boolean {
  return useAccountAuth((state) => state.sessionStatus === "initializing");
}
