import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const gatewayIndexSource = readFileSync(
  join(import.meta.dir, "..", "index.ts"),
  "utf8",
);

const nginxIngressSource = readFileSync(
  join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "cli",
    "src",
    "lib",
    "nginx-ingress.ts",
  ),
  "utf8",
);

function extractGatewayRouteObjects(): string[] {
  const routesStart = gatewayIndexSource.indexOf(
    "const routes: RouteDefinition[] = [",
  );
  const routesEnd = gatewayIndexSource.indexOf(
    "// Runtime proxy catch-all",
    routesStart,
  );
  expect(routesStart).toBeGreaterThanOrEqual(0);
  expect(routesEnd).toBeGreaterThan(routesStart);

  const routesSource = gatewayIndexSource.slice(routesStart, routesEnd);
  return routesSource.split(/\n    \},\n/);
}

function extractUnprotectedStaticV1Routes(): string[] {
  return extractGatewayRouteObjects()
    .flatMap((routeObject) => {
      const path = routeObject.match(/path:\s*"([^"]+)"/)?.[1];
      if (!path?.startsWith("/v1/")) return [];

      const auth = routeObject.match(/auth:\s*"([^"]+)"/)?.[1];
      return auth === undefined || auth === "none" ? [path] : [];
    })
    .sort();
}

function sensitiveRoutesSource(): string {
  const start = nginxIngressSource.indexOf("const SENSITIVE_GATEWAY_ROUTES = [");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = nginxIngressSource.indexOf("] as const", start);
  return nginxIngressSource.slice(start, end);
}

function assertDeniedBeforeV1Proxy(path: string): void {
  // The denylist is data-driven since the app-shell edge (#354): the
  // sensitive paths live in SENSITIVE_GATEWAY_ROUTES, and the emitted
  // config places the 404 blocks ahead of the /v1/ proxy in both shell
  // modes (web mode emits DENYLIST_LOCATIONS, app mode re-emits the
  // denylist for the /web iframe prefix too).
  expect(sensitiveRoutesSource()).toContain(`"${path}"`);
  const denyEmit = nginxIngressSource.indexOf("${DENYLIST_LOCATIONS}");
  const appDenyEmit = nginxIngressSource.indexOf("${denylistLocations()}");
  const proxyEmit = nginxIngressSource.indexOf(
    "${gatewayProxyLocations(opts.gatewayPort)}",
  );
  expect(denyEmit).toBeGreaterThanOrEqual(0);
  expect(proxyEmit).toBeGreaterThan(denyEmit);
  expect(appDenyEmit).toBeGreaterThanOrEqual(0);
}

function assertNotExplicitlyDenied(path: string): void {
  expect(sensitiveRoutesSource()).not.toContain(`"${path}"`);
}

describe("remote web ingress denylist", () => {
  test("blocks local-only unprotected static gateway /v1 routes before proxying /v1", () => {
    const unprotectedV1Routes = extractUnprotectedStaticV1Routes();
    expect(unprotectedV1Routes).toEqual([
      "/v1/devices",
      "/v1/devices/revoke",
      "/v1/guardian/init",
      "/v1/guardian/reset-bootstrap",
      "/v1/pair",
      "/v1/remote-web/pairing-challenge",
      "/v1/remote-web/pairing-requests",
      "/v1/remote-web/pairing-requests/approve",
      "/v1/remote-web/pairing-requests/deny",
      "/v1/remote-web/pairing-token",
      "/v1/remote-web/pairing-verification",
      "/v1/shared/invites/redeem",
    ]);

    const publicRemoteWebRoutes = new Set([
      "/v1/remote-web/pairing-challenge",
      "/v1/remote-web/pairing-token",
    ]);

    for (const path of unprotectedV1Routes) {
      if (publicRemoteWebRoutes.has(path)) continue;
      assertDeniedBeforeV1Proxy(path);
    }

    for (const path of publicRemoteWebRoutes) {
      assertNotExplicitlyDenied(path);
    }
  });

  test("blocks local web token minting before proxying remote requests", () => {
    const tokenRoute = gatewayIndexSource.slice(
      gatewayIndexSource.indexOf("// ── Web token auth ──"),
      gatewayIndexSource.indexOf("// Runtime proxy catch-all"),
    );

    expect(tokenRoute).toContain('path: "/auth/token"');
    expect(tokenRoute).toContain('auth: "custom"');
    assertDeniedBeforeV1Proxy("/auth/token");
  });
});
