import type { CookieJar, OriginCookie } from "../../operations/cookie-jar";

/**
 * A Map-backed `CookieJar` fake: cookies keyed by origin URL, a re-set of
 * a held name replacing it like a real store. The route-table tests seed
 * `store` directly to arrange a jar state, then read it to assert what a
 * row stored.
 */
export class MemoryCookieJar implements CookieJar {
  readonly store = new Map<string, OriginCookie[]>();

  async get(url: string): Promise<OriginCookie[]> {
    return [...(this.store.get(url) ?? [])];
  }

  async set(url: string, cookie: OriginCookie): Promise<void> {
    const list = this.store.get(url) ?? [];
    const existing = list.findIndex((held) => held.name === cookie.name);
    if (existing >= 0) list[existing] = cookie;
    else list.push(cookie);
    this.store.set(url, list);
  }
}
