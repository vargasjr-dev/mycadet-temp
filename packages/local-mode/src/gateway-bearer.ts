import type { TokenResult } from "./guardian-token";
import type { Fetch } from "@mycadet/shared/fetch";

/**
 * Host-side custody of the local gateway bearer.
 *
 * The desktop main process and the dev-server middleware are the trusted
 * hosts of the local data plane: each can read the on-disk guardian token
 * (via {@link GuardianTokenLease}) and mint a gateway actor bearer against
 * the loopback gateway's `/auth/token`. Minting here keeps both the
 * guardian token and the minted bearer out of the renderer — the browser
 * never sees either credential, so nothing token-shaped lands in
 * localStorage.
 *
 * The minted bearer is cached per gateway port with the same 60-second
 * expiry margin the client previously applied to its own mint, so a burst
 * of forwarded requests shares one mint instead of paying the guardian
 * lease per request.
 */

/** The loopback gateway's `/auth/token` mint response. */
interface MintedGatewayBearer {
  token: string;
  expiresAtEpochSeconds: number;
}

/**
 * Lease the guardian access token from the trusted host's disk/CLI
 * machinery. Mirrors the never-reject contract of the host credential
 * routes: a failure resolves with the structured result rather than
 * throwing.
 */
export type GuardianTokenLease = () => Promise<TokenResult>;

const FRESHNESS_MARGIN_SECONDS = 60;

const bearerCache = new Map<number, MintedGatewayBearer>();

function isFresh(bearer: MintedGatewayBearer): boolean {
  return (
    Date.now() / 1000 < bearer.expiresAtEpochSeconds - FRESHNESS_MARGIN_SECONDS
  );
}

/** @internal Exposed for test teardown only: the cache is module state. */
export function clearLoopbackGatewayBearerCache(): void {
  bearerCache.clear();
}

async function mintBearer(
  port: number,
  leaseGuardianToken: GuardianTokenLease,
  fetcher: Fetch,
): Promise<MintedGatewayBearer | null> {
  let guardianToken: string;
  try {
    const lease = await leaseGuardianToken();
    if (!lease.ok) {
      return null;
    }
    guardianToken = lease.accessToken;
  } catch {
    return null;
  }
  try {
    // The mint route is loopback-peer-gated and Origin-gated (a CSRF
    // defense for browsers); this server-to-server hop presents the same
    // loopback web origin the desktop forward's rewrite already produced.
    const response = await fetcher(`http://127.0.0.1:${port}/auth/token`, {
      method: "POST",
      headers: {
        origin: `http://127.0.0.1:${port}`,
        authorization: `Bearer ${guardianToken}`,
      },
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json().catch(() => null)) as {
      token?: unknown;
      expiresAt?: unknown;
    } | null;
    if (
      typeof body?.token !== "string" ||
      typeof body.expiresAt !== "number" ||
      !Number.isFinite(body.expiresAt)
    ) {
      return null;
    }
    return { token: body.token, expiresAtEpochSeconds: body.expiresAt };
  } catch {
    return null;
  }
}

export interface LoopbackGatewayBearerOptions {
  /** Skip the cache and mint fresh — the 401 re-mint path. */
  forceMint?: boolean;
  /**
   * Injectable for tests; defaults to the global fetch. A plain callable —
   * the Electron forward threads its own recorded fetcher through.
   */
  fetcher?: Fetch;
}

/**
 * A bearer for forwarded requests to the loopback gateway on `port`, minted
 * host-side and cached until near expiry. `null` when the guardian lease or
 * the mint fails — callers forward without a bearer and the gateway's own
 * response (401 on protected routes, an unauthenticated `readyz`) surfaces
 * the truth.
 */
export async function loopbackGatewayBearer(
  port: number,
  leaseGuardianToken: GuardianTokenLease,
  options: LoopbackGatewayBearerOptions = {},
): Promise<string | null> {
  if (!options.forceMint) {
    const cached = bearerCache.get(port);
    if (cached && isFresh(cached)) {
      return cached.token;
    }
  }
  const minted = await mintBearer(
    port,
    leaseGuardianToken,
    options.fetcher ?? fetch,
  );
  if (!minted) {
    return null;
  }
  bearerCache.set(port, minted);
  return minted.token;
}
