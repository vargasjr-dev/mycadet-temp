import { expect, mock, test } from "bun:test";
import { getCharacterComponents } from "@mycadet/avatar-catalog";

const components = getCharacterComponents();
const loadCatalog = mock(() => components);
mock.module("@mycadet/avatar-catalog", () => ({
  getCharacterComponents: loadCatalog,
}));
const { preloadBundledAvatarComponents } =
  await import("@design/utils/use-bundled-avatar-components");

// A dynamic import settles asynchronously, including its chained handlers.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("lazy catalog preload deduplicates requests, retries a failed load, and caches success", async () => {
  expect(loadCatalog).not.toHaveBeenCalled();
  loadCatalog.mockImplementationOnce(() => {
    throw new Error("temporary failure");
  });
  preloadBundledAvatarComponents();
  preloadBundledAvatarComponents();
  await settle();
  expect(loadCatalog).toHaveBeenCalledTimes(1);
  preloadBundledAvatarComponents();
  preloadBundledAvatarComponents();
  await settle();
  expect(loadCatalog).toHaveBeenCalledTimes(2);
  preloadBundledAvatarComponents();
  await settle();
  expect(loadCatalog).toHaveBeenCalledTimes(2);
});
