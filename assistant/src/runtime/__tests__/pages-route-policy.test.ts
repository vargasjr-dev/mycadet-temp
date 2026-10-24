/**
 * Shareable app pages are served outside the /v1/ namespace, at
 * `GET /pages/:appId`, but they are an ordinary entry in the shared ROUTES
 * array and carry an ordinary policy (`settings.read`, actor principals).
 *
 * These tests pin that the bare path dispatches through the router, so the
 * declared policy is enforced there: a single-route grant handed to a
 * third-party binary is refused, and a normal client still gets its page.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { seedApp } from "../../__tests__/helpers/seed-app.js";
import { getAppDirPath } from "../../apps/app-store.js";

const APP_ID = "app-under-test";

const { setDbReady } = await import("../../daemon/daemon-readiness.js");
const { RuntimeHttpServer } = await import("../http-server.js");

/** A desktop/web client identity: `actor_client_v1` carries settings.read. */
const ACTOR_IDENTITY = {
  "x-cadet-subject": "actor:self:test-principal",
  "x-cadet-principal-type": "actor",
  "x-cadet-scope-profile": "actor_client_v1",
};

/** The grant `assistant oauth proxy-url` hands to a third-party binary. */
const PROXY_GRANT_IDENTITY = {
  "x-cadet-subject": "local:self:oauth-proxy.stripe_link",
  "x-cadet-principal-type": "local",
  "x-cadet-scope-profile": "oauth_proxy_v1",
};

describe("GET /pages/:appId enforces its route policy", () => {
  let server: InstanceType<typeof RuntimeHttpServer>;
  let port = 0;

  beforeAll(async () => {
    // Real store row + real dist/index.html in the per-process workspace.
    seedApp({ id: APP_ID, name: "Test App" });
    const appDir = getAppDirPath(APP_ID);
    mkdirSync(join(appDir, "dist"), { recursive: true });
    writeFileSync(
      join(appDir, "dist", "index.html"),
      '<!DOCTYPE html><html><body><script src="./main.js"></script></body></html>',
    );
    setDbReady(true);
    server = new RuntimeHttpServer({ port: await getFreePort() });
    await server.start();
    port = server.actualPort;
  });

  afterAll(async () => {
    await server?.stop();
  });

  function fetchPage(
    identity: Record<string, string>,
    appId = APP_ID,
  ): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/pages/${appId}`, {
      headers: identity,
    });
  }

  test("serves the page to a client holding settings.read", async () => {
    const response = await fetchPage(ACTOR_IDENTITY);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    // Relative asset paths are rewritten onto the HTTP dist route.
    expect(await response.text()).toContain(
      `src="/v1/apps/${APP_ID}/dist/main.js"`,
    );
  });

  test("refuses an oauth_proxy_v1 grant", async () => {
    const response = await fetchPage(PROXY_GRANT_IDENTITY);

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  test("refuses a request with no token at all", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/pages/${APP_ID}`);

    expect(response.status).toBe(401);
  });

  test("an unknown app is a 404, not a 500", async () => {
    const response = await fetchPage(ACTOR_IDENTITY, "no-such-app");

    expect(response.status).toBe(404);
  });

  test("an id that decodes to a traversal is a 404, not a 500", async () => {
    // The router percent-decodes its path params, so the handler is asked to
    // resolve "../foo". Traversal is refused either way; the caller reads it
    // as an app that does not exist rather than a fault in the daemon.
    const response = await fetchPage(ACTOR_IDENTITY, "%2E%2E%2Ffoo");

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("..");
  });
});

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("Failed to allocate free port"));
        }
      });
    });
  });
}
