import { afterAll, expect, mock, test } from "bun:test";

const savedConfig = window.__CADET_CONFIG__;
const savedEnvironment = process.env.VITE_ENVIRONMENT;
process.env.VITE_ENVIRONMENT = "production";
window.__CADET_CONFIG__ = {
  remote: "custom",
  hubUrl: "https://mycadet.ai/assistant",
};
await import("@/lib/api-interceptors");
const { client } = await import("@/generated/auth/client.gen");
const originalClientConfig = client.getConfig();
afterAll(() => {
  window.__CADET_CONFIG__ = savedConfig;
  if (savedEnvironment === undefined) {
    delete process.env.VITE_ENVIRONMENT;
  } else {
    process.env.VITE_ENVIRONMENT = savedEnvironment;
  }
  client.setConfig(originalClientConfig);
});

test("Allauth SDK requests from a served browser target cloud with cookie credentials", async () => {
  const requests: Request[] = [];
  const fetch = Object.assign(
    mock(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const request = input instanceof Request ? input : new Request(input);
      requests.push(request);
      return Response.json({ data: null }, { status: 401 });
    }),
    { preconnect: globalThis.fetch.preconnect },
  );
  await client.get({ url: "/_allauth/browser/v1/auth/session", fetch });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe(
    "https://cloud.mycadet.ai/_allauth/browser/v1/auth/session",
  );
  expect(requests[0]?.credentials).toBe("include");
  expect(requests[0]?.headers.get("Authorization")).toBeNull();
});
