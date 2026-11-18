import { app, net, protocol, session } from "electron";
import { pathToFileURL } from "node:url";
import path from "node:path";

import log from "./app-logger";
import { type AllowedOrigin } from "./app-origin";
import { getDeviceId } from "./device-id";
import {
  forwardOperatorRequest,
  readLockfile,
  servedConfigFromLockfile,
  type CookieJar,
} from "@mycadet/local-mode";
import { planAppProtocolAssetRequest } from "@mycadet/electron-utils/app-protocol";

/**
 * The `app://` protocol handler all three desktop clients share: one
 * ordered pass — host check, `/__config`, operator routes (whose
 * fallthrough arm forwards the cloud's own account paths — `/_allauth`
 * and `/accounts`), then renderer assets (web
 * bundle on `/assistant`, app shell everywhere else) with an index.html
 * fallback that carries the injected config.
 */
const APP_PROTOCOL = "app";
const APP_HOST = "mycadet.ai";
const RENDERER_MOUNT = "/assistant";

/**
 * The session jar, as the `CookieJar` the operator route table speaks.
 * The pair the hatch mints (and every gateway rotation since) must live
 * in Chromium's store for the entry's gateway origin — the renderer's
 * `app://` origin can hold no cookies (the store refuses non-`http(s)`
 * schemes) and `protocol.handle` jars nothing on its own — while the
 * proxy row's dial, made host-side, can no more see that store than the
 * renderer can: this adapter is the bridge in both directions. Best-effort
 * both ways, per the jar's contract: a refused write degrades to a
 * warning (the next dial just reads unauthenticated), a failed read to an
 * empty jar.
 */
const sessionCookieJar: CookieJar = {
  get: async (url) => {
    try {
      return await session.defaultSession.cookies.get({ url });
    } catch {
      return [];
    }
  },
  set: async (url, cookie) => {
    try {
      await session.defaultSession.cookies.set({ ...cookie, url });
    } catch (err) {
      log.warn("[protocol-cookies] set failed:", err);
    }
  },
};

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
  // Single origin: the injected config carries THIS host's origin as
  // `baseUrl` — the renderer's one origin for API, auth, and the assistant
  // mount.
  const configJson = JSON.stringify({
    baseUrl: `${APP_PROTOCOL}://${APP_HOST}`,
    deviceId: getDeviceId() ?? undefined,
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

    // The operator routes ride ahead of the gateway proxy. The session
    // jar is the rows' cookie source and sink: the pair the hatch jars
    // (and every rotation since) attaches on each gateway dial. The
    // forward's fallthrough arm carries the cloud's own surfaces, dialed
    // through the main process's network stack (`net.fetch` — system
    // proxy, cert store).
    const operated = await forwardOperatorRequest(request, {
      cookieJar: sessionCookieJar,
      fetch: net.fetch,
    });
    if (operated) {
      return operated;
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

  protocol.handle(APP_PROTOCOL, respond);
}
