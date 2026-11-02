import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "fs";

import { dirname, join } from "path";
import {
  computeDeviceId,
  guardianTokenPath,
  isConfidentialRefreshUrl,
  loopbackSafeFetch,
  parseGuardianTokenFields,
  saveGuardianToken as writeGuardianToken,
  type GuardianTokenData,
} from "@mycadet/local-mode";

/**
 * Read a previously persisted guardian token for the given assistant.
 * Returns the parsed token data, or null if the file does not exist or is
 * unreadable.
 */
export function loadGuardianToken(
  assistantId: string,
): GuardianTokenData | null {
  try {
    const raw = readFileSync(guardianTokenPath(assistantId), "utf-8");
    return JSON.parse(raw) as GuardianTokenData;
  } catch {
    return null;
  }
}

export function saveGuardianToken(
  assistantId: string,
  data: GuardianTokenData,
): void {
  // Delegates to the shared @mycadet/local-mode writer (0700 dir, 0600 file)
  // resolving the same env-driven config dir the path resolver above uses.
  writeGuardianToken(assistantId, data);
}

/** Abort the refresh POST if the gateway is slow/unreachable (it's now on the
 *  hot request path, so it must never hang indefinitely). */
const REFRESH_FETCH_TIMEOUT_MS = 15_000;
/** Max time to wait for the per-assistant refresh lock before proceeding. */
const REFRESH_LOCK_WAIT_MS = 10_000;
/** A lock older than this is treated as stale (holder crashed) and stolen. */
const REFRESH_LOCK_STALE_MS = 30_000;
const REFRESH_LOCK_POLL_MS = 100;

function getRefreshLockPath(assistantId: string): string {
  return join(dirname(guardianTokenPath(assistantId)), "refresh.lock");
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Best-effort exclusive cross-process lock for a per-assistant token refresh.
 * Created atomically with `wx`; a stale lock (crashed holder) is stolen.
 * Returns true if acquired, false if it timed out (caller proceeds degraded).
 */
async function acquireRefreshLock(lockPath: string): Promise<boolean> {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > REFRESH_LOCK_STALE_MS) {
          unlinkSync(lockPath); // steal a stale lock, then retry
          continue;
        }
      } catch {
        continue; // lock vanished between open and stat — retry
      }
      if (Date.now() >= deadline) return false;
      await delay(REFRESH_LOCK_POLL_MS);
    }
  }
}

function releaseRefreshLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    /* already released/stolen */
  }
}

/**
 * True when a stored guardian token has reached its renewal point: now is
 * at/after `refreshAfter` (preferred) or `accessTokenExpiresAt`. Used to gate
 * refresh so a forged/synthetic 401 on a still-valid token can't coax out the
 * long-lived refresh credential. Unparseable timestamps → not due.
 */
export function guardianTokenDueForRenewal(token: GuardianTokenData): boolean {
  const raw = token.refreshAfter || token.accessTokenExpiresAt;
  const at = new Date(raw).getTime();
  if (!Number.isFinite(at)) {
    return false;
  }
  return at <= Date.now();
}

export type GuardianTokenRefreshResult =
  | { ok: true; token: GuardianTokenData }
  | { ok: false; status: number; error: string };

function failureChainText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let i = 0; i < 4 && current; i++) {
    if (current instanceof Error) {
      parts.push(current.name, current.message);
      if ("code" in current && current.code != null) {
        parts.push(String(current.code));
      }
      current = current.cause;
      continue;
    }
    if (current && typeof current === "object") {
      const record = current as {
        code?: unknown;
        message?: unknown;
        cause?: unknown;
        name?: unknown;
      };
      if (record.name != null) {
        parts.push(String(record.name));
      }
      if (record.message != null) {
        parts.push(String(record.message));
      }
      if (record.code != null) {
        parts.push(String(record.code));
      }
      current = record.cause;
      continue;
    }
    break;
  }
  return parts.join(" ").toLowerCase();
}

function isTimeoutLikeError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return true;
    }
  }
  const haystack = failureChainText(error);
  return (
    haystack.includes("timeout") ||
    haystack.includes("etimedout") ||
    haystack.includes("und_err_connect_timeout")
  );
}

function isUnreachableGatewayError(error: unknown): boolean {
  const haystack = failureChainText(error);
  return (
    haystack.includes("econnrefused") ||
    haystack.includes("econnreset") ||
    haystack.includes("enotfound") ||
    haystack.includes("ehostunreach") ||
    haystack.includes("enetunreach") ||
    haystack.includes("und_err_socket") ||
    haystack.includes("fetch failed") ||
    haystack.includes("unable to connect") ||
    haystack.includes("failed to connect")
  );
}

function classifyRefreshThrownError(
  error: unknown,
): GuardianTokenRefreshResult {
  if (isTimeoutLikeError(error)) {
    return {
      ok: false,
      status: 504,
      error: "Guardian token refresh timed out",
    };
  }
  if (isUnreachableGatewayError(error)) {
    return {
      ok: false,
      status: 503,
      error: "Assistant gateway is unreachable",
    };
  }
  return {
    ok: false,
    status: 500,
    error: "Failed to refresh guardian token",
  };
}

function classifyRefreshHttpStatus(status: number): GuardianTokenRefreshResult {
  // The guardian refresh route uses 403 for revoked, reused, or
  // device-mismatched tokens. That is a spent credential, not a
  // loopback-boundary refusal, so hosts treat it as 401.
  if (status === 401 || status === 403) {
    return {
      ok: false,
      status: 401,
      error: "Failed to refresh guardian token",
    };
  }
  if (status >= 500) {
    return {
      ok: false,
      status,
      error: `Assistant gateway rejected the token refresh (${status})`,
    };
  }
  return {
    ok: false,
    status,
    error: `Assistant gateway rejected the token refresh (${status})`,
  };
}

/**
 * Call POST /v1/guardian/refresh on the remote gateway to obtain a new
 * access token using an existing (possibly expired) access token for auth.
 * Returns a structured result so hosts can tell a spent credential (401,
 * including a refresh-endpoint 403 for revoked/reused/device-mismatched
 * tokens) from an unreachable gateway (503) instead of collapsing both
 * to null. 403 is reserved for a local confidentiality refusal (insecure
 * URL). Loopback and paired-token refusals are also 403, and they are
 * decided on the host before this refresh runs.
 *
 * Concurrency-safe: the gateway rotates refresh tokens and treats reuse of an
 * already-rotated token as replay (revoking the whole token family), so two
 * processes (e.g. `cadet message` + `cadet events`) refreshing the same
 * stored token at once would self-revoke and force re-pairing. We serialize on
 * a per-assistant lock and, once held, re-read the stored token: if another
 * process already rotated it while we waited, we return that fresh token
 * instead of replaying our now-stale refresh token.
 */
export async function refreshGuardianTokenResult(
  gatewayUrl: string,
  assistantId: string,
): Promise<GuardianTokenRefreshResult> {
  // Never send the long-lived refresh token over a non-loopback plaintext URL.
  if (!isConfidentialRefreshUrl(gatewayUrl)) {
    console.warn(
      `Refusing to refresh the guardian token over an insecure URL (${gatewayUrl}). ` +
        "The refresh token is only sent over https or a loopback address: " +
        "use an https URL, e.g. a tunnel, or connect over loopback.",
    );
    return {
      ok: false,
      status: 403,
      error: "Refusing to refresh the guardian token over an insecure URL",
    };
  }

  const before = loadGuardianToken(assistantId);
  if (!before) {
    return {
      ok: false,
      status: 404,
      error: "Guardian token not found",
    };
  }

  // Gateway persists expiresAt as epoch-ms numbers; Date.parse("1234567890000")
  // returns NaN. new Date() accepts both ISO strings and epoch-ms numbers.
  const refreshExpiry = new Date(before.refreshTokenExpiresAt).getTime();
  if (!Number.isFinite(refreshExpiry) || refreshExpiry <= Date.now()) {
    return {
      ok: false,
      status: 401,
      error: "Guardian refresh token expired",
    };
  }

  const lockPath = getRefreshLockPath(assistantId);
  const locked = await acquireRefreshLock(lockPath);
  try {
    // Re-read under the lock: a concurrent process may have rotated the token
    // while we waited. If the stored refresh token changed, ours is now stale
    // (replaying it would trip reuse-detection). Use the fresh token instead.
    const current = loadGuardianToken(assistantId);
    if (current && current.refreshToken !== before.refreshToken) {
      return { ok: true, token: current };
    }

    // We did NOT acquire the lock (another process is likely mid-refresh) and
    // the stored token hasn't been rotated yet. Do NOT call the gateway: our
    // refresh token may be the one the winner is rotating right now, and
    // replaying a rotated token revokes the whole family (forcing re-pair).
    // Surface a retryable failure so the next attempt can pick up the
    // winner's persisted token.
    if (!locked) {
      return {
        ok: false,
        status: 503,
        error: "Guardian token refresh is already in progress",
      };
    }

    const tokenData = current ?? before;

    const response = await loopbackSafeFetch(
      `${gatewayUrl}/v1/guardian/refresh`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenData.accessToken}`,
        },
        body: JSON.stringify({
          refreshToken: tokenData.refreshToken,
          // The refresh token is device-bound; send the device id used at init
          // (falling back to a fresh computation for tokens persisted before the
          // field was stored) so the gateway can verify the binding.
          deviceId: tokenData.deviceId || computeDeviceId(),
        }),
        signal: AbortSignal.timeout(REFRESH_FETCH_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      return classifyRefreshHttpStatus(response.status);
    }

    const parsed = parseGuardianTokenFields(await response.json());
    if (parsed.accessToken == null) {
      return {
        ok: false,
        status: 502,
        error: "Assistant gateway returned a malformed token refresh response",
      };
    }
    const refreshed: GuardianTokenData = {
      guardianPrincipalId:
        parsed.guardianPrincipalId ?? tokenData.guardianPrincipalId,
      accessToken: parsed.accessToken,
      accessTokenExpiresAt:
        parsed.accessTokenExpiresAt ?? tokenData.accessTokenExpiresAt,
      refreshToken: parsed.refreshToken ?? tokenData.refreshToken,
      refreshTokenExpiresAt:
        parsed.refreshTokenExpiresAt ?? tokenData.refreshTokenExpiresAt,
      refreshAfter: parsed.refreshAfter ?? tokenData.refreshAfter,
      deviceId: tokenData.deviceId,
      leasedAt: new Date().toISOString(),
      pairedGatewayUrl: tokenData.pairedGatewayUrl,
    };
    saveGuardianToken(assistantId, refreshed);
    return { ok: true, token: refreshed };
  } catch (error) {
    return classifyRefreshThrownError(error);
  } finally {
    if (locked) {
      releaseRefreshLock(lockPath);
    }
  }
}

/** Convenience wrapper around {@link refreshGuardianTokenResult}. */
export async function refreshGuardianToken(
  gatewayUrl: string,
  assistantId: string,
): Promise<GuardianTokenData | null> {
  const result = await refreshGuardianTokenResult(gatewayUrl, assistantId);
  return result.ok ? result.token : null;
}
