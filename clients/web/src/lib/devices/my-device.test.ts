import { afterEach, describe, expect, test } from "bun:test";

import { fetchMyDevice } from "@/lib/devices/my-device";
import { setSelfHostedConnection } from "@/lib/self-hosted/connection";

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
  setSelfHostedConnection(null);
});

describe("fetchMyDevice", () => {
  test("sends the paired bearer and returns the device row", async () => {
    setSelfHostedConnection({ url: "http://localhost:7830", token: "tok-1" });
    // Object container, not bare `let`s: TS narrows a captured let to its
    // initializer's type at the read site — closure assignments don't reset it.
    const seen: { path: string; auth: string | null } = {
      path: "",
      auth: null,
    };
    globalThis.fetch = withPreconnect(async (input, init) => {
      seen.path = String(input);
      seen.auth = new Headers(init?.headers).get("Authorization");
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
    expect(seen.path).toContain("/v1/devices/mine");
    expect(seen.auth).toBe("Bearer tok-1");
    expect(device?.hashedDeviceId).toBe("hash-1");
    expect(device?.platform).toBe("web");
    expect(device?.issuedAt).toBe(1_000);
  });

  test("returns null without a paired gateway session", async () => {
    setSelfHostedConnection(null);
    let called = false;
    globalThis.fetch = withPreconnect(async () => {
      called = true;
      return new Response("{}", { status: 200 });
    });

    const device = await fetchMyDevice();
    expect(device).toBeNull();
    expect(called).toBe(false);
  });

  test("returns null when the gateway cannot answer", async () => {
    setSelfHostedConnection({ url: "http://localhost:7830", token: "tok-1" });
    globalThis.fetch = withPreconnect(async () => new Response(null, { status: 404 }));

    const device = await fetchMyDevice();
    expect(device).toBeNull();
  });

  test("returns null on a malformed body", async () => {
    setSelfHostedConnection({ url: "http://localhost:7830", token: "tok-1" });
    globalThis.fetch = withPreconnect(async () =>
      new Response("<html>oops</html>", { status: 200 }),
    );

    const device = await fetchMyDevice();
    expect(device).toBeNull();
  });
});
