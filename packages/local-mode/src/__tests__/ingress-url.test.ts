import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveIngressPublicBaseUrl } from "../ingress-url";

let testDir = "";

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "local-mode-ingress-url-test-"));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("saveIngressPublicBaseUrl", () => {
  test("posts the URL to the gateway's ingress route, hatch-tagged, bearer-authed", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    await saveIngressPublicBaseUrl({
      gatewayUrl: "http://localhost:7832",
      bearerToken: "tok_abc",
      publicBaseUrl: "http://localhost:7832",
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return jsonResponse(200, { ok: true });
      }) as typeof fetch,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost:7832/v1/ingress/domains");
    expect(calls[0].init.method).toBe("POST");
    expect(
      (calls[0].init.headers as Record<string, string>).Authorization,
    ).toBe("Bearer tok_abc");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      publicBaseUrl: "http://localhost:7832",
      managedBy: "hatch",
    });
  });

  test("is best-effort — a failed save logs and resolves, never throws", async () => {
    const warnings: string[] = [];
    await saveIngressPublicBaseUrl({
      gatewayUrl: "http://localhost:7832",
      bearerToken: "tok_abc",
      publicBaseUrl: "http://localhost:7832",
      log: (msg) => warnings.push(msg),
      fetchImpl: (async (..._args: unknown[]) =>
        jsonResponse(500, { error: "boom" })) as typeof fetch,
    });

    expect(warnings.join("\n")).toContain("Failed to record the ingress URL");
  });

  test("a network error is absorbed the same way", async () => {
    const warnings: string[] = [];
    await saveIngressPublicBaseUrl({
      gatewayUrl: "http://localhost:7832",
      bearerToken: "tok_abc",
      publicBaseUrl: "http://localhost:7832",
      log: (msg) => warnings.push(msg),
      fetchImpl: (async (..._args: unknown[]) => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });

    expect(warnings.join("\n")).toContain("Failed to record the ingress URL");
  });

  test("without a leased token it skips the call entirely", async () => {
    let fetched = false;
    const warnings: string[] = [];
    await saveIngressPublicBaseUrl({
      gatewayUrl: "http://localhost:7832",
      publicBaseUrl: "http://localhost:7832",
      log: (msg) => warnings.push(msg),
      fetchImpl: (async (..._args: unknown[]) => {
        fetched = true;
        return jsonResponse(200, { ok: true });
      }) as typeof fetch,
    });

    expect(fetched).toBe(false);
    expect(warnings.join("\n")).toContain("guardian token was not leased");
  });
});
