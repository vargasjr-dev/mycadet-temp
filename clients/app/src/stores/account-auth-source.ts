import { App } from "@capacitor/app";
import { isNativePlatform } from "@app/runtime/native-platform";
import { isOAuthFlowInFlight } from "@web/runtime/native-auth";
import {
  useAuthStore as webAuthStore,
  subscribeCloudAccountLogout,
} from "@web/stores/auth-store";
import { getSession, logoutAccountSession } from "@app/lib/auth/session-client";
import { accountUserSnapshot } from "@app/stores/account-user-snapshot";
import { createAccountSessionSource } from "@app/stores/account-session-source";

/** App probes own account state; web actions preserve the current composed-client side effects. */
export const accountAuthSource = createAccountSessionSource({
  getSession,
  snapshot: accountUserSnapshot,
  synchronizeWeb: () => webAuthStore.getState().refreshSession(),
  logout: () =>
    webAuthStore
      .getState()
      .logout({ cloudAccount: { revokeSession: logoutAccountSession } }),
});

const stopCloudLogoutListener = subscribeCloudAccountLogout(() =>
  accountAuthSource.beginExternalLogout(),
);
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    stopCloudLogoutListener();
    cleanup?.();
  });

let readers = 0;
let cleanup: (() => void) | undefined;
/** Share resume listeners across account hooks and remove them with the last reader. */
export function startAccountSessionListeners(): () => void {
  if (readers++ === 0) {
    let disposed = false;
    const refresh = () => {
      if (!disposed && !isOAuthFlowInFlight())
        void accountAuthSource
          .observeSession()
          .catch((error) =>
            console.warn("account session probe failed", error),
          );
    };
    const visible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", visible);
    const nativeListener = isNativePlatform()
      ? App.addListener("appStateChange", (state) => {
          if (state.isActive) refresh();
        }).catch(() => undefined)
      : undefined;
    // Re-entering account UI revalidates the retained snapshot as well.
    refresh();
    cleanup = () => {
      if (disposed) return;
      disposed = true;
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", visible);
      if (nativeListener)
        void nativeListener.then((handle) => handle?.remove()).catch(() => {});
    };
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--readers === 0) {
      cleanup?.();
      cleanup = undefined;
    }
  };
}
