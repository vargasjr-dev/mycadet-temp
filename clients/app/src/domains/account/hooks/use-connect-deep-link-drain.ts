import { useEffect } from "react";
import { useNavigate } from "react-router";

import { getElectronBridge } from "@app/runtime/electron-bridge";
import { routes } from "@app/utils/routes";
import { pairingLinkForBase } from "@app/utils/pairing-address";

import { useConnectDialogStore } from "@app/stores/connect-dialog-store";
import {
  drainPendingDeepLinks,
  subscribeToDeepLinks,
  type DeepLink,
} from "@app/runtime/deep-links";

/**
 * The address a `connect` deep link asks the dialog to pair with. A link
 * carrying a device code recomposes into the pairing link the local-mode host
 * exchanges outright; a link carrying only a base becomes the bare address,
 * which mints its own approval code. `null` when the link carried no usable
 * base, leaving the dialog nothing to submit.
 */
function connectAddress(
  url: string | null,
  code: string | null,
): string | null {
  if (url === null) {
    return null;
  }
  if (code === null) {
    return url;
  }
  // The link the user sees in the address field, so it has to be one they can
  // also paste into another device's browser: the base plus the pair route,
  // not the base with a bare fragment hung off it.
  return pairingLinkForBase(url, code) ?? url;
}

/**
 * Drains the Electron host's deep links into the connect dialog.
 *
 * The OS can launch the app with `cadet://connect?…` before any renderer
 * exists; the shell buffers those main-side and hands them over on drain.
 * The hook subscribes first (live links), then drains the backlog, then
 * marks the store's `deepLinkDrainSettled` latch — web's chooser auto-skip
 * defers to that latch, so ordering is load-bearing: a buffered connect link
 * must park its dialog state before anything consumes the settled signal.
 *
 * Only `connect` is handled here. The other link kinds route into the chat
 * and billing surfaces the app bundle iframes or links out to, not into this
 * bundle's own routes; ignoring them (rather than erroring) keeps a stray
 * link inert instead of dead-ending the boot.
 */
export function useConnectDeepLinkDrain(): void {
  const navigate = useNavigate();

  useEffect(() => {
    const handle = (link: DeepLink): void => {
      if (link.kind !== "connect") {
        return;
      }
      // The hot path: a link landing while the window sits minimized or
      // behind another one. Main raises it for the cold path already.
      void getElectronBridge()?.mainWindow.ensureVisible();
      const address = connectAddress(link.url ?? null, link.code ?? null);
      // Park before navigating so the chooser mounts with the dialog
      // already open.
      useConnectDialogStore
        .getState()
        .openConnectDialog(
          address !== null
            ? { initialAddress: address }
            : { guidanceKind: link.legacy ? "legacy" : "generic" },
        );
      navigate(routes.account.selectAssistant);
    };

    // Subscribe-then-drain: a link landing between drain completion and
    // subscription would be lost the other way around.
    const unsubscribe = subscribeToDeepLinks(handle);
    void drainPendingDeepLinks()
      .then((pending) => {
        for (const link of pending) {
          handle(link);
        }
      })
      .catch(() => {
        // A failed drain must not wedge the latch: the links it carried are
        // still buffered main-side (drain only reads on failure), and the
        // dialog's own add flow still works.
      })
      .finally(() => {
        useConnectDialogStore.getState().markDeepLinkDrainSettled();
      });

    return unsubscribe;
  }, [navigate]);
}
