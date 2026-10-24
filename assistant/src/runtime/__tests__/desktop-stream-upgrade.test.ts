import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { RuntimeHttpServer } from "../http-server.js";
import {
  actorIdentityHeaders,
  gatewayIdentityHeaders,
  requireHttpAuth,
  upgradeHeaders,
  waitForClose,
} from "./runtime-ws-test-utils.js";

describe("RuntimeHttpServer /v1/desktop/stream upgrade", () => {
  let server: RuntimeHttpServer;
  let baseUrl: string;
  let restoreAuthEnv: () => void;
  const originalContainerized = process.env.IS_CONTAINERIZED;
  const originalPlatform = process.env.IS_CLOUD;

  beforeEach(async () => {
    restoreAuthEnv = requireHttpAuth();
    const port = 21400 + Math.floor(Math.random() * 300);
    server = new RuntimeHttpServer({ port, hostname: "127.0.0.1" });
    await server.start();
    baseUrl = `127.0.0.1:${server.actualPort}`;
    process.env.IS_CLOUD = "true";
  });

  afterEach(async () => {
    await server.stop();
    restoreAuthEnv();
    if (originalContainerized === undefined) {
      delete process.env.IS_CONTAINERIZED;
    } else {
      process.env.IS_CONTAINERIZED = originalContainerized;
    }
    if (originalPlatform === undefined) {
      delete process.env.IS_CLOUD;
    } else {
      process.env.IS_CLOUD = originalPlatform;
    }
  });

  test("refuses a non-private origin with 403", async () => {
    const res = await fetch(`http://${baseUrl}/v1/desktop/stream`, {
      headers: { ...upgradeHeaders, ...gatewayIdentityHeaders, Origin: "https://external.example.com" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain(
      "Direct desktop stream access disabled",
    );
  });

  test("refuses a missing or non-gateway identity with 401", async () => {
    const missing = await fetch(`http://${baseUrl}/v1/desktop/stream`, {
      headers: upgradeHeaders,
    });
    expect(missing.status).toBe(401);

    const actor = await fetch(`http://${baseUrl}/v1/desktop/stream`, {
      headers: { ...upgradeHeaders, ...actorIdentityHeaders },
    });
    expect(actor.status).toBe(401);
  });

  test("upgrades a gateway request and reports the feature gate as close code 4008", async () => {
    // The test daemon is not containerized, so the socket opens and is then
    // closed by the desktop-stream open handler rather than refused pre-upgrade.
    const ws = new WebSocket(`ws://${baseUrl}/v1/desktop/stream`, {
      headers: gatewayIdentityHeaders,
    } as unknown as string[]);
    const closed = await waitForClose(ws);
    expect(closed.code).toBe(4008);
    expect(closed.reason).toBe(
      "Virtual desktop is available only on enabled cloud-hosted assistants",
    );
  });
});

test("self-hosted containers cannot stream", async () => {
  const originalPlatform = process.env.IS_CLOUD;
  const originalContainerized = process.env.IS_CONTAINERIZED;
  const restoreAuth = requireHttpAuth();
  const server = new RuntimeHttpServer({ port: 0, hostname: "127.0.0.1" });
  try {
    await server.start();
    process.env.IS_CLOUD = "false";
    process.env.IS_CONTAINERIZED = "true";
    const baseUrl = `127.0.0.1:${server.actualPort}`;
    const ws = new WebSocket(`ws://${baseUrl}/v1/desktop/stream`, {
      headers: gatewayIdentityHeaders,
    } as unknown as string[]);
    expect((await waitForClose(ws)).code).toBe(4008);
  } finally {
    await server.stop();
    restoreAuth();
    if (originalPlatform === undefined) {
      delete process.env.IS_CLOUD;
    } else {
      process.env.IS_CLOUD = originalPlatform;
    }
    if (originalContainerized === undefined) {
      delete process.env.IS_CONTAINERIZED;
    } else {
      process.env.IS_CONTAINERIZED = originalContainerized;
    }
  }
});
