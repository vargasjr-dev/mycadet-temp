import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readReturningUser, isReturningAssistant } from "./returning-user";
const fetchSpy = spyOn(globalThis, "fetch");
const originalBridge = Object.getOwnPropertyDescriptor(window, "cadet");
beforeEach(() => {
  fetchSpy.mockReset();
  Reflect.deleteProperty(window, "cadet");
  localStorage.removeItem("device:onboarded_assistants");
  window.dispatchEvent(
    new StorageEvent("storage", { key: "device:onboarded_assistants" }),
  );
});
afterEach(() => {
  localStorage.removeItem("device:onboarded_assistants");
  window.dispatchEvent(
    new StorageEvent("storage", { key: "device:onboarded_assistants" }),
  );
  if (originalBridge) {
    Object.defineProperty(window, "cadet", originalBridge);
  } else {
    Reflect.deleteProperty(window, "cadet");
  }
});
function response(value: unknown) {
  return new Response(JSON.stringify(value));
}
test("fresh cloud membership and assistant data determine returning-user status", async () => {
  fetchSpy.mockResolvedValueOnce(response({ results: [{ id: "org-1" }] }));
  fetchSpy.mockResolvedValueOnce(
    response({
      results: [{ id: "assistant-1", created: "2020-01-01T00:00:00Z" }],
    }),
  );
  expect(await readReturningUser()).toBe(true);
  expect(fetchSpy.mock.calls[1]?.[0]).toContain("/v1/assistants/");
});
test("completion records are read live; malformed and missing signals do not skip consent", () => {
  expect(isReturningAssistant({ id: "assistant-1" })).toBe(false);
  localStorage.setItem(
    "device:onboarded_assistants",
    JSON.stringify({ "assistant-1": "2026-10-01" }),
  );
  expect(
    isReturningAssistant({
      id: "assistant-1",
      created: new Date().toISOString(),
    }),
  ).toBe(true);
  localStorage.setItem("device:onboarded_assistants", "not-json");
  expect(isReturningAssistant({ id: "assistant-1", created: "invalid" })).toBe(
    false,
  );
  expect(
    isReturningAssistant({
      id: "assistant-1",
      created: new Date(Date.now() + 86400000).toISOString(),
    }),
  ).toBe(false);
});
test("native host stamps identify local returning users independently of cloud availability", async () => {
  Object.defineProperty(window, "cadet", {
    configurable: true,
    value: {
      platform: "electron",
      localMode: {
        readLockfile: async () => ({
          assistants: [{ assistantId: "local-1", onboardedAt: "2026-10-01" }],
        }),
      },
    },
  });
  expect(await readReturningUser()).toBe(true);
  expect(fetchSpy).not.toHaveBeenCalled();
});
test("an invalid host response falls back to cloud without trusting malformed stamps", async () => {
  Object.defineProperty(window, "cadet", {
    configurable: true,
    value: {
      platform: "electron",
      localMode: {
        readLockfile: async () => ({
          assistants: [{ assistantId: "local-1", onboardedAt: 42 }],
        }),
      },
    },
  });
  fetchSpy.mockResolvedValueOnce(response({ results: [{ id: "org-1" }] }));
  fetchSpy.mockResolvedValueOnce(response({ results: [] }));
  expect(await readReturningUser()).toBe(false);
});

afterAll(() => fetchSpy.mockRestore());

test("same-tab completion notifications survive unavailable storage and cross-tab changes invalidate them", () => {
  window.dispatchEvent(
    new CustomEvent("cadet:pref-changed", {
      detail: {
        key: "device:onboarded_assistants",
        value: JSON.stringify({ "assistant-1": "2026-10-01" }),
      },
    }),
  );
  expect(isReturningAssistant({ id: "assistant-1" })).toBe(true);
  window.dispatchEvent(
    new CustomEvent("cadet:pref-changed", {
      detail: { key: "device:onboarded_assistants", value: "invalid" },
    }),
  );
  expect(isReturningAssistant({ id: "assistant-1" })).toBe(true);
  window.dispatchEvent(
    new StorageEvent("storage", { key: "device:onboarded_assistants" }),
  );
  expect(isReturningAssistant({ id: "assistant-1" })).toBe(false);
});
