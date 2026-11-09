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
  // The host's lockfile read answers first (no returning signal recorded),
  // then the cloud membership and assistant pages decide.
  fetchSpy.mockResolvedValueOnce(response({ assistants: [] }));
  fetchSpy.mockResolvedValueOnce(response({ results: [{ id: "org-1" }] }));
  fetchSpy.mockResolvedValueOnce(
    response({
      results: [{ id: "assistant-1", created: "2020-01-01T00:00:00Z" }],
    }),
  );
  expect(await readReturningUser()).toBe(true);
  // The first fetch is the host read (/v1/assistants/), the third the
  // cloud assistant page — same surface, two authorities.
  expect(fetchSpy.mock.calls[0]?.[0]).toContain("/v1/assistants/");
  expect(fetchSpy.mock.calls[2]?.[0]).toContain("/v1/assistants/");
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
  // The desktop answers the lockfile read through its operator route; the
  // dead bridge (if a stale shell still exposes one) is never consulted.
  Object.defineProperty(window, "cadet", {
    configurable: true,
    value: {
      platform: "electron",
      localMode: new Proxy(
        {},
        {
          get: () => {
            throw new Error("the localMode bridge must never be consulted");
          },
        },
      ),
    },
  });
  fetchSpy.mockResolvedValueOnce(
    response({
      assistants: [{ assistantId: "local-1", onboardedAt: "2026-10-01" }],
    }),
  );
  expect(await readReturningUser()).toBe(true);
  expect(fetchSpy.mock.calls[0]?.[0]).toContain("/v1/assistants/");
});
test("an invalid host response falls back to cloud without trusting malformed stamps", async () => {
  Object.defineProperty(window, "cadet", {
    configurable: true,
    value: { platform: "electron" },
  });
  // The lockfile read answers; the payload fails the lockfile schema.
  fetchSpy.mockResolvedValueOnce(response({ assistants: "not-a-list" }));
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

test("an injected id without a completion stamp does not bypass first-run signup", async () => {
  fetchSpy.mockResolvedValueOnce(
    response({ detail: "Authentication required" }),
  );
  expect(await readReturningUser()).toBe(false);
});
test("a stalled native host read cannot block routing after cancellation or start a late cloud lookup", async () => {
  // The native read IS the /v1 fetch now; an abort before it settles must
  // resolve false and never fire the late cloud lookups.
  let resolve!: (value: Response) => void;
  fetchSpy.mockImplementationOnce(
    Object.assign(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
      { preconnect: fetch.preconnect },
    ),
  );
  Object.defineProperty(window, "cadet", {
    configurable: true,
    value: { platform: "electron" },
  });
  const controller = new AbortController();
  const pending = readReturningUser({ signal: controller.signal });
  controller.abort();
  expect(await pending).toBe(false);
  resolve(response({ assistants: [] }));
  await Promise.resolve();
  expect(fetchSpy.mock.calls.length).toBe(1);
});
test("a cloud request that ignores cancellation still cannot hold up the destination", async () => {
  fetchSpy.mockImplementationOnce(
    Object.assign(() => new Promise<Response>(() => {}), {
      preconnect: fetch.preconnect,
    }),
  );
  const controller = new AbortController();
  const pending = readReturningUser({ signal: controller.signal });
  controller.abort();
  expect(await pending).toBe(false);
});
