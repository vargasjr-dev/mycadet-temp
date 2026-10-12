/**
 * Tests for {@link getPluginCatalog}.
 *
 * Exercises the cloud fetcher wiring and the per-ref TTL cache via a fake
 * `deps.fetch` returning a `/v1/plugins/` payload (no real network).
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";

import type { FetchLike } from "../fetch-like.js";
import {
  getPluginCatalog,
  invalidatePluginCatalogCache,
  PLUGIN_CATALOG_CACHE_TTL_MS,
} from "../plugin-catalog-cache.js";
import type { SearchPluginsDeps } from "../search-plugins.js";
import type { PluginCatalog } from "../search-plugins.js";

// A non-zero base time. Bun treats `setSystemTime(new Date(0))` as "reset to
// the real clock", so the fake clock must start from a positive epoch.
const BASE_TIME_MS = 1_700_000_000_000;

function githubNames(catalog: PluginCatalog): string[] {
  return catalog.matches
    .filter((match) => match.source.kind === "github")
    .map((match) => match.name);
}

/** A `deps.fetch` that serves a `/v1/plugins/` payload and counts its calls. */
function platformFetch(names: string[]): {
  fetch: FetchLike;
  calls: () => number;
} {
  let calls = 0;
  const body = JSON.stringify({
    plugins: names.map((name) => ({
      name,
      repo: `acme/${name}`,
      ref: "0".repeat(40),
    })),
  });
  const fetch: FetchLike = (async () => {
    calls += 1;
    return new Response(body, { status: 200 });
  }) as never;
  return { fetch, calls: () => calls };
}

/** A `deps.fetch` that always fails with a non-2xx (→ unavailable). */
function failingFetch(): { fetch: FetchLike; calls: () => number } {
  let calls = 0;
  const fetch: FetchLike = (async () => {
    calls += 1;
    return new Response("", { status: 503 });
  }) as never;
  return { fetch, calls: () => calls };
}

describe("getPluginCatalog", () => {
  beforeEach(() => {
    invalidatePluginCatalogCache();
  });

  afterEach(() => {
    setSystemTime();
  });

  test("fetches from the cloud once, then serves cache within the TTL", async () => {
    // GIVEN platform features enabled and a cloud fetcher returning ["a"]
    const { fetch, calls } = platformFetch(["a"]);
    const deps: SearchPluginsDeps = { fetch };

    // WHEN we request the same ref twice in quick succession
    const first = await getPluginCatalog("main", deps);
    const second = await getPluginCatalog("main", deps);

    // THEN the cloud is fetched exactly once — the second call is cached
    expect(calls()).toBe(1);
    expect(first).toEqual(second);
    expect(githubNames(first)).toEqual(["a"]);
    expect(first.ref).toBe("main");
  });

  test("refetches after invalidation", async () => {
    // GIVEN a first successful load
    const { fetch, calls } = platformFetch(["a"]);
    const deps: SearchPluginsDeps = { fetch };
    await getPluginCatalog("main", deps);

    // WHEN the cache is invalidated and we request again
    invalidatePluginCatalogCache();
    await getPluginCatalog("main", deps);

    // THEN the cloud is fetched a second time
    expect(calls()).toBe(2);
  });

  test("refetches after the TTL elapses", async () => {
    // GIVEN a fresh load at t0
    setSystemTime(new Date(BASE_TIME_MS));
    const { fetch, calls } = platformFetch(["a"]);
    const deps: SearchPluginsDeps = { fetch };
    await getPluginCatalog("main", deps);

    // WHEN the TTL has elapsed and we request again
    setSystemTime(new Date(BASE_TIME_MS + PLUGIN_CATALOG_CACHE_TTL_MS + 1));
    await getPluginCatalog("main", deps);

    // THEN the cloud is fetched again
    expect(calls()).toBe(2);
  });

  test("fails hard on refresh failure — does NOT serve the stale cache", async () => {
    // GIVEN a good catalog cached at t0
    setSystemTime(new Date(BASE_TIME_MS));
    const good = platformFetch(["good"]);
    const cached = await getPluginCatalog("main", { fetch: good.fetch });
    expect(githubNames(cached)).toEqual(["good"]);

    // WHEN the TTL has elapsed and the refresh fails
    setSystemTime(new Date(BASE_TIME_MS + PLUGIN_CATALOG_CACHE_TTL_MS + 1));
    const failing = failingFetch();
    const err = await getPluginCatalog("main", { fetch: failing.fetch }).catch(
      (e: unknown) => e,
    );

    // THEN the failure propagates instead of serving the stale catalog
    expect(err).toBeInstanceOf(Error);
    expect(failing.calls()).toBe(1);
  });
});
