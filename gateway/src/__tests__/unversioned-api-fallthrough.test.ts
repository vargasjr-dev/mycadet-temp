import { describe, expect, test } from "bun:test";

import { AuthRateLimiter } from "../auth-rate-limiter.js";
import type { RouteDefinition } from "../http/router.js";

/** Dynamic import AFTER module setup so the router always loads fresh. */
const { createRouter } = await import("../http/router.js");

const ROUTES: RouteDefinition[] = [
  {
    path: "/ps",
    method: "GET",
    handler: (req) =>
      Response.json({ route: "ps", seen: new URL(req.url).pathname }),
  },
  {
    path: /^\/assistants\/([^/]+)$/,
    method: "GET",
    handler: (_req, params) => Response.json({ route: "assistant", params }),
  },
  {
    // The gateway's native unversioned routes read the same way.
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

describe("unversioned api routing (P7: the /v1 prefix is optional)", () => {
  test("both spellings reach the same route; the dial rides through as sent", async () => {
    const unversioned = await dispatch("GET", "/ps");
    expect(await unversioned?.json()).toEqual({ route: "ps", seen: "/ps" });
    const versioned = await dispatch("GET", "/v1/ps");
    expect(await versioned?.json()).toEqual({ route: "ps", seen: "/v1/ps" });
  });

  test("regex routes resolve params in either spelling", async () => {
    for (const path of [
      "/assistants/assistant-1",
      "/v1/assistants/assistant-1",
    ]) {
      const response = await dispatch("GET", path);
      expect(await response?.json()).toEqual({
        route: "assistant",
        params: ["assistant-1"],
      });
    }
  });

  test("a native unversioned route serves its path directly", async () => {
    const response = await dispatch("GET", "/integrations");
    expect(await response?.json()).toEqual({ route: "native-unversioned" });
  });

  test("trailing-slash dials normalize into the same route", async () => {
    const response = await dispatch("GET", "/ps/");
    expect(response?.status).toBe(200);
  });

  test("unknown paths still miss (no blanket acceptance)", async () => {
    expect(await dispatch("GET", "/not-a-segment")).toBeNull();
    expect(await dispatch("GET", "/v1/not-a-segment")).toBeNull();
  });

  test("the strip only removes one /v1 prefix", async () => {
    expect(await dispatch("GET", "/v1/v1/ps")).toBeNull();
  });

  test("method mismatches miss in both spellings", async () => {
    expect(await dispatch("POST", "/ps")).toBeNull();
    expect(await dispatch("POST", "/v1/ps")).toBeNull();
  });
});
