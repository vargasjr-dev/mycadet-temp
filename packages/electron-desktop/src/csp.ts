import { session } from "electron";

// Root hostname (leading dot, e.g. ".mycadet.ai") injected at build time via
// electron-vite `define` from VITE_ROOT_HOSTNAME. Falls back to the
// production default when unset (e.g. under `bun test`, without the bundler).
declare const __CADET_ROOT_HOSTNAME__: string;
const ROOT_HOSTNAME =
  typeof __CADET_ROOT_HOSTNAME__ === "string"
    ? __CADET_ROOT_HOSTNAME__
    : ".mycadet.ai";
// Wildcard host for CSP source lists, e.g. "*.mycadet.ai".
const WILDCARD_HOST = `*${ROOT_HOSTNAME}`;

// 'unsafe-inline' in script-src: required because sandboxed srcdoc iframes
// (dynamic-page-surface, app-viewer) inherit the parent CSP and their
// injected bridge/storage scripts are inline. The sandbox attribute is the
// primary isolation boundary for that content.
//
// ws://localhost / ws://127.0.0.1 in connect-src: the self-hosted gateway's
// WebSocket endpoints (/v1/stt/stream dictation partials, /v1/live-voice).
// HTTP gateway traffic rides the app:// protocol forward in main and stays
// within 'self', but WebSocket upgrades can't take that path — the local
// loopback ingress is the one shape a static CSP can allowlist. A REMOTE
// self-hosted ingress (e.g. an ngrok wss:// URL) still can't be — those
// connections need the planned proxy-through-main follow-up.
//
// Signed cloud archive downloads and diagnostic uploads use Google storage
// hosts directly. Their URLs carry storage authorization.

// (`storage.googleapis.com/<bucket>/...`) and virtual-hosted
// (`<bucket>.storage.googleapis.com/...`) URL shapes are covered.
//
// Stripe hosts: the billing payment-method modal (auto-top-up) loads Stripe.js
// via `loadStripe` (script-src js.stripe.com), which mounts the card and
// address inputs inside iframes on js.stripe.com / *.js.stripe.com (frame-src)
// and confirms SetupIntents against api.stripe.com (connect-src).
// hooks.stripe.com hosts the 3D Secure challenge frame. link.com /
// *.link.com host the Link wallet frames the payment element mounts while
// `wallets.link` is enabled (the banner, the OTP sheet, the saved-card panel),
// which is what puts them in frame-src. They are in connect-src because
// Stripe.js itself runs in the top-level document and reaches those hosts
// directly; a cross-origin frame's own requests answer to its own policy,
// never to this one. Together that covers the frame and connection halves of
// Stripe's documented CSP set for Stripe.js
// (https://docs.stripe.com/security/guide); its img-src hosts already fall
// under the broad `https:` in img-src below, and maps.googleapis.com applies
// only when supplying your own Google Maps key to the Address Element.
// frame-src is the only directive that names Stripe hosts alongside 'self';
// without it frames fall back to `default-src 'self'`, which blocks the
// Element iframes. Keeping the list to 'self' + Stripe hosts costs the
// sandboxed srcdoc surfaces (visual, dynamic-page, app-viewer) nothing,
// because a srcdoc document resolves as 'self'.
//
// https://*.mycadet.ai in frame-src: the app shell's AssistantFrame
// (@mycadet/app) iframes the resolved assistant's own edge, where the web
// bundle is served — the same remote-web model the hub and the mobile shells
// use. 'self' covers the local-assistant shape (the same-origin /assistant
// mount and its __gateway forwards).
//
// frame-src must not be dropped, and 'self' must stay the floor. It is the
// only control over where a sandboxed frame can navigate *itself*: no CSP
// directive constrains a document navigating its own browsing context from
// the inside (`navigate-to` was never shipped), so a frame rendering
// model-authored markup would otherwise be free to carry conversation data
// out in a URL. It is enforced on every navigation of a nested browsing
// context, not just the first load, which is what makes it work here.
// See ATL-1197.
export const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://js.stripe.com https://*.js.stripe.com",
  "style-src 'self' 'unsafe-inline'",
  `connect-src 'self' blob: data: https://${WILDCARD_HOST} wss://${WILDCARD_HOST} https://api.elevenlabs.io https://api.deepgram.com https://storage.googleapis.com https://*.storage.googleapis.com https://api.stripe.com https://link.com https://*.link.com ws://localhost:* ws://127.0.0.1:*`,
  `frame-src 'self' https://${WILDCARD_HOST} https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com https://link.com https://*.link.com`,
  "img-src 'self' https: data: blob:",
  // Hosted voice-preview samples: ElevenLabs premades live in the
  // eleven-public-prod GCS bucket (path-scoped so the rest of GCS stays
  // blocked for media), Deepgram Aura previews on static.deepgram.com.
  "media-src 'self' blob: https://storage.googleapis.com/eleven-public-prod/ https://static.deepgram.com/",
  "worker-src 'self' blob: https://cdn.jsdelivr.net",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

export const installCsp = (): void => {
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ["app://*/*"] },
    (details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [CSP_POLICY],
        },
      });
    },
  );
};
