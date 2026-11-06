/**
 * Pure helpers for `cadet pair`'s remote-web approval flow.
 *
 * Pairing challenge stores are in-memory per gateway process, so approving a
 * code against a different assistant or environment than the one that served
 * the pair page looks identical to a typo'd or expired code. These helpers
 * turn the gateway's error envelope into a diagnostic that names the gateway
 * actually asked.
 */

import { resolveEnvironmentName } from "@mycadet/local-mode";
import { REMOTE_WEB_PAIRING_CODE_TTL_MS } from "@mycadet/service-contracts/remote-web-pairing";

const CODE_TTL_MINUTES = Math.round(REMOTE_WEB_PAIRING_CODE_TTL_MS / 60_000);

/**
 * Extract the `error.code` from a gateway JSON error envelope
 * (`{"error":{"code":...,"message":...}}`). Returns null when the body is not
 * JSON or carries no string code.
 */
export function parseGatewayErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } };
    return typeof parsed.error?.code === "string" ? parsed.error.code : null;
  } catch {
    return null;
  }
}

/**
 * Diagnostic for a failed `--web-approve`, naming which gateway rejected the
 * code and hinting at cross-assistant / cross-environment mismatches.
 */
export function formatWebApproveFailure(
  gatewayUrl: string,
  assistantReference: string,
  errorCode: string | null,
): string | null {
  if (errorCode !== "INVALID_USER_CODE" && errorCode !== "EXPIRED_USER_CODE") {
    return null;
  }
  const rejection =
    errorCode === "EXPIRED_USER_CODE"
      ? "Pairing code expired on"
      : "No such pairing code on";
  return [
    `${rejection} ${gatewayUrl} (assistant "${assistantReference}", environment "${resolveEnvironmentName()}").`,
    `Codes are minted by the gateway that serves the pair page, expire after ${CODE_TTL_MINUTES} minutes, and are single-use.`,
    "If the pair page came from a different assistant or environment, such as the desktop app's, re-run with that environment's CADET_ENVIRONMENT and that assistant's name.",
  ].join("\n");
}
