import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "fs";
import { hostname, platform } from "os";
import { dirname, join } from "path";

import {
  guardianTokenPath,
  isConfidentialRefreshUrl,
  resolveConfigDir,
  resolveConfigDirPaths,
  saveGuardianToken as writeGuardianToken,
  type GuardianTokenData,
} from "@mycadet/local-mode";

import { loopbackSafeFetch } from "./loopback-fetch.js";
import { z } from "zod";

/**
 * The guardian token fields as they arrive untrusted (gateway refresh/init
 * responses, persisted token files). Every field is independently optional
 * and independently caught: one malformed field must not invalidate the
 * others — callers fall back per field.
 */
const GuardianTokenFieldsSchema = z
  .object({
    guardianPrincipalId: z.string().optional().catch(undefined),
    accessToken: z.string().optional().catch(undefined),
    accessTokenExpiresAt: z
      .union([z.string(), z.number()])
      .optional()
      .catch(undefined),
    refreshToken: z.string().optional().catch(undefined),
    refreshTokenExpiresAt: z
      .union([z.string(), z.number()])
      .optional()
      .catch(undefined),
    refreshAfter: z
      .union([z.string(), z.number()])
      .transform((v) => (typeof v === "number" ? new Date(v).toISOString() : v))
      .optional()
      .catch(undefined),
    isNew: z.boolean().optional().catch(undefined),
    deviceId: z.string().optional().catch(undefined),
  })
  .catch({});

/** Narrow untrusted JSON to the token fields whose values have the right
 * shape; fields absent or malformed come back undefined for callers to
 * fall back on or reject. */
function parseGuardianTokenFields(value: unknown): Partial<GuardianTokenData> {
  return GuardianTokenFieldsSchema.parse(value);
}

const DEVICE_ID_SALT = "mycadet-host-id";

export type { GuardianTokenData };

function getGuardianTokenPath(assistantId: string): string {
  // Resolve via the shared @mycadet/local-mode resolver — the same one every
  // host-seam reader (`getGuardianAccessToken`) uses — so the token is always
  // written where it's read.
  return guardianTokenPath(resolveConfigDir(), assistantId);
}

function getPersistedDeviceIdPath(): string {
  return join(resolveConfigDir(), "device-id");
}

function hashWithSalt(input: string): string {
  return createHash("sha256")
    .update(input + DEVICE_ID_SALT)
    .digest("hex");
}

function getMacOSPlatformUUID(): string | null {
  try {
    const output = execSync(
      "ioreg -rd1 -c IOPlatformExpertDevice | awk '/IOPlatformUUID/{print $3}'",
      { encoding: "utf-8", timeout: 5000, windowsHide: true },
    ).trim();
    const uuid = output.replace(/"/g, "");
    return uuid.length > 0 ? uuid : null;
  } catch {
    return null;
  }
}

function getLinuxMachineId(): string | null {
  try {
    return readFileSync("/etc/machine-id", "utf-8").trim() || null;
  } catch {
    return null;
  }
}

function getWindowsMachineGuid(): string | null {
  try {
    const output = execSync(
      'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
      { encoding: "utf-8", timeout: 5000, windowsHide: true },
    ).trim();
    const match = output.match(/MachineGuid\s+REG_SZ\s+(.+)/);
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

export function getOrCreatePersistedDeviceId(): string {
  const path = getPersistedDeviceIdPath();
  try {
    const existing = readFileSync(path, "utf-8").trim();
    if (existing.length > 0) {
      return existing;
    }
  } catch {
    // File doesn't exist yet
  }
  const newId = randomUUID();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(path, newId + "\n", { mode: 0o600 });
  return newId;
}

/**
 * Compute a stable device identifier matching the native client conventions.
 *
 * - macOS: SHA-256 of IOPlatformUUID + salt
 * - Linux: SHA-256 of /etc/machine-id + salt
 * - Windows: SHA-256 of HKLM MachineGuid + salt
 * - Fallback: persisted random UUID in XDG config
 */
export function computeDeviceId(): string {
  const os = platform();

  if (os === "darwin") {
    const uuid = getMacOSPlatformUUID();
    if (uuid) return hashWithSalt(uuid);
  } else if (os === "linux") {
    const machineId = getLinuxMachineId();
    if (machineId) return hashWithSalt(machineId);
  } else if (os === "win32") {
    const guid = getWindowsMachineGuid();
    if (guid) return hashWithSalt(guid);
  }

  return getOrCreatePersistedDeviceId();
}

/**
 * Read a previously persisted guardian token for the given assistant.
 * Returns the parsed token data, or null if the file does not exist or is
 * unreadable.
 */
export function loadGuardianToken(
  assistantId: string,
): GuardianTokenData | null {
  for (const dir of resolveConfigDirPaths()) {
    try {
      const raw = readFileSync(guardianTokenPath(dir, assistantId), "utf-8");
      return JSON.parse(raw) as GuardianTokenData;
    } catch {
      // Try the next compatible location.
    }
  }
  return null;
}

export function saveGuardianToken(
  assistantId: string,
  data: GuardianTokenData,
): void {
  // Delegates to the shared @mycadet/local-mode writer (0700 dir, 0600 file)
  // with the same env-resolved config dir the path resolver above uses.
  writeGuardianToken(resolveConfigDir(), assistantId, data);
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
  return join(dirname(getGuardianTokenPath(assistantId)), "refresh.lock");
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
      isNew: false,
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

/**
 * The gateway may run in a separate container or VM from the machine
 * issuing this request (Docker, AWS, GCP), so its own hostname does not
 * identify the paired device. Read the CLI process's hostname here, where
 * it reflects the actual machine, and forward it in the init request.
 * Bootstrap is on the critical path, so a throwing or empty hostname
 * degrades to `undefined` rather than failing the lease.
 */
function readClientHostname(): string | undefined {
  try {
    return hostname() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Call POST /v1/guardian/init on the remote gateway to bootstrap a JWT
 * credential pair. The returned tokens are persisted locally under
 * `$XDG_CONFIG_HOME/cadet{-env}/assistants/<assistantId>/guardian-token.json`.
 */
const READY_POLL_INTERVAL_MS = 500;
const READY_POLL_BUDGET_MS = 60_000;

async function waitForGatewayReady(gatewayUrl: string): Promise<void> {
  const deadline = Date.now() + READY_POLL_BUDGET_MS;
  while (Date.now() < deadline) {
    try {
      const res = await loopbackSafeFetch(`${gatewayUrl}/readyz`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) return;
      // Only the documented "starting" gate is worth waiting out. Anything
      // else (404, connection refused) means there is no gate here — e.g.
      // test doubles that serve only the leased routes — so proceed and let
      // the caller's own retry budget handle it.
      if (res.status !== 503) return;
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
  }
}

export class GuardianLeasePermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardianLeasePermanentError";
  }
}

function describeJsonType(value: unknown): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export async function leaseGuardianToken(
  gatewayUrl: string,
  assistantId: string,
  bootstrapSecret?: string,
): Promise<GuardianTokenData> {
  // The gateway 503s every non-probe route ({status: "starting"}) while its
  // post-assistant-ready backfills run — exactly the window that burned the
  // caller's lease-retry budget. Poll /readyz (body-aware: it is the probe
  // the gateway docs point CLI waits at) until the gate opens before the
  // first init attempt.
  await waitForGatewayReady(gatewayUrl);

  const deviceId = computeDeviceId();
  const clientReportedName = readClientHostname();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (bootstrapSecret) {
    headers["x-bootstrap-secret"] = bootstrapSecret;
  }
  const response = await loopbackSafeFetch(`${gatewayUrl}/v1/guardian/init`, {
    method: "POST",
    headers,
    body: JSON.stringify({ platform: "cli", deviceId, clientReportedName }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`guardian/init failed (${response.status}): ${body}`);
  }

  const rawBody: unknown = await response.json();
  const parsed = parseGuardianTokenFields(rawBody);
  if (
    parsed.guardianPrincipalId == null ||
    parsed.accessToken == null ||
    parsed.accessTokenExpiresAt == null ||
    parsed.refreshToken == null ||
    parsed.refreshTokenExpiresAt == null ||
    parsed.refreshAfter == null ||
    parsed.isNew == null
  ) {
    const raw = z.record(z.string(), z.unknown()).catch({}).parse(rawBody);
    const requiredFields: (keyof typeof parsed)[] = [
      "guardianPrincipalId",
      "accessToken",
      "accessTokenExpiresAt",
      "refreshToken",
      "refreshTokenExpiresAt",
      "refreshAfter",
      "isNew",
    ];
    const unusable = requiredFields
      .filter((field) => parsed[field] == null)
      .map((field) => `${field} arrived as ${describeJsonType(raw[field])}`);
    throw new GuardianLeasePermanentError(
      `guardian/init returned a malformed token response (${response.status}) — ${unusable.join(", ")}`,
    );
  }
  const tokenData: GuardianTokenData = {
    guardianPrincipalId: parsed.guardianPrincipalId,
    accessToken: parsed.accessToken,
    accessTokenExpiresAt: parsed.accessTokenExpiresAt,
    refreshToken: parsed.refreshToken,
    refreshTokenExpiresAt: parsed.refreshTokenExpiresAt,
    refreshAfter: parsed.refreshAfter,
    isNew: parsed.isNew,
    deviceId,
    leasedAt: new Date().toISOString(),
  };

  saveGuardianToken(assistantId, tokenData);
  return tokenData;
}

/**
 * Clear the gateway's guardian-init lock + consumed-secret state via
 * `POST /v1/guardian/reset-bootstrap`, so a spent single-use bootstrap secret
 * can be used again by a subsequent `leaseGuardianToken`. Loopback-only on the
 * gateway; when bootstrap secrets are configured the gateway requires a
 * matching `x-bootstrap-secret`. Mirrors the macOS client's `forceReBootstrap`
 * recovery. Throws on a non-OK response.
 */
export async function resetGuardianBootstrap(
  gatewayUrl: string,
  bootstrapSecret?: string,
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (bootstrapSecret) {
    headers["x-bootstrap-secret"] = bootstrapSecret;
  }
  const response = await fetch(`${gatewayUrl}/v1/guardian/reset-bootstrap`, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `guardian/reset-bootstrap failed (${response.status}): ${body}`,
    );
  }
}
