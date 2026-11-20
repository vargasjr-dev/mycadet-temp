/**
 * Unregister this page's client id from the daemon on unload.
 *
 * The web client mints a fresh `X-Cadet-Client-Id` per page load (see
 * {@link getClientId}), so the daemon's same-clientId subscriber dedupe
 * never fires across refreshes — the old page's SSE subscriber can only
 * leave the hub when its socket is noticed dead. Behind the gateway
 * proxy that notice can take hours (the local proxy→daemon socket stays
 * ESTABLISHED long after the far end is gone), so `assistant clients
 * list` accumulates one live-looking web session per page load.
 *
 * This module is the fast path: on `pagehide` (refresh, navigation, tab
 * close) the page POSTs `POST /v1/clients/disconnect` for its own client
 * id via a `keepalive` fetch, which survives page teardown and rides the
 * same-origin cookie credentials. The daemon disposes the page's hub
 * subscribers immediately instead of waiting for the socket to rot.
 *
 * Best-effort by nature — no unload event is guaranteed on a killed tab
 * or process — so this complements, not replaces, the hub's abort/​cancel
 * dispose wiring. A page restored from bfcache after an unregister
 * simply reconnects: its stream is dead on resume, and the same-clientId
 * re-registration dedupes any lingering entry (see `sse-service.ts`).
 *
 * One listener per page, armed at most once. Safe to call from any
 * attachment lifetime.
 */
import {
  getClientId,
  getClientRegistrationHeaders,
} from "@/lib/client-identity";

const DISCONNECT_ENDPOINT = "/v1/clients/disconnect";

let armed = false;

export function armUnloadDisconnect(): void {
  if (armed || typeof window === "undefined") {
    return;
  }
  armed = true;
  window.addEventListener("pagehide", () => {
    // Fire-and-forget: the daemon 404s when the subscriber already left
    // (e.g. the abort-path dispose won the race), and a failed beacon is
    // exactly the case the server-side cleanup must eventually cover.
    // `keepalive` is what lets this fetch outlive the page that sent it.
    void fetch(DISCONNECT_ENDPOINT, {
      method: "POST",
      keepalive: true,
      headers: {
        ...getClientRegistrationHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ clientId: getClientId() }),
    }).catch(() => {});
  });
}
