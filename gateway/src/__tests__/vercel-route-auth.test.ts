/**
 * Auth pinning for the gateway Vercel control-plane routes.
 *
 * The dedicated proxy mints a gateway service token, so the runtime never
 * sees the caller's scopes. These registrations must stay edge-scoped:
 * GET → settings.read, POST/DELETE → settings.write. A read-only
 * ui_page_v1 token must not be able to overwrite or delete the stored
 * Vercel API token.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import "./test-preload.js";

import type { RouteDefinition } from "../http/routes/types.js";

let mockValidateEdgeToken = mock(
  (
    _token: string,
  ):
    | { ok: true; claims: { sub: string; scope_profile: string } }
    | { ok: false; reason: string } => ({ ok: false, reason: "noop" }),
);
const actualTokenExchange = await import("../auth/token-exchange.js");
mock.module("../auth/token-exchange.js", () => ({
  ...actualTokenExchange,
  validateEdgeToken: (token: string) => mockValidateEdgeToken(token),
}));

const { AuthRateLimiter } = await import("../auth-rate-limiter.js");
const { createRouter } = await import("../http/router.js");

const { ROUTES } = await import("../http/routes/vercel-control-plane-proxy.js");

describe("vercel control-plane route registrations", () => {
  test("GET/POST/DELETE use edge-scoped auth with settings scopes", () => {
    const routeObjects = ROUTES.filter(
      (route: RouteDefinition) =>
        route.path === "/integrations/vercel/config",
    );
    expect(routeObjects).toHaveLength(3);

    for (const routeObject of routeObjects) {
      expect(routeObject.auth).toBe("edge-scoped");
    }

    const getRoute = routeObjects.find(
      (routeObject) => routeObject.method === "get",
    );
    const postRoute = routeObjects.find(
      (routeObject) => routeObject.method === "post",
    );
    const deleteRoute = routeObjects.find(
      (routeObject) => routeObject.method === "delete",
    );

    expect(getRoute?.scope).toBe("settings.read");
    expect(postRoute?.scope).toBe("settings.write");
    expect(deleteRoute?.scope).toBe("settings.write");
  });
});

const UI_PAGE_TOKEN = "tok-ui-page";
const ACTOR_TOKEN = "tok-actor";

function makeVercelRouter() {
  const routes: RouteDefinition[] = [
    {
      path: "/integrations/vercel/config",
      method: "get",
      auth: "edge-scoped",
      scope: "settings.read",
      handler: () => Response.json({ ok: true, route: "get" }),
    },
    {
      path: "/integrations/vercel/config",
      method: "post",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: () => Response.json({ ok: true, route: "post" }),
    },
    {
      path: "/integrations/vercel/config",
      method: "delete",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: () => Response.json({ ok: true, route: "delete" }),
    },
  ];
  return createRouter(routes, { authRateLimiter: new AuthRateLimiter() });
}

async function dispatch(
  method: string,
  token: string,
): Promise<Response | null> {
  const url = new URL("http://gateway.local/v1/integrations/vercel/config");
  const req = new Request(url, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
  return makeVercelRouter()(req, url, () => "203.0.113.9");
}

describe("vercel control-plane scope enforcement", () => {
  beforeEach(() => {
    mockValidateEdgeToken = mock((token: string) => {
      if (token === UI_PAGE_TOKEN) {
        return {
          ok: true as const,
          claims: { sub: "svc:ui-page", scope_profile: "ui_page_v1" },
        };
      }
      if (token === ACTOR_TOKEN) {
        return {
          ok: true as const,
          claims: { sub: "svc:client", scope_profile: "actor_client_v1" },
        };
      }
      return { ok: false as const, reason: "unknown token" };
    });
  });

  test("GET passes for a settings.read (ui_page_v1) token", async () => {
    const res = await dispatch("GET", UI_PAGE_TOKEN);
    expect(res?.status).toBe(200);
  });

  test.each(["POST", "DELETE"] as const)(
    "%s returns 403 for a settings.read (ui_page_v1) token",
    async (method) => {
      const res = await dispatch(method, UI_PAGE_TOKEN);
      expect(res?.status).toBe(403);
    },
  );

  test.each(["GET", "POST", "DELETE"] as const)(
    "%s passes for a settings.write (actor_client_v1) token",
    async (method) => {
      const res = await dispatch(method, ACTOR_TOKEN);
      expect(res?.status).toBe(200);
    },
  );
});
