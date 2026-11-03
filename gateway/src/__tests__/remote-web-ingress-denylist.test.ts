import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const gatewayIndexSource = readFileSync(
  join(import.meta.dir, "..", "index.ts"),
  "utf8",
);

const denylistSource = readFileSync(
  join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "cli",
    "src",
    "lib",
    "servers",
    "common.ts",
  ),
  "utf8",
);

const edgeHandlerSource = readFileSync(
  join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "cli",
    "src",
    "lib",
    "servers",
    "bun.ts",
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

const PROVIDER_VALIDATED_WEBHOOK_PREFIXES = ["/webhooks/"];

// Unprotected but deliberately not denylisted: they are not part of the
// /v1 API surface the remote-web edge proxies (the desktop's own credential
// entry surface and OAuth client discovery), so the edge never forwards
// them and blocking them at the ingress would only break local dials.
const UNVERSIONED_PUBLIC_SURFACES = [
  "/assistant/credentials/enter",
  "/oauth/client-metadata.json",
];

function extractUnprotectedStaticV1Routes(): string[] {
  return extractGatewayRouteObjects()
    .flatMap((routeObject) => {
      const path = routeObject.match(/path:\s*"([^"]+)"/)?.[1];
      if (!path) return [];

      // P7 made the /v1 prefix optional: route definitions read the
      // unversioned shape and the matcher strips the prefix from either
      // spelling. Canonicalize to the versioned spelling the denylist
      // (and the schema) write.
      const canonical = path.startsWith("/v1/") ? path : `/v1${path}`;
      if (PROVIDER_VALIDATED_WEBHOOK_PREFIXES.some((p) => path.startsWith(p)))
        return [];
      if (UNVERSIONED_PUBLIC_SURFACES.includes(path)) return [];

      const auth = routeObject.match(/auth:\s*"([^"]+)"/)?.[1];
      return auth === undefined || auth === "none" ? [canonical] : [];
    })
    .sort();
}

function sensitiveRoutesSource(): string {
  const start = denylistSource.indexOf("const SENSITIVE_GATEWAY_ROUTES = [");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = denylistSource.indexOf("] as const", start);
  return denylistSource.slice(start, end);
}

function assertDeniedBeforeV1Proxy(path: string): void {
  // The denylist is data-driven since the app-shell edge (#354): the
  // sensitive paths live in SENSITIVE_GATEWAY_ROUTES, and the Bun.serve
  // handler consults the DENY_PATHS set before every other tier —
  // operator rows, the static surface, and the /v1 proxy all answer
  // behind the 404. The set builder also covers the /web iframe prefix
  // and the unversioned spellings of every route.
  expect(sensitiveRoutesSource()).toContain(`"${path}"`);
  const denyGuard = edgeHandlerSource.indexOf("if (DENY_PATHS.has(pathname))");
  const proxyCall = edgeHandlerSource.indexOf("proxyToGateway(request");
  expect(denyGuard).toBeGreaterThanOrEqual(0);
  expect(proxyCall).toBeGreaterThan(denyGuard);
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
