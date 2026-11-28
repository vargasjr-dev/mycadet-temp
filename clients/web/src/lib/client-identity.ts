import {
  CLIENT_METADATA_HEADERS,
  sanitizeClientMetadataValue,
} from "@mycadet/service-contracts/client-metadata";

import {
  detectBrowserInfo,
  detectClientOs,
} from "@/runtime/platform-detection";

import { mintRandomId } from "./random-id";
import { readInjectedConfig } from "./injected-config";

let cached: string | null = null;

/**
 * Desktop interfaces a shell may inject. Only these are honored from the
 * injected config — a malformed or foreign value falls back to "web".
 */
const SHELL_INTERFACES = ["macos", "windows", "linux"] as const;

let cachedInterface: string | null = null;

/**
 * The interface this web client reports for registration: the desktop
 * shell's interface when running embedded in one (the connection IS that
 * desktop client), otherwise "web".
 *
 * This only carries IDENTITY. The embedded client never serves host tools —
 * the shell's main process owns the host-proxy registration — so when the
 * resolved interface is a desktop one, the registration headers also carry
 * the `X-Cadet-Host-Proxy: 0` opt-out, keeping the daemon's
 * interface-to-capability derivation from advertising host capabilities for
 * this connection (see `events-routes.ts`).
 */
export function getRegisteredInterfaceId(): string {
  if (cachedInterface) {
    return cachedInterface;
  }
  const injected = readInjectedConfig()?.interfaceId;
  cachedInterface =
    injected !== undefined && SHELL_INTERFACES.some((id) => id === injected)
      ? injected
      : "web";
  return cachedInterface;
}

/**
 * Returns an opaque id identifying this page load (a UUID wherever
 * `crypto.randomUUID` is reachable, see `mintRandomId`).
 *
 * Generated on first call, cached in module memory for the rest of the
 * page's lifetime. Not persisted anywhere: each page load (initial nav,
 * reload, duplicated tab, restored bfcache entry) produces a fresh id.
 *
 * This is the unit the assistant daemon's self-echo suppression keys off:
 * a mutation and the SSE subscriber that should be skipped both come from
 * the same page-load `getClientId()` call, so they always match. Two tabs
 * (or duplicates of one) never collide because each got its own module
 * initialization.
 */
export function getClientId(): string {
  if (cached) {
    return cached;
  }
  cached = mintRandomId();
  return cached;
}

let cachedMetadataHeaders: Record<string, string> | null = null;

/**
 * Sanitized client-metadata headers persisted by the daemon under
 * `metadata.client` for turn analytics. All inputs (browser, OS surface,
 * build version) are constant for the lifetime of the page, so the result
 * is computed once and cached in module memory.
 *
 * These are analytics-only: unlike `X-Cadet-Interface-Id`, none of them
 * feed subscriber capability resolution.
 */
function getClientMetadataHeaders(): Record<string, string> {
  if (cachedMetadataHeaders) {
    return cachedMetadataHeaders;
  }
  const browser = detectBrowserInfo();
  const candidates: Array<[string, string | undefined]> = [
    [CLIENT_METADATA_HEADERS.browser_family, browser.family],
    [CLIENT_METADATA_HEADERS.browser_version, browser.version],
    [CLIENT_METADATA_HEADERS.os, detectClientOs()],
    [
      CLIENT_METADATA_HEADERS.interface_version,
      import.meta.env.VITE_APP_VERSION,
    ],
  ];
  const headers: Record<string, string> = {};
  for (const [name, raw] of candidates) {
    const value = sanitizeClientMetadataValue(raw);
    if (value) {
      headers[name] = value;
    }
  }
  cachedMetadataHeaders = headers;
  return headers;
}

/**
 * Headers identifying this web client to the assistant daemon.
 *
 * Attach to:
 *   - Long-lived SSE connections (so the hub's ClientRegistry can track
 *     the subscriber and its interface capabilities).
 *   - Every HTTP request (so the daemon can echo the id back on the
 *     resulting `sync_changed` and the hub can skip the originator's SSE
 *     subscriber).
 *
 * The central interceptor at `lib/api-interceptors.ts` attaches these to
 * all generated-client requests; raw `fetch` call sites still call this
 * helper directly.
 */
export function getClientRegistrationHeaders(): Record<string, string> {
  const interfaceId = getRegisteredInterfaceId();
  return {
    "X-Cadet-Client-Id": getClientId(),
    // The connection's interface: the desktop shell's interface when this
    // client runs embedded in one (the turn channel, client lists, and
    // desktop presence then read it as the desktop client it is), "web" in
    // a plain browser.
    //
    // This carries identity only. The daemon derives an SSE subscriber's
    // host-proxy capabilities from the interface id (`events-routes.ts` →
    // `supportsHostProxy`) — capabilities this renderer cannot serve, since
    // the Electron *main* process owns the host-tool executors through its
    // own registration. When embedded, the `X-Cadet-Host-Proxy: 0` opt-out
    // below zeroes those capabilities, preserving the invariant the old
    // always-"web" registration protected: exactly one host-capable client
    // per device, so host-tool resolution stays unambiguous. Platform
    // awareness for the assistant flows through the message body's
    // `clientOs` field as well (see `detectClientOs` in
    // `domains/chat/api/messages.ts`), which only feeds the per-turn
    // `client_os` context.
    "X-Cadet-Interface-Id": interfaceId,
    // Present only when reporting a desktop interface: this connection
    // opts out of host-proxy capability advertisement.
    ...(interfaceId === "web" ? {} : { "X-Cadet-Host-Proxy": "0" }),
    // Analytics-only client metadata (browser family/version, OS surface,
    // build version), persisted under `metadata.client` on user messages.
    // Values are sanitized and bounded; none affect capability resolution.
    ...getClientMetadataHeaders(),
  };
}
