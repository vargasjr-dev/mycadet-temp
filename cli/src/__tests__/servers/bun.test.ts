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
  mock.module("../../lib/web-dist.js", () => realWebDist);
});

import { createAppServerHandler } from "../../lib/servers/bun.js";
import {
  DEFAULT_APP_SERVER_PORT,
  appServerStatePath,
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
  // The server reads the lockfile (now at REQUEST time, per served document)
  // and keeps its own state under the XDG data dir — pin both config and
  // data homes so every test is hermetic.
  process.env.CADET_WORKSPACE_DIR = dir;
  process.env.XDG_CONFIG_HOME = dir;
  process.env.XDG_DATA_HOME = dir;
  return dir;
}

/** Seed the one assistant entry the served config resolves from the lockfile. */
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
}

/**
 * Real dist trees in a tmpdir plus the two documents the start path writes —
 * the STRIPPED dist indexes, NOT config-injected: the config is injected at
 * request time (from the lockfile) and only for the web bundle.
 */
function makeHandlerFixture(): HandlerFixture {
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
  writeFileSync(indexHtmlPath, FAKE_WEB_INDEX_HTML);
  writeFileSync(appIndexHtmlPath, FAKE_APP_INDEX_HTML);
  return {
    webDistDir,
    appDistDir,
    indexHtmlPath,
    appIndexHtmlPath,
  };
}

const EDGE_PEER_IP = "198.51.100.7";

/**
 * The handler under test, with the edge's peer address pinned: the handler
 * reads the peer off the server handle's `requestIP`, so direct handler
 * tests pass a stub handle (the live child passes Bun's real server).
 */
function handlerFor(fixture: HandlerFixture) {
  const handler = createAppServerHandler(fixture);
  const server = {
    requestIP: () => ({ address: EDGE_PEER_IP }),
  } as unknown as Parameters<ReturnType<typeof createAppServerHandler>>[1];
  return (request: Request) => handler(request, server);
}

/**
 * Capture proxied upstream requests. The edge no longer proxies /v1 — the
 * remaining stubs exist to prove it: a request that must not reach a
 * gateway records zero calls.
 */
function stubGatewayFetch(): { calls: Array<{ url: string }> } {
  const calls: Array<{ url: string }> = [];
  globalThis.fetch = mock(async (input: unknown, init?: unknown) => {
    const request =
      input instanceof Request
        ? input
        : new Request(input as string, init as RequestInit | undefined);
    calls.push({ url: request.url });
    return new Response("gateway says hi");
  }) as unknown as typeof fetch;
  return { calls };
}

async function readBody(response: Response): Promise<string> {
  return await response.text();
}

// ── The routes ───────────────────────────────────────────────

describe("the app server's routes", () => {
  pinProductionEnvironment();

  test("blocks the sensitive gateway routes in both spellings at both prefixes", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    for (const route of ["/v1/pair", "/pair", "/v1/devices", "/devices"]) {
      for (const path of [
        route,
        `${route}/`,
        `/web${route}`,
        `/web${route}/`,
      ]) {
        const response = await handler(
          new Request(`http://127.0.0.1:7840${path}`),
        );
        expect(response.status).toBe(404);
      }
    }
  });

  test("blocks the invite redemption and remote-web pairing helpers too", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    for (const path of [
      "/v1/shared/invites/redeem",
      "/v1/remote-web/pairing-requests/approve",
      "/web/v1/shared/invites/redeem",
      "/web/v1/remote-web/pairing-verification",
    ]) {
      const response = await handler(
        new Request(`http://127.0.0.1:7840${path}`),
      );
      expect(response.status).toBe(404);
    }
  });

  test("the sensitive routes 404 before any dispatch could see them", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    // /v1/pair is a real route at the gateway; the edge answers 404 before
    // any dispatch could ever see it.
    const response = await handler(
      new Request("http://127.0.0.1:7840/v1/pair", { method: "POST" }),
    );
    expect(response.status).toBe(404);
  });

  test("the gateway's versioned API surface is no longer the edge's business", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    const gateway = stubGatewayFetch();
    const response = await handler(
      new Request("http://127.0.0.1:7840/v1/conversations?limit=5"),
    );
    expect(response.status).toBe(404);
    expect(gateway.calls).toHaveLength(0);
  });

  test("answers its own liveness locally and leaves the gateway-only surfaces alone", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    const gateway = stubGatewayFetch();
    // The app server answers its own liveness locally — no gateway probe
    // behind it at all.
    const health = await handler(new Request("http://127.0.0.1:7840/healthz"));
    expect(await health.json()).toEqual({ ok: true });
    // Readiness and webhook callbacks are the gateway's own ports to answer;
    // the edge no longer fronts them.
    const ready = await handler(new Request("http://127.0.0.1:7840/readyz"));
    expect(ready.status).toBe(404);
    const webhook = await handler(
      new Request("http://127.0.0.1:7840/webhooks/telegram", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(webhook.status).toBe(404);
    expect(gateway.calls).toHaveLength(0);
  });

  test("the /web twin's non-assistant remainder 404s — no /v1 translation", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    const gateway = stubGatewayFetch();
    const plain = await handler(
      new Request("http://127.0.0.1:7840/web/channels"),
    );
    expect(plain.status).toBe(404);
    const versioned = await handler(
      new Request("http://127.0.0.1:7840/web/v1/channels"),
    );
    expect(versioned.status).toBe(404);
    expect(gateway.calls).toHaveLength(0);
  });

  test("unversioned, non-assistant paths have no catch-all to hide behind", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    const gateway = stubGatewayFetch();
    const response = await handler(
      new Request("http://127.0.0.1:7840/channels"),
    );
    expect(response.status).toBe(404);
    expect(gateway.calls).toHaveLength(0);
  });

  test("serves the app shell as the outer shell from the origin root", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    const response = await handler(new Request("http://127.0.0.1:7840/"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    // The shell document is the app dist's own index, UNINJECTED — the
    // config is a web-bundle affordance now (the shell reads its origin).
    expect(await readBody(response)).toBe(FAKE_APP_INDEX_HTML);
  });

  test("the shell's SPA routes fall back to the shell document", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    for (const path of ["/account", "/account/keys", "/logout"]) {
      const response = await handler(
        new Request(`http://127.0.0.1:7840${path}`),
      );
      expect(response.status).toBe(200);
      expect(await readBody(response)).toBe(FAKE_APP_INDEX_HTML);
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
    expect(await readBody(missing)).toBe(FAKE_APP_INDEX_HTML);
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

  test("the injected documents answer only where their namespace serves them", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    // The app index has no namespace of its own to hit directly.
    const appIndex = await handler(
      new Request("http://127.0.0.1:7840/__cadet-app-index.html"),
    );
    expect(appIndex.status).toBe(404);
    // A direct hit on a made-up name inside the /web/assistant mount falls
    // through to the mount's SPA fallback — the web dist's own document,
    // still uninjected (only the mount's exact paths get the config).
    const remoteIndex = await handler(
      new Request("http://127.0.0.1:7840/web/assistant/__remote-index.html"),
    );
    expect(remoteIndex.status).toBe(200);
    expect(await readBody(remoteIndex)).toBe(FAKE_WEB_INDEX_HTML);
  });

  test("iframes the web UI from the distinct /web/assistant namespace", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);

    const noSlash = await handler(
      new Request("http://127.0.0.1:7840/web/assistant"),
    );
    // The no-slash spelling serves the injected document directly (the
    // config injection is the mount's whole job; there is no redirect).
    expect(noSlash.status).toBe(200);
    expect(await readBody(noSlash)).toContain("__CADET_CONFIG__");

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

  test("serves remote web config inline with no-store, read from the LIVE lockfile", async () => {
    makeWorkspace();
    seedAssistant();
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);

    const response = await handler(
      new Request("http://127.0.0.1:7840/web/assistant/__config"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(await readBody(response))).toMatchObject({
      assistantId: "assistant-1",
      assistantName: "Homelab",
      remote: "local",
    });

    // The config is read from the lockfile per request — renaming or
    // re-pointing the assistant reaches the served document with no
    // restart.
    seedAssistant("Renamed");
    const reread = await handler(
      new Request("http://127.0.0.1:7840/web/assistant/__config"),
    );
    expect(JSON.parse(await readBody(reread))).toMatchObject({
      assistantId: "assistant-1",
      assistantName: "Renamed",
    });
  });

  test("the iframe mount's config injection rides the served document", async () => {
    makeWorkspace();
    seedAssistant();
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);
    const index = await handler(
      new Request("http://127.0.0.1:7840/web/assistant/"),
    );
    const body = await readBody(index);
    expect(body).toContain("__CADET_CONFIG__");
    expect(body).toContain('"assistantId":"assistant-1"');
    expect(body).toContain("web-shell");
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
    expect(await readBody(fallback)).toBe(FAKE_WEB_INDEX_HTML);
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
    const webFile = join(fixture.webDistDir, "channels.js");
    writeFileSync(webFile, "console.log('web root file');");
    const rootFile = await handler(
      new Request("http://127.0.0.1:7840/assistant/channels.js"),
    );
    expect(rootFile.status).toBe(200);
    expect(await readBody(rootFile)).toBe("console.log('web root file');");

    // ...and a miss falls back to the shell document.
    const miss = await handler(
      new Request("http://127.0.0.1:7840/assistant/nothing-here"),
    );
    expect(miss.status).toBe(200);
    expect(await readBody(miss)).toBe(FAKE_APP_INDEX_HTML);
  });

  test("compresses the static documents", async () => {
    const fixture = makeHandlerFixture();
    const handler = handlerFor(fixture);

    const compressed = await handler(
      new Request("http://127.0.0.1:7840/", {
        headers: { "accept-encoding": "gzip, deflate, br" },
      }),
    );
    expect(compressed.headers.get("content-encoding")).toBe("gzip");
    const bytes = new Uint8Array(await compressed.arrayBuffer());
    expect(new TextDecoder().decode(gunzipSync(bytes))).toContain("app-shell");

    // The proxied responses this edge no longer produces are the operator
    // row's business — local-mode's operations-proxy tests pin that the
    // proxied stream is passed through un-recompressed.
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

  test("websocket upgrades relay through the server handle", async () => {
    makeWorkspace();
    const fixture = makeHandlerFixture();
    const upgraded: Array<{ data: unknown }> = [];
    const handler = createAppServerHandler(fixture);
    // A stub server handle: the live child passes Bun's real Server.
    const server = {
      requestIP: () => ({ address: EDGE_PEER_IP }),
      upgrade: (request: Request, options?: { data: unknown }) => {
        expect(request.headers.get("upgrade")).toBe("websocket");
        upgraded.push({ data: options?.data });
        return true;
      },
    };
    const upgradeRequest = () =>
      new Request("http://127.0.0.1:7840/v1/channels/ws", {
        headers: {
          upgrade: "websocket",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version": "13",
        },
      });
    // No lockfile entry, no upstream to relay to.
    const orphan = await handler(upgradeRequest(), server);
    expect(orphan.status).toBe(502);
    expect(upgraded).toHaveLength(0);
    // The seeded entry resolves the relay target (the assistant's gateway);
    // the upstream connect happens at the socket level, not through fetch —
    // a client WebSocket to a closed port fails async; the upgrade decision
    // itself is what this pins.
    seedAssistant();
    const response = await handler(upgradeRequest(), server);
    // The socket is hijacked; the handler's response body is never used.
    expect(upgraded).toHaveLength(1);
    const data = upgraded[0]!.data as { upstream: WebSocket; queue: unknown[] };
    expect(data.upstream).toBeInstanceOf(WebSocket);
    expect(data.queue).toEqual([]);
    expect(response).toBeDefined();
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
  return createHash("sha256")
    .update(
      JSON.stringify({
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
  remoteWebConfigHash?: string;
}): number {
  const pid = 123_460;
  mkdirSync(getAppServerPaths().dir, { recursive: true });
  writeFileSync(
    appServerStatePath(),
    JSON.stringify(
      {
        listenPort: opts.listenPort,
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

  test("starts the server, writes the serve spec, and fingerprints the dists", async () => {
    makeWorkspace();
    seedAssistant();
    const fixture = makeHandlerFixture();
    mockDistsPresent(fixture);
    mockServerSpawn();

    const result = await startAppServer();

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
    // it. No config in the spec and none in the documents — the config is
    // read from the lockfile per request, and only the web bundle gets it.
    const state = readAppServerState();
    expect(state).toMatchObject({
      listenPort: result.listenPort,
      remoteWebConfigHash: appConfigHash(fixture),
    });
    expect(state?.serve).toMatchObject({
      webDistDir: fixture.webDistDir,
      appDistDir: fixture.appDistDir,
    });
    expect(state?.serve).not.toHaveProperty("config");
    expect(readFileSync(fixture.indexHtmlPath, "utf-8")).toBe(
      FAKE_WEB_INDEX_HTML,
    );
    expect(readFileSync(fixture.appIndexHtmlPath, "utf-8")).toBe(
      FAKE_APP_INDEX_HTML,
    );
  });

  test("never stamps an origin — even with a tunnel URL on record", async () => {
    makeWorkspace();
    seedAssistant();
    const fixture = makeHandlerFixture();
    mockDistsPresent(fixture);
    mockServerSpawn();
    stampTunnelRecordForTest("https://camping.ngrok-free.dev");

    const result = await startAppServer();

    expect(result.status).toBe("started");
    // The single-origin plan: tunnel clients reach the origin they came
    // in on, so nothing the server writes carries a base URL at all.
    const appIndex = readFileSync(fixture.appIndexHtmlPath, "utf-8");
    expect(appIndex).not.toContain("cloudUrl");
    expect(appIndex).not.toContain("hubUrl");
  });

  test("requires the web dist", async () => {
    makeWorkspace();
    seedAssistant();
    mockDistsMissing("web");

    const result = await startAppServer();

    expect(result).toEqual({ status: "web-dist-missing" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("requires the app dist", async () => {
    makeWorkspace();
    seedAssistant();
    mockDistsMissing("app");

    const result = await startAppServer();

    expect(result).toEqual({ status: "app-dist-missing" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("short-circuits when the running server already serves the built dists", async () => {
    makeWorkspace();
    seedAssistant();
    const fixture = makeHandlerFixture();
    mockDistsPresent(fixture);
    writeRunningState({
      listenPort: 7840,
      remoteWebConfigHash: appConfigHash(fixture),
    });

    const result = await startAppServer();

    expect(result).toMatchObject({
      status: "already-running",
      listenPort: 7840,
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("restarts the server when the built dists drift", async () => {
    makeWorkspace();
    seedAssistant();
    const fixture = makeHandlerFixture();
    mockDistsPresent(fixture);
    const pid = writeRunningState({
      listenPort: 7840,
      remoteWebConfigHash: "drifted-fingerprint",
    });
    fakePids.set(pid, { alive: true });
    installKillMock();
    mockServerSpawn();

    const result = await startAppServer();

    expect(result.status).toBe("started");
    // The drifted server was stopped first: SIGTERM to its recorded pid.
    expect(fakePids.get(pid)?.alive).toBe(false);
    expect(readAppServerState()).toMatchObject({
      remoteWebConfigHash: appConfigHash(fixture),
    });
  });

  test("a drifted server that survives the restart attempt is reported as already-running", async () => {
    makeWorkspace();
    seedAssistant();
    const fixture = makeHandlerFixture();
    mockDistsPresent(fixture);
    const pid = writeRunningState({
      listenPort: 7840,
      remoteWebConfigHash: "drifted-fingerprint",
    });
    fakePids.set(pid, { alive: true, unkillable: true });
    installKillMock();

    const result = await startAppServer();

    expect(result).toMatchObject({
      status: "already-running",
      listenPort: 7840,
    });
    expect(spawnMock).not.toHaveBeenCalled();
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

    const result = await startAppServer();

    expect(result.status).toBe("unreachable");
  });

  test("a child that exits despite a successful probe is a port conflict", async () => {
    makeWorkspace();
    seedAssistant();
    const fixture = makeHandlerFixture();
    mockDistsPresent(fixture);
    mockServerSpawnExitsOnStartup();

    const result = await startAppServer();

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

    const result = await startAppServer();

    expect(result.status).toBe("port-conflict");
    // The unowned child was killed before rolling back.
    expect(fakePids.get(SPAWNED_SERVER_PID)?.alive).toBe(false);
  });
});

/** Stamp the lockfile's tunnel record with a published URL. */
function stampTunnelRecordForTest(url: string): void {
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

describe("ensureAppServer", () => {
  pinProductionEnvironment();

  test("reuses a running server that already serves the built dists", async () => {
    makeWorkspace();
    const fixture = makeHandlerFixture();
    mockDistsPresent(fixture);
    writeRunningState({
      listenPort: 7841,
      remoteWebConfigHash: appConfigHash(fixture),
    });

    const server = await ensureAppServer();

    expect(server).toEqual({ port: 7841, started: false });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("missing web dist throws build guidance", async () => {
    makeWorkspace();
    mockDistsMissing("web");

    await expect(ensureAppServer()).rejects.toThrow(
      /Unable to locate built web assets.*VITE_CLOUD_MODE=false bun run build/s,
    );
  });

  test("an unreachable server throws with the log path", async () => {
    makeWorkspace();
    seedAssistant();
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

  test("binds loopback, owns the port via its pidfile, and serves", async () => {
    // The one place a socket is actually opened: the bind, the post-bind
    // pidfile, and the readiness probe are the facts under test.
    makeWorkspace();
    seedAssistant();
    const fixture = makeHandlerFixture();
    const freePort = await findAvailableServerPort(20_000, 200);
    if (freePort === null) {
      throw new Error("no free port for the live probe");
    }
    mkdirSync(getAppServerPaths().dir, { recursive: true });
    writeFileSync(
      appServerStatePath(),
      JSON.stringify(
        {
          listenPort: freePort,
          serve: {
            webDistDir: fixture.webDistDir,
            appDistDir: fixture.appDistDir,
            indexHtmlPath: fixture.indexHtmlPath,
            appIndexHtmlPath: fixture.appIndexHtmlPath,
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
      // The shell document is served plain through the live socket...
      const doc = await fetch(`http://127.0.0.1:${freePort}/`);
      expect(doc.status).toBe(200);
      expect(await doc.text()).toBe(FAKE_APP_INDEX_HTML);
      // ...while the web mount's config is injected AT REQUEST TIME from
      // the lockfile.
      const mount = await fetch(`http://127.0.0.1:${freePort}/web/assistant/`);
      expect(mount.status).toBe(200);
      const mountBody = await mount.text();
      expect(mountBody).toContain("__CADET_CONFIG__");
      expect(mountBody).toContain('"assistantId":"assistant-1"');
      // A graceful stop.
      child.kill("SIGTERM");
      await child.exited;
      expect(child.exitCode).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }, 30_000);
});
