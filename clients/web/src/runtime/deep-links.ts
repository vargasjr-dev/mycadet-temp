import { isElectron } from "@/runtime/is-electron";

/**
 * Per-capability wrapper for the Electron host's deep-link bridge —
 * `cadet://` and `cadet://` URL schemes routed in by
 * Launch Services. Same shape as `power-events.ts`: no-op off
 * Electron (web build, Capacitor iOS), publishes into the event bus
 * via `use-event-bus-init` once it lands, and domain consumers
 * subscribe via the bus — never via this wrapper directly.
 *
 * Two surfaces because deep links can arrive BEFORE the renderer
 * exists (the OS launches the app via a `cadet://` click):
 *
 *   - `drainPendingDeepLinks()` — returns the buffer of links
 *     that arrived during main-process startup, before the renderer
 *     had a chance to subscribe.
 *   - `subscribeToDeepLinks(callback)` — subscribes to LIVE links
 *     (post-renderer-ready). Subscribe BEFORE draining to cover the
 *     narrow race where a link arrives in flight.
 */

export type DeepLink =
  | { kind: "send"; message: string }
  | { kind: "openThread"; threadId: string }
  /** `<scheme>://connect` pairing hand-off. `code` is the device code the
   *  local-mode host exchanges, and is credential material: never log or
   *  breadcrumb it. `legacy` marks a link that carried an older version's
   *  pairing bundle, whose payload never crosses the bridge. */
  | { kind: "connect"; url?: string; code?: string; legacy?: true }
  | { kind: "unknown"; url: string };

export async function drainPendingDeepLinks(): Promise<DeepLink[]> {
  if (!isElectron()) {
    return [];
  }
  return (await window.cadet?.deepLinks.drain()) ?? [];
}

export function subscribeToDeepLinks(
  callback: (link: DeepLink) => void,
): () => void {
  if (!isElectron()) {
    return () => undefined;
  }
  return window.cadet?.deepLinks.onLink(callback) ?? (() => undefined);
}
