import { getElectronBridge, type DeepLink } from "./electron-bridge";

export type { DeepLink };

/**
 * Per-capability wrapper for the Electron host's deep-link bridge — the
 * `cadet://` schemes routed in by Launch Services, parsed main-side and
 * delivered as typed links. Same shape as web's `runtime/deep-links.ts`: a
 * no-op off Electron (the app bundle boots standalone, on Capacitor, or in a
 * plain browser), so callers need no shell guard.
 *
 * Two surfaces because deep links can arrive BEFORE the renderer exists (the
 * OS launches the app via a `cadet://` click before the window loads):
 *
 *   - `drainPendingDeepLinks()` — returns the buffer of links that arrived
 *     during main-process startup, before the renderer could subscribe.
 *   - `subscribeToDeepLinks(callback)` — subscribes to LIVE links.
 *     Subscribe BEFORE draining to cover the narrow race where a link
 *     arrives in flight between subscribe and drain.
 */

export async function drainPendingDeepLinks(): Promise<DeepLink[]> {
  return (await getElectronBridge()?.deepLinks.drain()) ?? [];
}

export function subscribeToDeepLinks(
  callback: (link: DeepLink) => void,
): () => void {
  return getElectronBridge()?.deepLinks.onLink(callback) ?? (() => undefined);
}
