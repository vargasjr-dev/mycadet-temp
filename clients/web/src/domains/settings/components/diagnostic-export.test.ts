import { afterAll, expect, mock, test } from "bun:test";

const { exportLocalDebugBundle } = await import("./diagnostic-export");
const originalFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = originalFetch;
});
test("exports logs through the scoped data plane and uploads bytes with no credential", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchMock = mock(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response("diagnostic tar bytes");
    },
  );
  globalThis.fetch = Object.assign(fetchMock, {
    preconnect: originalFetch.preconnect,
  });
  await exportLocalDebugBundle(
    {
      assistantId: "local-1",
      cloud: "local",
      name: "Local",
      port: 7830,
      hatchedAt: "2026-01-01",
    },
    "https://storage.example.com/upload",
  );
  expect(calls[0].url).toEndWith("/v1/assistants/local-1/logs/export");
  expect(new Headers(calls[0].init?.headers).has("Authorization")).toBe(false);
  expect(calls[1].url).toBe("https://storage.example.com/upload");
  expect(new Headers(calls[1].init?.headers).has("Authorization")).toBe(false);
  expect(calls[1].init?.body).toBeInstanceOf(Blob);
  expect(calls.some((call) => call.url.includes("/migrations/"))).toBe(false);
});
