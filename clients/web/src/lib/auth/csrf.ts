/**
 * CSRF token reads for cloud-backed requests.
 *
 * The browser's cookie jar holds the CSRF token the cloud sets — cookie
 * custody lives above this bundle, so the only job here is reading the jar
 * to echo the token back in the `X-CSRFToken` header on mutating requests
 * (POST, PUT, PATCH, DELETE) for the cloud's CSRF middleware.
 */
const CSRF_COOKIE_NAME = import.meta.env.PROD
  ? "__Secure-csrftoken"
  : "csrftoken";

/**
 * Read the CSRF token from the browser cookie jar.
 *
 * When duplicate cookies exist (e.g. a stale host-specific cookie alongside
 * the domain cookie), return the last match to match the server's
 * last-wins cookie semantics.
 */
export function getCsrfToken(): string | undefined {
  const match = document.cookie
    .split("; ")
    .findLast((row) => row.startsWith(`${CSRF_COOKIE_NAME}=`));
  return match?.split("=").slice(1).join("=");
}
