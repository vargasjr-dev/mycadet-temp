import * as childProcess from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import * as fsModule from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import * as httpClient from "../lib/http-client.js";
import * as versionModule from "@mycadet/shared/version";
import * as assistantConfigModule from "../lib/assistant-config.js";
import type { LockfileAssistant } from "../lib/assistant-config.js";

const realChildProcess = { ...childProcess };
const realFs = { ...fsModule };
const realHttpClient = { ...httpClient };
const realVersionModule = { ...versionModule };

const execFileSyncMock = mock(childProcess.execFileSync);
const spawnSyncMock = mock(childProcess.spawnSync);
const spawnMock = mock(childProcess.spawn);

/**
 * A git rev-parse that fails like a git-less tree: the built-sha stamp's
 * staleness probe stays inert and the per-test nginx fakes never see a git
 * spawn.
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
  spawnSync: spawnSyncMock,
  spawn: ((command: string, args: readonly string[], options?: SpawnOptions) =>
    command === "git"
      ? gitStubSpawn()
      : spawnMock(command, args, options ?? {})) as typeof childProcess.spawn,
}));

const existsSyncMock = mock(fsModule.existsSync);
const readFileSyncMock = mock(fsModule.readFileSync);

mock.module("node:fs", () => ({
  ...fsModule,
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
}));

const waitForDaemonReadyMock = mock<typeof httpClient.waitForDaemonReady>(
  async () => true,
);

mock.module("../lib/http-client.js", () => ({
  ...httpClient,
  waitForDaemonReady: waitForDaemonReadyMock,
}));

// The edge stamps the CLI's own stampedVersion as the served version — a
// fixed value here keeps the fingerprint replicas below exact.
const stampedVersionMock = mock(() => "1.2.3");

mock.module("@mycadet/shared/version", () => ({
  resolveVersion: stampedVersionMock,
}));

// The edge resolves the assistant it fronts itself (see ensureAppServer), so
// the resolution seam is mocked per test while the rest of assistant-config
// (name lookups, process records) stays real.
const realAssistantConfig = { ...assistantConfigModule };
const resolveTargetAssistantMock = mock(
  assistantConfigModule.resolveTargetAssistant,
);

mock.module("../lib/assistant-config.js", () => ({
  ...realAssistantConfig,
  resolveTargetAssistant: resolveTargetAssistantMock,
}));

// Restore the real modules once this file finishes so the mocks do not leak
// into sibling test files in the same `bun test` run.
afterAll(() => {
  mock.module("node:child_process", () => realChildProcess);
  mock.module("node:fs", () => realFs);
  mock.module("../lib/http-client.js", () => realHttpClient);
  mock.module("@mycadet/shared/version", () => realVersionModule);
  mock.module("../lib/assistant-config.js", () => realAssistantConfig);
});

import {
  buildNginxConfig,
  getIngressPaths,
  hasIpv6Loopback,
  buildRemoteWebIndexHtml,
  MAX_PRESERVED_MODULE_PRELOADS,
  ensureAppServer,
  readIngressState,
  startAppServer,
  stopContainerAppServer,
  stopIngressNginx,
} from "../lib/servers/nginx.js";
import { findAppDistDir, findWebDistDir } from "../lib/web-dist.js";

const originalKill = process.kill;
const workspaces: string[] = [];
const originalWorkspaceDir = process.env.CADET_WORKSPACE_DIR;
const originalDataHome = process.env.XDG_DATA_HOME;

/**
 * Registry-backed process.kill mock: registered fake PIDs answer liveness
 * probes and record kills, everything else forwards to the real kill. Lets
 * helpers compose (old-edge PID and freshly-spawned master PID at once).
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
  execFileSyncMock.mockReset();
  spawnSyncMock.mockReset();
  spawnSyncMock.mockImplementation(realChildProcess.spawnSync);
  spawnMock.mockReset();
  spawnMock.mockImplementation(realChildProcess.spawn);
  existsSyncMock.mockReset();
  existsSyncMock.mockImplementation(realFs.existsSync);
  readFileSyncMock.mockReset();
  readFileSyncMock.mockImplementation(realFs.readFileSync);
  stampedVersionMock.mockReset();
  stampedVersionMock.mockImplementation(() => "1.2.3");
  waitForDaemonReadyMock.mockReset();
  waitForDaemonReadyMock.mockImplementation(async () => true);
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

const originalConfigHome = process.env.XDG_CONFIG_HOME;

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "cadet-ingress-test-"));
  workspaces.push(dir);
  // The edge reads the lockfile's tunnel record and keeps its own state
  // under the XDG data dir — pin both config and data homes so every test
  // is hermetic.
  process.env.CADET_WORKSPACE_DIR = dir;
  process.env.XDG_CONFIG_HOME = dir;
  process.env.XDG_DATA_HOME = dir;
  return dir;
}

/** Seed the one assistant entry the edge's strict lookup fronts. */
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
  // Resolve exactly as the edge's own read will.
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

describe("buildNginxConfig", () => {
  const conf = buildNginxConfig({
    gatewayUrl: "http://127.0.0.1:7830",
    listenPort: 7840,
  });
  const remoteConf = buildNginxConfig({
    gatewayUrl: "http://127.0.0.1:7830",
    listenPort: 7840,

    webDistDir: "/tmp/cadet web/dist",
    appDistDir: "/tmp/cadet app/dist/standalone",
    config: {
      remote: "custom",
      assistantId: "assistant-1",
      version: "1.2.3",
    },
  });

  test("listens on loopback only", () => {
    expect(conf).toContain("listen 127.0.0.1:7840;");
    const listens = conf.match(/listen [^;]+;/g) ?? [];
    expect(listens.length).toBeGreaterThan(0);
    for (const directive of listens) {
      expect(directive).toMatch(/127\.0\.0\.1|\[::1\]/);
    }
  });

  test("adds the IPv6 loopback listener only where ::1 exists", () => {
    // A tunnel agent pointed at "localhost" reaches ::1 first on macOS, so an
    // IPv4-only bind refuses whichever share of a burst resolves that way.
    // Emitting it unconditionally would make nginx exit on an IPv6-less host.
    const withIpv6 = buildNginxConfig({
      gatewayUrl: "http://127.0.0.1:7830",
      listenPort: 7840,
      ipv6Loopback: true,
    });
    expect(withIpv6).toContain("listen 127.0.0.1:7840;");
    expect(withIpv6).toContain("listen [::1]:7840;");

    expect(conf).not.toContain("[::1]");
  });

  test("emits relative redirects so a fronting proxy keeps scheme and port", () => {
    for (const config of [conf, remoteConf]) {
      expect(config).toContain("absolute_redirect off;");
      expect(config).toContain("port_in_redirect off;");
    }
  });

  test("proxies requests to the gateway", () => {
    expect(conf).toContain("location / {");
    expect(conf).toContain("proxy_pass http://127.0.0.1:7830;");
    expect(conf).toContain('proxy_set_header X-Cadet-Edge-Forwarded "1";');
    expect(conf).toContain(
      "proxy_set_header X-Cadet-Client-Ip $cadet_edge_client_ip;",
    );
  });

  test("stamps the edge-observed client ip from the rightmost X-Forwarded-For entry", () => {
    for (const config of [conf, remoteConf]) {
      // Falls back to the raw peer when the TLS-terminating front sets no
      // X-Forwarded-For; the client cannot smuggle a value because
      // proxy_set_header overwrites inbound headers.
      expect(config).toContain(
        "map $http_x_forwarded_for $cadet_edge_client_ip {",
      );
      expect(config).toContain("default $remote_addr;");
      expect(config).toContain(
        '"~,?\\s*(?<cadet_last_xff>[^,\\s]+)\\s*$" $cadet_last_xff;',
      );
      expect(config).toContain(
        "proxy_set_header X-Cadet-Client-Ip $cadet_edge_client_ip;",
      );
    }
  });

  test("allowlists the Capacitor shells' own webview origins", () => {
    // The mobile shells fetch from `capacitor://localhost` (iOS) and
    // `https://localhost` (Android) — origins no web page can forge, so the
    // edge answers them without per-deployment config. nginx omits an
    // add_header whose value is empty, so an unmapped origin would strip
    // Access-Control-Allow-Origin from the assistant-metadata responses and
    // Safari would block the 200 it got.
    for (const origin of [
      "capacitor://localhost",
      "https://localhost",
      "http://localhost",
    ]) {
      expect(remoteConf).toContain(`${origin}" "${origin}";`);
    }
  });

  test("blocks local-only bootstrap helpers before the catch-all proxy", () => {
    const catchAll = conf.indexOf("location / {");
    expect(catchAll).toBeGreaterThan(-1);
    const deniedLocations = [
      "location = /auth/token { return 404; }",
      "location = /v1/pair { return 404; }",
      "location = /v1/guardian/init { return 404; }",
      "location = /v1/remote-web/pairing-verification { return 404; }",
    ];
    for (const location of deniedLocations) {
      expect(conf).toContain(location);
      expect(conf.indexOf(location)).toBeLessThan(catchAll);
    }
  });

  test("declares static MIME types needed by the SPA", () => {
    expect(remoteConf).toContain("default_type application/octet-stream;");
    expect(remoteConf).toContain("types {");
    expect(remoteConf).toContain("application/javascript js mjs;");
    expect(remoteConf).toContain("text/css css;");
    expect(remoteConf).toContain("text/html html htm;");
    expect(remoteConf).toContain("font/woff2 woff2;");
    expect(remoteConf).toContain("image/svg+xml svg svgz;");
  });

  test("compresses text asset types", () => {
    expect(remoteConf).toContain(
      "gzip_types application/javascript application/json application/wasm image/svg+xml text/css text/plain;",
    );
  });

  test("compresses only the static SPA surface, never a proxied response", () => {
    // Compression is opt-in per location: this server also proxies
    // authenticated /v1 and /webhooks traffic, and a compressed response
    // carrying both a secret and attacker-influenced content over TLS is the
    // BREACH side channel. The tuning at http scope stays inert.
    expect(remoteConf).not.toMatch(/^ {2}gzip on;$/m);
    const blocks = locationBlocks(remoteConf);
    expect(
      blocks
        .filter((b) => b.body.includes("gzip on;"))
        .map((b) => b.matcher)
        .sort(),
    ).toEqual([
      "/",
      "= /__cadet-app-index.html",
      "= /web/assistant/__remote-index.html",
      "^~ /assets/",
      "^~ /assistant/",
      "^~ /assistant/assets/",
      "^~ /web/assistant/",
    ]);
    expect(
      blocks
        .filter(
          (b) => b.body.includes("proxy_pass") && b.body.includes("gzip on;"),
        )
        .map((b) => b.matcher),
    ).toEqual([]);
  });

  test("revalidates the shell and forbids storing inline config", () => {
    const blocks = locationBlocks(remoteConf);
    const cacheControlOf = (matcher: string) =>
      blocks
        .find((b) => b.matcher === matcher)
        ?.body.match(/add_header Cache-Control "([^"]+)"/)?.[1];
    expect(cacheControlOf("= /web/assistant/__remote-index.html")).toBe(
      "no-cache",
    );
    expect(cacheControlOf("^~ /web/assistant/")).toBe("no-cache");
    expect(cacheControlOf("^~ /assistant/assets/")).toBe(
      "public, max-age=31536000, immutable",
    );
    // The app shell's own document revalidates too; its hashed assets don't.
    expect(cacheControlOf("= /__cadet-app-index.html")).toBe("no-cache");
    expect(cacheControlOf("^~ /assets/")).toBe(
      "public, max-age=31536000, immutable",
    );
    // Inline config has no validator and must not be stored.
    expect(cacheControlOf("= /web/assistant/__config")).toBe("no-store");
  });

  test("serves remote web config for the SPA", () => {
    expect(remoteConf).toContain("location = /web/assistant/__config {");
    expect(remoteConf).toContain("default_type application/json;");
    expect(remoteConf).toContain('add_header Cache-Control "no-store";');
    // The edge stamps the web bundle's InjectedConfig shape: the remote
    // kind resolves from the lockfile ("custom" when no entry claims it),
    // and the identity fields ride along verbatim.
    expect(remoteConf).toContain(
      'return 200 "{\\"remote\\":\\"custom\\",\\"assistantId\\":\\"assistant-1\\",\\"version\\":\\"1.2.3\\"}";',
    );
  });

  test("stamps assistantName, assistantId and hubUrl into the served config when provided", () => {
    const named = buildNginxConfig({
      gatewayUrl: "http://127.0.0.1:7830",
      listenPort: 7840,

      webDistDir: "/tmp/cadet web/dist",
      appDistDir: "/tmp/cadet app/dist/standalone",
      config: {
        remote: "custom",
        assistantName: "Homelab",
        assistantId: "assistant-1",
        hubUrl: "https://mycadet.ai/assistant",
        version: "1.2.3",
      },
    });
    expect(named).toContain(
      'return 200 "{\\"remote\\":\\"custom\\",\\"assistantName\\":\\"Homelab\\",\\"assistantId\\":\\"assistant-1\\",\\"hubUrl\\":\\"https://mycadet.ai/assistant\\",\\"version\\":\\"1.2.3\\"}";',
    );
  });

  test("proxies health and public API traffic to the gateway in remote web mode", () => {
    expect(remoteConf).toContain("location = /healthz {");
    expect(remoteConf).toContain("location = /readyz {");
    expect(remoteConf).toContain("location ^~ /v1/ {");
    expect(remoteConf).toContain("proxy_pass http://127.0.0.1:7830;");
    expect(remoteConf).toContain("proxy_request_buffering off;");
    expect(remoteConf).toContain("proxy_buffering off;");
    expect(remoteConf).toContain(
      'proxy_set_header X-Cadet-Edge-Forwarded "1";',
    );
  });

  test("proxies webhook callbacks to the gateway in remote web mode", () => {
    const webhooksStart = remoteConf.indexOf("location ^~ /webhooks/ {");
    expect(webhooksStart).toBeGreaterThan(-1);
    const webhooksBlock = remoteConf.slice(
      webhooksStart,
      remoteConf.indexOf("}", webhooksStart),
    );
    expect(webhooksBlock).toContain("proxy_pass http://127.0.0.1:7830;");
    expect(webhooksBlock).toContain("proxy_set_header Upgrade $http_upgrade;");
  });

  test("proxies /healthz in both modes", () => {
    expect(remoteConf).toContain("location = /healthz {");
    // The plain-proxy mode has no /healthz denylist entry, so the catch-all
    // proxy serves it.
    expect(conf).not.toContain("/healthz { return 404; }");
    expect(conf).toContain("location / {");
    expect(conf).toContain("proxy_pass http://127.0.0.1:7830;");
  });

  test("proxies /readyz in remote web mode so pairing does not look expired", () => {
    expect(remoteConf).toContain("location = /readyz {");
    const readyzStart = remoteConf.indexOf("location = /readyz {");
    const readyzBlock = remoteConf.slice(
      readyzStart,
      remoteConf.indexOf("location ^~ /v1/", readyzStart),
    );
    expect(readyzBlock).toContain("proxy_pass http://127.0.0.1:7830;");
    // Catch-all 404 must come after the exact /readyz location.
    expect(remoteConf.indexOf("location = /readyz {")).toBeLessThan(
      remoteConf.lastIndexOf("location / {"),
    );
  });

  test("blocks local-only bootstrap helpers before generic API proxying", () => {
    const deniedLocations = [
      "location = /auth/token { return 404; }",
      "location = /auth/token/ { return 404; }",
      "location = /v1/pair { return 404; }",
      "location = /v1/pair/ { return 404; }",
      "location = /v1/pair/web-init { return 404; }",
      "location = /v1/pair/web-init/ { return 404; }",
      "location = /v1/devices { return 404; }",
      "location = /v1/devices/ { return 404; }",
      "location = /v1/devices/revoke { return 404; }",
      "location = /v1/devices/revoke/ { return 404; }",
      "location = /v1/guardian/init { return 404; }",
      "location = /v1/guardian/init/ { return 404; }",
      "location = /v1/guardian/reset-bootstrap { return 404; }",
      "location = /v1/guardian/reset-bootstrap/ { return 404; }",
      "location = /v1/remote-web/pairing-requests { return 404; }",
      "location = /v1/remote-web/pairing-requests/ { return 404; }",
      "location = /v1/remote-web/pairing-requests/approve { return 404; }",
      "location = /v1/remote-web/pairing-requests/approve/ { return 404; }",
      "location = /v1/remote-web/pairing-requests/deny { return 404; }",
      "location = /v1/remote-web/pairing-requests/deny/ { return 404; }",
    ];
    for (const location of deniedLocations) {
      expect(remoteConf).toContain(location);
      expect(remoteConf.indexOf(location)).toBeLessThan(
        remoteConf.indexOf("location ^~ /v1/ {"),
      );
    }
  });

  test("supports websockets and SSE streaming", () => {
    expect(conf).toContain("map $http_upgrade $connection_upgrade");
    expect(conf).toContain("proxy_http_version 1.1;");
    expect(conf).toContain("proxy_set_header Upgrade $http_upgrade;");
    expect(conf).toContain("proxy_set_header Connection $connection_upgrade;");
    expect(conf).toContain("proxy_request_buffering off;");
    expect(conf).toContain("proxy_buffering off;");
    expect(conf).toContain("proxy_read_timeout 1h;");
  });

  test("the app-mode edge forwards every unversioned path to the gateway", () => {
    // No route enumeration lives at the edge: the forward matches any path
    // the edge does not serve itself, and the gateway's router resolves the
    // optional /v1 prefix (P7).
    const rootLocation = remoteConf
      .split("location ~ ^/(?!")[1]
      ?.split("    }")[0];
    expect(rootLocation).toBeDefined();
    expect(rootLocation).toContain("proxy_pass http://127.0.0.1:7830;");
    expect(rootLocation).not.toContain("rewrite");
    // The lookahead spares only the edge's own surface — the shell's routes
    // and the root files it ships.
    for (const owned of [
      "account(?:/|$)",
      "logout(?:/|$)",
      "index\\.html$",
      "favicon\\.svg$",
      "cadet-logo-white\\.svg$",
      "cadet-scene-cut\\.mp4$",
    ]) {
      expect(rootLocation).toContain(owned);
    }
    // Never gateway API vocabulary: a new gateway route needs no edge edit.
    for (const segment of [
      "admin",
      "assistants",
      "channels",
      "contacts",
      "oauth",
      "integrations",
    ]) {
      expect(rootLocation).not.toContain(segment);
    }
  });

  test("the iframe twin forwards the /web namespace's remainder to the /v1 route", () => {
    expect(remoteConf).toContain(
      "location ~ ^/web/(?!assistant(?:/|$)|v1(?:/|$))",
    );
    expect(remoteConf).toContain("rewrite ^/web/(.*)$ /v1/$1 break;");
    // Ordered ahead of the root catch-all so /web paths reach the twin
    // instead of forwarding verbatim with their iframe prefix.
    expect(remoteConf.indexOf("location ~ ^/web/(?!")).toBeLessThan(
      remoteConf.indexOf("location ~ ^/(?!"),
    );
    expect(remoteConf).not.toContain("location ^~ /web/ {");
  });

  test("web mode keeps its surface versioned (the gateway handles both spellings)", () => {
    expect(conf).not.toContain("location ~ ^/(?:");
    expect(conf).not.toContain("location ~ ^/web/");
  });

  test("the sensitive routes are blocked in both spellings at both prefixes", () => {
    for (const location of [
      "location = /pair ",
      "location = /pair/ ",
      "location = /devices ",
      "location = /v1/pair ",
      "location = /web/pair ",
      "location = /web/v1/pair ",
    ]) {
      expect(remoteConf).toContain(`${location}{ return 404; }`);
    }
    // Web mode's denylist also gains the unversioned twins.
    expect(conf).toContain("location = /pair { return 404; }");
  });
});

describe("buildRemoteWebIndexHtml", () => {
  test("injects the remote gateway config after any bundled local config", () => {
    const html =
      '<html><head><script>window.__CADET_CONFIG__={"webUrl":"https://mycadet.ai"}</script></head><body></body></html>';
    const result = buildRemoteWebIndexHtml(html, {
      remote: "docker",
      apiBaseUrl: "/v1",
    });

    expect(result).toContain(
      'window.__CADET_CONFIG__={"webUrl":"https://mycadet.ai"}',
    );
    expect(result).toContain(
      'window.__CADET_CONFIG__={"remote":"docker","apiBaseUrl":"/v1"}',
    );
    expect(result.indexOf('"webUrl"')).toBeLessThan(result.indexOf('"docker"'));
  });

  test("escapes config JSON before embedding it in a script tag", () => {
    const result = buildRemoteWebIndexHtml("</head>", {
      value: "</script><script>alert(1)</script>",
    });

    expect(result).not.toContain("</script><script>alert(1)</script>");
    expect(result).toContain("\\u003c/script\\u003e");
  });

  test("keeps the consolidated boot graph's modulepreload hints", () => {
    const html = [
      "<html><head>",
      '<link rel="modulepreload" crossorigin href="/assistant/assets/a-1.js">',
      '<link rel="modulepreload" crossorigin href="/assistant/assets/b-2.js">',
      '<link rel="modulepreload" crossorigin href="/assistant/assets/c-3.js">',
      '<link rel="modulepreload" crossorigin href="/assistant/assets/d-4.js">',
      '<link rel="stylesheet" crossorigin href="/assistant/assets/main-5.css">',
      '<script type="module" crossorigin src="/assistant/assets/index-6.js"></script>',
      "</head><body></body></html>",
    ].join("\n");

    const result = buildRemoteWebIndexHtml(html, { remote: "docker" });

    expect(result.match(/rel="modulepreload"/g)).toHaveLength(4);
    expect(result).toContain('href="/assistant/assets/a-1.js"');
    expect(result).toContain('href="/assistant/assets/main-5.css"');
    expect(result).toContain('src="/assistant/assets/index-6.js"');
  });

  test("strips a whole-graph preload set past the threshold, keeping entry and stylesheet", () => {
    const preloads = Array.from(
      { length: MAX_PRESERVED_MODULE_PRELOADS + 1 },
      (_, i) =>
        `<link rel="modulepreload" crossorigin href="/assistant/assets/chunk-${i}.js">`,
    );
    const html = [
      "<html><head>",
      ...preloads,
      '<link rel="stylesheet" crossorigin href="/assistant/assets/main-x.css">',
      '<script type="module" crossorigin src="/assistant/assets/index-y.js"></script>',
      "</head><body></body></html>",
    ].join("\n");

    const result = buildRemoteWebIndexHtml(html, { remote: "docker" });

    expect(result).not.toContain("modulepreload");
    expect(result).not.toContain("/assistant/assets/chunk-0.js");
    expect(result).toContain('href="/assistant/assets/main-x.css"');
    expect(result).toContain('src="/assistant/assets/index-y.js"');
  });

  test("keeps exactly the threshold count of hints", () => {
    const preloads = Array.from(
      { length: MAX_PRESERVED_MODULE_PRELOADS },
      (_, i) =>
        `<link rel="modulepreload" crossorigin href="/assistant/assets/chunk-${i}.js">`,
    );
    const html = `<html><head>${preloads.join("\n")}</head><body></body></html>`;

    const result = buildRemoteWebIndexHtml(html, { remote: "docker" });

    expect(result.match(/rel="modulepreload"/g)).toHaveLength(
      MAX_PRESERVED_MODULE_PRELOADS,
    );
  });
});

describe("nginx ingress process state", () => {
  function writeIngressState(listenPort: number): void {
    mkdirSync(getIngressPaths().dir, { recursive: true });
    writeFileSync(
      join(getIngressPaths().dir, "state.json"),
      JSON.stringify({ listenPort }) + "\n",
    );
  }

  function writePidFile(pid: number): void {
    mkdirSync(getIngressPaths().dir, { recursive: true });
    writeFileSync(getIngressPaths().pidPath, `${pid}\n`);
  }

  function pidPath(): string {
    return getIngressPaths().pidPath;
  }

  function nginxCommand(): string {
    const dir = getIngressPaths().dir;
    return `nginx: master process nginx -p ${dir} -c ${getIngressPaths().confPath} -g daemon off;`;
  }

  test("clears ingress state after nginx is confirmed stopped", async () => {
    makeWorkspace();
    const pid = 123_456;
    let alive = true;
    writeIngressState(7841);
    writePidFile(pid);
    execFileSyncMock.mockReturnValue(nginxCommand());
    process.kill = mock((targetPid: number, signal?: string | number): true => {
      if (targetPid !== pid) return originalKill(targetPid, signal);
      if (signal === 0) {
        if (!alive) throw new Error("dead");
        return true;
      }
      if (signal === "SIGTERM") {
        alive = false;
        return true;
      }
      return true;
    });

    await expect(stopIngressNginx()).resolves.toBe(true);

    expect(readIngressState()).toBeNull();
    expect(existsSync(pidPath())).toBe(false);
  });

  test("keeps ingress state when nginx kill fails", async () => {
    makeWorkspace();
    const pid = 123_457;
    writeIngressState(7841);
    writePidFile(pid);
    execFileSyncMock.mockReturnValue(nginxCommand());
    process.kill = mock((targetPid: number, signal?: string | number): true => {
      if (targetPid !== pid) return originalKill(targetPid, signal);
      if (signal === 0) return true;
      throw new Error("operation not permitted");
    });

    await expect(stopIngressNginx()).resolves.toBe(false);

    expect(readIngressState()).toEqual({ listenPort: 7841 });
    expect(existsSync(pidPath())).toBe(true);
  });

  test("clears ingress state when nginx exits before SIGTERM", async () => {
    makeWorkspace();
    const pid = 123_458;
    let aliveChecks = 0;
    writeIngressState(7841);
    writePidFile(pid);
    execFileSyncMock.mockReturnValue(nginxCommand());
    process.kill = mock((targetPid: number, signal?: string | number): true => {
      if (targetPid !== pid) return originalKill(targetPid, signal);
      if (signal === 0) {
        aliveChecks++;
        if (aliveChecks === 1) return true;
        throw new Error("dead");
      }
      throw new Error("no such process");
    });

    await expect(stopIngressNginx()).resolves.toBe(true);

    expect(readIngressState()).toBeNull();
    expect(existsSync(pidPath())).toBe(false);
  });

  test("does not kill another nginx instance when clearing stale state", async () => {
    makeWorkspace();
    const pid = 123_459;
    writeIngressState(7841);
    writePidFile(pid);
    execFileSyncMock.mockReturnValue(
      "nginx: master process nginx -p /tmp/other-ingress -c /tmp/other-ingress/nginx.conf",
    );
    process.kill = mock((targetPid: number, signal?: string | number): true => {
      if (targetPid !== pid) return originalKill(targetPid, signal);
      if (signal === 0) return true;
      throw new Error("should not kill another nginx instance");
    });

    await expect(stopIngressNginx()).resolves.toBe(false);

    expect(readIngressState()).toBeNull();
    expect(existsSync(pidPath())).toBe(false);
  });
});

const NGINX_VERSION = "nginx version: nginx/1.29.0";
const FAKE_INDEX_HTML = "<html><head></head><body></body></html>";
const WEB_INDEX_SUFFIX = join("dist", "index.html");
const APP_INDEX_SUFFIX = join("standalone", "index.html");
const FAKE_APP_INDEX_HTML =
  "<!doctype html><html><head><title>app</title></head><body>app-shell</body></html>";

/** The app dist the mocked fs presents (npm-arm resolution, like web's). */
function fakeAppDistDir(): string {
  const dist = findAppDistDir();
  if (dist === null) {
    throw new Error("expected a mocked app dist dir");
  }
  return dist;
}

function ingressConfPath(): string {
  return getIngressPaths().confPath;
}

function mockNginxInstalled(): void {
  spawnSyncMock.mockReturnValue({
    pid: 4242,
    output: [],
    stdout: "",
    stderr: NGINX_VERSION,
    status: 0,
    signal: null,
  });
}

function mockNginxMissing(): void {
  spawnSyncMock.mockReturnValue({
    pid: 0,
    output: [],
    stdout: "",
    stderr: "",
    status: 1,
    signal: null,
  });
}

const SPAWNED_NGINX_PID = 4243;

/**
 * Spawned nginx that wins its bind: alive as the master, and it records its
 * pid under the prefix dir like a real `daemon off` master, with a matching
 * ps answer so getIngressPid confirms ownership.
 */
function mockNginxSpawn(): void {
  spawnMock.mockImplementation(((_command: string, args: readonly string[]) => {
    const dir = String(args[args.indexOf("-p") + 1]);
    realFs.writeFileSync(join(dir, "nginx.pid"), `${SPAWNED_NGINX_PID}\n`);
    fakePids.set(SPAWNED_NGINX_PID, { alive: true });
    installKillMock();
    execFileSyncMock.mockImplementation(((
      _file: string,
      psArgs?: readonly string[],
    ) =>
      psArgs?.includes(String(SPAWNED_NGINX_PID))
        ? `nginx: master process nginx -p ${dir} -c ${join(dir, "nginx.conf")} -g daemon off;`
        : "") as typeof childProcess.execFileSync);
    const child = new childProcess.ChildProcess();
    Object.assign(child, { pid: SPAWNED_NGINX_PID });
    return child;
  }) as unknown as typeof childProcess.spawn);
}

/** Spawned nginx that exits on startup, as when the listen port is already bound. */
function mockNginxSpawnExitsOnStartup(): void {
  spawnMock.mockReturnValue(
    Object.assign(new childProcess.ChildProcess(), {
      pid: SPAWNED_NGINX_PID,
      exitCode: 1,
    }),
  );
}

/**
 * Spawned nginx that loses the bind race to a healthy squatter: still alive
 * when the probe resolves, exits shortly after, never writes a pid file.
 */
function mockNginxSpawnExitsAfterProbe(): void {
  spawnMock.mockImplementation((() => {
    const child = new childProcess.ChildProcess();
    Object.assign(child, { pid: SPAWNED_NGINX_PID });
    setTimeout(() => {
      Object.assign(child, { exitCode: 1 });
      child.emit("exit", 1);
    }, 150);
    return child;
  }) as unknown as typeof childProcess.spawn);
}

/**
 * Force the dist lookup to resolve nothing, regardless of checkout state:
 * no built bundle anywhere, and no clients/{web,app} source checkout for
 * the auto-build to run from.
 */
function mockWebDistMissing(): void {
  existsSyncMock.mockImplementation((path) => {
    const p = String(path);
    // No built bundle anywhere...
    if (p.endsWith("index.html")) return false;
    // ...and no source package for the auto-build to run.
    if (p.includes("clients/web/package.json")) return false;
    if (p.includes("clients/app/package.json")) return false;
    return realFs.existsSync(path);
  });
}

/** Force findWebDistDir() to resolve a dist dir, regardless of checkout state. */
function mockWebDistPresent(): void {
  // The edge always serves both bundles (the app shell plus the iframed web
  // SPA), so one mock presents both dists.
  existsSyncMock.mockImplementation((path) => {
    const p = String(path);
    if (p.endsWith(WEB_INDEX_SUFFIX)) return true;
    if (p.endsWith(APP_INDEX_SUFFIX)) return true;
    return realFs.existsSync(path);
  });
  readFileSyncMock.mockImplementation(((path, options) => {
    const p = String(path);
    if (p.endsWith(WEB_INDEX_SUFFIX)) return FAKE_INDEX_HTML;
    if (p.endsWith(APP_INDEX_SUFFIX)) return FAKE_APP_INDEX_HTML;
    return realFs.readFileSync(path as never, options as never);
  }) as typeof readFileSync);
}

/** Record a running edge: XDG state, live pidfile, matching ps output. */
function mockRunningEdge(opts: {
  listenPort: number;
  gatewayUrl?: string;
  remoteWebConfigHash?: string;
}): number {
  const pid = 123_460;
  mkdirSync(getIngressPaths().dir, { recursive: true });
  writeFileSync(
    join(getIngressPaths().dir, "state.json"),
    JSON.stringify({
      listenPort: opts.listenPort,
      ...(opts.gatewayUrl === undefined ? {} : { gatewayUrl: opts.gatewayUrl }),
      ...(opts.remoteWebConfigHash === undefined
        ? {}
        : { remoteWebConfigHash: opts.remoteWebConfigHash }),
    }) + "\n",
  );
  writeFileSync(getIngressPaths().pidPath, `${pid}\n`);
  const dir = getIngressPaths().dir;
  execFileSyncMock.mockReturnValue(
    `nginx: master process nginx -p ${dir} -c ${getIngressPaths().confPath} -g daemon off;`,
  );
  return pid;
}

/** SIGTERM to the given PID marks it dead; signal 0 reflects liveness. */
function mockKillableNginx(pid: number): { killed: () => boolean } {
  fakePids.set(pid, { alive: true });
  installKillMock();
  return { killed: () => fakePids.get(pid)?.alive === false };
}

/** The given PID stays alive: liveness probes succeed, kill signals fail. */
function mockUnkillableNginx(pid: number): void {
  fakePids.set(pid, { alive: true, unkillable: true });
  installKillMock();
}

/**
 * The multi-line `location <matcher> { ... }` blocks of a generated config,
 * so a test can assert what a location does rather than how its lines are
 * ordered. Single-line denylist locations carry no directives worth reading
 * and are skipped by the trailing-brace match.
 */
function locationBlocks(
  conf: string,
): Array<{ matcher: string; body: string }> {
  const blocks: Array<{ matcher: string; body: string }> = [];
  const opener = /^ {4}location ([^{]+?) \{$/gm;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(conf)) !== null) {
    const end = conf.indexOf("\n    }", opener.lastIndex);
    blocks.push({
      matcher: match[1],
      body: conf.slice(opener.lastIndex, end === -1 ? undefined : end),
    });
  }
  return blocks;
}

const PRODUCTION_HUB_URL = "https://mycadet.ai/assistant";

const originalEnvironment = process.env.CADET_ENVIRONMENT;

/** Pin the build environment so the stamped hubUrl is deterministic. */
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

describe("startAppServer", () => {
  pinProductionEnvironment();

  test("the metadata route serves the CLI's own version stamp, always ready", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();
    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });
    expect(result.status).toBe("started");
    const conf = realFs.readFileSync(ingressConfPath(), "utf8");
    const detail = conf
      .split('location = "/v1/assistants/assistant-1/" {')[1]
      ?.split("\n    }")[0];
    // The version is the CLI's own stamp (mocked to "1.2.3" here), so the
    // detail route is always a 200 — the served page's "which one is
    // running" answer follows the CLI, not the runtime's /healthz.
    expect(detail).toContain("return 200 ");
    expect(detail).toContain('\\"version\\":\\"1.2.3\\"');
  });

  test("serves the SPA config unchanged", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    if (result.status !== "started") {
      throw new Error(`expected started, got ${result.status}`);
    }
    const { webDistDir } = result;
    if (webDistDir === null) {
      throw new Error("expected a web dist dir in SPA mode");
    }

    const conf = realFs.readFileSync(ingressConfPath(), "utf-8");
    expect(conf).toBe(
      buildNginxConfig({
        gatewayUrl: "http://127.0.0.1:7830",
        listenPort: 7840,
        ipv6Loopback: hasIpv6Loopback(),

        webDistDir,
        appDistDir: fakeAppDistDir(),
        indexHtmlPath: join(getIngressPaths().dir, "assistant-index.html"),
        appIndexHtmlPath: join(getIngressPaths().dir, "app-index.html"),
        config: {
          remote: "local",
          assistantName: "Homelab",
          assistantId: "assistant-1",
          hubUrl: PRODUCTION_HUB_URL,
          version: "1.2.3",
        },
      }),
    );
    expect(conf).toContain("location ^~ /assistant/ {");
    expect(conf).toContain("location ^~ /webhooks/ {");
    expect(conf).toContain("location = /readyz {");
    const indexHtml = realFs.readFileSync(
      join(getIngressPaths().dir, "assistant-index.html"),
      "utf-8",
    );
    // The served config is the seeded entry's own facts: its recorded
    // kind, its display name, nothing aliased.
    expect(indexHtml).toContain('"remote":"local"');
    expect(indexHtml).toContain('"assistantName":"Homelab"');
    expect(indexHtml).toContain('"hubUrl":"https://mycadet.ai/assistant"');
    expect(readIngressState()).toEqual({
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:7830",
      remoteWebConfigHash: appConfigHash(),
    });
  });

  test("replaces leftover nginx.conf that omitted /readyz when the edge starts", async () => {
    // sleep stops nginx and leaves the last generated file. The next start
    // (wake) writes nginx.conf from the current template rather than reuse
    // that leftover, so a prior file without /readyz cannot keep pairing
    // broken after boot.
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();
    mkdirSync(getIngressPaths().dir, { recursive: true });
    writeFileSync(
      ingressConfPath(),
      [
        "location = /healthz {",
        "  proxy_pass http://127.0.0.1:7830;",
        "}",
        "location / {",
        "  return 404;",
        "}",
      ].join("\n"),
    );

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    expect(result.status).toBe("started");
    const conf = realFs.readFileSync(ingressConfPath(), "utf-8");
    expect(conf).toContain("location = /readyz {");
    const readyzStart = conf.indexOf("location = /readyz {");
    const readyzBlock = conf.slice(
      readyzStart,
      conf.indexOf("location ^~ /v1/", readyzStart),
    );
    expect(readyzBlock).toContain("proxy_pass http://127.0.0.1:7830;");
  });

  test("requires the web dist", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistMissing();

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    expect(result).toEqual({ status: "web-dist-missing" });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(realFs.existsSync(ingressConfPath())).toBe(false);
  });

  test("builds the missing web bundle from the source checkout and starts", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    // No built bundle anywhere, but the source checkout IS present, so the
    // edge auto-builds it through the spawn boundary (mocked here).
    existsSyncMock.mockImplementation((path) => {
      const p = String(path);
      if (p.endsWith(WEB_INDEX_SUFFIX)) return false;
      if (p.endsWith(APP_INDEX_SUFFIX)) return true;
      if (p.includes("clients/web/package.json")) return true;
      return realFs.existsSync(path);
    });
    mockNginxSpawn();
    const nginxSpawn = spawnMock.getMockImplementation();
    spawnMock.mockImplementation(((
      command: string,
      args: readonly string[],
      options?: SpawnOptions,
    ) => {
      if (command === "bun") {
        // The auto-build "lands" the bundle and exits cleanly.
        mockWebDistPresent();
        const child = new childProcess.ChildProcess();
        setTimeout(() => child.emit("exit", 0), 10);
        return child;
      }
      return nginxSpawn?.(command, args, options ?? {});
    }) as unknown as typeof childProcess.spawn);

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    expect(result).toEqual({
      status: "started",
      listenPort: 7840,
      webDistDir: expect.any(String),
      version: NGINX_VERSION,
    });
    const buildCalls = spawnMock.mock.calls.filter(
      ([command]) => command === "bun",
    );
    expect(buildCalls).toHaveLength(1);
    const [, buildArgs, buildOptions] = buildCalls[0] ?? [];
    expect(buildArgs).toEqual(["run", "build"]);
    expect(String(buildOptions?.cwd).endsWith(join("clients", "web"))).toBe(
      true,
    );
  });

  test("reports a failed source build with the manual recipe", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    // Bundle missing, source checkout present: the edge auto-builds, and
    // the build spawn fails.
    existsSyncMock.mockImplementation((path) => {
      const p = String(path);
      if (p.endsWith(WEB_INDEX_SUFFIX)) return false;
      if (p.endsWith(APP_INDEX_SUFFIX)) return true;
      if (p.includes("clients/web/package.json")) return true;
      return realFs.existsSync(path);
    });
    spawnMock.mockImplementation((() => {
      const child = new childProcess.ChildProcess();
      setTimeout(() => child.emit("exit", 1), 10);
      return child;
    }) as unknown as typeof childProcess.spawn);

    await expect(
      startAppServer({
        gatewayUrl: "http://127.0.0.1:7830",
        assistantId: "assistant-1",
      }),
    ).rejects.toThrow("cd clients/web && bun run build");
  });

  test("already-running reports the recorded listen port", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();
    const pid = mockRunningEdge({
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:7830",
      remoteWebConfigHash: appConfigHash(),
    });
    const edge = mockKillableNginx(pid);

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    expect(result).toEqual({
      status: "already-running",
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:7830",
    });
    expect(edge.killed()).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("a failed restart reports the recorded gateway port", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();
    const pid = mockRunningEdge({
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:7900",
    });
    mockUnkillableNginx(pid);

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    expect(result).toEqual({
      status: "already-running",
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:7900",
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("restarts the edge when its recorded gateway port drifts from the request", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();
    const pid = mockRunningEdge({
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:7900",
    });
    const edge = mockKillableNginx(pid);

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    if (result.status !== "started") {
      throw new Error(`expected started, got ${result.status}`);
    }
    const { webDistDir } = result;
    expect(edge.killed()).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const conf = realFs.readFileSync(ingressConfPath(), "utf-8");
    expect(conf).toBe(
      buildNginxConfig({
        gatewayUrl: "http://127.0.0.1:7830",
        listenPort: 7840,
        ipv6Loopback: hasIpv6Loopback(),

        webDistDir,
        appDistDir: fakeAppDistDir(),
        indexHtmlPath: join(getIngressPaths().dir, "assistant-index.html"),
        appIndexHtmlPath: join(getIngressPaths().dir, "app-index.html"),
        config: {
          remote: "local",
          assistantName: "Homelab",
          assistantId: "assistant-1",
          hubUrl: PRODUCTION_HUB_URL,
          version: "1.2.3",
        },
      }),
    );
    expect(conf).toContain("proxy_pass http://127.0.0.1:7830;");
    expect(readIngressState()).toEqual({
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:7830",
      remoteWebConfigHash: appConfigHash(),
    });
  });

  test("restarts an edge whose state predates the recorded gateway port", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();
    const pid = mockRunningEdge({ listenPort: 7840 });
    const edge = mockKillableNginx(pid);

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7900",
      assistantId: "assistant-1",
    });

    if (result.status !== "started") {
      throw new Error(`expected started, got ${result.status}`);
    }
    const { webDistDir } = result;
    expect(edge.killed()).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(realFs.readFileSync(ingressConfPath(), "utf-8")).toBe(
      buildNginxConfig({
        gatewayUrl: "http://127.0.0.1:7900",
        listenPort: 7840,
        ipv6Loopback: hasIpv6Loopback(),

        webDistDir,
        appDistDir: fakeAppDistDir(),
        indexHtmlPath: join(getIngressPaths().dir, "assistant-index.html"),
        appIndexHtmlPath: join(getIngressPaths().dir, "app-index.html"),
        config: {
          remote: "local",
          assistantName: "Homelab",
          assistantId: "assistant-1",
          hubUrl: PRODUCTION_HUB_URL,
          version: "1.2.3",
        },
      }),
    );
    expect(readIngressState()).toEqual({
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:7900",
      remoteWebConfigHash: appConfigHash(),
    });
  });

  test("short-circuits when the running SPA edge already serves the requested config", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();
    const pid = mockRunningEdge({
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:7830",
      remoteWebConfigHash: appConfigHash(),
    });
    const edge = mockKillableNginx(pid);

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    expect(result).toEqual({
      status: "already-running",
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:7830",
    });
    expect(edge.killed()).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  for (const drift of ["indexHtml", "webDistDir"] as const) {
    test(`restarts a detached edge when the web bundle ${drift} changes`, async () => {
      makeWorkspace();
      seedAssistant();
      mockNginxInstalled();
      mockNginxSpawn();
      mockWebDistPresent();
      const pid = mockRunningEdge({
        listenPort: 7840,
        gatewayUrl: "http://127.0.0.1:7830",
        remoteWebConfigHash: appConfigHash({
          ...(drift === "indexHtml"
            ? {
                indexHtml:
                  '<html><head><script src="/assistant/assets/old.js"></script></head></html>',
              }
            : { webDistDir: "/old-release/dist" }),
        }),
      });
      const edge = mockKillableNginx(pid);
      const result = await startAppServer({
        gatewayUrl: "http://127.0.0.1:7830",
        assistantId: "assistant-1",
      });
      expect(result).toMatchObject({ status: "started", listenPort: 7840 });
      expect(edge.killed()).toBe(true);
      expect(readIngressState()?.remoteWebConfigHash).toBe(appConfigHash());
      expect(
        realFs.readFileSync(
          join(getIngressPaths().dir, "assistant-index.html"),
          "utf-8",
        ),
      ).not.toContain("old.js");
    });
  }

  test("restarts the edge when the injected SPA config drifts from the recorded one", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();
    const pid = mockRunningEdge({
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:7830",
      remoteWebConfigHash: appConfigHash({ assistantName: "Old Name" }),
    });
    const edge = mockKillableNginx(pid);
    seedAssistant("New Name");

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    expect(result.status).toBe("started");
    expect(edge.killed()).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const indexHtml = realFs.readFileSync(
      join(getIngressPaths().dir, "assistant-index.html"),
      "utf-8",
    );
    expect(indexHtml).toContain('"assistantName":"New Name"');
    expect(readIngressState()).toEqual({
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:7830",
      remoteWebConfigHash: appConfigHash({ assistantName: "New Name" }),
    });
  });

  test("restarts an SPA edge whose state predates the config fingerprint", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();
    const pid = mockRunningEdge({
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:7830",
    });
    const edge = mockKillableNginx(pid);

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    expect(result.status).toBe("started");
    expect(edge.killed()).toBe(true);
    expect(readIngressState()).toEqual({
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:7830",
      remoteWebConfigHash: appConfigHash(),
    });
  });

  test("a config-drifted edge that survives the restart attempt reports it as stale", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();
    const pid = mockRunningEdge({
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:7830",
      remoteWebConfigHash: appConfigHash({ assistantName: "Old Name" }),
    });
    mockUnkillableNginx(pid);
    seedAssistant("New Name");

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    expect(result).toEqual({
      status: "already-running",
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:7830",
      staleRemoteWebConfig: true,
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("starts a fresh edge when the old one exits during the stop", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();
    const pid = mockRunningEdge({
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:7830",
      remoteWebConfigHash: "outdated-hash",
    });
    // Alive for the initial running check, dead by the time the stop helper
    // probes it: the race where the old edge exits on its own mid-switch.
    let liveChecks = 0;
    process.kill = mock((targetPid: number, signal?: string | number): true => {
      if (targetPid !== pid) return originalKill(targetPid, signal);
      if (signal === 0 && ++liveChecks === 1) return true;
      throw new Error("dead");
    });

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    if (result.status !== "started") {
      throw new Error(`expected started, got ${result.status}`);
    }
    const { webDistDir } = result;
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const conf = realFs.readFileSync(ingressConfPath(), "utf-8");
    expect(conf).toBe(
      buildNginxConfig({
        gatewayUrl: "http://127.0.0.1:7830",
        listenPort: 7840,
        ipv6Loopback: hasIpv6Loopback(),

        webDistDir,
        appDistDir: fakeAppDistDir(),
        indexHtmlPath: join(getIngressPaths().dir, "assistant-index.html"),
        appIndexHtmlPath: join(getIngressPaths().dir, "app-index.html"),
        config: {
          remote: "local",
          assistantName: "Homelab",
          assistantId: "assistant-1",
          hubUrl: PRODUCTION_HUB_URL,
          version: "1.2.3",
        },
      }),
    );
    expect(readIngressState()).toEqual({
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:7830",
      remoteWebConfigHash: appConfigHash(),
    });
  });

  test("a spawn that exits despite a successful probe is a port conflict, not started", async () => {
    // Another assistant's edge on the same listen port answers the readiness
    // probe while this workspace's nginx dies on the bind, so a healthy probe
    // alone must not count as started.
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockNginxSpawnExitsOnStartup();
    mockWebDistPresent();
    waitForDaemonReadyMock.mockImplementation(async () => true);

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    expect(result).toEqual({
      status: "port-conflict",
      listenPort: 7840,
      logPath: getIngressPaths().logPath,
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(readIngressState()).toBeNull();
  });

  test("a child that outlives the probe but never owns the port is a port conflict", async () => {
    // The healthy-squatter race: another workspace's edge answers the probe in
    // milliseconds, while our master is still failing its bind. The child being
    // alive right after the probe must not count as started.
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockNginxSpawnExitsAfterProbe();
    mockWebDistPresent();
    waitForDaemonReadyMock.mockImplementation(async () => true);

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    expect(result).toEqual({
      status: "port-conflict",
      listenPort: 7840,
      logPath: getIngressPaths().logPath,
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(readIngressState()).toBeNull();
  });

  test("started requires the pid file to name the live spawned master", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    expect(result).toEqual({
      status: "started",
      listenPort: 7840,
      webDistDir: expect.any(String),
      version: NGINX_VERSION,
    });
    expect(realFs.readFileSync(getIngressPaths().pidPath, "utf-8").trim()).toBe(
      String(SPAWNED_NGINX_PID),
    );
    // Ownership confirmed on the first settle iteration: exactly one ps
    // lookup, for the spawned master's pid, with no polling delay.
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock.mock.calls[0]?.[1]).toContain(
      String(SPAWNED_NGINX_PID),
    );
  });

  test("a spawn that exits with a failed probe is also a port conflict", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockNginxSpawnExitsOnStartup();
    mockWebDistPresent();
    waitForDaemonReadyMock.mockImplementation(async () => false);

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    expect(result.status).toBe("port-conflict");
  });

  test("a child still retrying its bind at the settle deadline is killed before rollback", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockWebDistPresent();
    const kills: string[] = [];
    // Alive for the whole settle window (nginx retrying its bind), never
    // writes a pid file; an orphan left running could win the bind later.
    spawnMock.mockImplementation((() => {
      const child = new childProcess.ChildProcess();
      Object.assign(child, {
        pid: SPAWNED_NGINX_PID,
        kill: (signal: string) => {
          kills.push(signal);
          return true;
        },
      });
      return child;
    }) as unknown as typeof childProcess.spawn);

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    expect(result.status).toBe("port-conflict");
    expect(kills).toEqual(["SIGTERM"]);
  }, 10_000);
});

describe("ensureAppServer", () => {
  const ASSISTANT_ID = "assistant-1";
  // The edge starts on the module's default port; nothing in these tests
  // binds it first.
  const REQUESTED_PORT = 7840;
  const originalConfigHome = process.env.XDG_CONFIG_HOME;
  let lockfileDir: string;

  pinProductionEnvironment();

  beforeEach(() => {
    resolveTargetAssistantMock.mockReturnValue({
      assistantId: ASSISTANT_ID,
      cloud: "local",
      port: 7830,
    } as never);
    // Isolated lockfile dir so the assistant-name lookup never reads a real
    // machine lockfile.
    lockfileDir = makeWorkspace();
    process.env.XDG_CONFIG_HOME = lockfileDir;
  });

  afterEach(() => {
    if (originalConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalConfigHome;
    }
  });

  test("threads the lockfile display name and assistant id into the served SPA config", async () => {
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();
    mkdirSync(join(lockfileDir, "cadet"), { recursive: true });
    writeFileSync(
      join(lockfileDir, "cadet", "lockfile.json"),
      JSON.stringify({
        assistants: [
          {
            assistantId: ASSISTANT_ID,
            name: "Homelab",
            cloud: "local",
            localUrl: "http://127.0.0.1:7830",
          },
        ],
        activeAssistant: ASSISTANT_ID,
      }),
    );

    await ensureAppServer();

    const indexHtml = realFs.readFileSync(
      join(getIngressPaths().dir, "assistant-index.html"),
      "utf-8",
    );
    expect(indexHtml).toContain('"assistantName":"Homelab"');
    expect(indexHtml).toContain(`"assistantId":"${ASSISTANT_ID}"`);
    expect(indexHtml).toContain(`"hubUrl":"${PRODUCTION_HUB_URL}"`);
  });

  test("reuses a running edge that already serves the requested config", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();
    const pid = mockRunningEdge({
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:7830",
      remoteWebConfigHash: appConfigHash({ assistantId: ASSISTANT_ID }),
    });
    const edge = mockKillableNginx(pid);

    const result = await ensureAppServer();

    expect(result).toEqual({
      port: 7840,
      started: false,
    });
    expect(edge.killed()).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("restarts the edge when the lockfile display name changes", async () => {
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();
    const writeLockfile = (name: string) => {
      mkdirSync(join(lockfileDir, "cadet"), { recursive: true });
      return writeFileSync(
        join(lockfileDir, "cadet", "lockfile.json"),
        JSON.stringify({
          assistants: [
            {
              assistantId: ASSISTANT_ID,
              name,
              cloud: "local",
              localUrl: "http://127.0.0.1:7830",
            },
          ],
          activeAssistant: ASSISTANT_ID,
        }),
      );
    };
    writeLockfile("Homelab");

    const first = await ensureAppServer();
    expect(first.started).toBe(true);

    // Same port and mode, renamed assistant: the edge must restart so the
    // served index carries the new label instead of reporting already-running.
    writeLockfile("Renamed");
    const second = await ensureAppServer();

    expect(second.started).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    const indexHtml = realFs.readFileSync(
      join(getIngressPaths().dir, "assistant-index.html"),
      "utf-8",
    );
    expect(indexHtml).toContain('"assistantName":"Renamed"');
    expect(indexHtml).not.toContain('"assistantName":"Homelab"');
  });

  test("a config-drifted edge that survives the restart attempt throws", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();
    const pid = mockRunningEdge({
      listenPort: REQUESTED_PORT,
      gatewayUrl: "http://127.0.0.1:7830",
      remoteWebConfigHash: appConfigHash({
        assistantName: "Stale Name",
        assistantId: ASSISTANT_ID,
      }),
    });
    mockUnkillableNginx(pid);

    const promise = ensureAppServer();

    await expect(promise).rejects.toThrow(
      "still serving an outdated remote web config",
    );
    await expect(promise).rejects.toThrow("even with SIGKILL");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("a port-drifted edge that survives the restart attempt throws", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();
    const pid = mockRunningEdge({
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:7900",
      remoteWebConfigHash: appConfigHash({ assistantId: ASSISTANT_ID }),
    });
    mockUnkillableNginx(pid);

    const promise = ensureAppServer();

    await expect(promise).rejects.toThrow(
      "still proxying http://127.0.0.1:7900 and could not be restarted against http://127.0.0.1:7830",
    );
    await expect(promise).rejects.toThrow("even with SIGKILL");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("restarts a port-drifted edge against the requested gateway port", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();
    const pid = mockRunningEdge({
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:7900",
      remoteWebConfigHash: appConfigHash({ assistantId: ASSISTANT_ID }),
    });
    const edge = mockKillableNginx(pid);

    const result = await ensureAppServer();

    expect(result).toEqual({
      port: REQUESTED_PORT,
      started: true,
    });
    expect(edge.killed()).toBe(true);
    const conf = realFs.readFileSync(ingressConfPath(), "utf-8");
    expect(conf).toContain("location ^~ /assistant/ {");
  });

  test("starts the SPA edge", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();

    const result = await ensureAppServer();

    expect(result).toEqual({
      port: REQUESTED_PORT,
      started: true,
    });
    const conf = realFs.readFileSync(ingressConfPath(), "utf-8");
    expect(conf).toContain("location ^~ /assistant/ {");
    expect(conf).toContain("location ^~ /webhooks/ {");
    expect(readIngressState()).toEqual({
      listenPort: REQUESTED_PORT,
      gatewayUrl: "http://127.0.0.1:7830",
      remoteWebConfigHash: appConfigHash({ assistantId: ASSISTANT_ID }),
    });
  });

  test("missing nginx throws with install instructions", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxMissing();

    const promise = ensureAppServer();

    await expect(promise).rejects.toThrow(
      "See https://nginx.org/en/docs/install.html for how to install",
    );
    await expect(promise).rejects.toThrow("NGINX_BIN");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("missing web dist throws build guidance", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockWebDistMissing();

    await expect(ensureAppServer()).rejects.toThrow("@mycadet/web");
  });

  test("an unreachable edge throws with the log path", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();
    waitForDaemonReadyMock.mockImplementation(async () => false);

    await expect(ensureAppServer()).rejects.toThrow(getIngressPaths().logPath);
  });

  test("a port conflict throws naming the port and the log path", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockNginxSpawnExitsOnStartup();
    mockWebDistPresent();
    waitForDaemonReadyMock.mockImplementation(async () => true);

    const promise = ensureAppServer();

    await expect(promise).rejects.toThrow(
      `already in use (for example by another assistant's app server)`,
    );
    await expect(promise).rejects.toThrow(`127.0.0.1:${REQUESTED_PORT}`);
    await expect(promise).rejects.toThrow(getIngressPaths().logPath);
  });
});

describe("stopContainerAppServer", () => {
  const originalWorkspaceDir = process.env.CADET_WORKSPACE_DIR;

  afterEach(() => {
    if (originalWorkspaceDir === undefined) {
      delete process.env.CADET_WORKSPACE_DIR;
    } else {
      process.env.CADET_WORKSPACE_DIR = originalWorkspaceDir;
    }
  });

  /** A container entry whose gateway port is only recoverable from its URLs. */
  function containerEntry(port: number): LockfileAssistant {
    return {
      assistantId: "docker-1",
      cloud: "docker",
      port: port,
      daemonPort: port + 1,
    };
  }

  test("stops the default-workspace edge fronting this assistant", async () => {
    makeWorkspace();
    const pid = mockRunningEdge({
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:7930",
    });
    const { killed } = mockKillableNginx(pid);

    expect(await stopContainerAppServer(containerEntry(7930))).toBe(true);
    expect(killed()).toBe(true);
  });

  test("leaves an edge fronting a different container assistant alone", async () => {
    makeWorkspace();
    const pid = mockRunningEdge({
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:7930",
    });
    const { killed } = mockKillableNginx(pid);

    expect(await stopContainerAppServer(containerEntry(8030))).toBe(false);
    expect(killed()).toBe(false);
  });

  test("leaves an unattributable edge alone", async () => {
    makeWorkspace();
    const pid = mockRunningEdge({ listenPort: 7840 });
    const { killed } = mockKillableNginx(pid);

    expect(await stopContainerAppServer(containerEntry(7930))).toBe(false);
    expect(killed()).toBe(false);
  });

  test("is a no-op when the edge fronts a different upstream", async () => {
    makeWorkspace();
    const pid = mockRunningEdge({
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:7930",
    });
    const { killed } = mockKillableNginx(pid);

    expect(
      await stopContainerAppServer({
        assistantId: "docker-1",
        cloud: "docker",
        port: 7830,
      }),
    ).toBe(false);
    expect(killed()).toBe(false);
  });

  test("is a no-op when no edge is running", async () => {
    makeWorkspace();

    expect(await stopContainerAppServer(containerEntry(7930))).toBe(false);
  });
});

describe("assistant metadata API", () => {
  function config(id = "assistant-1") {
    return buildNginxConfig({
      gatewayUrl: "http://127.0.0.1:7830",
      listenPort: 7840,

      webDistDir: "/tmp/web",
      appDistDir: "/tmp/app-dist",
      config: {
        remote: "custom",
        assistantName: "My assistant",
        assistantId: id,
        hubUrl: "https://parent.example",
        version: "1.2.3",
      },
    });
  }
  function body(conf: string, path: string, status = 200): unknown {
    const location = conf
      .split(`location = "${path}" {`)[1]
      ?.split("\n    }")[0];
    const value = location?.match(/return (200|409) ("(?:\\.|[^"\\])*");/);
    expect(Number(value?.[1])).toBe(status);
    if (!value) {
      throw new Error(`Missing metadata for ${path}`);
    }
    return JSON.parse(JSON.parse(value[2]));
  }
  test("lists only this host's assistant and returns its actual UI version and URL", () => {
    const conf = config();
    // Each row carries its own hosting kind — here the test env has no
    // lockfile entry for the id, so the remote kind is omitted (unknown
    // entries invent nothing).
    expect(body(conf, "/v1/assistants/")).toEqual({
      results: [{ id: "assistant-1", name: "My assistant" }],
      next: null,
    });
    expect(body(conf, "/v1/assistants/assistant-1/")).toEqual({
      id: "assistant-1",
      name: "My assistant",
      status: "active",
      version: "1.2.3",
      url: "web/assistant/",
    });
    expect(conf).not.toContain('location = "/v1/assistants/other/"');
  });
  test("metadata supports both slash forms and only read methods", () => {
    const conf = config();
    for (const path of [
      "/v1/assistants",
      "/v1/assistants/",
      "/v1/assistants/assistant-1",
      "/v1/assistants/assistant-1/",
    ]) {
      expect(body(conf, path)).toBeDefined();
    }
    expect(conf).toContain(
      "if ($request_method !~ ^(GET|HEAD)$) { return 405; }",
    );
    expect(conf).toContain(
      '"https://parent.example" "https://parent.example";',
    );
    expect(conf).toContain(
      "add_header Access-Control-Allow-Origin $cadet_app_origin always;",
    );
  });
  test("unknown identity yields an empty list without inventing an assistant ID", () => {
    const conf = buildNginxConfig({
      gatewayUrl: "http://127.0.0.1:7830",
      listenPort: 7840,

      webDistDir: "/tmp/web",
      appDistDir: "/tmp/app-dist",
      config: { remote: "custom" },
    });
    expect(body(conf, "/v1/assistants/")).toEqual({ results: [], next: null });
  });
  test("a known assistant without a UI bundle returns 409 on both detail paths", () => {
    const conf = buildNginxConfig({
      gatewayUrl: "http://127.0.0.1:7830",
      listenPort: 7840,

      webDistDir: "/tmp/web",
      appDistDir: "/tmp/app-dist",
      config: { remote: "custom", assistantId: "assistant-1" },
    });
    expect(body(conf, "/v1/assistants/")).toEqual({
      results: [{ id: "assistant-1" }],
      next: null,
    });
    for (const path of [
      "/v1/assistants/assistant-1",
      "/v1/assistants/assistant-1/",
    ]) {
      expect(body(conf, path, 409)).toEqual({
        detail: "assistant is not ready",
      });
    }
  });
  test("invalid browser origins fail before nginx starts", () => {
    expect(() =>
      buildNginxConfig({
        gatewayUrl: "http://127.0.0.1:7830",
        listenPort: 7840,

        webDistDir: "/tmp/web",
        appDistDir: "/tmp/app-dist",
        config: { remote: "custom", hubUrl: "ftp://parent.example" },
      }),
    ).toThrow("App origins");
  });
});

/** The fingerprint the edge must record for its served SPA config. */
function appConfigHash(
  opts: {
    assistantName?: string;
    assistantId?: string;
    cloudUrl?: string;
    indexHtml?: string;
    webDistDir?: string;
  } = {},
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        config: {
          remote: "local",
          assistantName: opts.assistantName ?? "Homelab",
          assistantId: opts.assistantId ?? "assistant-1",
          hubUrl: PRODUCTION_HUB_URL,
          cloudUrl: opts.cloudUrl,
          version: "1.2.3",
        },
        webDistDir: opts.webDistDir ?? findWebDistDir(),
        version: "1.2.3",
        appDistDir: findAppDistDir(),
        appIndexHtml: FAKE_APP_INDEX_HTML,
        indexHtml: opts.indexHtml ?? FAKE_INDEX_HTML,
      }),
    )
    .digest("hex");
}

describe("the app shell edge", () => {
  pinProductionEnvironment();

  function appConf() {
    return buildNginxConfig({
      gatewayUrl: "http://127.0.0.1:7830",
      listenPort: 7840,

      webDistDir: "/tmp/cadet web/dist",
      appDistDir: "/tmp/cadet app/dist/standalone",
      config: {
        remote: "custom",
        assistantId: "assistant-1",
        version: "1.2.3",
      },
    });
  }

  test("serves the app bundle as the outer shell from the origin root", () => {
    const conf = appConf();
    // The injected app document is internal-only and every shell route
    // (/, /account/*, /logout, and the /assistant/* host routes) falls back
    // to it through the named location.
    expect(conf).toContain("location = /__cadet-app-index.html {");
    // Without an explicit app index path, the config aliases the bundle's own
    // index; the edge start path points this at the ingress dir (below).
    expect(conf).toContain('alias "/tmp/cadet app/dist/standalone/index.html"');
    expect(conf).toContain("location @cadet_app_shell {");
    expect(conf).toContain("rewrite ^ /__cadet-app-index.html last;");
    expect(conf).toContain(
      "location = / {\n      rewrite ^ /__cadet-app-index.html last;\n    }",
    );
    expect(conf).toContain('alias "/tmp/cadet app/dist/standalone/assets/";');
    expect(conf).toContain('alias "/tmp/cadet app/dist/standalone/";');
    // The shell owns the /assistant/* host routes; the exact mounts load the
    // app document rather than the web SPA.
    expect(conf).toContain(
      "location = /assistant {\n      rewrite ^ /__cadet-app-index.html last;\n    }",
    );
    expect(conf).toContain(
      "location = /assistant/ {\n      rewrite ^ /__cadet-app-index.html last;\n    }",
    );
    expect(conf).toContain("try_files $uri @cadet_app_shell;");
    // No recursive loading: the web SPA's exact mount is gone from the shell.
    expect(conf).not.toContain(
      "location = /assistant/ {\n      rewrite ^ /assistant/__remote-index.html last;\n    }",
    );
  });

  test("iframes the web UI from the distinct /web/assistant namespace", () => {
    const conf = appConf();
    expect(conf).toContain('location = "/v1/assistants/assistant-1/"');
    expect(conf).toContain('\\"url\\":\\"web/assistant/\\"');
    expect(conf).toContain('\\"version\\":\\"1.2.3\\"');
    expect(conf).toContain(
      "location = /web/assistant/ {\n      rewrite ^ /web/assistant/__remote-index.html last;\n    }",
    );
    expect(conf).toContain("location = /web/assistant/__remote-index.html {");
    expect(conf).toContain('alias "/tmp/cadet web/dist/index.html"');
    expect(conf).toContain("location = /web/assistant/__config {");
    expect(conf).toContain("location ^~ /web/assistant/ {");
    expect(conf).toContain(
      "try_files $uri $uri/ /web/assistant/__remote-index.html;",
    );
    // The web bundle's asset URLs keep their baked /assistant/ base.
    expect(conf).toContain(
      'location ^~ /assistant/assets/ {\n      gzip on;\n      alias "/tmp/cadet web/dist/assets/"',
    );
    // Prefixed API paths the web UI builds from its serving prefix.
    expect(conf).toContain("location ^~ /web/v1/ {");
    expect(conf).toContain("proxy_pass http://127.0.0.1:7830/v1/;");
    // Nothing else under /web is served by the edge: the twin forwards the
    // namespace's remainder to the gateway, which 404s unknown paths.
    expect(conf).toContain("location ~ ^/web/(?!assistant(?:/|$)|v1(?:/|$)) {");
  });

  test("blocks the sensitive gateway routes under both prefixes", () => {
    const conf = appConf();
    for (const route of ["/v1/pair", "/v1/devices", "/v1/guardian/init"]) {
      expect(conf).toContain(`location = ${route} { return 404; }`);
      expect(conf).toContain(`location = /web${route} { return 404; }`);
    }
  });

  test("proxies runtime API paths verbatim for both surfaces", () => {
    const conf = appConf();
    expect(conf).toContain(
      "location ^~ /v1/ {\n      proxy_pass http://127.0.0.1:7830;",
    );
    expect(conf).toContain(
      "location ^~ /webhooks/ {\n      proxy_pass http://127.0.0.1:7830;",
    );
    expect(conf).toContain(
      "location = /healthz {\n      proxy_pass http://127.0.0.1:7830;",
    );
  });

  test("starts, injects both documents, and records the edge fingerprint", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    expect(result.status).toBe("started");
    const ingressDir = getIngressPaths().dir;
    const appIndex = realFs.readFileSync(
      join(ingressDir, "app-index.html"),
      "utf-8",
    );
    expect(appIndex).toContain("__CADET_CONFIG__");
    expect(appIndex).toContain(`"assistantId":"assistant-1"`);
    const conf = realFs.readFileSync(ingressConfPath(), "utf-8");
    expect(conf).toContain("location = /__cadet-app-index.html {");
    expect(conf).toContain('\\"url\\":\\"web/assistant/\\"');
    // The served shell document must be the edge's INJECTED copy (which
    // carries the served config), never the raw dist index — that one only
    // carries the build-time vite stamp.
    expect(conf).toContain(`alias "${join(ingressDir, "app-index.html")}"`);
    expect(readIngressState()).toMatchObject({
      gatewayUrl: "http://127.0.0.1:7830",
      remoteWebConfigHash: appConfigHash({ assistantId: "assistant-1" }),
    });
  });

  test("stamps the saved tunnel URL as the served config's cloudUrl", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();
    // The record is the save: the edge reads its cloudUrl from there.
    stampTunnelRecord("https://camping.ngrok-free.dev");

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    expect(result.status).toBe("started");
    const appIndex = realFs.readFileSync(
      join(getIngressPaths().dir, "app-index.html"),
      "utf-8",
    );
    // Tunnel clients can only reach the origin they came in on, so the
    // account/auth surfaces' backend base is the tunnel URL, not the
    // loopback gateway seed.
    expect(appIndex).toContain(`"cloudUrl":"https://camping.ngrok-free.dev"`);
    // The URL rides the fingerprint: a changed tunnel URL rotates the edge.
    expect(readIngressState()).toMatchObject({
      remoteWebConfigHash: appConfigHash({
        assistantId: "assistant-1",
        cloudUrl: "https://camping.ngrok-free.dev",
      }),
    });
  });

  test("omits cloudUrl when no tunnel URL is on record", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    expect(result.status).toBe("started");
    const appIndex = realFs.readFileSync(
      join(getIngressPaths().dir, "app-index.html"),
      "utf-8",
    );
    // Omitted — the shell's same-origin fallbacks own it until a tunnel
    // saves a URL.
    expect(appIndex).not.toContain("cloudUrl");
  });

  test("fails fast when the app bundle is not built", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();
    // A real build in the checkout would satisfy the lookup; the failure
    // path needs the lookup to resolve nothing, regardless of checkout state.
    // Web dist stays present so the app-dist check is the one that fires.
    const previousExists = existsSyncMock.getMockImplementation();
    existsSyncMock.mockImplementation((path) => {
      const p = String(path);
      if (p.endsWith(APP_INDEX_SUFFIX)) return false;
      // The app auto-build must not run from the real checkout either.
      if (p.includes("clients/app/package.json")) return false;
      return previousExists ? previousExists(path) : realFs.existsSync(path);
    });

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    expect(result).toEqual({ status: "app-dist-missing" });
    expect(realFs.existsSync(ingressConfPath())).toBe(false);
  });

  test("reuses an already-running edge", async () => {
    makeWorkspace();
    seedAssistant();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();
    mockRunningEdge({
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:7830",
      remoteWebConfigHash: appConfigHash({ assistantId: "assistant-1" }),
    });
    const edge = mockKillableNginx(123_460);

    const result = await startAppServer({
      gatewayUrl: "http://127.0.0.1:7830",
      assistantId: "assistant-1",
    });

    expect(result).toMatchObject({
      status: "already-running",
    });
    expect(edge.killed()).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
