import {
  CLIENT_METADATA_HEADERS,
  sanitizeClientMetadataValue,
} from "@mycadet/service-contracts/client-metadata";
import { interfaceIdSchema } from "@mycadet/assistant-api";

import {
  detectBrowserInfo,
  detectClientOs,
} from "@/runtime/platform-detection";

import { mintRandomId } from "./random-id";
import { readInjectedConfig } from "./injected-config";

let cached: string | null = null;

let cachedInterface: string | null = null;

/**
 * The interface this web client reports on turns: the embedding shell's
 * interface when a desktop shell injected one, otherwise "web". Validated
 * against the daemon's shared interface vocabulary.
 */
export function getClientInterfaceId(): string {
  if (cachedInterface) {
    return cachedInterface;
  }
  const parsed = interfaceIdSchema.safeParse(readInjectedConfig()?.interfaceId);
  cachedInterface = parsed.success ? parsed.data : "web";
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
  return {
    "X-Cadet-Client-Id": getClientId(),
    // The SSE registration's interface. Registration is the transport, not
    // the shell: the hub derives subscriber capabilities server-side from
    // this id, and a renderer serves no host tools — the shell's main
    // process owns that registration. The embedding shell's interface
    // rides the turn body instead (see `domains/chat/api/messages.ts`).
    "X-Cadet-Interface-Id": "web",
    // Analytics-only client metadata (browser family/version, OS surface,
    // build version), persisted under `metadata.client` on user messages.
    // Values are sanitized and bounded; none affect capability resolution.
    ...getClientMetadataHeaders(),
  };
}
