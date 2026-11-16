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

/**
 * Browser-like cookie custody for the single-origin protocol: Electron's
 * `protocol.handle` does not store a response's Set-Cookie headers into
 * the session's cookie jar — the headers ride the wire but never land —
 * so the handler does what the browser would have done: every response
 * through the pass has its Set-Cookie applied to the jar for the
 * request's own origin. The hatch's pairing feed, the gateway's rotation
 * refreshes — anything a forward hands back — lands.
 *
 * Best-effort: a cookie that fails to set never fails the response.
 */
async function applyResponseCookies(
  request: Request,
  response: Response,
): Promise<void> {
  for (const raw of response.headers.getSetCookie()) {
    const details = cookieJarDetails(request.url, raw);
    if (!details) continue;
    try {
      await session.defaultSession.cookies.set(details);
    } catch (err) {
      log.warn("[protocol-cookies] set failed:", err);
    }
  }
}

function cookieJarDetails(
  url: string,
  raw: string,
): Electron.CookiesSetDetails | null {
  const [pair, ...attrs] = raw.split(";");
  const eq = pair.indexOf("=");
  if (eq <= 0) return null;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!name) return null;
  const details: Electron.CookiesSetDetails = { url, name, value };
  let maxAge: number | undefined;
  for (const attr of attrs) {
    const sep = attr.indexOf("=");
    const attrName = (sep === -1 ? attr : attr.slice(0, sep))
      .trim()
      .toLowerCase();
    const attrValue = sep === -1 ? "" : attr.slice(sep + 1).trim();
    if (attrName === "path") {
      details.path = attrValue || undefined;
    } else if (attrName === "secure") {
      details.secure = true;
    } else if (attrName === "httponly") {
      details.httpOnly = true;
    } else if (attrName === "samesite") {
      const site = attrValue.toLowerCase();
      details.sameSite =
        site === "strict"
          ? "strict"
          : site === "lax"
            ? "lax"
            : site === "none"
              ? "no_restriction"
              : "unspecified";
    } else if (attrName === "max-age") {
      const parsed = Number(attrValue);
      if (Number.isFinite(parsed)) maxAge = parsed;
    } else if (attrName === "expires" && details.expirationDate === undefined) {
      const parsed = Date.parse(attrValue);
      if (Number.isFinite(parsed)) details.expirationDate = parsed / 1000;
    }
  }
  if (maxAge !== undefined) {
    details.expirationDate = Math.floor(Date.now() / 1000) + maxAge;
  }
  return details;
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

  const respond = async (request: Request): Promise<Response> => {
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
  };

  protocol.handle(APP_PROTOCOL, async (request) => {
    const response = await respond(request);
    await applyResponseCookies(request, response);
    return response;
  });
}
