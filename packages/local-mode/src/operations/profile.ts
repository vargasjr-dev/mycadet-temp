/**
 * The operator availability check — the one piece of the user's profile
 * surface that lives on the OPERATOR api.
 *
 * The profile's data-layer api (get/patch the user's profile) is gateway
 * side — the operator layer never mutates a data layer. Availability is
 * the exception: the operator owns the "is this handle usable" question
 * for now, and with single-user operators the honest answer is mostly
 * "yes" — a pure format check against the canonical handle codes. It gets
 * fleshed out (a real namespace) when the surface is prepared for cloud.
 */

import type { OperatorRequest } from "./routes";

// ---------------------------------------------------------------------------
// Handle rules — the canonical codes the bundles already have copy for
// ---------------------------------------------------------------------------

export const USERNAME_ERROR_CODES = [
  "too_short",
  "too_long",
  "invalid_chars",
  "leading_underscore",
  "trailing_underscore",
  "leading_hyphen",
  "trailing_hyphen",
  "all_digits",
  "reserved",
  "taken",
] as const;

export type UsernameErrorCode = (typeof USERNAME_ERROR_CODES)[number];

export const USERNAME_COPY: Record<UsernameErrorCode, string> = {
  too_short: "Must be at least 3 characters.",
  too_long: "Must be at most 30 characters.",
  invalid_chars:
    "Use only lowercase letters, digits, hyphens, and underscores.",
  leading_underscore: "Cannot start with an underscore.",
  trailing_underscore: "Cannot end with an underscore.",
  leading_hyphen: "Cannot start with a hyphen.",
  trailing_hyphen: "Cannot end with a hyphen.",
  all_digits: "Cannot be all digits.",
  reserved: "This handle is reserved.",
  taken: "This handle is already taken.",
};

/** Check a candidate handle against the local handle rules. */
export function checkUsernameRule(username: string): UsernameErrorCode | null {
  if (username.length < 3) return "too_short";
  if (username.length > 30) return "too_long";
  if (/[^a-z0-9_-]/.test(username)) return "invalid_chars";
  if (username.startsWith("_")) return "leading_underscore";
  if (username.endsWith("_")) return "trailing_underscore";
  if (username.startsWith("-")) return "leading_hyphen";
  if (username.endsWith("-")) return "trailing_hyphen";
  if (/^[0-9]+$/.test(username)) return "all_digits";
  return null;
}

/**
 * Availability: a local format check — the operator surface's single-user
 * assumption means there is no namespace to collide with yet, so valid
 * handles are available. The gateway's profile patch enforces the same
 * rules (its copy is canonical); this twin exists so the operator surface
 * answers without reaching into a data layer.
 */
export async function runUsernameAvailableRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  const url = new URL(request.path ?? "/", "http://localhost");
  const username = url.searchParams.get("username") ?? "";
  const code = checkUsernameRule(username);
  if (!code) {
    return Response.json({ available: true, code: null, message: null });
  }
  return Response.json({
    available: false,
    code,
    message: USERNAME_COPY[code],
  });
}
