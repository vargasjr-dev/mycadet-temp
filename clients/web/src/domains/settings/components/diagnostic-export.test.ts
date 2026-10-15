import { afterAll, expect, mock, test } from "bun:test";
mock.module("@/lib/local-mode", () => ({
  getLocalGatewayUrl: () => "/assistant/__gateway/7830",
}));
mock.module("@/runtime/local-mode-host", () => ({
  fetchGuardianTokenHost: async () => "guardian",
}));
const { exportLocalDebugBundle } = await import("./diagnostic-export");
const originalFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = originalFetch;
});
test("diagnostics exports logs and uploads bytes without forwarding the guardian to storage", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchMock = mock(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/auth/token")) {
        return Response.json({ token: "gateway-token" });
      }
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
      runtimeUrl: "http://localhost:7830",
      hatchedAt: "2026-01-01",
    },
    "https://storage.example.com/upload",
  );
  expect(calls[1].url).toEndWith("/v1/logs/export");
  expect(new Headers(calls[1].init?.headers).get("Authorization")).toBe(
    "Bearer gateway-token",
  );
  expect(calls[2].url).toBe("https://storage.example.com/upload");
  expect(new Headers(calls[2].init?.headers).has("Authorization")).toBe(false);
  expect(calls[2].init?.body).toBeInstanceOf(Blob);
  expect(calls.some((call) => call.url.includes("/migrations/"))).toBe(false);
});
