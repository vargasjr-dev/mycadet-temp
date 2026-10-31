import fs from "node:fs";

import { resolveLockfilePath } from "./config";

import type { TokenResult } from "./guardian-token";
import {
  FLATTENED_FIRST_SEGMENTS,
  GATEWAY_PORT,
  getGatewayUrl,
  isCloudEntry,
  isLoopbackGatewayCloud,
  isUsableBaseUrl,
  LockfileAssistantSchema,
} from "./lockfile-contract";
import type { LockfileAssistant } from "./lockfile-contract";
import { isLoopbackPublicUrl } from "@mycadet/service-contracts/remote-web-pairing";

export { FLATTENED_FIRST_SEGMENTS };

/**
 * The assistant gateway's data-plane surfaces. The generated SDK addresses
 * the gateway at the scoped `/v1/assistants/{assistantId}/...` routes — the
 * ONE client surface — and the serving host (the Electron `app://` protocol
 * handler, the Vite dev middleware) resolves the id from the path against the
 * lockfile target map: the id resolves to the entry's loopback port (locally
 * hatched gateways) or recorded remote `runtimeUrl` (imported pairings), so
 * the renderer never encodes a port or a host and the local/paired split
 * lives entirely host-side.
 */
const GATEWAY_PATTERN = /^\/v1\/assistants\/([^/?#]+)(?:\/(.*))?$/;

export interface GatewayTarget {
  assistantId: string;
  /** Pathname forwarded onto the target, without the query. */
  path: string;
  /** Query string including the leading `?`, or empty. */
  search: string;
}

export type GatewayParseResult =
  | { match: true; valid: true; target: GatewayTarget }
  | { match: true; valid: false }
  | { match: false };

/**
 * A tail containing a `.` or `..` path segment (raw or percent-encoded) could
 * escape the target's recorded path prefix on hosts that forward the tail
 * un-normalized, so it is an invalid parse. A segment whose percent-encoding
 * doesn't decode is rejected for the same reason: it can't be verified.
 */
function hasDotSegment(path: string): boolean {
  for (const segment of path.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    if (decoded === "." || decoded === "..") {
      return true;
    }
  }
  return false;
}

/**
 * Parse an assistant gateway's data-plane URL given as `pathname + search` (a
 * `#fragment` suffix is tolerated and dropped), so every host hands over the
 * same shape and the decision is host-independent. The scoped SDK surface
 * `/v1/assistants/{assistantId}[/rest]` parses: the forward path is the scoped
 * path itself (flattened for the contact family; the `readyz` tail forwards
 * to the gateway's root `/readyz`), so the gateway receives exactly what the
 * SDK addressed.
 */
export function parseAssistantGatewayUrl(url: string): GatewayParseResult {
  const delimiter = url.search(/[?#]/);
  const pathname = delimiter === -1 ? url : url.slice(0, delimiter);
  const suffix = delimiter === -1 ? "" : url.slice(delimiter);
  const search = suffix.startsWith("?") ? (suffix.split("#")[0] ?? "") : "";

  const scoped = GATEWAY_PATTERN.exec(pathname);
  if (scoped) {
    let assistantId: string;
    try {
      assistantId = decodeURIComponent(scoped[1]!);
    } catch {
      // Malformed percent-encoding is an invalid parse, not a crash.
      return { match: true, valid: false };
    }
    const rest = scoped[2];
    if (hasDotSegment(assistantId) || hasDotSegment(rest ?? "")) {
      return { match: true, valid: false };
    }
    const firstSegment = rest?.split("/")[0];
    const path =
      rest === "readyz"
        ? // The readiness probe asks about the resolved assistant's gateway
          // itself, and the gateway serves it at the root — not under the
          // scoped prefix.
          "/readyz"
        : firstSegment !== undefined &&
            FLATTENED_FIRST_SEGMENTS.has(firstSegment)
          ? `/v1/${rest}`
          : pathname;
    return { match: true, valid: true, target: { assistantId, path, search } };
  }

  return { match: false };
}

/**
 * Where the lockfile says an assistant's gateway lives. Loopback targets are
 * reached at `http://127.0.0.1:{port}` (the host builds the URL and rewrites
 * `Origin`); remote targets at the entry's recorded `runtimeUrl` (the host
 * strips renderer headers and installs its own guardian bearer).
 */
export type GatewayEntryTarget =
  | { kind: "loopback"; port: number }
  | { kind: "remote"; runtimeUrl: string };

/**
 * Verdict for an assistant gateway data-plane URL, combining the URL parse
 * with the
 * lockfile target-map check into one decision a host can act on without
 * re-deriving the rules.
 *
 *   - `pass`     — not a gateway URL; the host serves it normally.
 *   - `reject`   — a gateway URL whose id is malformed or whose tail is a
 *                  traversal attempt (the security boundary: the proxy only
 *                  reaches gateways of assistants the user actually hatched
 *                  or imported, never arbitrary loopback services or URLs).
 *                  An unknown id is `pass` instead: cloud assistants' SDK
 *                  routes and stale ids fall through to the host's generic
 *                  `/v1` handling. Carries the status and message the host
 *                  answers with.
 *   - `forward`  — forward to the entry's resolved target, carrying the
 *                  assistant id so the trusted host can resolve its bearer.
 */
export type GatewayProxyDecision =
  | { kind: "pass" }
  | { kind: "reject"; status: number; message: string }
  | {
      kind: "forward";
      assistantId: string;
      path: string;
      search: string;
      target: GatewayEntryTarget;
    };

const GATEWAY_REJECTION: GatewayProxyDecision = {
  kind: "reject",
  status: 403,
  message: "Assistant is not active in lockfile",
};

/**
 * Resolve an assistant gateway data-plane URL, given as `pathname + search`,
 * to a proxy verdict. Identical across every host that proxies the data plane
 * (the Electron `app://` protocol handler, the Vite dev middleware) so the
 * security boundary is defined once and the hosts can't drift.
 *
 * `getTargets` is a thunk (typically `() => readGatewayTargets(...)`) so the
 * lockfile is read only once a gateway URL is matched — the hot path of
 * static-asset and non-gateway requests never touches disk.
 */
export function resolveGatewayProxyTarget(
  url: string,
  getTargets: () => Map<string, LockfileAssistant>,
): GatewayProxyDecision {
  const parsed = parseAssistantGatewayUrl(url);
  if (!parsed.match) {
    return { kind: "pass" };
  }
  if (!parsed.valid) {
    return GATEWAY_REJECTION;
  }
  const entry = getTargets().get(parsed.target.assistantId);
  // Cloud assistants are driven through the platform session, never
  // forwarded over this machine's proxy.
  if (!entry || isCloudEntry(entry)) {
    return { kind: "pass" };
  }
  const gatewayUrl = getGatewayUrl(entry);
  if (isUsableBaseUrl(gatewayUrl) && !isLoopbackPublicUrl(gatewayUrl)) {
    return {
      kind: "forward",
      assistantId: parsed.target.assistantId,
      path: parsed.target.path,
      search: parsed.target.search,
      target: { kind: "remote", runtimeUrl: gatewayUrl },
    };
  }
  if (!isLoopbackGatewayCloud(entry.cloud)) {
    return { kind: "pass" };
  }
  const port = entry.port;
  if (port == null || port < MIN_GATEWAY_PORT || port > MAX_GATEWAY_PORT) {
    return { kind: "pass" };
  }
  return {
    kind: "forward",
    assistantId: parsed.target.assistantId,
    path: parsed.target.path,
    search: parsed.target.search,
    target: { kind: "loopback", port },
  };
}

const MIN_GATEWAY_PORT = 1024;
const MAX_GATEWAY_PORT = 65535;

/**
 * Entry clouds this machine's host can retire directly: the host CLI owns
 * their teardown (daemon stop, container removal, instance archive). Every
 * other entry retires through the cloud's retire route the same proxy
 * forwards, so the bundle never branches on entry type.
 */
export function isHostRetirableEntry(entry: LockfileAssistant): boolean {
  return (
    isLoopbackGatewayCloud(entry.cloud) || entry.cloud === "apple-container"
  );
}

const RETIRE_PATTERN = /^\/v1\/assistants\/([^/?#]+)\/retire\/?$/;

/**
 * The scoped surface's retire arm. A `DELETE` on `/v1/assistants/{id}/retire/`
 * for an entry the host can retire directly (`isHostRetirableEntry`) is
 * answered host-side by running the CLI's retire, not forwarded to the
 * entry's gateway (which cannot retire itself). Anything else is `pass`: the
 * data-plane plan and the cloud forward keep the request on the endpoint the
 * bundle called, which is the contract: one retire endpoint for every entry
 * type, the serving host deciding how to honor it.
 *
 * Pure in the URL; `lockfile` is a thunk (typically the host's watched
 * in-memory snapshot, falling back to disk) evaluated only after the URL
 * matches, so the hot path of every other request never touches it.
 */
export function resolveAssistantRetireProxyDecision(
  pathname: string,
  method: string,
  lockfile: () => { assistants: readonly unknown[] } | null,
): { kind: "retireLocal"; assistantId: string } | { kind: "pass" } {
  if (method !== "DELETE") {
    return { kind: "pass" };
  }
  const match = RETIRE_PATTERN.exec(pathname);
  if (!match) {
    return { kind: "pass" };
  }
  let assistantId: string;
  try {
    assistantId = decodeURIComponent(match[1]!);
  } catch {
    return { kind: "pass" };
  }
  const lockfileValue = lockfile();
  if (!lockfileValue) {
    return { kind: "pass" };
  }
  for (const rawEntry of lockfileValue.assistants) {
    const parsed = LockfileAssistantSchema.safeParse(rawEntry);
    if (!parsed.success || parsed.data.assistantId !== assistantId) {
      continue;
    }
    return isHostRetirableEntry(parsed.data)
      ? { kind: "retireLocal", assistantId: parsed.data.assistantId }
      : { kind: "pass" };
  }
  return { kind: "pass" };
}

/**
 * Compute the id-keyed gateway-target map from a lockfile's assistant
 * entries. Each entry parses through {@link LockfileAssistantSchema}; an
 * entry that fails the parse (or carries no usable id) is skipped. An
 * off-machine `runtimeUrl` (an absolute http(s) address that is not
 * loopback — a connect import's remote gateway) resolves to it directly;
 * otherwise a loopback-gateway cloud (`local`, `docker`) resolves to its
 * recorded loopback port (`entry.port`). Everything
 * else — the cloud — is left out, and an absent id is a proxy
 * rejection.
 *
 * Pure, so a host holding an in-memory lockfile snapshot (e.g. the Electron
 * lockfile watcher) derives the map without touching disk on the request
 * path.
 */
export function gatewayTargetsFromLockfile(lockfile: {
  assistants: readonly unknown[];
}): Map<string, GatewayEntryTarget> {
  const targets = new Map<string, GatewayEntryTarget>();
  for (const rawEntry of lockfile.assistants) {
    const parsed = LockfileAssistantSchema.safeParse(rawEntry);
    if (!parsed.success) {
      continue;
    }
    const { assistantId } = parsed.data;
    if (!assistantId) {
      continue;
    }
    const gatewayUrl = getGatewayUrl(parsed.data);
    // Cloud assistants are driven through the platform session, never
    // forwarded over this machine's proxy.
    if (isCloudEntry(parsed.data)) {
      continue;
    }
    if (isUsableBaseUrl(gatewayUrl) && !isLoopbackPublicUrl(gatewayUrl)) {
      targets.set(assistantId, { kind: "remote", runtimeUrl: gatewayUrl });
      continue;
    }
    if (!isLoopbackGatewayCloud(parsed.data.cloud)) {
      continue;
    }
    const port = parsed.data.port;
    if (port != null && port >= MIN_GATEWAY_PORT && port <= MAX_GATEWAY_PORT) {
      targets.set(assistantId, { kind: "loopback", port });
    }
  }
  return targets;
}

type LockfileEntriesRead =
  | { kind: "ok"; assistants: unknown[] }
  | { kind: "missing" }
  | { kind: "unreadable" };

/**
 * Read one lockfile candidate's raw `assistants` array. `missing` is an
 * absent file; `unreadable` is any other read failure or malformed JSON. The
 * one read-loop body the gateway-proxy reader walks on `missing`/`unreadable`.
 */
function readLockfileAssistantEntries(candidate: string): LockfileEntriesRead {
  let raw: string;
  try {
    raw = fs.readFileSync(candidate, "utf-8");
  } catch (err: unknown) {
    if ((err as unknown as { code?: string }).code === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "unreadable" };
  }
  try {
    const data = JSON.parse(raw) as { assistants?: unknown };
    return {
      kind: "ok",
      assistants: Array.isArray(data.assistants) ? data.assistants : [],
    };
  } catch {
    return { kind: "unreadable" };
  }
}

/**
 * Read the id-keyed gateway-target map from the lockfile on disk. The
 * lockfile's assistant entries ARE the gateway targets; the map keys them
 * by id. Path selection matches the unpair write path (`readRawLockfile` in
 * lockfile.ts): the first readable, parseable lockfile is authoritative even
 * when it yields no targets, so an unpaired or retired assistant can never
 * survive in a stale fallback file's target map.
 */
export function readGatewayTargets(): Map<string, LockfileAssistant> {
  const read = readLockfileAssistantEntries(resolveLockfilePath());
  if (read.kind !== "ok") {
    return new Map<string, LockfileAssistant>();
  }
  const targets = new Map<string, LockfileAssistant>();
  for (const rawEntry of read.assistants) {
    const parsed = LockfileAssistantSchema.safeParse(rawEntry);
    if (parsed.success && parsed.data.assistantId) {
      targets.set(parsed.data.assistantId, parsed.data);
    }
  }
  return targets;
}

/**
 * Strip renderer-controlled and browser-ambient headers from a remote forward
 * before the remote hop. The trusted host installs its own guardian bearer
 * after this function returns, so a renderer-provided `Authorization` header
 * can never select or override the credential sent upstream.
 */
export function sanitizePairedForwardHeaders(headers: Headers): void {
  const secFetchNames: string[] = [];
  headers.forEach((_value, name) => {
    if (name.toLowerCase().startsWith("sec-fetch-")) {
      secFetchNames.push(name);
    }
  });
  for (const name of secFetchNames) {
    headers.delete(name);
  }
  headers.delete("origin");
  headers.delete("referer");
  headers.delete("cookie");
  headers.delete("authorization");
  // Paired runtimeUrls are commonly ngrok tunnels; free-tier ngrok answers
  // browser User-Agents with an interstitial page (ERR_NGROK_6024) unless
  // this header is present. Harmless for every other target.
  headers.set("ngrok-skip-browser-warning", "true");
}

export type PairedGuardianTokenProvider = (
  assistantId: string,
) => Promise<TokenResult>;

export type PairedForwardAuthorizationResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/** Replace renderer authorization with the paired credential owned by the host. */
export async function authorizePairedForwardHeaders(
  assistantId: string,
  headers: Headers,
  getGuardianToken: PairedGuardianTokenProvider,
): Promise<PairedForwardAuthorizationResult> {
  sanitizePairedForwardHeaders(headers);
  const result = await getGuardianToken(assistantId);
  if (!result.ok) {
    return result;
  }
  headers.set("authorization", `Bearer ${result.accessToken}`);
  return { ok: true };
}
