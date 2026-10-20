import { afterEach, expect, test } from "bun:test";
import { isLocalClient } from "@app/lib/runtime-mode";

afterEach(() => {
  window.__CADET_CONFIG__ = undefined;
});

test("the injected config's remote field decides: cloud is not local", () => {
  window.__CADET_CONFIG__ = { remote: "cloud" };
  expect(isLocalClient()).toBe(false);
});

test("local, custom, and absent configs all read as local clients", () => {
  window.__CADET_CONFIG__ = { remote: "local" };
  expect(isLocalClient()).toBe(true);
  window.__CADET_CONFIG__ = { remote: "custom" };
  expect(isLocalClient()).toBe(true);
  window.__CADET_CONFIG__ = undefined;
  expect(isLocalClient()).toBe(true);
});
