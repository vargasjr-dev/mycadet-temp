/**
 * Origin switching for the account chooser. A remembered origin is a separate
 * deployment, so selecting one is a full navigation to that base, not an
 * in-app route change.
 *
 * The navigation fork, per host:
 *
 * - **Electron desktop** asks the main process to load the target
 *   (`mainWindow.navigateTo`): `loadURL` does not fire `will-navigate`, so the
 *   shell's same-origin guard — which ejects renderer-initiated cross-origin
 *   https navigations to the system browser — never sees this one and the
 *   window itself goes to the origin.
 * - **Native mobile** swaps the shell's webview origin in place through the
 *   `SelfHostedServers` plugin; a shell too old to carry the plugin falls back
 *   to the same navigation the browser takes, which is degraded but is what
 *   the pair-page path already does there.
 * - **Plain browser** navigates directly.
 */

import { Capacitor } from "@capacitor/core";

import { getElectronBridge } from "@app/runtime/electron-bridge";
import {
  nativeSwitchToOrigin,
  nativeSwitchToOriginPath,
} from "@app/runtime/self-hosted-servers";
import {
  normalizeOriginUrl,
  type RememberedOrigin,
} from "@app/stores/remembered-origins-store";
import {
  REMOTE_PAIR_PATH,
  pairingLinkForBase,
} from "@app/utils/pairing-address";
import { routes } from "@app/utils/routes";

/**
 * The pair route as the native shell addresses it: relative to the assistant
 * entry the shell loads, which is what `switchToPath` appends.
 */
const NATIVE_PAIR_ROUTE = REMOTE_PAIR_PATH.slice(`${routes.assistant}/`.length);

/**
 * Whether `origin` is the deployment serving the running app. Stored urls are
 * already canonical, so the running base is the side that needs normalizing.
 */
export function isCurrentOrigin(origin: RememberedOrigin): boolean {
  return normalizeOriginUrl(window.location.origin) === origin.url;
}

/**
 * Navigate to the SPA root at the origin's base. An unpaired or expired
 * session bounces to that origin's own pair page via its resolver, which is
 * the intended degraded state.
 *
 * A `deviceCode` lands on that pair page directly instead, so the
 * already-approved pairing completes in one step rather than minting a fresh
 * challenge. The code is credential material: it is read from the pasted
 * link, never written to the origin store, and exists only for the length of
 * this navigation. A browser navigation carries it in the fragment, which
 * never reaches the wire; the native swap carries it in the query, the only
 * shape the shells accept.
 *
 * Everything the swap has to do before the shell leaves the origin belongs to
 * the plugin wrapper, so no caller can leave one of them out.
 */
export async function switchToOrigin(
  origin: RememberedOrigin,
  deviceCode?: string,
): Promise<void> {
  const pairUrl = deviceCode
    ? pairingLinkForBase(origin.url, deviceCode)
    : null;
  // The pair route relative to the shell's assistant entry. Both Capacitor
  // plugins refuse a path carrying a fragment, so the code rides in the query
  // here; the pair page reads either.
  const pairPath =
    deviceCode && pairUrl !== null
      ? `${NATIVE_PAIR_ROUTE}?${new URLSearchParams({
          device_code: deviceCode,
        }).toString()}`
      : null;
  const navigate = () =>
    window.location.assign(pairUrl ?? `${origin.url}${routes.assistant}`);
  const electron = getElectronBridge();
  if (electron) {
    await electron.mainWindow.navigateTo(
      pairUrl ?? `${origin.url}${routes.assistant}`,
    );
    return;
  }
  // Nothing is awaited ahead of the web navigation: it is issued in the same
  // tick as the call, and the preparation the native swap needs lives behind
  // the fork, in the plugin wrapper.
  if (!Capacitor.isNativePlatform()) {
    navigate();
    return;
  }
  const switched =
    pairPath === null
      ? await nativeSwitchToOrigin(origin.url)
      : await nativeSwitchToOriginPath(origin.url, pairPath);
  if (!switched) {
    navigate();
  }
}
