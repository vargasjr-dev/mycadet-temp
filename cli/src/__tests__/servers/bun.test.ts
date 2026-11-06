import * as childProcess from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import * as fsModule from "node:fs";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { resolveLockfilePath } from "@mycadet/local-mode";
import * as httpClient from "@mycadet/local-mode";
import * as versionModule from "@mycadet/shared/version";
import * as assistantConfigModule from "../../lib/assistant-config.js";
import * as webDistModule from "../../lib/web-dist.js";

const realChildProcess = { ...childProcess };
const realFs = { ...fsModule };
const realHttpClient = { ...httpClient };
const realVersionModule = { ...versionModule };
const realWebDist = { ...webDistModule };

const execFileSyncMock = mock(childProcess.execFileSync);
const spawnMock = mock(childProcess.spawn);

/**
 * A git rev-parse that fails like a git-less tree: the built-sha stamp's
 * staleness probe stays inert and the per-test fakes never see a git spawn.
 */
function gitStubSpawn(): childProcess.ChildProcess {
  const child = new childProcess.ChildProcess();
  Object.defineProperty(child, "stdout", { value: null });
  setTimeout(() => child.emit("exit", 1), 0);
  return child;
}

mock.module("node:child_process", () => ({
  ...childProcess,
  execFileSync: execFileSyncMock,
  spawn: ((command: string, args: readonly string[], options?: SpawnOptions) =>
    command === "git"
      ? gitStubSpawn()
      : spawnMock(command, args, options ?? {})) as typeof childProcess.spawn,
}));

const waitForDaemonReadyMock = mock<typeof httpClient.waitForDaemonReady>(
  async () => true,
);

mock.module("@mycadet/local-mode", () => ({
  ...httpClient,
  waitForDaemonReady: waitForDaemonReadyMock,
}));

// The server stamps the CLI's own resolveVersion as the served version — a
// fixed value here keeps the fingerprint replicas below exact.
const stampedVersionMock = mock(() => "1.2.3");

mock.module("@mycadet/shared/version", () => ({
  resolveVersion: stampedVersionMock,
}));

// The server resolves the assistant it fronts itself (see ensureAppServer),
// so the resolution seam is mocked per test while the rest of
// assistant-config (name lookups, process records) stays real.
const realAssistantConfig = { ...assistantConfigModule };
const resolveTargetAssistantMock = mock(
  assistantConfigModule.resolveTargetAssistant,
);

mock.module("../../lib/assistant-config.js", () => ({
  ...realAssistantConfig,
  resolveTargetAssistant: resolveTargetAssistantMock,
}));

// The dist resolution is mocked onto REAL fixture directories, so both the
// lifecycle (reads the dist indexes, fingerprints them) and the handler
// (serves the files) test against bytes on disk.
const resolveClientDistsMock = mock(webDistModule.resolveClientDists);

mock.module("../../lib/web-dist.js", () => ({
  ...webDistModule,
  resolveClientDists: resolveClientDistsMock,
}));

// Restore the real modules once this file finishes so the mocks do not leak
// into sibling test files in the same `bun test` run.
afterAll(() => {
  mock.module("node:child_process", () => realChildProcess);
  mock.module("@mycadet/local-mode", () => realHttpClient);
  mock.module("@mycadet/shared/version", () => realVersionModule);
  mock.module("../../lib/assistant-config.js", () => realAssistantConfig);
  mock.module("../../lib/web-dist.js", () => realWebDist);
});

import { createAppServerHandler } from "../../lib/servers/bun.js";
import {
  DEFAULT_APP_SERVER_PORT,
  MAX_PRESERVED_MODULE_PRELOADS,
  appServerStatePath,
  buildRemoteWebIndexHtml,
  ensureAppServer,
  findAvailableServerPort,
  getAppServerPaths,
  readAppServerState,
  startAppServer,
} from "../../lib/servers/common.js";

const originalKill = process.kill;
const originalFetch = globalThis.fetch;
const workspaces: string[] = [];
const originalWorkspaceDir = process.env.CADET_WORKSPACE_DIR;
const originalDataHome = process.env.XDG_DATA_HOME;
const originalConfigHome = process.env.XDG_CONFIG_HOME;

/**
 * Registry-backed process.kill mock: registered fake PIDs answer liveness
 * probes and record kills, everything else forwards to the real kill.
 */
const fakePids = new Map<number, { alive: boolean; unkillable?: boolean }>();

function installKillMock(): void {
  process.kill = mock((targetPid: number, signal?: string | number): true => {
    const entry = fakePids.get(targetPid);
    if (!entry) {
      return originalKill(targetPid, signal);
    }
    if (signal === 0) {
      if (!entry.alive) {
        throw new Error("dead");
      }
      return true;
    }
    if (entry.unkillable) {
      throw new Error("operation not permitted");
    }
    entry.alive = false;
    return true;
  });
}

afterEach(() => {
  if (originalConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalConfigHome;
  }
  process.kill = originalKill;
  fakePids.clear();
  globalThis.fetch = originalFetch;
  execFileSyncMock.mockReset();
  execFileSyncMock.mockImplementation(realChildProcess.execFileSync);
  spawnMock.mockReset();
  spawnMock.mockImplementation(realChildProcess.spawn);
  stampedVersionMock.mockReset();
  stampedVersionMock.mockImplementation(() => "1.2.3");
  waitForDaemonReadyMock.mockReset();
  waitForDaemonReadyMock.mockImplementation(async () => true);
  resolveClientDistsMock.mockReset();
  resolveTargetAssistantMock.mockReset();
  for (const dir of workspaces.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (originalWorkspaceDir === undefined) {
    delete process.env.CADET_WORKSPACE_DIR;
  } else {
    process.env.CADET_WORKSPACE_DIR = originalWorkspaceDir;
  }
  if (originalDataHome === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = originalDataHome;
  }
});

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "cadet-app-server-test-"));
  workspaces.push(dir);
  // The server reads the lockfile and keeps its own state under the XDG
  // data dir — pin both config and data homes so every test is hermetic.
  process.env.CADET_WORKSPACE_DIR = dir;
  process.env.XDG_CONFIG_HOME = dir;
  process.env.XDG_DATA_HOME = dir;
  return dir;
}

/** Seed the one assistant entry the server's strict lookup fronts. */
function seedAssistant(name = "Homelab"): void {
  const path = resolveLockfilePath();
  realFs.mkdirSync(join(path, ".."), { recursive: true });
  realFs.writeFileSync(
    path,
    JSON.stringify({
      assistants: [
        {
          assistantId: "assistant-1",
          name,
          cloud: "local",
          localUrl: "http://127.0.0.1:7830",
        },
      ],
      activeAssistant: "assistant-1",
    }),
  );
}

/** Stamp the lockfile's tunnel record with a published URL. */
function stampTunnelRecord(url: string): void {
  const path = resolveLockfilePath();
  let lockfile: Record<string, unknown> = {};
  try {
    lockfile = JSON.parse(realFs.readFileSync(path, "utf-8")) as Record<
      string,
      unknown
    >;
  } catch {
    // No lockfile yet: the stamp creates it.
  }
  lockfile.tunnel = {
    pid: 4242,
    provider: "ngrok",
    startedAt: new Date().toISOString(),
    publicUrl: url,
  };
  realFs.mkdirSync(join(path, ".."), { recursive: true });
  realFs.writeFileSync(path, JSON.stringify(lockfile));
}

const originalEnvironment = process.env.CADET_ENVIRONMENT;

function pinProductionEnvironment(): void {
  beforeEach(() => {
    process.env.CADET_ENVIRONMENT = "production";
  });
  afterEach(() => {
    if (originalEnvironment === undefined) {
      delete process.env.CADET_ENVIRONMENT;
    } else {
      process.env.CADET_ENVIRONMENT = originalEnvironment;
    }
  });
}

// ── Handler fixtures ─────────────────────────────────────────

const FAKE_WEB_INDEX_HTML = "<html><head></head><body>web-shell</body></html>";
const FAKE_APP_INDEX_HTML =
  "<!doctype html><html><head><title>app</title></head><body>app-shell</body></html>";
const WEB_CHUNK_JS = "console.log('web chunk');";
const APP_CHUNK_JS = "console.log('app chunk');";

interface HandlerFixture {
  webDistDir: string;
  appDistDir: string;
  indexHtmlPath: string;
  appIndexHtmlPath: string;
  spec: Parameters<typeof createAppServerHandler>[0];
  config: Record<string, unknown>;
}

/**
 * Real dist trees in a tmpdir plus the two injected documents the start
 * path would write, and the handler bound to them.
 */
function makeHandlerFixture(
  config: Record<string, unknown> = {
    remote: "local",
    assistantName: "Homelab",
    assistantId: "assistant-1",
    version: "1.2.3",
  },
): HandlerFixture {
  const root = mkdtempSync(join(tmpdir(), "cadet-app-server-fixtures-"));
  workspaces.push(root);
  const webDistDir = join(root, "web");
  const appDistDir = join(root, "app");
  mkdirSync(join(webDistDir, "assets"), { recursive: true });
  mkdirSync(join(appDistDir, "assets"), { recursive: true });
  writeFileSync(join(webDistDir, "index.html"), FAKE_WEB_INDEX_HTML);
  writeFileSync(join(appDistDir, "index.html"), FAKE_APP_INDEX_HTML);
  writeFileSync(join(webDistDir, "assets", "app.js"), WEB_CHUNK_JS);
  writeFileSync(join(appDistDir, "assets", "app.js"), APP_CHUNK_JS);
  writeFileSync(join(appDistDir, "favicon.svg"), "<svg>cadet</svg>");
  const paths = getAppServerPaths();
  mkdirSync(paths.dir, { recursive: true });
  const indexHtmlPath = join(paths.dir, "assistant-index.html");
  const appIndexHtmlPath = join(paths.dir, "app-index.html");
  writeFileSync(
    indexHtmlPath,
    buildRemoteWebIndexHtml(FAKE_WEB_INDEX_HTML, config),
  );
  writeFileSync(
    appIndexHtmlPath,
    buildRemoteWebIndexHtml(FAKE_APP_INDEX_HTML, config),
  );
  return {
    webDistDir,
    appDistDir,
    indexHtmlPath,
    appIndexHtmlPath,
    config,
    spec: {
      gatewayUrl: "http://127.0.0.1:7830",
      webDistDir,
      appDistDir,
      indexHtmlPath,
      appIndexHtmlPath,
      config,
    },
  };
}

const EDGE_PEER_IP = "198.51.100.7";

/**
 * The handler under test, with the edge's peer address pinned (the live
 * server threads `server.requestIP` here; direct handler tests pass a
 * stub).
 */
function handlerFor(fixture: HandlerFixture) {
  return createAppServerHandler(fixture.spec, {
    requestIP: () => EDGE_PEER_IP,
  });
}

/** Capture the proxy's upstream request and answer a canned response. */
function stubGatewayFetch(
  respond: (init: {
    url: string;
    method: string;
    headers: Headers;
    body: ReadableStream<Uint8Array> | null;
  }) => Response = () => new Response("gateway says hi"),
): {
  calls: Array<{
    url: string;
    method: string;
    headers: Headers;
    body: ReadableStream<Uint8Array> | null;
  }>;
} {
  const calls: Array<{
    url: string;
    method: string;
    headers: Headers;
    body: ReadableStream<Uint8Array> | null;
  }> = [];
  globalThis.fetch = mock(async (input: unknown, init?: unknown) => {
    const request =
      input instanceof Request
        ? input
        : new Request(input as string, init as RequestInit | undefined);
    const body =
      request.body instanceof ReadableStream
        ? (request.body as ReadableStream<Uint8Array>)
        : null;
    calls.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body,
    });
    return respond(calls[calls.length - 1]!);
  }) as unknown as typeof fetch;
  return { calls };
}

async function readBody(response: Response): Promise<string> {
  return await response.text();
}

// ── The routes ───────────────────────────────────────────────

describe("the app server's routes", () => {
  pinProductionEnvironment();

  test("the edge no longer judges vocabulary — sensitive routes ride to the gateway's own gate", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    const gateway = stubGatewayFetch();
    // The old edge denylist is gone: the edge forwards everything it serves
    // but doesn't own, and the gateway's own auth gates the sensitive rows.
    for (const path of [
      "/v1/pair",
      "/pair",
      "/v1/shared/invites/redeem",
      "/v1/remote-web/pairing-requests/approve",
    ]) {
      const response = await handler(
        new Request(`http://127.0.0.1:7840${path}`, { method: "POST" }),
      );
      expect(response.status).toBe(200);
    }
    expect(gateway.calls).toHaveLength(4);
  });

  test("proxies the versioned gateway API surface verbatim", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    const gateway = stubGatewayFetch();
    const response = await handler(
      new Request("http://127.0.0.1:7840/v1/conversations?limit=5"),
    );
    expect(response.status).toBe(200);
    expect(await readBody(response)).toBe("gateway says hi");
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]!.url).toBe(
      "http://127.0.0.1:7830/v1/conversations?limit=5",
    );
  });

  test("healthz answers locally; other probes and webhooks ride to the gateway", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    const gateway = stubGatewayFetch();
    const health = await handler(new Request("http://127.0.0.1:7840/healthz"));
    expect(health.status).toBe(200);
    const ready = await handler(new Request("http://127.0.0.1:7840/readyz"));
    expect(ready.status).toBe(200);
    await handler(
      new Request("http://127.0.0.1:7840/webhooks/telegram", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(gateway.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/readyz",
      "/webhooks/telegram",
    ]);
  });

  test("stamps the edge-observed client ip from the rightmost X-Forwarded-For entry", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    const gateway = stubGatewayFetch();
    await handler(
      new Request("http://127.0.0.1:7840/v1/things", {
        headers: { "x-forwarded-for": "203.0.113.9, 198.51.100.7" },
      }),
    );
    const headers = gateway.calls[0]!.headers;
    expect(headers.get("x-cadet-client-ip")).toBe("198.51.100.7");
  });

  test("falls back to the raw peer when no X-Forwarded-For is set", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    const gateway = stubGatewayFetch();
    await handler(new Request("http://127.0.0.1:7840/v1/things"));
    expect(gateway.calls[0]!.headers.get("x-cadet-client-ip")).toBe(
      EDGE_PEER_IP,
    );
  });

  test("strips the host and hop-by-hop headers from the upstream request", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    const gateway = stubGatewayFetch();
    await handler(
      new Request("http://127.0.0.1:7840/v1/things", {
        headers: {
          host: "camping.ngrok-free.dev",
          connection: "keep-alive",
          "keep-alive": "timeout=5",
          authorization: "Bearer device-token",
        },
      }),
    );
    const headers = gateway.calls[0]!.headers;
    expect(headers.get("host")).toBeNull();
    expect(headers.get("connection")).toBeNull();
    expect(headers.get("keep-alive")).toBeNull();
    // The caller's own headers ride as-is.
    expect(headers.get("authorization")).toBe("Bearer device-token");
  });

  test("drops the length and encoding headers a decoded proxied response outgrows", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    stubGatewayFetch(
      () =>
        new Response("gateway body", {
          status: 201,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": "999",
            "Content-Encoding": "gzip",
          },
        }),
    );
    const response = await handler(
      new Request("http://127.0.0.1:7840/v1/things"),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  test("streams a POST body to the gateway", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    let received = "";
    globalThis.fetch = mock(async (input: unknown, init?: unknown) => {
      const request =
        input instanceof Request
          ? input
          : new Request(input as string, init as RequestInit | undefined);
      received = await request.text();
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const response = await handler(
      new Request("http://127.0.0.1:7840/v1/messages", {
        method: "POST",
        body: "the message body",
        headers: { "content-type": "text/plain" },
      }),
    );
    expect(response.status).toBe(204);
    expect(received).toBe("the message body");
  });

  test("the /web twin forwards the iframe namespace's remainder to the /v1 route", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    const gateway = stubGatewayFetch();
    await handler(new Request("http://127.0.0.1:7840/web/channels"));
    await handler(new Request("http://127.0.0.1:7840/web/v1/channels"));
    expect(gateway.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/v1/channels",
      "/v1/channels",
    ]);
  });

  test("the root catch-all forwards unversioned paths verbatim — no rewrite", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    const gateway = stubGatewayFetch();
    // The gateway's router resolves the optional /v1 prefix (P7); the edge
    // never enumerates gateway vocabulary.
    await handler(new Request("http://127.0.0.1:7840/channels"));
    expect(new URL(gateway.calls[0]!.url).pathname).toBe("/channels");
  });

  test("serves the app shell as the outer shell from the origin root", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    const response = await handler(new Request("http://127.0.0.1:7840/"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    const body = await readBody(response);
    // The INJECTED document — the served config rides the script tag.
    expect(body).toContain("__CADET_CONFIG__");
    expect(body).toContain('"assistantId":"assistant-1"');
  });

  test("the shell's SPA routes fall back to the injected document", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    for (const path of ["/account", "/account/keys", "/logout"]) {
      const response = await handler(
        new Request(`http://127.0.0.1:7840${path}`),
      );
      expect(response.status).toBe(200);
      expect(await readBody(response)).toContain("__CADET_CONFIG__");
    }
  });

  test("the shell's shipped root files win over the SPA fallback", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    const favicon = await handler(
      new Request("http://127.0.0.1:7840/favicon.svg"),
    );
    expect(favicon.status).toBe(200);
    expect(await readBody(favicon)).toBe("<svg>cadet</svg>");
    // A named root file with no dist file falls back to the shell document
    // (try_files semantics), never a bare 404.
    const missing = await handler(
      new Request("http://127.0.0.1:7840/cadet-scene-cut.mp4"),
    );
    expect(missing.status).toBe(200);
    expect(await readBody(missing)).toContain("__CADET_CONFIG__");
  });

  test("serves the app dist's own index at /index.html (nginx try_files parity)", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    const response = await handler(
      new Request("http://127.0.0.1:7840/index.html"),
    );
    expect(response.status).toBe(200);
    expect(await readBody(response)).toBe(FAKE_APP_INDEX_HTML);
  });

  test("serves the app dist's assets immutably", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    const response = await handler(
      new Request("http://127.0.0.1:7840/assets/app.js"),
    );
    expect(response.status).toBe(200);
    expect(await readBody(response)).toBe(APP_CHUNK_JS);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  test("unknown /web/assistant paths fall back to the injected web document", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    const fallback = await handler(
      new Request("http://127.0.0.1:7840/web/assistant/__remote-index.html"),
    );
    expect(fallback.status).toBe(200);
    expect(await readBody(fallback)).toContain("__CADET_CONFIG__");
  });

  test("iframes the web UI from the distinct /web/assistant namespace", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);

    const noSlash = await handler(
      new Request("http://127.0.0.1:7840/web/assistant"),
    );
    expect(noSlash.status).toBe(302);
    expect(noSlash.headers.get("location")).toBe("/web/assistant/");

    const root = await handler(new Request("http://127.0.0.1:7840/web"));
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/web/assistant/");

    const index = await handler(
      new Request("http://127.0.0.1:7840/web/assistant/"),
    );
    expect(index.status).toBe(200);
    const indexBody = await readBody(index);
    expect(indexBody).toContain("__CADET_CONFIG__");

    const byName = await handler(
      new Request("http://127.0.0.1:7840/web/assistant/index.html"),
    );
    expect(byName.status).toBe(200);
    expect(await readBody(byName)).toContain("__CADET_CONFIG__");
  });

  test("serves remote web config inline with no-store", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    const response = await handler(
      new Request("http://127.0.0.1:7840/web/assistant/__config"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(await readBody(response))).toMatchObject({
      assistantId: "assistant-1",
    });
  });

  test("the iframe mount serves the web dist's files with the web index as SPA fallback", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    const file = await handler(
      new Request("http://127.0.0.1:7840/web/assistant/assets/app.js"),
    );
    expect(file.status).toBe(200);
    expect(await readBody(file)).toBe(WEB_CHUNK_JS);

    const fallback = await handler(
      new Request("http://127.0.0.1:7840/web/assistant/channels/inbox"),
    );
    expect(fallback.status).toBe(200);
    expect(await readBody(fallback)).toContain("__CADET_CONFIG__");
  });

  test("the web bundle's baked /assistant/ base serves its files; the shell owns the fallback", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);

    const assets = await handler(
      new Request("http://127.0.0.1:7840/assistant/assets/app.js"),
    );
    expect(assets.status).toBe(200);
    expect(await readBody(assets)).toBe(WEB_CHUNK_JS);
    expect(assets.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );

    // Real files win under the baked base...
    expect(fixture.spec.webDistDir).toBeDefined();
    const webFile = join(fixture.webDistDir, "channels.js");
    writeFileSync(webFile, "console.log('web root file');");
    const rootFile = await handler(
      new Request("http://127.0.0.1:7840/assistant/channels.js"),
    );
    expect(rootFile.status).toBe(200);
    expect(await readBody(rootFile)).toBe("console.log('web root file');");
  });

  test("compresses the static documents and never a proxied response", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);

    const compressed = await handler(
      new Request("http://127.0.0.1:7840/", {
        headers: { "accept-encoding": "gzip, deflate, br" },
      }),
    );
    expect(compressed.headers.get("content-encoding")).toBe("gzip");
    const bytes = new Uint8Array(await compressed.arrayBuffer());
    expect(new TextDecoder().decode(gunzipSync(bytes))).toContain(
      "__CADET_CONFIG__",
    );

    stubGatewayFetch(
      () =>
        new Response("<html>gateway html</html>", {
          headers: { "content-type": "text/html" },
        }),
    );
    const proxied = await handler(
      new Request("http://127.0.0.1:7840/v1/page", {
        headers: { "accept-encoding": "gzip" },
      }),
    );
    expect(proxied.headers.get("content-encoding")).toBeNull();
    expect(await readBody(proxied)).toBe("<html>gateway html</html>");
  });

  test("revalidates the shell with an etag and answers 304 on a match", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    const first = await handler(new Request("http://127.0.0.1:7840/"));
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(first.headers.get("cache-control")).toBe("no-cache");

    const second = await handler(
      new Request("http://127.0.0.1:7840/", {
        headers: { "if-none-match": etag! },
      }),
    );
    expect(second.status).toBe(304);
  });

  test("dispatches the operator rows — the list contract rides the edge", async () => {
    makeWorkspace();
    seedAssistant();
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    const response = await handler(
      new Request("http://127.0.0.1:7840/v1/assistants/"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      assistants?: Array<{ id: string }>;
    };
    expect(body.status).toBe("selection");
    expect(body.assistants?.[0]?.id).toBe("assistant-1");
  });

  test("operator reads carry the app-origin CORS treatment", async () => {
    makeWorkspace();
    seedAssistant();
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);

    const shell = await handler(
      new Request("http://127.0.0.1:7840/v1/assistants/", {
        headers: { origin: "capacitor://localhost" },
      }),
    );
    expect(shell.headers.get("access-control-allow-origin")).toBe(
      "capacitor://localhost",
    );
    expect(shell.headers.get("access-control-allow-credentials")).toBe("true");

    const stranger = await handler(
      new Request("http://127.0.0.1:7840/v1/assistants/", {
        headers: { origin: "https://evil.example" },
      }),
    );
    expect(stranger.headers.get("access-control-allow-origin")).toBeNull();

    const preflight = await handler(
      new Request("http://127.0.0.1:7840/v1/assistants/", {
        method: "OPTIONS",
        headers: { origin: "capacitor://localhost" },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "capacitor://localhost",
    );
  });

  test("websocket upgrades relay to the gateway through the server handle", async () => {
    const fixture = makeHandlerFixture();
    const upgraded: Array<{ data: unknown }> = [];
    const handler = createAppServerHandler(fixture.spec, {
      requestIP: () => EDGE_PEER_IP,
    });
    // A stub server handle: the live child passes Bun's real Server.
    const server = {
      requestIP: () => ({ address: EDGE_PEER_IP }),
      upgrade: (request: Request, options?: { data: unknown }) => {
        expect(request.headers.get("upgrade")).toBe("websocket");
        upgraded.push({ data: options?.data });
        return true;
      },
    };
    // The upstream connect happens against the (stubbed) global fetch
    // socket-level, not fetch — a client WebSocket to a closed port fails
    // async; the upgrade decision itself is what this pins.
    globalThis.fetch = mock(
      async () => new Response(null, { status: 200 }),
    ) as unknown as typeof fetch;
    const response = await handler(
      new Request("http://127.0.0.1:7840/v1/channels/ws", {
        headers: {
          upgrade: "websocket",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version": "13",
        },
      }),
      server,
    );
    // The socket is hijacked; the handler's response body is never used.
    expect(upgraded).toHaveLength(1);
    const data = upgraded[0]!.data as { upstream: WebSocket; queue: unknown[] };
    expect(data.upstream).toBeInstanceOf(WebSocket);
    expect(data.queue).toEqual([]);
    expect(response).toBeDefined();
  });
});

// ── The injected document ────────────────────────────────────

describe("buildRemoteWebIndexHtml", () => {
  test("injects the remote gateway config after any bundled local config", () => {
    const raw = `<html><head><script>window.__CADET_CONFIG__={"stamped":"local"}</script></head></html>`;
    const html = buildRemoteWebIndexHtml(raw, { remote: "docker" });
    const first = html.indexOf("__CADET_CONFIG__");
    const second = html.indexOf("__CADET_CONFIG__", first + 1);
    expect(second).toBeGreaterThan(first);
    expect(html.slice(second)).toContain('"remote":"docker"');
  });

  test("escapes config JSON before embedding it in a script tag", () => {
    const html = buildRemoteWebIndexHtml("<html><head></head></html>", {
      assistantName: "</script><script>alert(1)</script>",
    });
    expect(html).not.toContain("</script><script>alert(1)</script>");
    expect(html).toContain("\\u003c/script\\u003e");
  });

  test("keeps the consolidated boot graph's modulepreload hints", () => {
    const hints = Array.from(
      { length: MAX_PRESERVED_MODULE_PRELOADS },
      (_, i) => `<link rel="modulepreload" href="/assets/${i}.js">`,
    ).join("");
    const raw = `<html><head>${hints}</head></html>`;
    expect(buildRemoteWebIndexHtml(raw, {})).toContain(
      `<link rel="modulepreload" href="/assets/0.js">`,
    );
  });

  test("strips a whole-graph preload set past the threshold, keeping entry and stylesheet", () => {
    const hints = Array.from(
      { length: MAX_PRESERVED_MODULE_PRELOADS + 1 },
      (_, i) => `<link rel="modulepreload" href="/assets/${i}.js">`,
    ).join("");
    const raw = `<html><head>${hints}<link rel="stylesheet" href="/assets/entry.css"></head></html>`;
    const html = buildRemoteWebIndexHtml(raw, {});
    expect(html).not.toContain("modulepreload");
    expect(html).toContain("/assets/entry.css");
  });
});

// ── Port discovery ───────────────────────────────────────────

describe("findAvailableServerPort", () => {
  test("skips a port a live listener already holds", async () => {
    const { createServer } = await import("node:net");
    const { once } = await import("node:events");
    const first = await findAvailableServerPort(49152, 20);
    expect(first).not.toBeNull();
    const listener = createServer();
    listener.listen(first!, "127.0.0.1");
    await once(listener, "listening");
    try {
      const second = await findAvailableServerPort(first!, 4);
      expect(second).not.toBeNull();
      expect(second!).toBeGreaterThan(first!);
    } finally {
      listener.close();
    }
  });
});

// ── The lifecycle ────────────────────────────────────────────

const SPAWNED_SERVER_PID = 4243;

/**
 * The spawned child, mocked: writes the pidfile like the real child does
 * after a successful bind, registers as alive, and answers the ps-cmdline
 * ownership probe with a command line that names the state dir.
 */
function mockServerSpawn(): void {
  spawnMock.mockImplementation(((_command: string) => {
    realFs.mkdirSync(join(getAppServerPaths().pidPath, ".."), {
      recursive: true,
    });
    realFs.writeFileSync(
      getAppServerPaths().pidPath,
      `${SPAWNED_SERVER_PID}\n`,
    );
    fakePids.set(SPAWNED_SERVER_PID, { alive: true });
    installKillMock();
    execFileSyncMock.mockImplementation(((
      _file: string,
      psArgs?: readonly string[],
    ) => {
      if (psArgs?.includes(String(SPAWNED_SERVER_PID))) {
        return `bun ${fileURLToPath(import.meta.url)} ${getAppServerPaths().dir}`;
      }
      return "";
    }) as typeof childProcess.execFileSync);
    const child = new childProcess.ChildProcess();
    Object.assign(child, { pid: SPAWNED_SERVER_PID });
    return child;
  }) as unknown as typeof childProcess.spawn);
}

/** Spawned child that exits on startup, as when the listen port is bound. */
function mockServerSpawnExitsOnStartup(): void {
  spawnMock.mockReturnValue(
    Object.assign(new childProcess.ChildProcess(), {
      pid: SPAWNED_SERVER_PID,
      exitCode: 1,
    }),
  );
}

/** Resolve the dist mock onto real fixture trees. */
function mockDistsPresent(fixture: HandlerFixture): void {
  resolveClientDistsMock.mockResolvedValue({
    webDistDir: fixture.webDistDir,
    appDistDir: fixture.appDistDir,
    builtSha: "abc1234",
  });
}

function mockDistsMissing(which: "web" | "app"): void {
  resolveClientDistsMock.mockResolvedValue({
    webDistDir: which === "web" ? null : "/tmp/unused-web",
    appDistDir: which === "app" ? null : "/tmp/unused-app",
    builtSha: "",
  });
}

/**
 * The fingerprint replica, computed against the SAME fixture dirs the
 * under-test start hashed — the dist roots are fingerprint inputs.
 */
function appConfigHash(fixture: HandlerFixture): string {
  // Field order matters: JSON.stringify is order-sensitive. The injected
  // config is identity-only — the single-origin plan strips every
  // origin-shaped field, so no cloudUrl/hubUrl rides the fingerprint.
  const base = fixture.config as Record<string, unknown>;
  const config: Record<string, unknown> = {
    remote: base.remote,
    assistantName: base.assistantName,
    assistantId: base.assistantId,
    version: base.version,
  };
  return createHash("sha256")
    .update(
      JSON.stringify({
        config,
        webDistDir: fixture.webDistDir,
        version: "1.2.3",
        appDistDir: fixture.appDistDir,
        appIndexHtml: FAKE_APP_INDEX_HTML,
        indexHtml: FAKE_WEB_INDEX_HTML,
      }),
    )
    .digest("hex");
}

function writeRunningState(opts: {
  listenPort: number;
  gatewayUrl?: string;
  remoteWebConfigHash?: string;
}): number {
  const pid = 123_460;
  mkdirSync(getAppServerPaths().dir, { recursive: true });
  writeFileSync(
    appServerStatePath(),
    JSON.stringify(
      {
        listenPort: opts.listenPort,
        ...(opts.gatewayUrl === undefined
          ? {}
          : { gatewayUrl: opts.gatewayUrl }),
        ...(opts.remoteWebConfigHash === undefined
          ? {}
          : { remoteWebConfigHash: opts.remoteWebConfigHash }),
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(getAppServerPaths().pidPath, `${pid}\n`);
  const dir = getAppServerPaths().dir;
  installKillMock();
  fakePids.set(pid, { alive: true });
  execFileSyncMock.mockReturnValue(
    `bun ${fileURLToPath(import.meta.url)} ${dir}`,
  );
  return pid;
}

describe("startAppServer", () => {
  pinProductionEnvironment();

  test("starts the server, writes the serve spec, and fingerprints the config", async () => {
    makeWorkspace();
    seedAssistant();
    const fixture = makeHandlerFixture();
    mockDistsPresent(fixture);
    mockServerSpawn();

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    if (result.status !== "started") {
      throw new Error(`expected started, got ${result.status}`);
    }
    expect(result.listenPort).toBeGreaterThanOrEqual(DEFAULT_APP_SERVER_PORT);
    expect(result.webDistDir).toBe(fixture.webDistDir);
    expect(result.builtSha).toBe("abc1234");
    expect(result.version).toBe("1.2.3");

    // The child is spawned detached, straight off this module, with the
    // state dir as the ownership argument and the log as both stdio.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls[0]! as [
      string,
      string[],
      SpawnOptions,
    ];
    expect(command).toBe(process.execPath);
    expect(args[0]!.endsWith("/lib/servers/bun.ts")).toBe(true);
    expect(args[1]).toBe(getAppServerPaths().dir);
    expect(options?.detached).toBe(true);

    // The serve spec rides the state file; the child is stateless beyond
    // it.
    const state = readAppServerState();
    expect(state).toMatchObject({
      listenPort: result.listenPort,
      gatewayUrl: "http://127.0.0.1:7830",
      remoteWebConfigHash: appConfigHash(fixture),
    });
    expect(state?.serve).toMatchObject({
      gatewayUrl: "http://127.0.0.1:7830",
      webDistDir: fixture.webDistDir,
      appDistDir: fixture.appDistDir,
    });
    expect(state?.serve?.config).toMatchObject({
      assistantId: "assistant-1",
      assistantName: "Homelab",
    });

    // Both injected documents carry the served config.
    const webIndex = readFileSync(fixture.indexHtmlPath, "utf-8");
    expect(webIndex).toContain('"remote":"local"');
    expect(webIndex).toContain('"assistantName":"Homelab"');
    const appIndex = readFileSync(fixture.appIndexHtmlPath, "utf-8");
    expect(appIndex).toContain("__CADET_CONFIG__");
    expect(appIndex).toContain('"assistantId":"assistant-1"');
  });

  test("never stamps an origin — even with a tunnel URL on record", async () => {
    makeWorkspace();
    seedAssistant();
    const fixture = makeHandlerFixture();
    mockDistsPresent(fixture);
    mockServerSpawn();
    stampTunnelRecord("https://camping.ngrok-free.dev");

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    expect(result.status).toBe("started");
    // The single-origin plan: tunnel clients reach the origin they came
    // in on, so the served config carries no base URL at all — the
    // shell reads window.location.origin.
    const appIndex = readFileSync(fixture.appIndexHtmlPath, "utf-8");
    expect(appIndex).not.toContain("cloudUrl");
    expect(appIndex).not.toContain("hubUrl");
    expect(readAppServerState()).toMatchObject({
      remoteWebConfigHash: appConfigHash(fixture),
    });
  });

  test("requires the web dist", async () => {
    makeWorkspace();
    seedAssistant();
    mockDistsMissing("web");

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    expect(result).toEqual({ status: "web-dist-missing" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("requires the app dist", async () => {
    makeWorkspace();
    seedAssistant();
    mockDistsMissing("app");

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    expect(result).toEqual({ status: "app-dist-missing" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("short-circuits when the running server already serves the requested config", async () => {
    makeWorkspace();
    seedAssistant();
    const fixture = makeHandlerFixture();
    mockDistsPresent(fixture);
    writeRunningState({
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:7830",
      remoteWebConfigHash: appConfigHash(fixture),
    });

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    expect(result).toMatchObject({
      status: "already-running",
      listenPort: 7840,
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("restarts the server when its recorded gateway upstream drifts", async () => {
    makeWorkspace();
    seedAssistant();
    const fixture = makeHandlerFixture();
    mockDistsPresent(fixture);
    const pid = writeRunningState({
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:9999",
      remoteWebConfigHash: appConfigHash(fixture),
    });
    fakePids.set(pid, { alive: true });
    installKillMock();
    mockServerSpawn();

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    expect(result.status).toBe("started");
    // The drifted server was stopped first: SIGTERM to its recorded pid.
    expect(fakePids.get(pid)?.alive).toBe(false);
    expect(readAppServerState()).toMatchObject({
      gatewayUrl: "http://127.0.0.1:7830",
    });
  });

  test("restarts the server when the injected SPA config drifts", async () => {
    makeWorkspace();
    seedAssistant("Renamed");
    const fixture = makeHandlerFixture();
    mockDistsPresent(fixture);
    const pid = writeRunningState({
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:7830",
      remoteWebConfigHash: appConfigHash(fixture),
    });
    fakePids.set(pid, { alive: true });
    installKillMock();
    mockServerSpawn();

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    expect(result.status).toBe("started");
    expect(fakePids.get(pid)?.alive).toBe(false);
  });

  test("a config-drifted server that survives the restart attempt reports it as stale", async () => {
    makeWorkspace();
    seedAssistant("Renamed");
    const fixture = makeHandlerFixture();
    mockDistsPresent(fixture);
    const pid = writeRunningState({
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:7830",
      remoteWebConfigHash: appConfigHash(fixture),
    });
    fakePids.set(pid, { alive: true, unkillable: true });
    installKillMock();

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    expect(result).toMatchObject({
      status: "already-running",
      staleRemoteWebConfig: true,
      listenPort: 7840,
    });
    expect(fakePids.get(pid)?.alive).toBe(true);
  });

  test("an unreachable child rolls back to no server", async () => {
    makeWorkspace();
    seedAssistant();
    const fixture = makeHandlerFixture();
    mockDistsPresent(fixture);
    // The child spawns but the readiness probe never answers.
    spawnMock.mockImplementation((() => {
      const child = new childProcess.ChildProcess();
      Object.assign(child, { pid: SPAWNED_SERVER_PID });
      return child;
    }) as unknown as typeof childProcess.spawn);
    waitForDaemonReadyMock.mockImplementation(async () => false);

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    expect(result.status).toBe("unreachable");
  });

  test("a child that exits despite a successful probe is a port conflict", async () => {
    makeWorkspace();
    seedAssistant();
    const fixture = makeHandlerFixture();
    mockDistsPresent(fixture);
    mockServerSpawnExitsOnStartup();

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    // A dead spawn is a port conflict even when the probe succeeded: that
    // probe reached some other process bound to the port, not this one.
    expect(result.status).toBe("port-conflict");
  });

  test("a child that outlives the probe but never owns the port is a port conflict", async () => {
    makeWorkspace();
    seedAssistant();
    const fixture = makeHandlerFixture();
    mockDistsPresent(fixture);
    // The child stays alive but never writes the pidfile (lost the bind).
    spawnMock.mockImplementation((() => {
      const child = new childProcess.ChildProcess();
      Object.assign(child, { pid: SPAWNED_SERVER_PID });
      fakePids.set(SPAWNED_SERVER_PID, { alive: true });
      installKillMock();
      // The module kills the CHILD HANDLE (not process.kill) — route that
      // into the registry so the test can observe it.
      child.kill = (() => {
        const entry = fakePids.get(SPAWNED_SERVER_PID);
        if (entry) entry.alive = false;
        return true;
      }) as typeof child.kill;
      return child;
    }) as unknown as typeof childProcess.spawn);

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    expect(result.status).toBe("port-conflict");
    // The unowned child was killed before rolling back.
    expect(fakePids.get(SPAWNED_SERVER_PID)?.alive).toBe(false);
  });
});

describe("ensureAppServer", () => {
  pinProductionEnvironment();

  function mockTargetAssistant(name = "Homelab"): void {
    resolveTargetAssistantMock.mockReturnValue({
      assistantId: "assistant-1",
      name,
      cloud: "local",
      localUrl: "http://127.0.0.1:7830",
      port: 7830,
    } as never);
  }

  test("threads the lockfile display name and assistant id into the served config", async () => {
    makeWorkspace();
    seedAssistant("Threaded Name");
    mockTargetAssistant("Threaded Name");
    const fixture = makeHandlerFixture({
      remote: "local",
      assistantName: "Threaded Name",
      assistantId: "assistant-1",
      version: "1.2.3",
    });
    mockDistsPresent(fixture);
    mockServerSpawn();

    const server = await ensureAppServer();

    expect(server.started).toBe(true);
    const appIndex = readFileSync(fixture.appIndexHtmlPath, "utf-8");
    expect(appIndex).toContain('"assistantName":"Threaded Name"');
  });

  test("reuses a running server that already serves the requested config", async () => {
    makeWorkspace();
    seedAssistant();
    mockTargetAssistant();
    const fixture = makeHandlerFixture();
    mockDistsPresent(fixture);
    writeRunningState({
      listenPort: 7841,
      gatewayUrl: "http://127.0.0.1:7830",
      remoteWebConfigHash: appConfigHash(fixture),
    });

    const server = await ensureAppServer();

    expect(server).toEqual({ port: 7841, started: false });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("a drifted server that survives the restart attempt throws", async () => {
    makeWorkspace();
    // The LOCKFILE's display name changed under the recorded fingerprint —
    // the derived config drifts, the restart is attempted, and the
    // unkillable survivor reports stale.
    seedAssistant("Renamed");
    mockTargetAssistant("Renamed");
    const fixture = makeHandlerFixture();
    mockDistsPresent(fixture);
    writeRunningState({
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:7830",
      remoteWebConfigHash: appConfigHash(fixture),
    });
    fakePids.set(123_460, { alive: true, unkillable: true });
    installKillMock();

    await expect(ensureAppServer()).rejects.toThrow(
      /still serving an outdated remote web config/,
    );
  });

  test("a gateway-drifted server that survives the restart attempt throws", async () => {
    makeWorkspace();
    seedAssistant();
    mockTargetAssistant();
    const fixture = makeHandlerFixture();
    mockDistsPresent(fixture);
    writeRunningState({
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:9999",
      remoteWebConfigHash: appConfigHash(fixture),
    });
    fakePids.set(123_460, { alive: true, unkillable: true });
    installKillMock();

    await expect(ensureAppServer()).rejects.toThrow(
      /is still proxying http:\/\/127\.0\.0\.1:9999/,
    );
  });

  test("missing web dist throws build guidance", async () => {
    makeWorkspace();
    mockTargetAssistant();
    mockDistsMissing("web");

    await expect(ensureAppServer()).rejects.toThrow(
      /Unable to locate built web assets.*VITE_CLOUD_MODE=false bun run build/s,
    );
  });

  test("an unreachable server throws with the log path", async () => {
    makeWorkspace();
    seedAssistant();
    mockTargetAssistant();
    const fixture = makeHandlerFixture();
    mockDistsPresent(fixture);
    spawnMock.mockImplementation((() => {
      const child = new childProcess.ChildProcess();
      Object.assign(child, { pid: SPAWNED_SERVER_PID });
      return child;
    }) as unknown as typeof childProcess.spawn);
    waitForDaemonReadyMock.mockImplementation(async () => false);

    await expect(ensureAppServer()).rejects.toThrow(
      /did not become reachable on 127\.0\.0\.1:\d+/,
    );
  });

  test("a port conflict throws naming the port and the log path", async () => {
    makeWorkspace();
    seedAssistant();
    mockTargetAssistant();
    const fixture = makeHandlerFixture();
    mockDistsPresent(fixture);
    mockServerSpawnExitsOnStartup();

    await expect(ensureAppServer()).rejects.toThrow(
      /exited on startup[\s\S]*app-server\.log/,
    );
  });
});

// ── The live child ───────────────────────────────────────────

describe("the live server child", () => {
  pinProductionEnvironment();

  test("binds both loopback stacks, owns the port via its pidfile, and serves", async () => {
    // The one place a socket is actually opened: the bind, the post-bind
    // pidfile, and the readiness probe are the facts under test.
    makeWorkspace();
    seedAssistant();
    const fixture = makeHandlerFixture();
    const freePort = await findAvailableServerPort(20_000, 200);
    if (freePort === null) {
      throw new Error("no free port for the live probe");
    }
    // A stub gateway so /healthz's proxy answers.
    const gateway = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response('{status:"ok"}', {
          headers: { "content-type": "application/json" },
        }),
    });
    try {
      mkdirSync(getAppServerPaths().dir, { recursive: true });
      writeFileSync(
        appServerStatePath(),
        JSON.stringify(
          {
            listenPort: freePort,
            gatewayUrl: `http://127.0.0.1:${gateway.port}`,
            serve: {
              gatewayUrl: `http://127.0.0.1:${gateway.port}`,
              webDistDir: fixture.webDistDir,
              appDistDir: fixture.appDistDir,
              indexHtmlPath: fixture.indexHtmlPath,
              appIndexHtmlPath: fixture.appIndexHtmlPath,
              config: fixture.config,
            },
          },
          null,
          2,
        ) + "\n",
      );
      const child = Bun.spawn(
        [
          process.execPath,
          fileURLToPath(new URL("../../lib/servers/bun.ts", import.meta.url)),
          getAppServerPaths().dir,
        ],
        {
          env: {
            ...process.env,
            XDG_DATA_HOME: process.env.XDG_DATA_HOME!,
            XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME!,
            CADET_WORKSPACE_DIR: process.env.CADET_WORKSPACE_DIR!,
            CADET_ENVIRONMENT: "production",
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      try {
        const deadline = Date.now() + 10_000;
        for (;;) {
          const status = await fetch(`http://127.0.0.1:${freePort}/healthz`)
            .then((r) => r.status)
            .catch(() => 0);
          if (status === 200) break;
          if (Date.now() > deadline || child.exitCode !== null) {
            throw new Error(
              `the server child never became ready (exit ${child.exitCode})`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        // Ownership: the pidfile names a live process of ours.
        const pid = parseInt(
          readFileSync(getAppServerPaths().pidPath, "utf-8").trim(),
          10,
        );
        expect(pid).toBeGreaterThan(0);
        expect(child.pid).toBe(pid);
        // The SPA document is served through the live socket.
        const doc = await fetch(`http://127.0.0.1:${freePort}/`);
        expect(doc.status).toBe(200);
        expect(await doc.text()).toContain("__CADET_CONFIG__");
        // A graceful stop.
        child.kill("SIGTERM");
        await child.exited;
        expect(child.exitCode).toBe(0);
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    } finally {
      gateway.stop(true);
    }
  }, 30_000);
});
