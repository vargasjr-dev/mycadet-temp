import fs from "node:fs";

import type { TokenResult } from "./guardian-token";
import {
  getLoopbackGatewayPort,
  isLoopbackGatewayCloud,
  isUsableRuntimeUrl,
  LockfileAssistantSchema,
  resolveCloud,
} from "./lockfile-contract";

/**
 * The unified, id-keyed gateway proxy paths. The data-plane proxy is addressed
 * by assistant id — the lockfile resolves the id to the entry's loopback port
 * (locally hatched gateways) or recorded remote `runtimeUrl` (imported
 * pairings) — so the renderer never encodes a port and the local/paired split
 * lives entirely host-side.
 */
const GATEWAY_PATTERN = /^(?:\/assistant)?\/__gateway\/([^/?#]+)(\/.*)?$/;

export interface GatewayTarget {
  assistantId: string;
  /** Pathname tail forwarded onto the target, without the query. */
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
 * Parse a gateway-proxy URL given as `pathname + search` (a `#fragment`
 * suffix is tolerated and dropped), so every host hands over the same shape
 * and the decision is host-independent. Accepts the unified
 * `/__gateway/{assistantId}` with or without the `/assistant` prefix.
 */
export function parseAssistantGatewayUrl(url: string): GatewayParseResult {
  const delimiter = url.search(/[?#]/);
  const pathname = delimiter === -1 ? url : url.slice(0, delimiter);
  const suffix = delimiter === -1 ? "" : url.slice(delimiter);
  const search = suffix.startsWith("?") ? (suffix.split("#")[0] ?? "") : "";

  const match = pathname.match(GATEWAY_PATTERN);
  if (!match) {
    return { match: false };
  }

  let assistantId: string;
  try {
    assistantId = decodeURIComponent(match[1]!);
  } catch {
    // Malformed percent-encoding is an invalid parse, not a crash.
    return { match: true, valid: false };
  }

  const path = match[2] || "/";
  if (hasDotSegment(path)) {
    return { match: true, valid: false };
  }

  return {
    match: true,
    valid: true,
    target: { assistantId, path, search },
  };
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
 * Verdict for a gateway-proxy URL, combining the URL parse with the
 * lockfile target-map check into one decision a host can act on without
 * re-deriving the rules.
 *
 *   - `pass`     — not a gateway URL; the host serves it normally.
 *   - `reject`   — a gateway URL whose id is malformed, whose tail is a
 *                  traversal attempt, or whose id is not active in the
 *                  lockfile (the security boundary: the proxy only reaches
 *                  gateways of assistants the user actually hatched or
 *                  imported, never arbitrary loopback services or URLs).
 *                  Carries the status and message the host answers with.
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
 * Resolve a gateway-proxy URL, given as `pathname + search`, to a proxy
 * verdict. Identical across every host that proxies the data plane (the
 * Electron `app://` protocol handler, the Vite dev middleware, the CLI web
 * server) so the security boundary is defined once and the hosts can't drift.
 *
 * `getTargets` is a thunk (typically `() => readGatewayTargets(...)`) so the
 * lockfile is read only once a gateway URL is matched — the hot path of
 * static-asset and non-gateway requests never touches disk.
 */
export function resolveGatewayProxyTarget(
  url: string,
  getTargets: () => Map<string, GatewayEntryTarget>,
): GatewayProxyDecision {
  const parsed = parseAssistantGatewayUrl(url);
  if (!parsed.match) {
    return { kind: "pass" };
  }
  if (!parsed.valid) {
    return GATEWAY_REJECTION;
  }
  const target = getTargets().get(parsed.target.assistantId);
  if (!target) {
    return GATEWAY_REJECTION;
  }
  return {
    kind: "forward",
    assistantId: parsed.target.assistantId,
    path: parsed.target.path,
    search: parsed.target.search,
    target,
  };
}

const MIN_GATEWAY_PORT = 1024;
const MAX_GATEWAY_PORT = 65535;

/**
 * Compute the id-keyed gateway-target map from a lockfile's assistant
 * entries. Each entry parses through {@link LockfileAssistantSchema}; an
 * entry that fails the parse (or carries no usable id) is skipped. A paired
 * entry resolves to its recorded remote `runtimeUrl` (usable http(s) only);
 * a loopback-gateway cloud (`local`, `docker`) resolves to its recorded
 * loopback port via {@link getLoopbackGatewayPort}. Everything else —
 * externally-managed containers, the platform cloud, remote self-hosted
 * clouds the SPA doesn't drive — is left out, and an absent id is a proxy
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
    const { assistantId, cloud, resources, runtimeUrl } = parsed.data;
    if (!assistantId) {
      continue;
    }
    const cloudValue = resolveCloud({ cloud });
    if (cloudValue === "paired") {
      if (isUsableRuntimeUrl(runtimeUrl)) {
        targets.set(assistantId, { kind: "remote", runtimeUrl });
      }
      continue;
    }
    if (!isLoopbackGatewayCloud(cloudValue)) {
      continue;
    }
    const port = getLoopbackGatewayPort({ resources, runtimeUrl });
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
 * Read the gateway-target map from the lockfile on disk
 * ({@link gatewayTargetsFromLockfile} over the first readable candidate).
 * Path selection matches the unpair write path (`readRawLockfile` in
 * lockfile.ts): the first readable, parseable lockfile is authoritative even
 * when it yields no targets, so an unpaired or retired assistant can never
 * survive in a stale fallback file's target map.
 */
export function readGatewayTargets(
  lockfilePaths: string[],
): Map<string, GatewayEntryTarget> {
  for (const candidate of lockfilePaths) {
    const read = readLockfileAssistantEntries(candidate);
    if (read.kind !== "ok") {
      continue;
    }
    return gatewayTargetsFromLockfile({ assistants: read.assistants });
  }
  return new Map<string, GatewayEntryTarget>();
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
  runtimeUrl: string,
) => Promise<TokenResult>;

export type PairedForwardAuthorizationResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/** Replace renderer authorization with the paired credential owned by the host. */
export async function authorizePairedForwardHeaders(
  assistantId: string,
  runtimeUrl: string,
  headers: Headers,
  getGuardianToken: PairedGuardianTokenProvider,
): Promise<PairedForwardAuthorizationResult> {
  sanitizePairedForwardHeaders(headers);
  const result = await getGuardianToken(assistantId, runtimeUrl);
  if (!result.ok) {
    return result;
  }
  headers.set("authorization", `Bearer ${result.accessToken}`);
  return { ok: true };
}
