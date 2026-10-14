import { useEffect, useSyncExternalStore } from "react";
import type { AccountAuthSnapshot } from "@app/stores/auth-state";
import {
  accountAuthSource,
  startAccountSessionListeners,
} from "@app/stores/account-auth-source";

/** Select a primitive or stable reference; account state is owned by app’s cloud-session source. */
function useAccountAuth<T>(selector: (state: AccountAuthSnapshot) => T): T {
  useEffect(() => {
    void accountAuthSource
      .getSnapshot()
      .initSession()
      .catch((error) =>
        console.warn("account session initialization failed", error),
      );
    return startAccountSessionListeners();
  }, []);
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
