import { App } from "@capacitor/app";
import { isNativePlatform } from "@app/runtime/native-platform";
import { isOAuthFlowInFlight } from "@app/runtime/oauth-flow-state";
import { getSession } from "@app/lib/auth/session-client";
import { logoutAccount } from "@app/lib/auth/logout-account";
import { accountUserSnapshot } from "@app/stores/account-user-snapshot";
import { createAccountSessionSource } from "@app/stores/account-session-source";

/** Account session authority is independent of assistant runtime state. */
export const accountAuthSource = createAccountSessionSource({
  getSession,
  snapshot: accountUserSnapshot,
  logout: logoutAccount,
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => cleanup?.());
}

let readers = 0;
let cleanup: (() => void) | undefined;
/** Share resume listeners across account hooks and remove them with the last reader. */
export function startAccountSessionListeners(): () => void {
  if (readers++ === 0) {
    let disposed = false;
    const refresh = () => {
      if (!disposed && !isOAuthFlowInFlight()) {
        void accountAuthSource
          .observeSession()
          .catch((error) =>
            console.warn("account session probe failed", error),
          );
      }
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
