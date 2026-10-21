import { useEffect, useLayoutEffect, useRef } from "react";
import { useNavigate } from "react-router";

import type { DeepLink } from "@mycadet/ipc-contract";
import { captureError } from "@mycadet/design-library/utils/capture-error";
import { getElectronBridge } from "@app/runtime/electron-bridge";
import { useConnectDialogStore } from "@app/stores/connect-dialog-store";
import { connectAddress } from "@app/utils/pairing-address";
import { routes } from "@app/utils/routes";

/**
 * Renderer-side consumer for the Electron host's `cadet://` deep-link
 * bridge (`window.cadet.deepLinks`). The shells parse `<scheme>://connect`
 * pairing hand-offs and buffer anything that arrives before the renderer
 * exists; this hook subscribes to live links and drains that backlog.
 *
 * Only the `connect` arm drives an app surface: it parks the request in the
 * connect-dialog store and lands on the assistant chooser, which opens its
 * Connect a Remote Assistant dialog off that store. A `url`+`code` link
 * recomposes into the pairing link and prefills the address field, so the
 * pair completes on one click; a link carrying only a base prefills that,
 * and the dialog mints its own approval code; a link with no usable base
 * gets guidance instead of a prefill, naming its legacy pairing bundle when
 * it carried one. The remaining arms are web-chat surfaces (threads,
 * composer pre-fill, checkout) the app bundle doesn't mount, so they are
 * ignored; unknown links are unparseable shapes the shell already logs.
 *
 * Subscribe BEFORE draining (web's electron-deep-links ordering): a link
 * landing between drain completion and subscription would be lost
 * otherwise. The subscription is synchronous and the drain runs in the
 * background. Window visibility is main-side (the shells' deep-link setup
 * calls ensureVisible), so unlike web's consumer this makes no
 * ensureMainWindowVisible call.
 *
 * Off Electron (the Capacitor and browser boots) `getElectronBridge()`
 * returns undefined: no subscription, and the drain falls through to an
 * empty backlog — but the settled latch still fires, matching web's
 * no-op-then-latch shape.
 */
export function useDeepLinkConsumer(): void {
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  useLayoutEffect(() => {
    navigateRef.current = navigate;
  });

  useEffect(() => {
    const bridge = getElectronBridge();
    const handleLink = (link: DeepLink): void => {
      if (link.kind !== "connect") {
        return;
      }
      const address = connectAddress(link.url ?? null, link.code ?? null);
      // Park before navigating so the chooser mounts with the dialog
      // already open (its auto-skip stands down while it is).
      useConnectDialogStore
        .getState()
        .openConnectDialog(
          address !== null
            ? { initialAddress: address }
            : { guidanceKind: link.legacy ? "legacy" : "generic" },
        );
      navigateRef.current(routes.account.selectAssistant);
    };
    // Subscribe synchronously, before the drain below.
    const unsubscribe =
      bridge?.deepLinks?.onLink(handleLink) ?? (() => undefined);
    let cancelled = false;
    void (bridge?.deepLinks?.drain() ?? Promise.resolve([]))
      .then((pending) => {
        if (cancelled) {
          return;
        }
        for (const link of pending) {
          handleLink(link);
        }
      })
      .catch((err) => {
        captureError(err, { context: "deep_link_drain", level: "warning" });
      })
      .finally(() => {
        // Latch after the backlog publishes so a buffered connect link parks
        // its dialog state before the chooser's auto-skip resumes.
        useConnectDialogStore.getState().markDeepLinkDrainSettled();
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
}
