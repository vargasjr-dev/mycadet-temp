import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as realLoopbackFetch from "../loopback-fetch";
import { notifyGatewayOfPublicUrl } from "../ingress-url";
import { saveLockfileAssistant } from "../lockfile";
import { guardianTokenPath } from "../config";

const loopbackSafeFetchMock = mock<typeof realLoopbackFetch.loopbackSafeFetch>(
  async () => new Response("{}", { status: 200 }),
);

mock.module("../loopback-fetch.js", () => ({
  ...realLoopbackFetch,
  loopbackSafeFetch: loopbackSafeFetchMock,
}));

let testDir = "";

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "local-mode-ingress-url-test-"));
  process.env.XDG_CONFIG_HOME = testDir;
  saveLockfileAssistant(
    {
      assistantId: "ing-a1",
      cloud: "docker",
      port: 7832,
      daemonPort: 7821,
    },
    "ing-a1",
  );
  const tokenPath = guardianTokenPath("ing-a1");
  mkdirSync(join(tokenPath, ".."), { recursive: true });
  writeFileSync(
    tokenPath,
    JSON.stringify({
      guardianPrincipalId: "gp-1",
      accessToken: "tok_file_abc",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      refreshToken: "r_1",
      refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      refreshAfter: new Date(Date.now() + 1_800_000).toISOString(),
      deviceId: "dev-1",
      leasedAt: new Date().toISOString(),
    }),
  );
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
  test("resolves the entry's gateway URL and token file, posts the caller's tag", async () => {
    await notifyGatewayOfPublicUrl({
      publicUrl: "http://127.0.0.1:7832",
      assistantId: "ing-a1",
      managedBy: "hatch",
    });

    expect(loopbackSafeFetchMock).toHaveBeenCalledTimes(1);
    const call = loopbackSafeFetchMock.mock.calls[0]!;
    expect(String(call[0])).toBe("http://127.0.0.1:7832/v1/ingress/domains");
    expect(call[1]!.method).toBe("POST");
    expect(new Headers(call[1]!.headers).get("Authorization")).toBe(
      "Bearer tok_file_abc",
    );
    expect(JSON.parse(String(call[1]!.body))).toEqual({
      publicBaseUrl: "http://127.0.0.1:7832",
      managedBy: "hatch",
    });
  });

  test("defaults the tag to tunnel — the original caller's shape unchanged", async () => {
    await notifyGatewayOfPublicUrl({
      publicUrl: "https://foo.ngrok.app",
      assistantId: "ing-a1",
    });

    expect(
      JSON.parse(String(loopbackSafeFetchMock.mock.calls[0]![1]!.body)),
    ).toEqual({
      publicBaseUrl: "https://foo.ngrok.app",
      managedBy: "tunnel",
    });
  });

  test("an unknown assistant falls back to the default gateway port, bearer-less", async () => {
    await notifyGatewayOfPublicUrl({
      publicUrl: "https://foo.ngrok.app",
      assistantId: "missing-entry",
    });

    const call = loopbackSafeFetchMock.mock.calls[0]!;
    expect(String(call[0])).toBe("http://127.0.0.1:7830/v1/ingress/domains");
    expect(new Headers(call[1]!.headers).get("Authorization")).toBeNull();
  });

  test("is best-effort — a failed save logs and resolves, never throws", async () => {
    const warnings: string[] = [];
    loopbackSafeFetchMock.mockImplementation(async () =>
      jsonResponse(500, { error: "boom" }),
    );
    await notifyGatewayOfPublicUrl({
      publicUrl: "http://127.0.0.1:7832",
      assistantId: "ing-a1",
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
    await notifyGatewayOfPublicUrl({
      publicUrl: "http://127.0.0.1:7832",
      assistantId: "ing-a1",
      log: (msg) => warnings.push(msg),
    });

    expect(warnings.join("\n")).toContain(
      "Could not record the ingress domain with the gateway",
    );
  });
});
