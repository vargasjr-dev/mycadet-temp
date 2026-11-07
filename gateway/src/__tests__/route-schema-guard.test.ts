import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withoutVersionPrefix } from "../http/router.js";
import {
  TWILIO_MEDIA_STREAM_WEBHOOK_PATH,
  TWILIO_STATUS_WEBHOOK_PATH,
  TWILIO_VOICE_WEBHOOK_PATH,
} from "@mycadet/service-contracts/twilio-ingress";
import { buildSchema } from "../schema.js";
import { ROUTES as barrelRoutes } from "../http/routes/index.js";
import { regexToOpenApiPath } from "../http/routes/regex-to-openapi-path.js";

/** A route extracted from source: path + optional HTTP method. */
interface ExtractedRoute {
  path: string;
  method: string | null; // null means "any method"
}

const ROUTE_PATH_CONSTANTS: Record<string, string> = {
  TWILIO_MEDIA_STREAM_WEBHOOK_PATH,
  TWILIO_STATUS_WEBHOOK_PATH,
  TWILIO_VOICE_WEBHOOK_PATH,
  // A regex rather than a literal, shared with the WebSocket upgrade branch
  // so the two halves of the plugin surface cannot disagree. Given here in
  // the converted form the extractor would have produced from it inline.
  PLUGIN_WEBHOOK_PATH_PATTERN: "/webhooks/plugins/{param1}/{param2}",
};

/**
 * Extracts route paths from the gateway index.ts source code.
 *
 * Routes are defined in two places:
 * 1. The routes barrel (src/http/routes/index.ts) — every HTTP route lives in
 *    a per-domain ROUTES array concatenated there; the same array the router
 *    and the spec generator consume
 * 2. Pre-router paths in the `fetch()` handler (healthz, readyz, schema, WS upgrades)
 *
 * We parse the source text rather than importing index.ts because it calls
 * `main()` at module scope which starts the server.
 */
function extractRoutesFromSource(): ExtractedRoute[] {
  const src = readFileSync(
    join(import.meta.dirname!, "..", "index.ts"),
    "utf-8",
  );

  const lines = src.split("\n");
  const routes: ExtractedRoute[] = [];
  const seenPreRouterPaths = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match string literal paths: `path: "/some/path"`
    const stringMatch = line.match(/path:\s*"([^"]+)"/);
    if (stringMatch) {
      const method = findMethodNearPath(lines, i);
      routes.push({ path: stringMatch[1], method });
      continue;
    }

    // Match shared path constants: `path: SOME_WEBHOOK_PATH`
    const constantMatch = line.match(/path:\s*([A-Z0-9_]+)\b/);
    const constantPath = constantMatch
      ? ROUTE_PATH_CONSTANTS[constantMatch[1]]
      : undefined;
    if (constantPath) {
      const method = findMethodNearPath(lines, i);
      routes.push({ path: constantPath, method });
      continue;
    }

    // Match regex paths: `path: /^\/v1\/contacts\/([^/]+)$/`
    const regexMatch = line.match(/path:\s*\/\^(.*?)\$\//);
    if (regexMatch) {
      const converted = regexToOpenApiPath(new RegExp(regexMatch[1]));
      if (converted) {
        const method = findMethodNearPath(lines, i);
        routes.push({ path: converted, method });
      }
      continue;
    }

    // Pre-router paths matched via `url.pathname === "/..."` in the fetch handler
    const preRouterMatch = line.match(/url\.pathname\s*===\s*"([^"]+)"/);
    if (preRouterMatch && !seenPreRouterPaths.has(preRouterMatch[1])) {
      seenPreRouterPaths.add(preRouterMatch[1]);
      routes.push({ path: preRouterMatch[1], method: null });
    }

    const preRouterConstantMatch = line.match(
      /url\.pathname\s*===\s*([A-Z0-9_]+)\b/,
    );
    const preRouterConstantPath = preRouterConstantMatch
      ? ROUTE_PATH_CONSTANTS[preRouterConstantMatch[1]]
      : undefined;
    if (
      preRouterConstantPath &&
      !seenPreRouterPaths.has(preRouterConstantPath)
    ) {
      seenPreRouterPaths.add(preRouterConstantPath);
      routes.push({ path: preRouterConstantPath, method: null });
    }
  }

  // The route table must come from the barrel, not an inline array.
  if (
    !src.includes("const routes: readonly GatewayRouteDefinition[] = ROUTES;")
  ) {
    throw new Error(
      "index.ts no longer spreads the routes barrel — update this guard",
    );
  }

  return routes;
}

/**
 * Looks for a `method: "..."` declaration near a `path:` line.
 * In the route table, method is always declared within a few lines
 * of path (same object literal). We scan up to 3 lines after path.
 */
function findMethodNearPath(
  lines: string[],
  pathLineIndex: number,
): string | null {
  // method can appear before or after path within the same object.
  // Scan a small window around the path line, stopping at object boundaries.
  for (let offset = -3; offset <= 3; offset++) {
    const idx = pathLineIndex + offset;
    if (idx < 0 || idx >= lines.length) continue;
    const methodMatch = lines[idx].match(/method:\s*"([A-Z]+)"/);
    if (methodMatch) return methodMatch[1];
  }
  return null;
}

/**
 * The routes barrel (the same declarations index.ts spreads and the spec
 * generator reads), flattened to source-shaped entries. Only the flat route
 * + its dispatch-only aliases are listed — plus the assistant-scoped mirrors
 * the schema documents (see SCHEMA_DOCUMENTED_SCOPED) and the dispatch-only
 * scoped mirrors (e.g. desktop setup) whose hand-written regexes the source
 * parse used to see.
 */
function extractFusedRoutes(): ExtractedRoute[] {
  return barrelRoutes.flatMap((route) => {
    if (typeof route.path !== "string") {
      // Raw regex dispatch path — convert like the source parse did.
      const converted = regexToOpenApiPath(route.path);
      return converted
        ? [{ path: converted, method: route.method?.toUpperCase() ?? null }]
        : [];
    }
    const path: string = route.path;
    const routes: ExtractedRoute[] = [
      { path, method: route.method?.toUpperCase() ?? null },
    ];
    for (const alias of route.aliases ?? []) {
      routes.push({ path, method: alias.toUpperCase() });
    }
    // The assistant-scoped mirrors the router generates (`route.scoped`)
    // are published only for the global settings surfaces — the same set
    // the hand-built schema documented when the mirrors were inline (the
    // old source parse only saw the ones whose regexes captured the
    // assistant id, which were exactly these). Everything else stays
    // dispatch-only.
    if (route.scoped && SCHEMA_DOCUMENTED_SCOPED.has(route.operationId!)) {
      routes.push({
        path: `/assistants/{param1}${path}`,
        method: route.method?.toUpperCase() ?? null,
      });
      for (const alias of route.aliases ?? []) {
        routes.push({
          path: `/assistants/{param1}${path}`,
          method: alias.toUpperCase(),
        });
      }
    }
    return routes;
  });
}

/**
 * The assistant-scoped mirrors the hand-built schema (buildSchema) documents.
 * The router generates a mirror for every `scoped: true` entry; the schema
 * publishes the prefixed spelling only for the global settings surfaces, so
 * only those join the guard's route set.
 */
const SCHEMA_DOCUMENTED_SCOPED = new Set([
  "permissionsThresholdsGet",
  "permissionsThresholdsPut",
  "conversationThresholdGet",
  "conversationThresholdPut",
  "conversationThresholdDelete",
  "upgradePolicyGet",
  "upgradePolicyPut",
]);

/** Deduplicated, sorted list of unique route paths (canonical — unversioned). */
function extractRoutePathsFromSource(): string[] {
  const paths = new Set(
    [...extractRoutesFromSource(), ...extractFusedRoutes()].map((r) =>
      withoutVersionPrefix(r.path),
    ),
  );
  return [...paths].sort();
}

// ── Routes that are intentionally undocumented in the OpenAPI schema ──
// Each entry must have a comment explaining why it's excluded.
const EXCLUDED_FROM_SCHEMA = new Set(
  [
    // Runtime proxy catch-all — documented as /{path} in the schema
    "catch-all",
    // Loopback-only remote web pairing challenge — not part of the public gateway API
    "/v1/remote-web/pairing-challenge",
    // Remote web pairing verification bootstrap — not part of the public gateway API
    "/v1/remote-web/pairing-verification",
    // Remote web pairing token bootstrap — not part of the public gateway API
    "/v1/remote-web/pairing-token",
    // Loopback-only pairing-request approval surface: not part of the public gateway API
    "/v1/remote-web/pairing-requests",
    "/v1/remote-web/pairing-requests/approve",
    "/v1/remote-web/pairing-requests/deny",
    // Shared-invite redemption, called by the cloud on an invitee's behalf;
    // not part of the public gateway API
    "/v1/shared/invites/redeem",
    // Internal-only: reachable only via vembda's trusted gateway-query proxy
    "/v1/contacts/guardian/channel",
    // Managed-speech relay — daemon-only WS egress to tunnel, rejected on any
    // ingress path; not part of the public gateway API
    "/v1/speech/stt/stream",
    "/v2/speech/stt/stream",
    "/v1/speech/tts/stream",
    // Loopback-only ingress domain recording — the local CLI reports its
    // tunnel's public URL (bearer-authed); not part of the public gateway API
    "/v1/ingress/domains",
    // Plugin-declared webhooks — which paths exist is decided at runtime by the
    // installed plugins and the guardian's approvals, so there is no fixed set
    // to document. The declaration schema is the contract, not this path.
    "/webhooks/plugins/{param1}/{param2}",
    // The entries above are written in the versioned spelling they're excluded
    // under in the schema; the guard compares canonical (unversioned) paths, so
    // they normalize once here — P7's optional /v1 prefix.
  ].map(withoutVersionPrefix),
);

// ── Schema paths that don't map to a discrete route definition ──
// These are documented in the schema but correspond to pre-router logic
// or catch-all behavior rather than an explicit route table entry.
const SCHEMA_ONLY_PATHS = new Set([
  // Served by the catch-all runtime proxy, not a dedicated route
  "/{path}",
]);

describe("route-schema sync guard", () => {
  const schema = buildSchema() as { paths: Record<string, unknown> };
  // P7 made the /v1 prefix optional on the wire: route definitions read the
  // unversioned shape and the matcher strips the prefix from either spelling.
  // The schema keeps the versioned spelling (the public API contract), so
  // both sides of every comparison below canonicalize through the same
  // stripper the router itself uses.
  const schemaKeyByCanonical = new Map(
    Object.keys(schema.paths).map((k) => [withoutVersionPrefix(k), k] as const),
  );
  const schemaPaths = new Set(schemaKeyByCanonical.keys());
  const routePaths = extractRoutePathsFromSource();

  test("every route path should have a corresponding schema entry", () => {
    const missing: string[] = [];

    for (const routePath of routePaths) {
      if (EXCLUDED_FROM_SCHEMA.has(routePath)) continue;

      // The catch-all regex `/^\//` matches everything — it maps to /{path} in the schema
      if (routePath === "/") continue;

      // Normalize regex-extracted parameterized paths to match schema naming.
      // Route regexes use positional params ({param1}, {param2}) while the
      // schema uses semantic names. We check if any schema path matches
      // structurally (same segments, params in same positions).
      const matched = findMatchingSchemaPath(routePath, schemaPaths);
      if (!matched) {
        missing.push(routePath);
      }
    }

    expect(missing).toEqual([]);
  });

  test("every schema path should have a corresponding route", () => {
    const orphaned: string[] = [];

    for (const schemaPath of schemaPaths) {
      if (SCHEMA_ONLY_PATHS.has(schemaPath)) continue;

      const matched = findMatchingRoutePath(schemaPath, routePaths);
      if (!matched) {
        orphaned.push(schemaPath);
      }
    }

    expect(orphaned).toEqual([]);
  });

  test("HTTP methods for each path should match between routes and schema", () => {
    const routes = extractRoutesFromSource().map((r) => ({
      ...r,
      // Canonical (unversioned) shape — the matcher strips the optional
      // /v1 prefix at dispatch, so comparisons read the bare spelling.
      path: withoutVersionPrefix(r.path),
    }));
    const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
    type HttpMethod = (typeof HTTP_METHODS)[number];

    const mismatches: string[] = [];

    // Build a map of path → set of methods from the route table.
    // Routes without an explicit method match any method — skip those
    // since the guard can't know which methods they actually handle.
    const routeMethodsByPath = new Map<string, Set<HttpMethod>>();
    for (const route of routes) {
      if (EXCLUDED_FROM_SCHEMA.has(route.path)) continue;
      if (route.path === "/") continue; // catch-all
      if (!route.method) continue; // any-method routes can't be compared

      const normalizedPath = resolveSchemaPath(route.path, schemaPaths);
      if (!normalizedPath) continue;

      let methods = routeMethodsByPath.get(normalizedPath);
      if (!methods) {
        methods = new Set();
        routeMethodsByPath.set(normalizedPath, methods);
      }
      methods.add(route.method.toLowerCase() as HttpMethod);
    }

    // For each path that has explicit methods in the route table,
    // verify the schema documents exactly the same set of methods.
    for (const [path, routeMethods] of routeMethodsByPath) {
      const schemaEntry = (
        schema.paths as Record<string, Record<string, unknown>>
      )[schemaKeyByCanonical.get(path) ?? path];
      if (!schemaEntry) continue; // path-level mismatch is caught by the other tests

      const schemaMethods = new Set(
        HTTP_METHODS.filter((m) => m in schemaEntry),
      );

      const missingFromSchema = [...routeMethods].filter(
        (m) => !schemaMethods.has(m),
      );
      const extraInSchema = [...schemaMethods].filter(
        (m) => !routeMethods.has(m),
      );

      for (const m of missingFromSchema) {
        mismatches.push(
          `${m.toUpperCase()} ${path}: in routes but not in schema`,
        );
      }
      for (const m of extraInSchema) {
        mismatches.push(
          `${m.toUpperCase()} ${path}: in schema but not in routes`,
        );
      }
    }

    expect(mismatches).toEqual([]);
  });

  test("excluded routes list contains only paths that actually exist", () => {
    // Catch-all is a special synthetic entry
    const actualPaths = new Set(routePaths);
    const stale = [...EXCLUDED_FROM_SCHEMA].filter(
      (p) => p !== "catch-all" && !actualPaths.has(p),
    );

    expect(stale).toEqual([]);
  });

  test("advertised-interface check flags a URL with no registered route", () => {
    const unserved = unservedInterfacePaths(
      [{ url: "https://assistant.example.com/a2a/message:send" }],
      routePaths,
    );

    expect(unserved).toEqual(["/a2a/message:send"]);
  });

  test("regex route normalization ignores negative lookaheads", () => {
    expect(
      regexToOpenApiPath(
        new RegExp(String.raw`\/v1\/contacts\/(?!invites$)([^/]+)`),
      ),
    ).toBe("/v1/contacts/{param1}");
  });
});

/**
 * Returns the pathnames of the advertised A2A interfaces that no gateway route
 * table entry serves.
 */
function unservedInterfacePaths(
  supportedInterfaces: ReadonlyArray<{ url: string }>,
  registeredPaths: string[],
): string[] {
  const registered = new Set(registeredPaths);
  return supportedInterfaces
    .map((iface) => new URL(iface.url).pathname)
    .filter((path) => !registered.has(path));
}

/**
 * Returns the schema path string that matches a route path, or null if none.
 * Used by the method comparison test to look up schema entries by path.
 */
function resolveSchemaPath(
  routePath: string,
  schemaPaths: Set<string>,
): string | null {
  if (schemaPaths.has(routePath)) return routePath;

  const routeSegments = routePath.split("/");

  for (const schemaPath of schemaPaths) {
    const schemaSegments = schemaPath.split("/");
    if (routeSegments.length !== schemaSegments.length) continue;

    const matches = routeSegments.every((seg, i) => {
      if (seg === schemaSegments[i]) return true;
      if (seg.startsWith("{") && schemaSegments[i].startsWith("{")) return true;
      return false;
    });

    if (matches) return schemaPath;
  }

  return null;
}

/**
 * Checks if a route path (possibly with {paramN} placeholders) matches
 * any schema path (with semantic parameter names like {contactId}).
 *
 * Two paths match if they have the same number of segments and every
 * non-parameter segment is identical.
 */
function findMatchingSchemaPath(
  routePath: string,
  schemaPaths: Set<string>,
): boolean {
  // Direct match
  if (schemaPaths.has(routePath)) return true;

  const routeSegments = routePath.split("/");

  for (const schemaPath of schemaPaths) {
    const schemaSegments = schemaPath.split("/");
    if (routeSegments.length !== schemaSegments.length) continue;

    const matches = routeSegments.every((seg, i) => {
      if (seg === schemaSegments[i]) return true;
      // Both are parameters
      if (seg.startsWith("{") && schemaSegments[i].startsWith("{")) return true;
      return false;
    });

    if (matches) return true;
  }

  return false;
}

/**
 * Checks if a schema path matches any route path, accounting for
 * parameterized segments.
 */
function findMatchingRoutePath(
  schemaPath: string,
  routePaths: string[],
): boolean {
  if (routePaths.includes(schemaPath)) return true;

  const schemaSegments = schemaPath.split("/");

  for (const routePath of routePaths) {
    const routeSegments = routePath.split("/");
    if (schemaSegments.length !== routeSegments.length) continue;

    const matches = schemaSegments.every((seg, i) => {
      if (seg === routeSegments[i]) return true;
      if (seg.startsWith("{") && routeSegments[i].startsWith("{")) return true;
      return false;
    });

    if (matches) return true;
  }

  return false;
}
