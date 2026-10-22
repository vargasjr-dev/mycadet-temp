import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  clearLoopbackGatewayBearerCache,
  loopbackGatewayBearer,
} from "./gateway-bearer";
import type { TokenResult } from "./guardian-token";

const realFetch = globalThis.fetch;

let leaseResult: TokenResult = { ok: true, accessToken: "guardian-tok" };
let mintResponses: Response[] = [];
let mintCalls: Array<{ url: string; init?: RequestInit }> = [];

const lease = mock(async (): Promise<TokenResult> => leaseResult);

// The mint fetch is the I/O seam: recorded and answered per test.
globalThis.fetch = (async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  mintCalls.push({ url: String(input), init });
  const response = mintResponses.shift();
  if (!response) {
    throw new TypeError("no scripted mint response");
  }
  return response;
}) as unknown as typeof fetch;

const mintOk = (token = "minted-bearer", expiresAt?: number) =>
  new Response(
    JSON.stringify({
      token,
      expiresAt: expiresAt ?? Math.floor(Date.now() / 1000) + 3600,
    }),
    { headers: { "content-type": "application/json" } },
  );

beforeEach(() => {
  clearLoopbackGatewayBearerCache();
  lease.mockClear();
  leaseResult = { ok: true, accessToken: "guardian-tok" };
  mintCalls = [];
  mintResponses = [mintOk()];
});

afterEach(() => {
  clearLoopbackGatewayBearerCache();
});

describe("loopbackGatewayBearer", () => {
  test("mints against the loopback gateway with the guardian lease", async () => {
    const bearer = await loopbackGatewayBearer(8080, lease);

    expect(bearer).toBe("minted-bearer");
    expect(mintCalls).toHaveLength(1);
    expect(mintCalls[0].url).toBe("http://127.0.0.1:8080/auth/token");
    expect(mintCalls[0].init?.method).toBe("POST");
    const headers = new Headers(mintCalls[0].init?.headers);
    // The mint route is Origin-gated (a CSRF defense for browsers); the
    // server-to-server hop presents the loopback web origin it dials.
    expect(headers.get("origin")).toBe("http://127.0.0.1:8080");
    expect(headers.get("authorization")).toBe("Bearer guardian-tok");
  });

  test("caches the mint per port so a burst shares one lease", async () => {
    await loopbackGatewayBearer(8080, lease);
    const again = await loopbackGatewayBearer(8080, lease);

    expect(again).toBe("minted-bearer");
    expect(mintCalls).toHaveLength(1);
    expect(lease).toHaveBeenCalledTimes(1);
  });

  test("ports cache independently", async () => {
    mintResponses = [mintOk("bearer-8080"), mintOk("bearer-8081")];
    await loopbackGatewayBearer(8080, lease);
    const other = await loopbackGatewayBearer(8081, lease);

    expect(other).toBe("bearer-8081");
    expect(mintCalls).toHaveLength(2);
  });

  test("a bearer inside the freshness margin is reused; an expired one re-mints", async () => {
    // Expired an hour ago: the first call must mint.
    mintResponses = [
      mintOk("stale-bearer", Math.floor(Date.now() / 1000) - 3600),
    ];
    const stale = await loopbackGatewayBearer(8080, lease);
    expect(stale).toBe("stale-bearer");

    // Within the margin (expires in 30s): the cached mint is reused.
    mintResponses = [
      mintOk("fresh-bearer", Math.floor(Date.now() / 1000) + 30),
    ];
    const fresh = await loopbackGatewayBearer(8080, lease, { forceMint: true });
    expect(fresh).toBe("fresh-bearer");

    // The margin itself (60s) keeps a 90s-lived bearer cacheable.
    mintResponses = [
      mintOk("margin-bearer", Math.floor(Date.now() / 1000) + 90),
    ];
    await loopbackGatewayBearer(8080, lease, { forceMint: true });
    const cached = await loopbackGatewayBearer(8080, lease);
    expect(cached).toBe("margin-bearer");
    expect(mintCalls).toHaveLength(3);
  });

  test("forceMint skips the cache and replaces it", async () => {
    await loopbackGatewayBearer(8080, lease);
    mintResponses = [mintOk("rotated-bearer")];

    const rotated = await loopbackGatewayBearer(8080, lease, {
      forceMint: true,
    });

    expect(rotated).toBe("rotated-bearer");
    expect(mintCalls).toHaveLength(2);
  });

  test("a failed guardian lease yields no bearer", async () => {
    leaseResult = { ok: false, status: 404, error: "Guardian token not found" };

    const bearer = await loopbackGatewayBearer(8080, lease);

    expect(bearer).toBeNull();
    expect(mintCalls).toHaveLength(0);
  });

  test("a rejected mint yields no bearer", async () => {
    mintResponses = [new Response("Unauthorized", { status: 401 })];

    const bearer = await loopbackGatewayBearer(8080, lease);

    expect(bearer).toBeNull();
  });

  test("a malformed mint body yields no bearer", async () => {
    mintResponses = [
      new Response(JSON.stringify({ token: 5 }), { status: 200 }),
    ];

    const bearer = await loopbackGatewayBearer(8080, lease);

    expect(bearer).toBeNull();
  });

  test("a thrown lease yields no bearer", async () => {
    const throwingLease = mock(async (): Promise<TokenResult> => {
      throw new Error("host down");
    });

    const bearer = await loopbackGatewayBearer(8080, throwingLease);

    expect(bearer).toBeNull();
  });
});
