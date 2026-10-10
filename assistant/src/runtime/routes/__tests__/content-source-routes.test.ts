/**
 * Unit tests for content-source-routes.ts.
 *
 * Drives the handler function directly (bypassing the router); sidecar
 * writes land in the preload's real per-process workspace and are asserted
 * by reading the file back.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { beforeEach, describe, expect, test } from "bun:test";

// The preload's workspace is where route handlers build sidecar paths.
const WORKSPACE_DIR = process.env.CADET_WORKSPACE_DIR!;
const SIDECAR_PATH = () => `${WORKSPACE_DIR}/data/content-source.json`;

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { ROUTES } from "../content-source-routes.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findHandler(operationId: string): RouteDefinition["handler"] {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route.handler;
}

function makeArgs(body?: Record<string, unknown>): RouteHandlerArgs {
  return { body };
}

const handler = findHandler("content_source_set");

beforeEach(() => {
  // The preload workspace is shared by the whole process; drop any sidecar
  // a previous test wrote so absence assertions are honest.
  rmSync(SIDECAR_PATH(), { force: true });
});

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

describe("content_source_set — URL validation", () => {
  test("https URL is accepted and sidecar written", () => {
    const result = handler(makeArgs({ url: "https://myblog.com/posts" }));
    expect(result).toEqual({ ok: true });

    expect(existsSync(SIDECAR_PATH())).toBe(true);
    const written = JSON.parse(readFileSync(SIDECAR_PATH(), "utf-8"));
    expect(written.url).toBe("https://myblog.com/posts");
  });

  test("http URL is accepted and sidecar written", () => {
    const result = handler(makeArgs({ url: "http://intranet.example.com" }));
    expect(result).toEqual({ ok: true });
  });

  test("URL with leading/trailing whitespace is trimmed", () => {
    const result = handler(makeArgs({ url: "  https://blog.example.com  " }));
    expect(result).toEqual({ ok: true });

    const written = JSON.parse(readFileSync(SIDECAR_PATH(), "utf-8"));
    expect(written.url).toBe("https://blog.example.com/");
  });

  test("bare hostname without protocol returns invalid_url", () => {
    const result = handler(makeArgs({ url: "myblog.com" }));
    expect(result).toEqual({ ok: false, error: "invalid_url" });
    expect(existsSync(SIDECAR_PATH())).toBe(false);
  });

  test("ftp:// URL is rejected", () => {
    const result = handler(makeArgs({ url: "ftp://files.example.com" }));
    expect(result).toEqual({ ok: false, error: "invalid_url" });
    expect(existsSync(SIDECAR_PATH())).toBe(false);
  });

  test("empty string returns invalid_url", () => {
    const result = handler(makeArgs({ url: "" }));
    expect(result).toEqual({ ok: false, error: "invalid_url" });
    expect(existsSync(SIDECAR_PATH())).toBe(false);
  });

  test("whitespace-only string returns invalid_url", () => {
    const result = handler(makeArgs({ url: "   " }));
    expect(result).toEqual({ ok: false, error: "invalid_url" });
    expect(existsSync(SIDECAR_PATH())).toBe(false);
  });

  test("javascript: URL is rejected", () => {
    const result = handler(makeArgs({ url: "javascript:alert(1)" }));
    expect(result).toEqual({ ok: false, error: "invalid_url" });
    expect(existsSync(SIDECAR_PATH())).toBe(false);
  });

  test("missing url field returns invalid_url", () => {
    const result = handler(makeArgs({}));
    expect(result).toEqual({ ok: false, error: "invalid_url" });
  });
});

// ---------------------------------------------------------------------------
// Sidecar content verification
// ---------------------------------------------------------------------------

describe("content_source_set — sidecar contents", () => {
  test("writes url to data/content-source.json", () => {
    handler(makeArgs({ url: "https://example.com/blog" }));

    const written = JSON.parse(readFileSync(SIDECAR_PATH(), "utf-8"));
    expect(Object.keys(written)).toEqual(["url"]);
  });

  test("no sidecar written on invalid URL", () => {
    handler(makeArgs({ url: "not-a-url" }));
    expect(existsSync(SIDECAR_PATH())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Route policy verification
// ---------------------------------------------------------------------------

describe("route policy", () => {
  test("content_source_set requires settings.write (secrets-grade)", () => {
    const route = ROUTES.find((r) => r.operationId === "content_source_set");
    expect(route?.policy?.requiredScopes).toContain("settings.write");
  });
});
