/**
 * The cookie custody seam between the operator route table and the serving
 * host's cookie store. The cookie-carrying rows — the hatch row, which
 * mints the webview's credential pair, and the proxy row, whose upstream
 * rotates it — speak this interface instead of a wire convention: the host
 * hands its own store over as a `CookieJar` on `forwardOperatorRequest`,
 * and the rows own the rest (parsing a `Set-Cookie` value into a
 * `OriginCookie`, serializing the jar's cookies into a `Cookie` header) so
 * no host repeats the logic.
 *
 * A jar is best-effort by contract: `get` resolves (a failed read is an
 * empty jar), `set` swallows refusals (an unstored pair degrades to an
 * unauthenticated dial, never a failed response) — a host that wants more
 * noise logs inside its own adapter.
 */

/**
 * A cookie as a cookie store holds it — the store's grain, not the wire's.
 * The field set is deliberately the intersection every real store speaks
 * (Chromium's session jar, a browser's native jar): name, value, and the
 * scope attributes. Absent attributes read as the store's defaults.
 */
export interface OriginCookie {
  name: string;
  value: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
  /** Epoch seconds; absent reads as a session cookie. */
  expirationDate?: number;
}

/**
 * A cookie store, addressed by URL: `get` answers the cookies the store
 * holds for `url`'s origin (what a browser would attach as `Cookie`);
 * `set` stores `cookie` for `url`'s origin, keyed by name (a re-set of a
 * held name replaces it, like a real jar).
 */
export interface CookieJar {
  get(url: string): Promise<OriginCookie[]>;
  set(url: string, cookie: OriginCookie): Promise<void>;
}

/**
 * Parse one raw `Set-Cookie` value into a jar-ready `OriginCookie` — the
 * name/value pair plus the attributes a store keeps. A value with no
 * parseable pair (empty name, no `=`) parses as null. `Max-Age` wins over
 * `Expires` when both ride (the RFC 6265 precedence).
 */
export function parseSetCookie(raw: string): OriginCookie | null {
  const [pair, ...attrs] = raw.split(";");
  const eq = pair.indexOf("=");
  if (eq <= 0) return null;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!name) return null;
  const cookie: OriginCookie = { name, value };
  let maxAge: number | undefined;
  for (const attr of attrs) {
    const sep = attr.indexOf("=");
    const attrName = (sep === -1 ? attr : attr.slice(0, sep))
      .trim()
      .toLowerCase();
    const attrValue = sep === -1 ? "" : attr.slice(sep + 1).trim();
    if (attrName === "path") {
      cookie.path = attrValue || undefined;
    } else if (attrName === "secure") {
      cookie.secure = true;
    } else if (attrName === "httponly") {
      cookie.httpOnly = true;
    } else if (attrName === "samesite") {
      const site = attrValue.toLowerCase();
      cookie.sameSite =
        site === "strict"
          ? "strict"
          : site === "lax"
            ? "lax"
            : site === "none"
              ? "no_restriction"
              : "unspecified";
    } else if (attrName === "max-age") {
      const parsed = Number(attrValue);
      if (Number.isFinite(parsed)) maxAge = parsed;
    } else if (attrName === "expires" && cookie.expirationDate === undefined) {
      const parsed = Date.parse(attrValue);
      if (Number.isFinite(parsed)) cookie.expirationDate = parsed / 1000;
    }
  }
  if (maxAge !== undefined) {
    cookie.expirationDate = Math.floor(Date.now() / 1000) + maxAge;
  }
  return cookie;
}

/**
 * Serialize the jar's cookies into the `Cookie` header a browser would
 * attach — `name=value` pairs joined with `; `.
 */
export function cookieHeader(cookies: OriginCookie[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}
