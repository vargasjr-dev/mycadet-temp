import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import type { Plugin, Connect, ViteDevServer } from "vite";

import {
  resolveLocalConfigFromEnv,
  resolveDevCliInvocation,
  isLoopbackAddr,
  headerHostIsLoopback,
  originIsAllowed,
  hasSameOriginCredentialProof,
  getLockfileData,
  getLocalAssistantStatus,
  readLockfileAssistantAvatar,
  renameLockfileAssistantIfPresent,
  stampLockfileAssistantOnboardedIfPresent,
  upsertRendererLockfileAssistant,
  replaceCloudAssistants,
  isActiveAssistant,
  isPairedLockfileEntry,
  PAIRED_GUARDIAN_TOKEN_HOST_ONLY_ERROR,
  runDevicesList,
  runDevicesRevoke,
  runHatch,
  runRetire,
  runSleep,
  runUpgrade,
  runWake,
  pairingCancel,
  pairingPoll,
  pairingStart,
  unpairAssistant,
  getGuardianAccessToken,
  getPairedGuardianAccessToken,
  resolveGatewayProxyTarget,
  readGatewayTargets,
  authorizePairedForwardHeaders,
  type CliInvocation,
} from "@mycadet/local-mode";
import { stampedVersion } from "@mycadet/shared/version";
import cliPkg from "../../cli/package.json";

// The local host's own routes live at the conductor's /v1 shapes: assistant
// lifecycle operations at the conductor's assistants paths, pairing under the
// gateway's remote-web namespace, device management at the gateway's devices
// routes, and the dev session store at /v1/session. The scoped assistant
// routes (detail/avatar/retire/wake/sleep) are intercepted before the
// id-keyed gateway proxy below for host-managed entries; paired and cloud
// entries pass through to that proxy.
const GUARDIAN_TOKEN_PATTERN = /^\/v1\/assistants\/([^/]+)\/guardian-token$/;
const LOCAL_STATUS_PATTERN = /^\/v1\/assistants\/([^/]+)\/?$/;
const LOCAL_AVATAR_PATTERN = /^\/v1\/assistants\/([^/]+)\/avatar\/get$/;
const LOCAL_UPGRADE_PATTERN = /^\/v1\/assistants\/([^/]+)\/upgrade\/?$/;
const LOCAL_RETIRE_PATTERN = /^\/v1\/assistants\/([^/]+)\/retire\/?$/;
const LOCAL_UNPAIR_PATTERN = /^\/v1\/assistants\/([^/]+)\/unpair\/?$/;
const LOCAL_SLEEP_PATTERN = /^\/v1\/assistants\/([^/]+)\/sleep\/?$/;
const LOCAL_WAKE_PATTERN = /^\/v1\/assistants\/([^/]+)\/wake\/?$/;
const CLOUD_SESSION_PATTERN = /^\/v1\/session$/;

function requestPathname(req: http.IncomingMessage): string {
  return (req.url ?? "").split("?")[0]!;
}

function lockfileEntryFor(lockfilePaths: string[], assistantId: string) {
  const result = getLockfileData(lockfilePaths);
  if (!result.ok) {
    return undefined;
  }
  return result.data.assistants.find((a) => a.assistantId === assistantId);
}

/**
 * Whether the middleware serves a scoped assistant route itself instead of
 * passing the request to the id-keyed gateway proxy: the entry is host-managed
 * (a locally hatched or dockerized assistant — the operation runs on this
 * machine), not paired (the entry's assistant lives behind its recorded
 * runtimeUrl, which the gateway proxy forwards to) and not platform-managed
 * (a cloud entry, served by the conductor through the dev `/v1` proxy).
 */
function isHostManagedEntry(
  lockfilePaths: string[],
  assistantId: string,
): boolean {
  const entry = lockfileEntryFor(lockfilePaths, assistantId);
  return (
    entry != null &&
    entry.cloud !== "cloud" &&
    !isPairedLockfileEntry(lockfilePaths, assistantId)
  );
}

// In-memory loopback cloud session token for the dev server. The proxy
// (vite.config.ts) and the middleware below run in the same Node process, so
// this module singleton bridges them. Dev-only and session-scoped; the
// installed CLI persists the token via its own store.
let devCloudSessionToken: string | null = null;
export function getDevCloudSessionToken(): string | null {
  return devCloudSessionToken;
}

/**
 * Whether a proxied request is same-origin SPA traffic that may carry a
 * host-owned credential. A cross-origin page must not be able to use the dev
 * proxy as a confused deputy. Mirrors the Bun server's check.
 */
export function isSameOriginProxyRequest(req: http.IncomingMessage): boolean {
  const host = Array.isArray(req.headers.host)
    ? req.headers.host[0]
    : req.headers.host;
  const origin = Array.isArray(req.headers.origin)
    ? req.headers.origin[0]
    : req.headers.origin;
  const site = req.headers["sec-fetch-site"];
  const siteValue = Array.isArray(site) ? site[0] : site;
  return hasSameOriginCredentialProof(host, origin, siteValue);
}

export function localModePlugin(env: Record<string, string>): Plugin {
  const config = resolveLocalConfigFromEnv(env);
  const baseDir = path.resolve(import.meta.dirname, "..", "..");

  // The `/assistant/__config` document, also injected into the index. No
  // `assistantId`: the dev server fronts every assistant in the lockfile at
  // once, so it has no single identity to report the way an nginx edge does.
  // `version` is stamped here the same way `cadet --version` stamps itself,
  // so the page's version row answers the same thing `cadet-local --version`
  // does and nothing can override it out of band.
  const configJson = JSON.stringify({
    cloudUrl: config.cloudUrl,
    version: stampedVersion(cliPkg.version),
  });

  return {
    name: "cadet-local-mode",
    transformIndexHtml(html) {
      return html.replace(
        "</head>",
        `<script>window.__CADET_CONFIG__=${configJson}</script></head>`,
      );
    },
    configureServer(server) {
      server.middlewares.use(loopbackCallbackMiddleware());
      server.middlewares.use(cloudSessionMiddleware());
      server.middlewares.use(configMiddleware(configJson));
      server.middlewares.use(lockfileMiddleware(config.lockfilePaths));
      server.middlewares.use(hatchMiddleware(baseDir));
      server.middlewares.use(retireMiddleware(baseDir, config.lockfilePaths));
      server.middlewares.use(
        unpairMiddleware(config.lockfilePaths, config.configDir),
      );
      server.middlewares.use(
        pairingMiddleware(config.lockfilePaths, config.configDir),
      );
      server.middlewares.use(sleepMiddleware(baseDir, config.lockfilePaths));
      server.middlewares.use(wakeMiddleware(baseDir, config.lockfilePaths));
      server.middlewares.use(devicesMiddleware(baseDir));
      const upgradingLocalAssistantIds = new Set<string>();
      server.middlewares.use(
        upgradeMiddleware(
          baseDir,
          config.lockfilePaths,
          upgradingLocalAssistantIds,
        ),
      );
      server.middlewares.use(
        statusMiddleware(config.lockfilePaths, upgradingLocalAssistantIds),
      );
      server.middlewares.use(avatarMiddleware(config.lockfilePaths, env));
      server.middlewares.use(
        guardianTokenMiddleware(
          config.lockfilePaths,
          config.configDir,
          baseDir,
          env,
        ),
      );
      server.middlewares.use(
        gatewayProxyMiddleware(
          config.lockfilePaths,
          config.configDir,
          baseDir,
          env,
        ),
      );
      server.middlewares.use(accountSpaFallback(server));
    },
  };
}

function respondJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/**
 * Buffer and parse a JSON request body. An empty body resolves to `{}` (the
 * per-field validation reports what's missing); malformed JSON resolves to
 * `null`.
 */
function readJsonBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(
          JSON.parse(Buffer.concat(chunks).toString()) as Record<
            string,
            unknown
          >,
        );
      } catch {
        resolve(null);
      }
    });
  });
}

function rejectUnlessLocalEndpointRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const peer = req.socket.remoteAddress ?? "";
  const host = Array.isArray(req.headers.host)
    ? req.headers.host[0]
    : req.headers.host;
  const origin = Array.isArray(req.headers.origin)
    ? req.headers.origin[0]
    : req.headers.origin;
  if (
    !isLoopbackAddr(peer) ||
    !headerHostIsLoopback(host) ||
    !originIsAllowed(origin)
  ) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Forbidden" }));
    return true;
  }
  return false;
}

function loopbackCallbackMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (req.url?.startsWith("/callback")) {
      const qs = req.url.slice("/callback".length);
      res.writeHead(302, { Location: `/account/cloud-callback${qs}` });
      res.end();
      return;
    }
    next();
  };
}

// Receives the loopback platform session token from the SPA (after it has
// validated the `state` nonce) and holds it for the proxy. Mirrors the Bun
// server's /__local/cloud-session endpoint.
function cloudSessionMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const path = (req.url ?? "").split("?")[0];
    if (!CLOUD_SESSION_PATTERN.test(path)) {
      return next();
    }
    if (rejectUnlessLocalEndpointRequest(req, res)) {
      return;
    }

    if (req.method === "DELETE") {
      devCloudSessionToken = null;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let token: unknown;
      try {
        token = (
          JSON.parse(Buffer.concat(chunks).toString()) as { token?: unknown }
        ).token;
      } catch {
        token = undefined;
      }
      if (typeof token !== "string" || !/^[A-Za-z0-9]+$/.test(token)) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: false, error: "Invalid token" }));
        return;
      }
      devCloudSessionToken = token;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  };
}

function configMiddleware(configJson: string): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (req.url !== "/assistant/__config" && req.url !== "/__config") {
      return next();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(configJson);
  };
}

function accountSpaFallback(server: ViteDevServer): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (
      !req.url?.startsWith("/account/") &&
      !req.url?.startsWith("/account?") &&
      req.url !== "/account"
    ) {
      return next();
    }

    const indexPath = path.join(server.config.root, "index.html");
    fs.readFile(indexPath, "utf-8", (err, html) => {
      if (err) {
        return next(err);
      }
      server
        .transformIndexHtml(req.url!, html)
        .then((transformed) => {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(transformed);
        })
        .catch(next);
    });
  };
}

function lockfileMiddleware(
  lockfilePaths: string[],
): Connect.NextHandleFunction {
  return (req, res, next) => {
    // Bare `/v1/assistants/` only: the SDK's list request (query-carrying)
    // passes through to the dev `/v1` proxy and the conductor's list route.
    if (requestPathname(req) !== "/v1/assistants/") {
      return next();
    }

    if (rejectUnlessLocalEndpointRequest(req, res)) {
      return;
    }

    if (req.method === "GET") {
      const result = getLockfileData(lockfilePaths);
      if (result.ok) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result.data));
      } else {
        res.statusCode = result.status;
        res.end();
      }
    } else if (req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString()) as Record<
            string,
            unknown
          >;
        } catch {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
          return;
        }

        let result;
        if (body.syncPlatform && Array.isArray(body.cloudAssistants)) {
          result = replaceCloudAssistants(
            lockfilePaths,
            body.cloudAssistants as Array<Record<string, unknown>>,
            body.organizationId as string | undefined,
          );
        } else if (body.rename && typeof body.rename === "object") {
          const rename = body.rename as Record<string, unknown>;
          result = renameLockfileAssistantIfPresent(
            lockfilePaths,
            rename.assistantId as string,
            rename.name as string,
          );
        } else if (body.onboarded && typeof body.onboarded === "object") {
          const onboarded = body.onboarded as Record<string, unknown>;
          result = stampLockfileAssistantOnboardedIfPresent(
            lockfilePaths,
            onboarded.assistantId as string,
            onboarded.onboardedAt as string,
          );
        } else {
          result = upsertRendererLockfileAssistant(
            lockfilePaths,
            body.assistant as Record<string, unknown>,
            body.activeAssistant as string | undefined,
          );
        }
        res.statusCode = result.ok ? 200 : result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result));
      });
    } else {
      res.statusCode = 405;
      res.end();
    }
  };
}

function hatchMiddleware(baseDir: string): Connect.NextHandleFunction {
  return (req, res, next) => {
    // The conductor's create flow marks itself with `?mode=create` and passes
    // through to the dev `/v1` proxy; a plain POST hatches locally.
    if (
      requestPathname(req) !== "/v1/assistants/hatch" ||
      (req.url ?? "").includes("mode=create")
    ) {
      return next();
    }

    if (rejectUnlessLocalEndpointRequest(req, res)) {
      return;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let species = "cadet";
      let remote: string | undefined;
      if (chunks.length > 0) {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as {
            species?: string;
            remote?: string;
          };
          if (body.species) {
            species = body.species;
          }
          if (body.remote) {
            remote = body.remote;
          }
        } catch {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
          return;
        }
      }

      let invocation: CliInvocation;
      try {
        invocation = resolveDevCliInvocation(baseDir, import.meta.url);
      } catch (err) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        return;
      }

      runHatch(invocation, species, remote ? { remote } : undefined).then(
        (result) => {
          res.statusCode = result.ok ? 200 : result.status;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify(
              result.ok
                ? { ok: true, assistantId: result.assistantId }
                : { ok: false, error: result.error },
            ),
          );
        },
      );
    });
  };
}

function retireMiddleware(
  baseDir: string,
  lockfilePaths: string[],
): Connect.NextHandleFunction {
  return (req, res, next) => {
    const match = requestPathname(req).match(LOCAL_RETIRE_PATTERN);
    if (!match) {
      return next();
    }

    if (rejectUnlessLocalEndpointRequest(req, res)) {
      return;
    }

    if (req.method !== "DELETE") {
      res.statusCode = 405;
      res.end();
      return;
    }

    const assistantId = decodeURIComponent(match[1]!);
    if (
      !isHostManagedEntry(lockfilePaths, assistantId) ||
      !isActiveAssistant(lockfilePaths, assistantId)
    ) {
      // Paired entries retire behind their recorded runtimeUrl (the gateway
      // proxy forwards), cloud entries through the conductor's own retire
      // route on the dev `/v1` proxy.
      return next();
    }

    let invocation: CliInvocation;
    try {
      invocation = resolveDevCliInvocation(baseDir, import.meta.url);
    } catch (err) {
      respondJson(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    void runRetire(invocation, assistantId, {
      cloudToken: getDevCloudSessionToken() ?? undefined,
    }).then((result) => {
      respondJson(
        res,
        result.ok ? 200 : result.status,
        result.ok ? { ok: true } : { ok: false, error: result.error },
      );
    });
  };
}

function unpairMiddleware(
  lockfilePaths: string[],
  configDir: string,
): Connect.NextHandleFunction {
  return (req, res, next) => {
    const match = requestPathname(req).match(LOCAL_UNPAIR_PATTERN);
    if (!match) {
      return next();
    }

    if (rejectUnlessLocalEndpointRequest(req, res)) {
      return;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }

    const assistantId = decodeURIComponent(match[1]!);
    if (lockfileEntryFor(lockfilePaths, assistantId) == null) {
      // Not an entry on this machine — the id-keyed proxy resolves the rest
      // (the conductor's routes for a cloud id).
      return next();
    }

    const result = unpairAssistant(lockfilePaths, configDir, assistantId);
    respondJson(
      res,
      result.ok ? 200 : result.status,
      result.ok
        ? { ok: true, lockfile: result.lockfile }
        : { ok: false, error: result.error },
    );
  };
}

/** The three pairing routes, under the gateway's remote-web namespace. */
const PAIRING_ROUTES = ["pairing-start", "pairing-poll", "pairing-cancel"];

function pairingRoute(url: string | undefined): string | null {
  const path = (url ?? "").split("?")[0];
  for (const route of PAIRING_ROUTES) {
    if (path === `/v1/remote-web/${route}`) {
      return route;
    }
  }
  return null;
}

/**
 * The device-code exchange that registers an assistant paired on another
 * machine: start an attempt from a pasted address, poll it until the host
 * approves, cancel it on the way out. It runs here rather than in the browser,
 * so the device code and the credentials it buys never reach the renderer.
 */
function pairingMiddleware(
  lockfilePaths: string[],
  configDir: string,
): Connect.NextHandleFunction {
  return (req, res, next) => {
    const route = pairingRoute(req.url);
    if (route === null) {
      return next();
    }

    if (rejectUnlessLocalEndpointRequest(req, res)) {
      return;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }

    void readJsonBody(req).then(async (body) => {
      if (!body) {
        respondJson(res, 400, { ok: false, error: "Invalid JSON body" });
        return;
      }

      if (route === "pairing-cancel") {
        respondJson(res, 200, { ok: pairingCancel(body.handle) });
        return;
      }

      if (route === "pairing-start") {
        const result = await pairingStart(body.address);
        respondJson(
          res,
          result.ok ? 200 : result.status,
          result.ok
            ? {
                ok: true,
                handle: result.handle,
                userCode: result.userCode,
                expiresAt: result.expiresAt,
                intervalSeconds: result.intervalSeconds,
              }
            : // `rejection` rides along so the renderer can show its own
              // localized copy for a refused address instead of this host's
              // English.
              {
                ok: false,
                reason: result.reason,
                error: result.error,
                rejection: result.rejection,
              },
        );
        return;
      }

      const result = await pairingPoll(lockfilePaths, configDir, {
        handle: body.handle,
        name: body.name,
      });
      if (!result.ok) {
        respondJson(res, result.status, {
          ok: false,
          reason: result.reason,
          error: result.error,
        });
        return;
      }
      respondJson(
        res,
        200,
        result.status === "pending"
          ? {
              ok: true,
              status: "pending",
              expiresAt: result.expiresAt,
              intervalSeconds: result.intervalSeconds,
            }
          : {
              ok: true,
              status: "imported",
              assistantId: result.assistantId,
              accessOnly: result.accessOnly,
            },
      );
    });
  };
}

function sleepMiddleware(
  baseDir: string,
  lockfilePaths: string[],
): Connect.NextHandleFunction {
  return (req, res, next) => {
    const match = requestPathname(req).match(LOCAL_SLEEP_PATTERN);
    if (!match) {
      return next();
    }

    if (rejectUnlessLocalEndpointRequest(req, res)) {
      return;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }

    const assistantId = decodeURIComponent(match[1]!);
    if (!isHostManagedEntry(lockfilePaths, assistantId)) {
      return next();
    }

    let invocation: CliInvocation;
    try {
      invocation = resolveDevCliInvocation(baseDir, import.meta.url);
    } catch (err) {
      respondJson(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    void runSleep(invocation, assistantId).then((result) => {
      respondJson(
        res,
        result.ok ? 200 : result.status,
        result.ok ? { ok: true } : { ok: false, error: result.error },
      );
    });
  };
}

function wakeMiddleware(
  baseDir: string,
  lockfilePaths: string[],
): Connect.NextHandleFunction {
  return (req, res, next) => {
    const match = requestPathname(req).match(LOCAL_WAKE_PATTERN);
    if (!match) {
      return next();
    }

    if (rejectUnlessLocalEndpointRequest(req, res)) {
      return;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }

    const assistantId = decodeURIComponent(match[1]!);
    if (!isHostManagedEntry(lockfilePaths, assistantId)) {
      // A paired entry's wake rides the gateway proxy to its recorded
      // runtimeUrl (the shell's not-ready panel wakes through it).
      return next();
    }

    void readJsonBody(req).then((body) => {
      const repairGuardian = body?.repairGuardian === true;

      let invocation: CliInvocation;
      try {
        invocation = resolveDevCliInvocation(baseDir, import.meta.url);
      } catch (err) {
        respondJson(res, 500, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      void runWake(invocation, assistantId, { repairGuardian }).then(
        (result) => {
          respondJson(
            res,
            result.ok ? 200 : result.status,
            result.ok ? { ok: true } : { ok: false, error: result.error },
          );
        },
      );
    });
  };
}

// Paired-device management via the CLI (`cadet devices … --json`). POST-only
// (the renderer's postLocalCommand always POSTs); run-helper results respond
// 200 with `ok` discriminating success so all hosts share one wire shape.
function devicesMiddleware(baseDir: string): Connect.NextHandleFunction {
  return (req, res, next) => {
    const isRevoke = requestPathname(req) === "/v1/devices/revoke";
    if (!isRevoke && requestPathname(req) !== "/v1/devices") {
      return next();
    }

    if (rejectUnlessLocalEndpointRequest(req, res)) {
      return;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }

    void readJsonBody(req).then((body) => {
      if (!body) {
        respondJson(res, 400, { ok: false, error: "Invalid JSON body" });
        return;
      }

      const assistantId = body.assistantId;
      if (typeof assistantId !== "string" || !assistantId) {
        respondJson(res, 400, { ok: false, error: "Missing assistantId" });
        return;
      }

      let revokeHash: string | null = null;
      if (isRevoke) {
        const hashedDeviceId = body.hashedDeviceId;
        if (typeof hashedDeviceId !== "string" || !hashedDeviceId) {
          respondJson(res, 400, { ok: false, error: "Missing hashedDeviceId" });
          return;
        }
        revokeHash = hashedDeviceId;
      }

      let invocation: CliInvocation;
      try {
        invocation = resolveDevCliInvocation(baseDir, import.meta.url);
      } catch (err) {
        respondJson(res, 500, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      if (revokeHash !== null) {
        void runDevicesRevoke(invocation, assistantId, revokeHash).then(
          (result) => {
            respondJson(res, 200, result);
          },
        );
        return;
      }
      void runDevicesList(invocation, assistantId).then((result) => {
        respondJson(res, 200, result);
      });
    });
  };
}

function upgradeMiddleware(
  baseDir: string,
  lockfilePaths: string[],
  upgradingLocalAssistantIds: Set<string>,
): Connect.NextHandleFunction {
  return (req, res, next) => {
    const match = requestPathname(req).match(LOCAL_UPGRADE_PATTERN);
    if (!match) {
      return next();
    }

    if (rejectUnlessLocalEndpointRequest(req, res)) {
      return;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }

    const pathAssistantId = decodeURIComponent(match[1]!);
    if (!isHostManagedEntry(lockfilePaths, pathAssistantId)) {
      return next();
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let latest = false;
      let force = false;
      let version: string | undefined;
      if (chunks.length > 0) {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as {
            latest?: boolean;
            force?: boolean;
            version?: string;
          };
          latest = body.latest === true;
          force = body.force === true;
          version = body.version;
        } catch {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
          return;
        }
      }

      const assistantId = pathAssistantId;
      if (!isActiveAssistant(lockfilePaths, assistantId)) {
        res.statusCode = 403;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            ok: false,
            error: "Can only upgrade the active local assistant",
          }),
        );
        return;
      }

      if (upgradingLocalAssistantIds.has(assistantId)) {
        res.statusCode = 409;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            ok: false,
            error: "An upgrade is already in progress for this assistant.",
          }),
        );
        return;
      }

      let invocation: CliInvocation;
      try {
        invocation = resolveDevCliInvocation(baseDir, import.meta.url);
      } catch (err) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        return;
      }

      const options = {
        ...(latest ? { latest } : {}),
        ...(version ? { version } : {}),
        ...(force ? { force } : {}),
      };

      upgradingLocalAssistantIds.add(assistantId);
      runUpgrade(invocation, assistantId, options)
        .then((result) => {
          res.statusCode = result.ok ? 200 : result.status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(result));
        })
        .finally(() => {
          upgradingLocalAssistantIds.delete(assistantId);
        });
    });
  };
}

function statusMiddleware(
  lockfilePaths: string[],
  upgradingLocalAssistantIds: Set<string>,
): Connect.NextHandleFunction {
  return (req, res, next) => {
    const match = requestPathname(req).match(LOCAL_STATUS_PATTERN);
    if (!match) {
      return next();
    }

    if (rejectUnlessLocalEndpointRequest(req, res)) {
      return;
    }

    if (req.method !== "GET") {
      res.statusCode = 405;
      res.end();
      return;
    }

    const assistantId = decodeURIComponent(match[1]!);
    if (!isHostManagedEntry(lockfilePaths, assistantId)) {
      // Paired entries resolve behind their recorded runtimeUrl and cloud
      // entries through the conductor — the id-keyed proxies own those.
      return next();
    }

    if (upgradingLocalAssistantIds.has(assistantId)) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, state: "upgrading" }));
      return;
    }

    void getLocalAssistantStatus(lockfilePaths, assistantId).then((result) => {
      res.statusCode = result.ok ? 200 : result.status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
    });
  };
}

function avatarMiddleware(
  lockfilePaths: string[],
  env: Record<string, string>,
): Connect.NextHandleFunction {
  return (req, res, next) => {
    const match = requestPathname(req).match(LOCAL_AVATAR_PATTERN);
    if (!match) {
      return next();
    }

    if (rejectUnlessLocalEndpointRequest(req, res)) {
      return;
    }

    if (req.method !== "GET") {
      res.statusCode = 405;
      res.end();
      return;
    }

    let assistantId: string;
    try {
      assistantId = decodeURIComponent(match[1]!);
    } catch {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, error: "Malformed assistant ID" }));
      return;
    }
    if (!isHostManagedEntry(lockfilePaths, assistantId)) {
      return next();
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        readLockfileAssistantAvatar(lockfilePaths, assistantId, env),
      ),
    );
  };
}

function guardianTokenMiddleware(
  lockfilePaths: string[],
  configDir: string,
  baseDir: string,
  env: Record<string, string>,
): Connect.NextHandleFunction {
  return (req, res, next) => {
    const match = requestPathname(req).match(GUARDIAN_TOKEN_PATTERN);
    if (!match) {
      return next();
    }

    if (req.method !== "GET") {
      res.statusCode = 405;
      res.end();
      return;
    }

    if (rejectUnlessLocalEndpointRequest(req, res)) {
      return;
    }

    const assistantId = decodeURIComponent(match[1]!);

    if (lockfileEntryFor(lockfilePaths, assistantId) == null) {
      return next();
    }

    if (isPairedLockfileEntry(lockfilePaths, assistantId)) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: PAIRED_GUARDIAN_TOKEN_HOST_ONLY_ERROR }));
      return;
    }

    let invocation: CliInvocation;
    try {
      invocation = resolveDevCliInvocation(baseDir, import.meta.url);
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return;
    }

    getGuardianAccessToken(assistantId, configDir, invocation, true, env, {
      paired: false,
    }).then((result) => {
      if (result.ok) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ accessToken: result.accessToken }));
      } else {
        res.statusCode = result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: result.error }));
      }
    });
  };
}

function gatewayProxyMiddleware(
  lockfilePaths: string[],
  configDir: string,
  baseDir: string,
  env: Record<string, string>,
): Connect.NextHandleFunction {
  return (req, res, next) => {
    // Gateway data plane. The scoped SDK surface (`/v1/assistants/{id}/*`)
    // and the legacy unscoped prefix (`/assistant/__gateway/{id}/*`,
    // `/auth/token` mint and `/readyz` until they fold into `/v1`) share one
    // id-keyed proxy for every assistant gateway. The lockfile resolves the
    // id to a loopback port (locally hatched) or a recorded remote
    // `runtimeUrl` (imported pairing) — that target map is the allowlist.
    // Loopback hops forward the renderer's headers (notably its minted
    // gateway bearer) with the Host rewritten; remote hops strip renderer
    // authorization and browser-ambient headers on this server-to-server
    // hop, and the dev-server host reads the paired guardian bearer from
    // disk and installs it after sanitization. An unknown id on the scoped
    // surface passes through to the dev `/v1` proxy (the cloud), so cloud
    // assistants keep their platform-served routes.
    const decision = resolveGatewayProxyTarget(req.url ?? "", () =>
      readGatewayTargets(lockfilePaths),
    );
    if (decision.kind === "pass") {
      return next();
    }

    if (rejectUnlessLocalEndpointRequest(req, res)) {
      return;
    }

    if (decision.kind === "reject") {
      res.statusCode = decision.status;
      res.end(decision.message);
      return;
    }

    if (decision.target.kind === "loopback") {
      const { port } = decision.target;
      pipeGatewayProxy(
        req,
        res,
        http,
        {
          hostname: "127.0.0.1",
          port,
          path: decision.path + decision.search,
          method: req.method,
          headers: {
            ...req.headers,
            host: `127.0.0.1:${port}`,
          },
        },
        "Gateway proxy error",
      );
      return;
    }

    if (!isSameOriginProxyRequest(req)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    let invocation: CliInvocation;
    try {
      invocation = resolveDevCliInvocation(baseDir, import.meta.url);
    } catch (err) {
      res.statusCode = 500;
      res.end(err instanceof Error ? err.message : String(err));
      return;
    }

    const target = new URL(decision.target.runtimeUrl);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) {
        continue;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          headers.append(name, item);
        }
      } else {
        headers.set(name, value);
      }
    }
    void authorizePairedForwardHeaders(
      decision.assistantId,
      decision.target.runtimeUrl,
      headers,
      (assistantId, runtimeUrl) =>
        getPairedGuardianAccessToken(
          assistantId,
          runtimeUrl,
          configDir,
          invocation,
          true,
          env,
        ),
    ).then((result) => {
      if (!result.ok) {
        res.statusCode = result.status;
        res.end(result.error);
        return;
      }
      headers.set("host", target.host);
      pipeGatewayProxy(
        req,
        res,
        target.protocol === "https:" ? https : http,
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || undefined,
          path: decision.path + decision.search,
          method: req.method,
          headers: Object.fromEntries(headers.entries()),
        },
        "Paired gateway proxy error",
      );
    });
  };
}

// One streamed hop for both gateway data-plane proxies. Drops the upstream's
// `transfer-encoding` before re-emitting: Node's http server sets its own when
// we pipe the streamed body, so copying the gateway's `chunked` too yields a
// duplicate ("too many transfer encodings"). A strict downstream proxy (the
// `vel up` Caddy edge) rejects that with 502, fatal for the SSE `/events`
// stream, whose failure drives a client reconnect + full-refetch loop.
function pipeGatewayProxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  transport: Pick<typeof http, "request">,
  options: http.RequestOptions,
  errorMessage: string,
): void {
  const proxyReq = transport.request(options, (proxyRes) => {
    const headers = { ...proxyRes.headers };
    delete headers["transfer-encoding"];
    res.writeHead(proxyRes.statusCode ?? 502, headers);
    proxyRes.pipe(res);
  });

  proxyReq.on("error", () => {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.end(errorMessage);
    }
  });

  req.pipe(proxyReq);
}
