import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as realLoopbackFetch from "../loopback-fetch";
import { notifyGatewayOfPublicUrl } from "../ingress-url";

let testDir = "";

const loopbackSafeFetchMock = mock<typeof realLoopbackFetch.loopbackSafeFetch>(
  async () => new Response("{}", { status: 200 }),
);

mock.module("../loopback-fetch.js", () => ({
  ...realLoopbackFetch,
  loopbackSafeFetch: loopbackSafeFetchMock,
}));

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "local-mode-ingress-url-test-"));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  loopbackSafeFetchMock.mockClear();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("notifyGatewayOfPublicUrl", () => {
  test("posts the URL to the gateway's ingress route with the caller's tag", async () => {
    await notifyGatewayOfPublicUrl("http://localhost:7832", undefined, {
      gatewayUrl: "http://localhost:7832",
      bearerToken: "tok_abc",
      managedBy: "hatch",
    });

    expect(loopbackSafeFetchMock).toHaveBeenCalledTimes(1);
    const call = loopbackSafeFetchMock.mock.calls[0]!;
    expect(String(call[0])).toBe("http://localhost:7832/v1/ingress/domains");
    expect(call[1]!.method).toBe("POST");
    expect((call[1]!.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok_abc",
    );
    expect(JSON.parse(String(call[1]!.body))).toEqual({
      publicBaseUrl: "http://localhost:7832",
      managedBy: "hatch",
    });
  });

  test("defaults the tag to tunnel — the original caller's shape unchanged", async () => {
    await notifyGatewayOfPublicUrl("https://foo.ngrok.app", undefined, {
      gatewayUrl: "http://127.0.0.1:7830",
    });

    expect(
      JSON.parse(String(loopbackSafeFetchMock.mock.calls[0]![1]!.body)),
    ).toEqual({
      publicBaseUrl: "https://foo.ngrok.app",
      managedBy: "tunnel",
    });
  });

  test("is best-effort — a failed save logs and resolves, never throws", async () => {
    const warnings: string[] = [];
    loopbackSafeFetchMock.mockImplementation(async () =>
      jsonResponse(500, { error: "boom" }),
    );
    await notifyGatewayOfPublicUrl("http://localhost:7832", undefined, {
      gatewayUrl: "http://localhost:7832",
      bearerToken: "tok_abc",
      log: (msg) => warnings.push(msg),
    });

    expect(warnings.join("\n")).toContain(
      "Could not record the ingress domain with the gateway",
    );
  });

  test("a network error is absorbed the same way", async () => {
    const warnings: string[] = [];
    loopbackSafeFetchMock.mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });
    await notifyGatewayOfPublicUrl("http://localhost:7832", undefined, {
      gatewayUrl: "http://localhost:7832",
      bearerToken: "tok_abc",
      log: (msg) => warnings.push(msg),
    });

    expect(warnings.join("\n")).toContain(
      "Could not record the ingress domain with the gateway",
    );
  });
});
