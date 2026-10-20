import { afterEach, expect, spyOn, test } from "bun:test";

import {
  REMEMBERED_ORIGINS_STORAGE_KEY,
  normalizeOriginUrl,
  resetRememberedOriginsForTesting,
  toRememberedOrigins,
  useRememberedOriginsStore,
} from "./remembered-origins-store";
import * as localSettings from "@app/utils/local-settings";

afterEach(() => {
  localStorage.clear();
  resetRememberedOriginsForTesting();
});

test("normalizeOriginUrl trims, canonicalizes, and refuses non-https or unparseable bases", () => {
  expect(normalizeOriginUrl("  https://Host.Example/prefix/  ")).toBe(
    "https://host.example/prefix",
  );
  expect(normalizeOriginUrl("https://host.example/prefix/assistant/pair")).toBe(
    "https://host.example/prefix/assistant/pair",
  );
  expect(normalizeOriginUrl("https://host.example?q=1#frag")).toBe(
    "https://host.example",
  );
  expect(normalizeOriginUrl("http://host.example")).toBeNull();
  expect(normalizeOriginUrl("javascript:alert(1)")).toBeNull();
  expect(normalizeOriginUrl("not a url")).toBeNull();
  expect(normalizeOriginUrl("   ")).toBeNull();
});

test("toRememberedOrigins drops unusable items, keeps the first per url, and stamps a fallback date", () => {
  const parsed = toRememberedOrigins([
    "not-an-object",
    null,
    { url: "https://a.example", addedAt: "2026-01-01T00:00:00.000Z" },
    { url: "https://a.example", addedAt: "2026-02-02T00:00:00.000Z" },
    { url: "http://b.example" },
    { name: "Named", url: "https://c.example/" },
  ]);
  expect(parsed).toEqual([
    { url: "https://a.example", addedAt: "2026-01-01T00:00:00.000Z" },
    { name: "Named", url: "https://c.example", addedAt: parsed[1]!.addedAt },
  ]);
  // The fallback stamped the dateless entry with the call's single "now".
  expect(typeof parsed[1]!.addedAt).toBe("string");
});

test("hydrate reads the stored list and an absent key reads as empty", async () => {
  localStorage.setItem(
    REMEMBERED_ORIGINS_STORAGE_KEY,
    JSON.stringify([
      { url: "https://a.example", addedAt: "2026-01-01T00:00:00.000Z" },
    ]),
  );
  await useRememberedOriginsStore.hydrate();
  expect(useRememberedOriginsStore.getState()).toEqual({
    origins: [
      { url: "https://a.example", addedAt: "2026-01-01T00:00:00.000Z" },
    ],
    hydrated: true,
    // Web's zustand shape collapses the actions into the state read.
    addOrigin: expect.any(Function),
    removeOrigin: expect.any(Function),
    hydrate: expect.any(Function),
  });
});

test("a stored value that is not a JSON array leaves the store unhydrated, and a later hydrate retries", async () => {
  localStorage.setItem(REMEMBERED_ORIGINS_STORAGE_KEY, '{"nope":true}');
  await useRememberedOriginsStore.hydrate();
  expect(useRememberedOriginsStore.getState().hydrated).toBe(false);

  localStorage.setItem(
    REMEMBERED_ORIGINS_STORAGE_KEY,
    JSON.stringify([{ url: "https://a.example" }]),
  );
  await useRememberedOriginsStore.hydrate();
  expect(useRememberedOriginsStore.getState().hydrated).toBe(true);
  expect(useRememberedOriginsStore.getState().origins).toHaveLength(1);
});

test("addOrigin stores and publishes the normalized base, refusing invalid urls", async () => {
  const bad = await useRememberedOriginsStore.addOrigin({
    url: "http://x.example",
  });
  expect(bad).toEqual({ ok: false });
  expect(localStorage.getItem(REMEMBERED_ORIGINS_STORAGE_KEY)).toBeNull();

  const result = await useRememberedOriginsStore.addOrigin({
    url: " https://Host.Example/prefix/ ",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(result.origin.url).toBe("https://host.example/prefix");
  expect(useRememberedOriginsStore.getState().origins).toHaveLength(1);
  expect(
    JSON.parse(localStorage.getItem(REMEMBERED_ORIGINS_STORAGE_KEY)!),
  ).toEqual([
    { url: "https://host.example/prefix", addedAt: result.origin.addedAt },
  ]);
});

test("re-adding a remembered url keeps its original addedAt and updates the name only when given", async () => {
  const first = await useRememberedOriginsStore.addOrigin({
    url: "https://a.example",
  });
  if (!first.ok) throw new Error("unreachable");
  const second = await useRememberedOriginsStore.addOrigin({
    url: "https://a.example/",
  });
  if (!second.ok) throw new Error("unreachable");
  expect(second.origin.addedAt).toBe(first.origin.addedAt);
  expect(useRememberedOriginsStore.getState().origins).toHaveLength(1);

  const named = await useRememberedOriginsStore.addOrigin({
    url: "https://a.example",
    name: "  Workshop  ",
  });
  if (!named.ok) throw new Error("unreachable");
  expect(named.origin.name).toBe("Workshop");
  expect(named.origin.addedAt).toBe(first.origin.addedAt);
});

test("a failed persistence write is reported, never published", async () => {
  const setSpy = spyOn(localSettings, "setLocalSetting").mockReturnValue(false);
  try {
    const result = await useRememberedOriginsStore.addOrigin({
      url: "https://a.example",
    });
    expect(result).toEqual({ ok: false });
    expect(useRememberedOriginsStore.getState().origins).toHaveLength(0);
  } finally {
    setSpy.mockRestore();
  }
});

test("a failed read leaves addOrigin refusing, so empty state never overwrites storage", async () => {
  localStorage.setItem(REMEMBERED_ORIGINS_STORAGE_KEY, "not json at all");
  const result = await useRememberedOriginsStore.addOrigin({
    url: "https://a.example",
  });
  expect(result).toEqual({ ok: false });
  expect(localStorage.getItem(REMEMBERED_ORIGINS_STORAGE_KEY)).toBe(
    "not json at all",
  );
});

test("removeOrigin forgets the entry and a failed write keeps it", async () => {
  await useRememberedOriginsStore.addOrigin({ url: "https://a.example" });
  await useRememberedOriginsStore.addOrigin({ url: "https://b.example" });

  await useRememberedOriginsStore.removeOrigin("https://a.example");
  expect(
    useRememberedOriginsStore.getState().origins.map((o) => o.url),
  ).toEqual(["https://b.example"]);

  const setSpy = spyOn(localSettings, "setLocalSetting").mockReturnValue(false);
  try {
    await useRememberedOriginsStore.removeOrigin("https://b.example");
    expect(useRememberedOriginsStore.getState().origins).toHaveLength(1);
  } finally {
    setSpy.mockRestore();
  }
});

test("a storage change from another tab refreshes the hydrated store", async () => {
  await useRememberedOriginsStore.hydrate();
  localStorage.setItem(
    REMEMBERED_ORIGINS_STORAGE_KEY,
    JSON.stringify([
      { url: "https://elsewhere.example", addedAt: "2026-01-01T00:00:00.000Z" },
    ]),
  );
  window.dispatchEvent(
    new StorageEvent("storage", { key: REMEMBERED_ORIGINS_STORAGE_KEY }),
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(
    useRememberedOriginsStore.getState().origins.map((o) => o.url),
  ).toEqual(["https://elsewhere.example"]);
});
