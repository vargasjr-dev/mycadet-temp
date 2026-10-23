import { describe, expect, test } from "bun:test";

import { AuthRateLimiter } from "../auth-rate-limiter.js";
import type { RouteDefinition } from "../http/router.js";

/** Dynamic import AFTER module setup so the router always loads fresh. */
const { createRouter } = await import("../http/router.js");

const ROUTES: RouteDefinition[] = [
  {
    path: "/v1/ps",
    method: "GET",
    handler: (req) =>
      Response.json({ route: "ps", seen: new URL(req.url).pathname }),
  },
  {
    path: /^\/v1\/assistants\/([^/]+)$/,
    method: "GET",
    handler: (_req, params) => Response.json({ route: "assistant", params }),
  },
  // The gateway's native unversioned routes stay reachable raw-first.
  {
    path: "/integrations",
    method: "GET",
    handler: () => Response.json({ route: "native-unversioned" }),
  },
];

function makeRouter(): ReturnType<typeof createRouter> {
  return createRouter(ROUTES, { authRateLimiter: new AuthRateLimiter() });
}

async function dispatch(
  method: string,
  path: string,
): Promise<Response | null> {
  const url = new URL(`http://gateway.local${path}`);
  const req = new Request(url, { method });
  return makeRouter()(req, url, () => "203.0.113.9");
}

describe("unversioned api fallthrough (P7: the /v1 prefix is optional)", () => {
  test("an unversioned dial reaches the same handler as its /v1 spelling", async () => {
    const unversioned = await dispatch("GET", "/ps");
    expect(unversioned?.status).toBe(200);
    expect(await unversioned?.json()).toEqual({ route: "ps", seen: "/ps" });

    const versioned = await dispatch("GET", "/v1/ps");
    expect(versioned?.status).toBe(200);
    expect(await versioned?.json()).toEqual({ route: "ps", seen: "/v1/ps" });
  });

  test("regex routes resolve params against the versioned shape", async () => {
    const response = await dispatch("GET", "/assistants/assistant-1");
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      route: "assistant",
      params: ["assistant-1"],
    });
  });

  test("a native unversioned route wins over the versioned twin (raw first)", async () => {
    const response = await dispatch("GET", "/integrations");
    expect(await response?.json()).toEqual({ route: "native-unversioned" });
  });

  test("trailing-slash dials normalize into the same route", async () => {
    const response = await dispatch("GET", "/ps/");
    expect(response?.status).toBe(200);
  });

  test("unknown unversioned paths still miss (no blanket acceptance)", async () => {
    expect(await dispatch("GET", "/not-a-segment")).toBeNull();
    expect(await dispatch("GET", "/v1/not-a-segment")).toBeNull();
  });

  test("the fallback only strips one /v1 prefix", async () => {
    expect(await dispatch("GET", "/v1/v1/ps")).toBeNull();
  });

  test("method mismatches miss in both spellings", async () => {
    expect(await dispatch("POST", "/ps")).toBeNull();
    expect(await dispatch("POST", "/v1/ps")).toBeNull();
  });
});
