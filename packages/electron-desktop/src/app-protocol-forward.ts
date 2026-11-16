import { app, net, protocol, session } from "electron";
import { pathToFileURL } from "node:url";
import path from "node:path";

import { getVersionInfo } from "./about";
import log from "./app-logger";
import { type AllowedOrigin } from "./app-origin";
import { forwardCloudRequest } from "./cloud-forward";
import { getDeviceId } from "./device-id";
import {
  forwardOperatorRequest,
  getGuardianAccessToken,
  getGuardianTokenAsCookies,
  loadGuardianToken,
  readLockfile,
  resolveLocalConfigFromEnv,
  servedConfigFromLockfile,
} from "@mycadet/local-mode";
import { planAppProtocolAssetRequest } from "@mycadet/electron-utils/app-protocol";

/**
 * The `app://` protocol handler all three desktop clients share: one
 * ordered pass — host check, `/__config`, operator routes, gateway
 * proxy, cloud forward, then renderer assets (web bundle on
 * `/assistant`, app shell everywhere else) with an index.html fallback
 * that carries the injected config.
 */
const APP_PROTOCOL = "app";
const APP_HOST = "mycadet.ai";
const RENDERER_MOUNT = "/assistant";

/** The hatch row's operator path — the pairing cookie ships off its 200. */
const HATCH_PATH = "/v1/assistants/hatch";

/**
 * The lease's pair as the webview's jar entries — the same feed the hatch
 * response ships as Set-Cookie headers (which Electron's protocol handler
 * does not store), crossed into the session's cookie jar here instead.
 */
function leaseCookieJarEntries(assistantId: string): Promise<string[]> {
  // The stored pair (local/docker) ships whole — both jar entries the
  // gateway's own feed spells. Baseten holds a sandbox token instead of a
  // guardian pair: the access half alone still authenticates the dials.
  const pair = loadGuardianToken?.(assistantId);
  if (pair) return Promise.resolve(getGuardianTokenAsCookies(pair));
  return getGuardianAccessToken(assistantId).then((result) =>
    result.ok
      ? [
          `cadet_web_access=${encodeURIComponent(result.accessToken)}; HttpOnly; Path=/; SameSite=Strict`,
        ]
      : [],
  );
}

/** The cookie jar the webview's requests ride (Electron's `Cookies`). */
export interface PairingCookieSink {
  set: (details: {
    url: string;
    name: string;
    value: string;
    httpOnly?: boolean;
    path?: string;
  }) => Promise<void>;
}

const appOrigin = (): AllowedOrigin => ({
  protocol: `${APP_PROTOCOL}:`,
  host: APP_HOST,
});

// Every client resolves BOTH renderer roots the same way: packaged
// builds read the staged resources, dev reads the source-tree builds.
const repoRoot = (): string => path.resolve(app.getAppPath(), "..", "..");

const resolveAppDistRoot = (): string => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app-dist");
  }
  // Dev source tree: clients/app/dist/standalone — the standalone
  // target's outDir. Requires `bun run build` in clients/app/.
  return path.join(repoRoot(), "clients", "app", "dist", "standalone");
};

const resolveWebDistRoot = (): string => {
  if (app.isPackaged) {
    // Windows ships the web bundle once, inside the CLI runtime (the
    // installed copy under userData is a clone of that directory);
    // the other platforms stage it at the resources root. Packaged
    // macOS builds ship no web-dist at all (the web bundle is iframed
    // from the assistant's version), so that root stays empty.
    return process.platform === "win32"
      ? path.join(process.resourcesPath, "cli-runtime", "web-dist")
      : path.join(process.resourcesPath, "web-dist");
  }
  // Dev source tree: clients/web/dist. Requires `bun run build` in
  // clients/web/.
  return path.join(repoRoot(), "clients", "web", "dist");
};

/**
 * Ship the hatch's pairing credential up to the client: a successful
 * local/docker hatch leases a guardian token (the pairing), and the
 * webview's subsequent same-origin calls — the boot resolution's
 * `GET /v1/assistant` first among them — authenticate only when the
 * browser presents it. The main process owns the lease's import (the
 * renderer never sees the token in JS), so the credential crosses into
 * the webview as the gateway's browser access cookie (#576 cookie
 * custody) instead of any page-reachable handle.
 *
 * Everything here is best-effort: a hatch whose cookie ship fails still
 * succeeds (the response passes through untouched), and requests that are
 * not the hatch row pass straight through.
 */
export async function shipPairingCookie(
  request: Request,
  response: Response,
  sink: PairingCookieSink,
  accessTokenCookies: (assistantId: string) => Promise<string[]> = async (
    assistantId,
  ) => leaseCookieJarEntries(assistantId),
): Promise<void> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== HATCH_PATH) {
    return;
  }
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { ok?: boolean; assistantId?: unknown } | null;
  const assistantId =
    body?.ok && typeof body.assistantId === "string" ? body.assistantId : null;
  if (!assistantId) {
    return;
  }
  let cookies: string[] = [];
  try {
    cookies = await accessTokenCookies(assistantId);
  } catch (err) {
    log.warn("[pairing-cookie] guardian token read failed:", err);
    return;
  }
  for (const cookie of cookies) {
    // Each feed entry is the gateway's own Set-Cookie spelling:
    // name=<value>; attrs.
    const eq = cookie.indexOf("=");
    const semi = cookie.indexOf(";");
    if (eq <= 0) continue;
    const name = cookie.slice(0, eq).trim();
    const value = cookie.slice(eq + 1, semi === -1 ? undefined : semi).trim();
    if (!name || !value) continue;
    try {
      await sink.set({
        url: `${APP_PROTOCOL}://${APP_HOST}/`,
        name,
        value,
        httpOnly: cookie.toLowerCase().includes("httponly"),
        path: "/",
      });
    } catch (err) {
      log.warn("[pairing-cookie] cookie set failed:", err);
    }
  }
}

export function registerAppProtocol(): void {
  const webDistRoot = resolveWebDistRoot();
  const webIndexHtml = path.join(webDistRoot, "index.html");
  const appDistRoot = resolveAppDistRoot();
  const appIndexHtml = path.join(appDistRoot, "index.html");
  const cloudUrl = resolveLocalConfigFromEnv().cloudUrl;
  // Single origin: the injected config carries THIS host's origin as
  // `baseUrl` — the renderer's one origin for API, auth, and the assistant
  // mount. `cloudUrl` stays a host-side forward target only; it never
  // crosses into the renderer.
  const configJson = JSON.stringify({
    baseUrl: `${APP_PROTOCOL}://${APP_HOST}`,
    deviceId: getDeviceId() ?? undefined,
    version: getVersionInfo().version,
    ...servedConfigFromLockfile(readLockfile()),
  }).replace(/</g, "\\u003c");

  protocol.handle(APP_PROTOCOL, async (request) => {
    if (new URL(request.url).host !== APP_HOST) {
      return new Response("Forbidden", { status: 403 });
    }
    const pathname = new URL(request.url).pathname;
    if (pathname === "/assistant/__config" || pathname === "/__config") {
      return new Response(configJson, {
        headers: { "Content-Type": "application/json" },
      });
    }

    // The operator routes ride ahead of the gateway proxy.
    const operated = await forwardOperatorRequest(request);
    if (operated) {
      // A hatched pairing leases a guardian token — cross it into the
      // webview's cookie jar before the response lands, so the caller's
      // very next resolution dial presents it.
      await shipPairingCookie(request, operated, {
        set: (details) => session.defaultSession.cookies.set(details),
      });
      return operated;
    }

    // `/v1/*`, `/_allauth/*`, `/accounts/*` forward to the
    // cloud so managed mode and desktop replay ingest work.
    const cloudProxied = await forwardCloudRequest({
      request,
      cloudBase: cloudUrl,
      fetcher: net.fetch,
      allowedOrigin: appOrigin(),
      log,
    });
    if (cloudProxied) {
      return cloudProxied;
    }

    // The `/assistant` mount serves the web bundle; every other path
    // is the app shell.
    const isWebMount = pathname.startsWith(RENDERER_MOUNT);
    const asset = await planAppProtocolAssetRequest({
      rendererRoot: isWebMount ? webDistRoot : appDistRoot,
      indexHtml: isWebMount ? webIndexHtml : appIndexHtml,
      requestUrl: request.url,
      mountPrefix: isWebMount ? RENDERER_MOUNT : undefined,
      allowedOrigin: appOrigin(),
    });
    if (asset.kind === "forbidden") {
      return new Response("Forbidden", { status: 403 });
    }
    if (asset.kind === "fetch") {
      const response = await net.fetch(pathToFileURL(asset.path).toString());
      if (asset.path !== appIndexHtml && asset.path !== webIndexHtml) {
        return response;
      }
      const html = await response.text();
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.set("content-type", "text/html; charset=utf-8");
      const finalHtml =
        asset.path === webIndexHtml
          ? html.replace(
              "</head>",
              `<script>window.__CADET_CONFIG__=${configJson}</script></head>`,
            )
          : html;
      return new Response(finalHtml, { status: response.status, headers });
    }
    return new Response("Not Found", { status: 404 });
  });
}
