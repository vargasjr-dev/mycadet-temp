/**
 * Tests for the gated catalog resolvers.
 *
 * `resolveSourceFromMatch` is exercised as a pure function. The catalog-backed
 * resolvers run against a mocked cloud catalog (zero real network), plus a
 * case that asserts a rejecting catalog fetch propagates rather than
 * resolving to `null`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { FetchLike } from "../fetch-like.js";
import { invalidatePluginCatalogCache } from "../plugin-catalog-cache.js";
import {
  findCatalogEntry,
  resolvePluginSourceFromCatalog,
  resolveSourceFromMatch,
} from "../plugin-catalog-resolve.js";
import type {
  PluginSearchMatch,
  SearchPluginsDeps,
} from "../search-plugins.js";
import { PluginCatalogUnavailableError } from "../search-plugins.js";

const FULL_SHA = "63a91ecadbf4c4719a4602a5abb00883f9966034";

/** A synthetic catalog match with an overridable source. */
function match(
  source: Partial<
    Extract<PluginSearchMatch["source"], { kind: "github" }>
  > = {},
): PluginSearchMatch {
  return {
    name: "example",
    path: "github:acme/example@ref",
    category: null,
    source: { kind: "github", repo: "acme/example", ref: FULL_SHA, ...source },
  };
}

describe("resolveSourceFromMatch", () => {
  test("returns owner/repo/path/ref for a full-SHA match", () => {
    expect(
      resolveSourceFromMatch(
        match({ repo: "acme/widget", path: "pkg/plugin" }),
      ),
    ).toEqual({
      kind: "github",
      owner: "acme",
      repo: "widget",
      path: "pkg/plugin",
      ref: FULL_SHA,
    });
  });

  test('defaults path to "" when the source declares none', () => {
    expect(resolveSourceFromMatch(match())).toEqual({
      kind: "github",
      owner: "acme",
      repo: "example",
      path: "",
      ref: FULL_SHA,
    });
  });

  test.each([
    ["absent", undefined],
    ["empty", ""],
  ])('resolves a repo-root %s path to ""', (_label, path) => {
    // A repo-root entry (`path: ""` or absent) is valid — the clean-path gate
    // only applies to a non-empty path, so it must not be rejected.
    expect(resolveSourceFromMatch(match({ path }))).toEqual({
      kind: "github",
      owner: "acme",
      repo: "example",
      path: "",
      ref: FULL_SHA,
    });
  });

  test.each([
    ["too many segments", "owner/repo/extra"],
    ["a slashless name", "justname"],
  ])("throws on an invalid repo slug with %s", (_label, repo) => {
    expect(() => resolveSourceFromMatch(match({ repo }))).toThrow(
      /invalid source/,
    );
  });

  test.each([
    ["a branch", "main"],
    ["a tag", "v1.2.3"],
    ["a short SHA", "63a91ec"],
  ])("throws on %s ref", (_label, ref) => {
    expect(() => resolveSourceFromMatch(match({ ref }))).toThrow(
      /invalid source/,
    );
  });

  test("resolves a clean nested path", () => {
    expect(resolveSourceFromMatch(match({ path: "packages/plugin" }))).toEqual({
      kind: "github",
      owner: "acme",
      repo: "example",
      path: "packages/plugin",
      ref: FULL_SHA,
    });
  });

  test.each([
    ["a leading `..` segment", "../evil"],
    ["an interior `..` segment", "a/../b"],
    ["a backslash `..` segment", "a\\..\\b"],
    ["an empty segment", "a//b"],
  ])("throws on an unsafe path with %s", (_label, path) => {
    expect(() => resolveSourceFromMatch(match({ path }))).toThrow(
      /invalid source/,
    );
  });
});

describe("catalog-backed resolvers (cloud catalog)", () => {
  beforeEach(() => {
    invalidatePluginCatalogCache();
  });

  afterEach(() => {
    invalidatePluginCatalogCache();
  });

  /** A `deps.fetch` serving a small `/v1/plugins/` payload. */
  const catalogDeps: SearchPluginsDeps = {
    fetch: (async () =>
      new Response(
        JSON.stringify({
          plugins: [
            {
              name: "caveman",
              repo: "JuliusBrussee/caveman",
              ref: FULL_SHA,
            },
            {
              name: "gamma",
              repo: "acme/gamma",
              ref: FULL_SHA,
            },
          ],
        }),
        { status: 200 },
      )) as FetchLike,
  };

  test("findCatalogEntry returns the catalog entry for a known name", async () => {
    const entry = await findCatalogEntry("caveman", catalogDeps);
    expect(entry?.name).toBe("caveman");
    expect(entry?.source).toEqual({
      kind: "github",
      repo: "JuliusBrussee/caveman",
      path: undefined,
      ref: FULL_SHA,
    });
  });

  test("resolvePluginSourceFromCatalog resolves a known name to its pinned source", async () => {
    expect(
      await resolvePluginSourceFromCatalog("caveman", catalogDeps),
    ).toEqual({
      kind: "github",
      owner: "JuliusBrussee",
      repo: "caveman",
      path: "",
      ref: FULL_SHA,
    });
  });

  test("resolvePluginSourceFromCatalog returns null for an unknown name", async () => {
    expect(
      await resolvePluginSourceFromCatalog("no-such-plugin", catalogDeps),
    ).toBeNull();
  });

  test("does not resolve a QA integration while its feature flag is off", async () => {
    expect(
      await resolvePluginSourceFromCatalog("gamma", {
        ...catalogDeps,
        featureFlagEnabled: () => false,
      }),
    ).toBeNull();
  });

  test("resolves a QA integration while its feature flag is on", async () => {
    expect(
      await resolvePluginSourceFromCatalog("gamma", {
        ...catalogDeps,
        featureFlagEnabled: () => true,
      }),
    ).toMatchObject({
      kind: "github",
      owner: "acme",
      repo: "gamma",
    });
  });
});

describe("catalog-backed resolvers (platform enabled)", () => {
  beforeEach(() => {
    invalidatePluginCatalogCache();
  });

  afterEach(() => {
    invalidatePluginCatalogCache();
  });

  test("propagates PluginCatalogUnavailableError instead of resolving to null", async () => {
    const deps: SearchPluginsDeps = {
      fetch: (async () => {
        throw new Error("network down");
      }) as FetchLike,
    };
    const promise = resolvePluginSourceFromCatalog("caveman", deps);
    await expect(promise).rejects.toBeInstanceOf(PluginCatalogUnavailableError);
  });
});
