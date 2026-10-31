import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import {
  isDnsIndependentLoopbackUrl,
  isLoopbackPublicUrl,
} from "@mycadet/service-contracts/remote-web-pairing";

import { guardianTokenPath, basetenTokenPath } from "./config";
import { readLockfile } from "./lockfile";
import type { CliInvocation } from "./util";

const GUARDIAN_TOKEN_REFRESH_TIMEOUT_MS = 15_000;
const guardianTokenRefreshes = new Map<string, Promise<TokenResult>>();

export const PAIRED_GUARDIAN_TOKEN_HOST_ONLY_ERROR =
  "Paired assistant credentials are available only through the paired gateway proxy";
export const PAIRED_GUARDIAN_TARGET_MISMATCH_ERROR =
  "Paired assistant target does not match the stored pairing";

/** The persisted shape of an assistant's guardian token file. */
export interface GuardianTokenData {
  guardianPrincipalId: string;
  accessToken: string;
  /** ISO date string or epoch-ms number as returned by the gateway. */
  accessTokenExpiresAt: string | number;
  refreshToken: string;
  /** ISO date string or epoch-ms number as returned by the gateway. */
  refreshTokenExpiresAt: string | number;
  refreshAfter: string;
  isNew: boolean;
  deviceId: string;
  leasedAt: string;
  /** Remote gateway bound to a credential imported through the pairing flow. */
  pairedGatewayUrl?: string;
}

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
 * Persist the Baseten sandbox access token a hatch exchanged for an
 * assistant, at {@link basetenTokenPath} under the guardian token's
 * 0600/0700 discipline. Read by the desktop proxy's forward planner — the
 * single credential for reaching that sandbox's gateway.
 */
export function saveBasetenSandboxToken(
  assistantId: string,
  token: string,
): void {
  const tokenPath = basetenTokenPath(assistantId);
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  const data = JSON.stringify({ token, mintedAt: new Date().toISOString() });
  fs.writeFileSync(tokenPath, data + "\n", { mode: 0o600 });
  fs.chmodSync(tokenPath, 0o600);
}

/** The token file the hatch writes: the sandbox access token plus mint bookkeeping. */
const BasetenTokenFileSchema = z.object({
  token: z.string().min(1),
  mintedAt: z.string().optional(),
});

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
 * Prefix of the machine-readable line `cadet gateway token refresh` writes
 * to stderr on failure so hosts can distinguish a spent credential (401)
 * from an unreachable gateway (503) without scraping the human message.
 */
export const GUARDIAN_REFRESH_ERROR_PREFIX = "CADET_REFRESH_ERROR=";

/** Encode a structured refresh failure for the CLI's stderr. */
export function formatGuardianRefreshCliFailure(
  status: number,
  error: string,
): string {
  return `${GUARDIAN_REFRESH_ERROR_PREFIX}${JSON.stringify({ status, error })}`;
}

/**
 * Read the structured status out of a failed `cadet gateway token refresh`.
 * An unlabeled non-zero exit defaults to 503: this spawn only runs when the
 * on-disk refresh token is still unexpired, so a bare CLI failure is an
 * unreachable or still-starting gateway, not a spent credential.
 */
export function parseGuardianRefreshCliFailure(
  stdout: string,
  stderr: string,
): TokenResult {
  const blob = `${stderr}\n${stdout}`;
  for (const line of blob.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(GUARDIAN_REFRESH_ERROR_PREFIX)) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(
        trimmed.slice(GUARDIAN_REFRESH_ERROR_PREFIX.length),
      );
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        !("status" in parsed) ||
        typeof (parsed as { status: unknown }).status !== "number"
      ) {
        continue;
      }
      const status = (parsed as { status: number }).status;
      if (status < 400 || status > 599) {
        continue;
      }
      const errorText =
        "error" in parsed &&
        typeof (parsed as { error: unknown }).error === "string" &&
        (parsed as { error: string }).error.trim() !== ""
          ? (parsed as { error: string }).error
          : "Failed to refresh guardian token";
      return { ok: false, status, error: errorText };
    } catch {
      // Keep scanning; a later well-formed line still wins.
    }
  }
  return {
    ok: false,
    status: 503,
    error: "Failed to refresh guardian token",
  };
}

export interface GuardianTokenOptions {
  /**
   * True when the entry was imported from another machine via `cadet pair`.
   * A paired entry has no local daemon, so expired-refresh guidance points at
   * re-pairing instead of `cadet hatch`/`cadet wake`.
   */
  paired?: boolean;
  /** Gateway URL resolved for the paired proxy request. */
  pairedGatewayUrl?: string;
}

export function getGuardianAccessToken(
  assistantId: string,
  invocation: CliInvocation,
  isLoopback: boolean,
  options?: GuardianTokenOptions,
): Promise<TokenResult> {
  if (!isLoopback) {
    return Promise.resolve({ ok: false, status: 403, error: "Forbidden" });
  }

  let tokenPath: string;
  try {
    tokenPath = guardianTokenPath(assistantId);
  } catch {
    return Promise.resolve({
      ok: false,
      status: 400,
      error: "Invalid assistant ID",
    });
  }

  let raw: string | undefined;
  try {
    raw = fs.readFileSync(tokenPath, "utf-8");
  } catch {
    // Not found at the one canonical location.
  }
  if (raw === undefined) {
    return Promise.resolve({
      ok: false,
      status: 404,
      error: "Guardian token not found",
    });
  }

  let data: GuardianTokenData;
  try {
    data = JSON.parse(raw) as GuardianTokenData;
  } catch {
    return Promise.resolve({
      ok: false,
      status: 500,
      error: "Malformed guardian token file",
    });
  }

  if (data.pairedGatewayUrl) {
    if (!options?.paired) {
      return Promise.resolve({
        ok: false,
        status: 403,
        error: PAIRED_GUARDIAN_TOKEN_HOST_ONLY_ERROR,
      });
    }
    if (options.pairedGatewayUrl !== data.pairedGatewayUrl) {
      return Promise.resolve({
        ok: false,
        status: 403,
        error: PAIRED_GUARDIAN_TARGET_MISMATCH_ERROR,
      });
    }
  } else if (options?.paired) {
    if (!options.pairedGatewayUrl) {
      return Promise.resolve({
        ok: false,
        status: 403,
        error: PAIRED_GUARDIAN_TARGET_MISMATCH_ERROR,
      });
    }
    data = { ...data, pairedGatewayUrl: options.pairedGatewayUrl };
    try {
      saveGuardianToken(assistantId, data);
    } catch {
      return Promise.resolve({
        ok: false,
        status: 500,
        error: "Failed to bind paired assistant credential",
      });
    }
  }

  if (!isAccessTokenExpired(data)) {
    return Promise.resolve({ ok: true, accessToken: data.accessToken });
  }

  if (isRefreshTokenExpired(data)) {
    return Promise.resolve({
      ok: false,
      status: 401,
      error: options?.paired
        ? "Guardian token expired. Run `cadet pair` on the assistant's machine, then re-import it from the app's connect flow or with `cadet connect import`."
        : "Guardian token expired. Re-run `cadet hatch` or `cadet wake`.",
    });
  }

  const existingRefresh = guardianTokenRefreshes.get(tokenPath);
  if (existingRefresh) {
    return existingRefresh;
  }
  const refresh = refreshToken(assistantId, invocation).finally(() => {
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

/** Resolve a paired bearer only when the proxy target matches its binding. */
export async function getPairedGuardianAccessToken(
  assistantId: string,
  pairedGatewayUrl: string,
  invocation: CliInvocation | (() => Promise<CliInvocation>),
  isLoopback: boolean,
): Promise<TokenResult> {
  // Baseten sandboxes don't lease guardian tokens: the credential is the
  // sandbox access token the hatch saved beside the lockfile, read straight
  // from disk — no CLI runtime, no mint, no refresh cycle. A missing file
  // surfaces the structured 404 the proxy renders.
  if (isBasetenAssistant(assistantId)) {
    return readBasetenSandboxToken(assistantId);
  }
  let resolved: CliInvocation;
  try {
    resolved =
      typeof invocation === "function" ? await invocation() : invocation;
  } catch (err) {
    return { ok: false, status: 500, error: (err as Error).message };
  }
  return getGuardianAccessToken(assistantId, resolved, isLoopback, {
    paired: true,
    pairedGatewayUrl,
  });
}

function refreshToken(
  assistantId: string,
  invocation: CliInvocation,
): Promise<TokenResult> {
  return new Promise((resolve) => {
    const child = spawn(
      invocation.command,
      [...invocation.baseArgs, "gateway", "token", "refresh", assistantId],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env },
      },
    );

    let stdout = "";
    let stderr = "";
    let done = false;

    const finish = (result: TokenResult) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        ok: false,
        status: 500,
        error: "Guardian token refresh timed out",
      });
    }, GUARDIAN_TOKEN_REFRESH_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        const accessToken = stdout.trim();
        if (accessToken) {
          finish({ ok: true, accessToken });
        } else {
          finish({ ok: false, status: 500, error: "CLI returned empty token" });
        }
      } else {
        // This spawn only runs when the on-disk refresh token is still
        // unexpired. A non-zero CLI exit is therefore a transport or
        // gateway-availability failure unless the CLI labels a spent
        // credential (401) or a local confidentiality refusal (403).
        finish(parseGuardianRefreshCliFailure(stdout, stderr));
      }
    });

    child.on("error", (err) => {
      finish({
        ok: false,
        status: 500,
        error: `Failed to spawn CLI: ${err.message}`,
      });
    });
  });
}
