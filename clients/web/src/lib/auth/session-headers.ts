/**
 * Session-auth header assembly for the same-origin platform dials that
 * stopped riding the generated cloud client.
 *
 * The auth interceptor centralizes these headers for every generated-client
 * request; the few dials that swapped to plain same-origin fetch (the tts
 * voice catalog, the live-voice token mint) need the same credentials, and
 * the header literals live here — inside the auth boundary — rather than
 * handcrafted at each call site.
 */

import { getCsrfToken } from "./csrf";
import { isElectron } from "@/runtime/is-electron";
import { getElectronSessionToken } from "@/runtime/session-token";

const ELECTRON_RENDERER_ORIGIN_HEADER = "X-Cadet-Electron-Renderer-Origin";

/**
 * The session credentials a mutating platform request carries: the CSRF
 * echo of the cookie jar on web, or the electron shell's session token
 * (plus the renderer origin its mutation check reads) there. Cookie custody
 * stays with the browser's jar — a same-origin fetch rides it unaided.
 */
export function platformMutationSessionHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (isElectron()) {
    const sessionToken = getElectronSessionToken();
    if (sessionToken) {
      headers["X-Session-Token"] = sessionToken;
      headers[ELECTRON_RENDERER_ORIGIN_HEADER] = `${window.location.protocol}//${window.location.host}`;
    }
  } else {
    const csrfToken = getCsrfToken();
    if (csrfToken) {
      headers["X-CSRFToken"] = csrfToken;
    }
  }
  return headers;
}
