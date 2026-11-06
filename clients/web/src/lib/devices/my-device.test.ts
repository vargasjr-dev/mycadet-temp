import { afterEach, describe, expect, test } from "bun:test";

import { fetchMyDevice } from "@/lib/devices/my-device";

const realFetch = globalThis.fetch;

// bun-types' `typeof fetch` carries a `preconnect` companion member; the
// house shape attaches a no-op so mock implementations type-check cast-free.
function withPreconnect(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(impl, { preconnect: () => {} });
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchMyDevice", () => {
  test("fetches the device row same-origin", async () => {
    // The pairing simplification dropped the client-side session record:
    // the request rides the browser's own session at the same-origin
    // gateway path.
    // Object container, not bare `let`s: TS narrows a captured let to its
    // initializer's type at the read site — closure assignments don't reset it.
    const seen: { path: string } = { path: "" };
    globalThis.fetch = withPreconnect(async (input) => {
      seen.path = String(input);
      return new Response(
        JSON.stringify({
          device: {
            hashedDeviceId: "hash-1",
            platform: "web",
            pairingUserAgent: null,
            clientReportedName: null,
            issuedAt: 1_000,
            expiresAt: 2_000,
            lastUsedAt: null,
          },
        }),
        { status: 200 },
      );
    });

    const device = await fetchMyDevice();
    expect(seen.path).toContain("/v1/assistant/devices/mine");
    expect(device?.hashedDeviceId).toBe("hash-1");
    expect(device?.platform).toBe("web");
    expect(device?.issuedAt).toBe(1_000);
  });

  test("returns null when the gateway cannot answer", async () => {
    globalThis.fetch = withPreconnect(
      async () => new Response(null, { status: 404 }),
    );

    const device = await fetchMyDevice();
    expect(device).toBeNull();
  });

  test("returns null on a malformed body", async () => {
    globalThis.fetch = withPreconnect(
      async () => new Response("<html>oops</html>", { status: 200 }),
    );

    const device = await fetchMyDevice();
    expect(device).toBeNull();
  });
});
