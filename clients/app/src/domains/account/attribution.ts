export const ATTRIBUTION_PARAMS: readonly string[] = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "gclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "fbclid",
  "ttclid",
  "li_fat_id",
  "twclid",
];

/** Server truncates per-field; this only bounds what we put on the wire. */
const ATTRIBUTION_VALUE_MAX_LENGTH = 512;

/**
 * Attribution params present on the current URL, carried here from the
 * campaign landing page.
 *
 * Attribution normally rides the `cadet_utm` cookie, but that cookie is set
 * by the marketing site's middleware and does not survive a social in-app
 * browser (Instagram, Facebook) handing off to the system browser — the new
 * cookie jar never saw it, so paid-social signups arrive unattributed.
 * URL params do survive that handoff, and the backend falls back to reading
 * them off the request when the cookie is missing, so forwarding them here
 * gives the flow a cookie-free path to attribution.
 */
export function readAttributionParams(search: string): Record<string, string> {
  const params = new URLSearchParams(search);
  const collected: Record<string, string> = {};
  for (const key of ATTRIBUTION_PARAMS) {
    const value = params.get(key);
    if (value) {
      collected[key] = value.slice(0, ATTRIBUTION_VALUE_MAX_LENGTH);
    }
  }
  return collected;
}

/**
 * Append the allowlisted attribution params found in `search` to `href`, so
 * auth cross-links keep the cookie-free attribution path described above
 * alive across a pivot.
 *
 * Keys already present in `href`'s query string win: an href that carries
 * attribution was decorated deliberately upstream, so re-applying is safe
 * (idempotent). Returns `href` unchanged when nothing new is collected.
 */
export function withPreservedAttribution(href: string, search: string): string {
  const queryStart = href.indexOf("?");
  const existing = new URLSearchParams(
    queryStart === -1 ? "" : href.slice(queryStart + 1),
  );
  const additions = new URLSearchParams();
  for (const [key, value] of Object.entries(readAttributionParams(search))) {
    if (!existing.has(key)) {
      additions.append(key, value);
    }
  }
  const query = additions.toString();
  if (query === "") {
    return href;
  }
  return `${href}${queryStart === -1 ? "?" : "&"}${query}`;
}
