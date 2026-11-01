import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";

import { ConfigFileCache } from "../../config-file-cache.js";
import * as realCredentialReader from "../../credential-reader.js";
import * as realPaths from "../../paths.js";
import { handleSaveIngressDomain } from "./ingress-domains.js";

// The handler's write path resolves the workspace config through
// getWorkspaceDir (config-file-utils imports it from ./paths.js —
// credential-reader.ts no longer re-exports it); the mock redirects it into a
// per-test temp dir. credential-reader is spread-real so credential-cache's
// readCredentialResult import still resolves while the route runs.
let workspaceDir = "";

mock.module("../../paths.js", () => ({
  ...realPaths,
  getWorkspaceDir: () => workspaceDir,
}));
mock.module("../../credential-reader.js", () => ({
  ...realCredentialReader,
}));

const SavedIngressSchema = z.looseObject({
  ingress: z
    .looseObject({
      publicBaseUrl: z.string().optional(),
      publicBaseUrlManagedBy: z.string().optional(),
    })
    .optional(),
});

let testDir = "";

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "gateway-ingress-domains-test-"));
  workspaceDir = testDir;
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function request(body?: unknown): Request {
  return new Request("http://127.0.0.1/v1/ingress/domains", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function readSavedIngress(): z.infer<typeof SavedIngressSchema>["ingress"] {
  const raw = SavedIngressSchema.parse(
    JSON.parse(readFileSync(join(workspaceDir, "config.json"), "utf-8")),
  );
  return raw.ingress;
}

describe("POST /v1/ingress/domains", () => {
  test("records the tunnel URL as tunnel-managed in the gateway config", async () => {
    const res = await handleSaveIngressDomain(
      request({ publicBaseUrl: "https://foo.ngrok.app" }),
      "127.0.0.1",
      new ConfigFileCache(),
    );

    expect(res.status).toBe(200);
    expect(readSavedIngress()).toMatchObject({
      publicBaseUrl: "https://foo.ngrok.app",
      publicBaseUrlManagedBy: "tunnel",
    });
  });

  test("normalizes the URL the same way every other public base URL is", async () => {
    await handleSaveIngressDomain(
      request({ publicBaseUrl: "https://foo.ngrok.app/" }),
      "127.0.0.1",
      new ConfigFileCache(),
    );

    expect(readSavedIngress()?.publicBaseUrl).toBe("https://foo.ngrok.app");
  });

  test("is a no-op write when the URL is already recorded as tunnel-managed", async () => {
    const configFile = new ConfigFileCache();
    await handleSaveIngressDomain(
      request({ publicBaseUrl: "https://foo.ngrok.app" }),
      "127.0.0.1",
      configFile,
    );
    const afterFirst = readFileSync(join(workspaceDir, "config.json"), "utf-8");

    await handleSaveIngressDomain(
      request({ publicBaseUrl: "https://foo.ngrok.app" }),
      "127.0.0.1",
      configFile,
    );
    const afterSecond = readFileSync(
      join(workspaceDir, "config.json"),
      "utf-8",
    );

    expect(afterSecond).toBe(afterFirst);
  });

  test("does not gate on the peer IP — auth lives in the edge-guardian strategy", async () => {
    // The docker hatch's gateway sees the host CLI as a non-loopback peer
    // (the docker bridge IP); peer-IP gating here 403'd valid
    // guardian-token requests, so it moved to the auth strategy.
    const res = await handleSaveIngressDomain(
      request({ publicBaseUrl: "https://foo.ngrok.app" }),
      "10.0.0.1",
      new ConfigFileCache(),
    );

    expect(res.status).toBe(200);
  });

  test("rejects a body without a usable public URL", async () => {
    const res = await handleSaveIngressDomain(
      request({}),
      "127.0.0.1",
      new ConfigFileCache(),
    );

    expect(res.status).toBe(400);
  });

  test("rejects non-POST methods", async () => {
    const res = await handleSaveIngressDomain(
      new Request("http://127.0.0.1/v1/ingress/domains", { method: "GET" }),
      "127.0.0.1",
      new ConfigFileCache(),
    );

    expect(res.status).toBe(405);
  });
});
