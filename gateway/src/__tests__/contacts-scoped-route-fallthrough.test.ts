/**
 * Pins that the gateway registers NO assistant-scoped contact routes.
 *
 * The generated gateway SDK emits assistant-scoped URLs, but both deployment
 * boundaries flatten contact-family paths before the gateway routes them
 * (the cloud's runtime proxy; `rewriteForSelfHostedIngress` in
 * self-hosted), so the gateway serves only the flat contact routes and a
 * scoped contact request falls through to the runtime-proxy catch-all.
 */

import { describe, expect, mock, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import "./test-preload.js";

// ---------------------------------------------------------------------------
// Source pinning — no scoped contact registrations in index.ts
// ---------------------------------------------------------------------------

// Belt-and-suspenders grep over index.ts; the route-table tests below pin the
// real registrations.
describe("contact route registrations (index.ts)", () => {
  test("no route path scopes a contact-family path under /v1/assistants", () => {
    const routesDir = join(import.meta.dir, "..", "http", "routes");
    const pathLines = readdirSync(routesDir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .flatMap((f) =>
        readFileSync(join(routesDir, f), "utf8")
          .split("\n")
          .filter((line) => /^\s*path:/.test(line)),
      );

    expect(pathLines.length).toBeGreaterThan(0);
    const scopedContactPaths = pathLines.filter(
      (line) => line.includes("assistants") && line.includes("contact"),
    );
    expect(scopedContactPaths).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Behavioral — scoped contact writes fall through to the catch-all
// ---------------------------------------------------------------------------

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(null, { status: 200 }),
);

const actualFetch = await import("../fetch.js");
mock.module("../fetch.js", () => ({
  ...actualFetch,
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

let proxyConfig: import("../config.js").GatewayConfig;

const actualConfig = await import("../config.js");
mock.module("../config.js", () => ({
  ...actualConfig,
  getConfig: () => proxyConfig,
}));

function makeConfig(): import("../config.js").GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    port: 7830,
    runtimeProxyRequireAuth: false,
    runtimeTimeoutMs: 30000,
    maxAttachmentConcurrency: 3,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 50 * 1024 * 1024,
      slack: 50 * 1024 * 1024,
      whatsapp: 50 * 1024 * 1024,
      default: 50 * 1024 * 1024,
    },
    trustProxy: false,
  };
}

let capturedUrl: string | null = null;
let nextIp = 0;

const { dispatchRoute, expandRoute } = await import("../http/router.js");
const { ROUTES } = await import("../http/routes/index.js");

function captureDials() {
  fetchMock = mock(async (input) => {
    capturedUrl = String(input);
    return new Response(null, { status: 200 });
  });
}

/**
 * Dispatch through the real route table. Each dial gets its own client IP so
 * the shared auth rate limiter never ties suites together.
 */
async function dispatch(method: string, path: string) {
  const url = new URL(`http://gateway.local${path}`);
  const req = new Request(url, { method });
  const ip = `203.0.113.${++nextIp}`;
  return dispatchRoute(req, url, () => ip, { requestIP: () => null } as never);
}

const SCOPED_CONTACT_WRITES: Array<[string, string]> = [
  ["POST", "/v1/assistants/x/contacts"],
  ["POST", "/v1/assistants/x/contacts/prompt/submit"],
  ["POST", "/v1/assistants/x/contacts/record/submit"],
  ["POST", "/v1/assistants/x/contact-channels/ch-1/verify"],
  ["DELETE", "/v1/assistants/x/contacts/contact-1"],
];

describe("scoped contact writes fall through to the runtime proxy", () => {
  test.each(SCOPED_CONTACT_WRITES)(
    "%s %s → runtime-proxy catch-all, not the control plane",
    async (method, path) => {
      proxyConfig = makeConfig();
      captureDials();
      const res = await dispatch(method, path);
      expect(res?.status).toBe(200);
      // The catch-all flattens assistant-scoped paths onto the daemon's
      // flat surface; a control-plane route would have answered here.
      expect(capturedUrl).toContain("localhost:7821");
    },
  );

  test("daemon-only subpaths fall through to the runtime proxy", async () => {
    proxyConfig = makeConfig();
    captureDials();
    for (const path of ["/v1/contacts/search", "/v1/contacts/prompt"]) {
      await dispatch("POST", path);
      expect(capturedUrl).toContain("localhost:7821");
      capturedUrl = null;
    }
  });
});

// ---------------------------------------------------------------------------
// Registration-order invariants within the real expanded table
// ---------------------------------------------------------------------------

function firstMatch(
  method: string,
  path: string,
): { path: unknown; index: number } | null {
  const expanded = ROUTES.flatMap((route) => expandRoute(route));
  for (let i = 0; i < expanded.length; i++) {
    const entry = expanded[i]!;
    const source = entry.path;
    const pattern =
      source instanceof RegExp
        ? source
        : new RegExp(`^${String(source).replace(/\{[^}]+\}/g, "([^/]+)")}/?$`);
    if (!pattern.test(path)) continue;
    if (entry.method && entry.method.toLowerCase() !== method.toLowerCase())
      continue;
    return { path: source, index: i };
  }
  return null;
}

describe("registration-order invariants within the flat table", () => {
  test("flat POST /v1/contacts still hits the control-plane handler", () => {
    const matched = firstMatch("POST", "/contacts");
    expect(matched).not.toBeNull();
    expect(String(matched!.path)).toBe("/contacts");
  });

  test("POST /v1/contacts/record/submit reaches the record handler, not the :id catch-all", () => {
    expect(String(firstMatch("POST", "/contacts/record/submit")!.path)).toBe(
      "/contacts/record/submit",
    );
    // POST has no :id contact route: unknown ids are daemon-only, so the
    // catch-all is their first (and only) match.
    const withId = firstMatch("POST", "/contacts/any-id");
    expect(withId!.path).toEqual(/^\//);
  });

  test("DELETE /v1/contacts/invites/:id revokes the invite, not a contact", () => {
    expect(String(firstMatch("DELETE", "/contacts/invites/inv-1")!.path)).toBe(
      "/contacts/invites/{invite_id}",
    );
    const contact = firstMatch("DELETE", "/contacts/contact-1");
    expect(contact!.path).toBeInstanceOf(RegExp);
    expect(String(contact!.path)).toContain("(?<contact_id>");
  });
});
