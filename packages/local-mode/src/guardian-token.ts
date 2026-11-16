import { execSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, platform } from "node:os";
import path from "node:path";
import { dirname, join } from "node:path";

import { z } from "zod";

import { isDnsIndependentLoopbackUrl } from "@mycadet/service-contracts/remote-web-pairing";

import { loopbackSafeFetch } from "./loopback-fetch";

import {
  basetenTokenPath,
  guardianTokenPath,
  resolveConfigDir,
} from "./config";
import type { LockfileAssistant } from "./lockfile-contract";
import { readLockfile } from "./lockfile";
import { pairDevice } from "./operations/pair";

const guardianTokenRefreshes = new Map<string, Promise<TokenResult>>();

import {
  GuardianTokenFileSchema,
  type GuardianTokenData,
} from "./guardian-contract";

export { GuardianTokenFileSchema, type GuardianTokenData };

/**
 * Persist an assistant's guardian token where every host-seam reader resolves
 * it (`guardianTokenPath`). The per-assistant directory is created 0700 and the
 * file written 0600; chmod after the write covers a pre-existing file whose
 * mode drifted.
 */
export function saveGuardianToken(
  assistantId: string,
  data: GuardianTokenData,
): void {
  const tokenPath = guardianTokenPath(assistantId);
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenPath, JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.chmodSync(tokenPath, 0o600);
}

/**
 * Read a previously persisted guardian token for the given assistant.
 * Returns the parsed token data, or null if the file does not exist or is
 * unreadable.
 */
export function loadGuardianToken(
  assistantId: string,
): GuardianTokenData | null {
  try {
    const parsed = GuardianTokenFileSchema.safeParse(
      JSON.parse(fs.readFileSync(guardianTokenPath(assistantId), "utf-8")),
    );
    if (parsed.success) {
      return parsed.data;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist the Baseten sandbox access token a hatch exchanged for an
 * assistant, at {@link basetenTokenPath} under the guardian token's
 * 0600/0700 discipline. Read by the desktop proxy's forward planner — the
 * single credential for reaching that sandbox's gateway.
 */
export function saveBasetenSandboxToken(
  assistantId: string,
  token: string,
  previewToken?: string,
): void {
  const tokenPath = basetenTokenPath(assistantId);
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  const data = JSON.stringify({
    token,
    ...(previewToken ? { previewToken } : {}),
    mintedAt: new Date().toISOString(),
  });
  fs.writeFileSync(tokenPath, data + "\n", { mode: 0o600 });
  fs.chmodSync(tokenPath, 0o600);
}

/** The token file the hatch writes: the sandbox access token, the gateway
 * preview's token when one was minted, plus mint bookkeeping. */
const BasetenTokenFileSchema = z.object({
  token: z.string().min(1),
  previewToken: z.string().min(1).optional(),
  mintedAt: z.string().optional(),
});

/**
 * The gateway preview's token, saved at hatch — the credential the preview
 * edge wants on every request (header for servers, a cookie for browsers
 * after the first open). Undefined on token files that predate the
 * preview. Baseten mints the two tokens differently: the sandbox access
 * token is an API-key EXCHANGE at POST /v1/token (the server sets a 2h
 * expiry), while preview tokens are minted per-preview with a CALLER-set
 * expires_at — which is why this one is the door credential and the
 * sandbox token only feeds the exec HTTP arm.
 */
export function readBasetenPreviewToken(
  assistantId: string,
): string | undefined {
  try {
    const parsed = BasetenTokenFileSchema.safeParse(
      JSON.parse(fs.readFileSync(basetenTokenPath(assistantId), "utf-8")),
    );
    return parsed.success ? parsed.data.previewToken : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read a saved Baseten sandbox access token. TokenResult-shaped so it drops
 * straight into the paired-forward credential seam: a missing or corrupt
 * file is a 404, never a throw — the proxy surfaces the structured error.
 */
export function readBasetenSandboxToken(assistantId: string): TokenResult {
  try {
    const parsed = BasetenTokenFileSchema.safeParse(
      JSON.parse(fs.readFileSync(basetenTokenPath(assistantId), "utf-8")),
    );
    if (parsed.success) {
      return { ok: true, accessToken: parsed.data.token };
    }
    return {
      ok: false,
      status: 404,
      error:
        "Baseten sandbox token file is missing a token — re-run `cadet hatch --remote baseten`.",
    };
  } catch (err: unknown) {
    if ((err as unknown as { code?: string }).code === "ENOENT") {
      return {
        ok: false,
        status: 404,
        error:
          "No Baseten sandbox token saved for this assistant — re-run `cadet hatch --remote baseten`.",
      };
    }
    return {
      ok: false,
      status: 500,
      error: `Failed to read the Baseten sandbox token: ${err}`,
    };
  }
}

/**
 * The guardian refresh token is long-lived and replayable, so it is only
 * transmitted over a confidential channel: HTTPS, or a host that stays on this
 * machine whatever DNS answers (local dev, or a same-host reverse proxy /
 * tunnel agent). Refreshing against any other plaintext `http://` URL is
 * refused; an on-path attacker could otherwise capture the refresh token and
 * rotate it into fresh credentials.
 *
 * A user-chosen malicious `https://` destination is intentionally out of
 * scope: HTTPS protects the channel, and the access token already goes
 * wherever the configured URL points. This guard targets the
 * plaintext-interception vector.
 */
export function isConfidentialRefreshUrl(gatewayUrl: string): boolean {
  try {
    return (
      new URL(gatewayUrl).protocol === "https:" ||
      // The narrow loopback set, not {@link isLoopbackUrl}: this grants a
      // plaintext channel the trust of an encrypted one, and a reserved
      // `*.localhost` name resolves to whatever DNS says on a resolver that
      // does not implement RFC 6761, which would put the refresh token on the
      // wire to an arbitrary address.
      isDnsIndependentLoopbackUrl(gatewayUrl)
    );
  } catch {
    return false;
  }
}

function isAccessTokenExpired(data: GuardianTokenData): boolean {
  const expiresAt = new Date(data.accessTokenExpiresAt).getTime();
  if (!Number.isFinite(expiresAt)) return true;
  return Date.now() >= expiresAt - 60_000;
}

function isRefreshTokenExpired(data: GuardianTokenData): boolean {
  const expiresAt = new Date(data.refreshTokenExpiresAt).getTime();
  if (!Number.isFinite(expiresAt)) return true;
  return Date.now() >= expiresAt;
}

export type TokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; status: number; error: string };

/**
 * Re-invoke the pair flow for an assistant and persist the fresh pair.
 * The daemon-side refresh path: the same `gateway pairing mint` the CLI's
 * lease runs, resolved against the lockfile's persisted entry.
 */
async function leaseGuardianTokenFromLockfile(
  assistantId: string,
): Promise<TokenResult> {
  const entry = readLockfile().assistants.find(
    (a) => a.assistantId === assistantId,
  );
  if (!entry) {
    return {
      ok: false,
      status: 404,
      error: "Guardian token not found",
    };
  }
  try {
    const tokenData = await leaseGuardianToken(entry);
    return { ok: true, accessToken: tokenData.accessToken };
  } catch (err) {
    return {
      ok: false,
      status: 401,
      error:
        err instanceof Error
          ? `Guardian re-pair failed: ${err.message}`
          : "Guardian re-pair failed",
    };
  }
}

/**
 * The guardian access token for an assistant, from its xdg token file —
 * the only argument is the assistant id, everything else is on disk.
 * Baseten sandboxes don't lease guardian tokens: the credential is the
 * sandbox access token the hatch saved beside the lockfile, read straight
 * from disk — no CLI runtime, no mint, no refresh cycle. A missing file
 * surfaces the structured 404 the proxy renders.
 */
export async function getGuardianAccessToken(
  assistantId: string,
): Promise<TokenResult> {
  if (isBasetenAssistant(assistantId)) {
    return readBasetenSandboxToken(assistantId);
  }

  let tokenPath: string;
  try {
    tokenPath = guardianTokenPath(assistantId);
  } catch {
    return {
      ok: false,
      status: 400,
      error: "Invalid assistant ID",
    };
  }

  let raw: string | undefined;
  try {
    raw = fs.readFileSync(tokenPath, "utf-8");
  } catch {
    // Not found at the one canonical location.
  }
  if (raw === undefined) {
    return {
      ok: false,
      status: 404,
      error: "Guardian token not found",
    };
  }

  let data: GuardianTokenData;
  try {
    data = JSON.parse(raw) as GuardianTokenData;
  } catch {
    return {
      ok: false,
      status: 500,
      error: "Malformed guardian token file",
    };
  }

  if (!isAccessTokenExpired(data)) {
    return { ok: true, accessToken: data.accessToken };
  }

  if (isRefreshTokenExpired(data)) {
    return {
      ok: false,
      status: 401,
      error:
        "Guardian token expired. Re-run `cadet hatch`, `cadet wake`, or `cadet pair`.",
    };
  }

  const existingRefresh = guardianTokenRefreshes.get(tokenPath);
  if (existingRefresh) {
    return existingRefresh;
  }
  // Due, not dead: the refresh IS a re-pair — the pairing mint revokes the
  // device's old tokens and issues a fresh pair, persisted by the lease. No
  // refresh API is called and no long-lived token travels over HTTP.
  const refresh = leaseGuardianTokenFromLockfile(assistantId).finally(() => {
    if (guardianTokenRefreshes.get(tokenPath) === refresh) {
      guardianTokenRefreshes.delete(tokenPath);
    }
  });
  guardianTokenRefreshes.set(tokenPath, refresh);
  return refresh;
}

/**
 * Whether the lockfile records this assistant on the Baseten topology —
 * the proxy's credential seam branches on it (sandbox access token file,
 * not a leased guardian bearer).
 */
function isBasetenAssistant(assistantId: string): boolean {
  return (
    readLockfile().assistants.find((a) => a.assistantId === assistantId)
      ?.cloud === "baseten"
  );
}

/**
 * True when a stored guardian token has reached its renewal point: now is
 * at/after `refreshAfter` (preferred) or `accessTokenExpiresAt`. Unparseable
 * timestamps → not due, so a forged/synthetic 401 can't coax a credential
 * movement.
 */
export function guardianTokenDueForRenewal(token: GuardianTokenData): boolean {
  const raw = token.refreshAfter || token.accessTokenExpiresAt;
  const at = new Date(raw).getTime();
  if (!Number.isFinite(at)) {
    return false;
  }
  return at <= Date.now();
}

/**
 * The lease's pair as the webview's cookie feed: the hatch response ships
 * these as Set-Cookie headers so the page's requests authenticate through
 * the gateway's own middleware — no bearer token in page JavaScript.
 * HttpOnly and no Secure: the loopback http feeds would have a Secure
 * cookie refused by the jar (the iOS replay lesson). Only meaningful when
 * the gateway answers on the SAME host as the hatch response — a cookie is
 * host-scoped, so a remote gateway's origin (baseten's preview URL) can
 * never see this jar.
 */
export function getGuardianTokenAsCookies(token: GuardianTokenData): string[] {
  return [
    `cadet_web_access=${encodeURIComponent(token.accessToken)}; HttpOnly; Path=/; SameSite=Strict`,
    `cadet_web_refresh=${encodeURIComponent(token.refreshToken)}; HttpOnly; Path=/; SameSite=Strict`,
  ];
}

/**
 * The ONE guardian-token door for host-side consumers: read the stored
 * lease, and when it is due for renewal re-invoke the pair flow instead of
 * calling a refresh API — the pairing mint revokes the device's old tokens
 * and issues a fresh pair, so "refresh" and "pair" are the same operation
 * and no long-lived refresh token ever travels over an HTTP request. A
 * failed re-pair is not fatal when the stored token still has life left
 * (the `refreshAfter` marker deliberately precedes expiry); consumers fall
 * back to it.
 */
export async function loadFreshGuardianToken(
  assistantId: string,
): Promise<GuardianTokenData | null> {
  const stored = loadGuardianToken(assistantId);
  if (stored && !guardianTokenDueForRenewal(stored)) {
    return stored;
  }

  const entry = readLockfile().assistants.find(
    (a) => a.assistantId === assistantId,
  );
  if (!entry) {
    return stored ?? null;
  }
  try {
    return await leaseGuardianToken(entry);
  } catch {
    return stored ?? null;
  }
}

// ─── The guardian-token lease ────────────────────────────────────────────
// Pairing IS the lease: the pair operation's transport proves presence
// (host-loopback POST for local, in-container exec for docker), and the
// paired response IS the credential. Every local-topology hatch leases
// after its gateway is up so hosts can import the token instead of
// re-pairing.

/**
 * Parse /v1/pair's device-bound response into the token data the lease
 * persists. The payload speaks the guardian token file's own field names
 * (the gateway's DeviceBoundPairPayload), so the file schema parses it
 * directly — a malformed 200 throws a {@link GuardianLeasePermanentError};
 * it will not fix itself on retry.
 */
export function parseGuardianToken(raw: unknown): GuardianTokenData {
  const parsed = GuardianTokenFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GuardianLeasePermanentError(
      `guardian pair returned a malformed token response — ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

const DEVICE_ID_SALT = "mycadet-host-id";

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

function readClientHostname(): string | undefined {
  try {
    return hostname() || undefined;
  } catch {
    return undefined;
  }
}

export class GuardianLeasePermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardianLeasePermanentError";
  }
}

/**
 * Pair with the assistant's gateway and persist the minted credential —
 * the lease every local-topology hatch runs once its gateway is up.
 * The pair operation's transport proves presence; re-pairing IS the repair.
 * Waiting for the gateway's ready gate is the caller's job (the hatch
 * waits on the assistant before leasing) — the lease itself just pairs.
 */
export async function leaseGuardianToken(
  entry: LockfileAssistant,
): Promise<GuardianTokenData> {
  const assistantId = entry.assistantId;

  const deviceId = computeDeviceId();
  const clientReportedName = readClientHostname();

  const paired = await pairDevice(entry, {
    platform: "cli",
    deviceId,
    clientReportedName,
  });
  if (!paired.ok) throw new Error(paired.error);

  // The pair door already zod-parsed the mint's stdout line.
  const tokenData = paired.response;

  saveGuardianToken(assistantId, tokenData);
  return tokenData;
}
