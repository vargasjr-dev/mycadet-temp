import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";

import { getAppDirPath, UNSUPPORTED_LEGACY_APP_HTML } from "../apps/app-store.js";
import { seedApp } from "./helpers/seed-app.js";

beforeAll(() => {
  // Real store rows written in the on-disk format. The compiled app carries
  // a dist/index.html; the legacy app has only a root index.html and no src/.
  seedApp({ id: "app-1", name: "Compiled App", schemaJson: "{}" });
  const appDir = getAppDirPath("app-1");
  mkdirSync(join(appDir, "dist"), { recursive: true });
  writeFileSync(
    join(appDir, "dist", "index.html"),
    '<!DOCTYPE html><html><head></head><body><script src="main.js"></script></body></html>',
  );
  seedApp({
    id: "legacy-1",
    name: "Legacy App",
    htmlDefinition: "<div>Hello</div>",
    schemaJson: "{}",
  });
});

import { ROUTES } from "../runtime/routes/app-routes.js";
import { BadRequestError, NotFoundError } from "../runtime/routes/errors.js";
import type { ResponseHeaderArgs } from "../runtime/routes/types.js";

/** Find a route by operationId. */
function getRoute(operationId: string) {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route not found: ${operationId}`);
  }
  return route;
}

/** Resolve responseHeaders from a route definition for the given args. */
function getResponseHeaders(
  operationId: string,
  args: ResponseHeaderArgs,
): Record<string, string> {
  const route = getRoute(operationId);
  if (!route.responseHeaders) {
    return {};
  }
  if (typeof route.responseHeaders === "function") {
    return route.responseHeaders(args);
  }
  return route.responseHeaders;
}

/** Parse CSP header into a directive map. */
function parseCsp(header: string): Record<string, string> {
  const directives: Record<string, string> = {};
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx === -1) {
      continue;
    }
    directives[trimmed.slice(0, spaceIdx)] = trimmed.slice(spaceIdx + 1);
  }
  return directives;
}

describe("app-routes CSP headers", () => {
  test("does NOT include 'unsafe-inline' in script-src", () => {
    const headers = getResponseHeaders("pages_serve", {
      pathParams: { appId: "app-1" },
    });
    const directives = parseCsp(headers["Content-Security-Policy"]);
    expect(directives["script-src"]).not.toContain("'unsafe-inline'");
  });

  test("includes 'self' in script-src for external main.js", () => {
    const headers = getResponseHeaders("pages_serve", {
      pathParams: { appId: "app-1" },
    });
    const directives = parseCsp(headers["Content-Security-Policy"]);
    expect(directives["script-src"]).toContain("'self'");
  });

  test("includes 'unsafe-inline' in style-src", () => {
    const headers = getResponseHeaders("pages_serve", {
      pathParams: { appId: "app-1" },
    });
    const directives = parseCsp(headers["Content-Security-Policy"]);
    expect(directives["style-src"]).toContain("'unsafe-inline'");
  });

  test("has img-src with self, data, and https", () => {
    const headers = getResponseHeaders("pages_serve", {
      pathParams: { appId: "app-1" },
    });
    const directives = parseCsp(headers["Content-Security-Policy"]);
    expect(directives["img-src"]).toContain("'self'");
    expect(directives["img-src"]).toContain("data:");
    expect(directives["img-src"]).toContain("https:");
  });
});

describe("handleServePage", () => {
  const pageHandler = getRoute("pages_serve").handler;

  test("serves compiled dist/index.html for compiled apps", () => {
    const html = pageHandler({ pathParams: { appId: "app-1" } }) as string;
    expect(html).toContain("/v1/apps/app-1/dist/main.js");
  });

  test("serves the unsupported-format message for legacy single-file apps", () => {
    const html = pageHandler({ pathParams: { appId: "legacy-1" } }) as string;
    expect(html).toContain(UNSUPPORTED_LEGACY_APP_HTML);
    expect(html).not.toContain("<div>Hello</div>");
  });

  test("throws NotFoundError for unknown apps", () => {
    expect(() => pageHandler({ pathParams: { appId: "nope" } })).toThrow(
      NotFoundError,
    );
  });
});

describe("handleServeDistFile appId validation", () => {
  const distHandler = getRoute("apps_dist_file").handler;

  test("rejects appId with encoded path traversal (..)", () => {
    expect(() =>
      distHandler({ pathParams: { appId: "..", filename: "main.js" } }),
    ).toThrow(BadRequestError);
  });

  test("rejects appId with forward slash", () => {
    expect(() =>
      distHandler({
        pathParams: { appId: "../../etc", filename: "main.js" },
      }),
    ).toThrow(BadRequestError);
  });

  test("rejects appId with backslash", () => {
    expect(() =>
      distHandler({
        pathParams: { appId: "foo\\bar", filename: "main.js" },
      }),
    ).toThrow(BadRequestError);
  });

  test("rejects empty appId", () => {
    expect(() =>
      distHandler({ pathParams: { appId: "", filename: "main.js" } }),
    ).toThrow(BadRequestError);
  });

  test("rejects appId with leading whitespace", () => {
    expect(() =>
      distHandler({
        pathParams: { appId: " app-1", filename: "main.js" },
      }),
    ).toThrow(BadRequestError);
  });

  test("rejects appId with trailing whitespace", () => {
    expect(() =>
      distHandler({
        pathParams: { appId: "app-1 ", filename: "main.js" },
      }),
    ).toThrow(BadRequestError);
  });

  test("rejects appId containing .. in the middle", () => {
    expect(() =>
      distHandler({
        pathParams: { appId: "foo..bar", filename: "main.js" },
      }),
    ).toThrow(BadRequestError);
  });

  test("allows valid appId and filename (file not found throws NotFoundError)", () => {
    expect(() =>
      distHandler({
        pathParams: { appId: "app-1", filename: "main.js" },
      }),
    ).toThrow(NotFoundError);
  });
});
