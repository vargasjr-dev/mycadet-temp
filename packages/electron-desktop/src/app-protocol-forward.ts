import { app, net, protocol } from "electron";
import { pathToFileURL } from "node:url";
import path from "node:path";

import { type AllowedOrigin } from "./app-origin";
import { getDeviceId } from "./device-id";
import {
  forwardOperatorRequest,
  readLockfile,
  servedConfigFromLockfile,
} from "@mycadet/local-mode";
import { authorityCookieJar } from "./authority-cookie-jar";
import { planAppProtocolAssetRequest } from "./app-protocol";

/**
 * The `app://` protocol handler all three desktop clients share: one
 * ordered pass — host check, `/__config`, operator routes (whose
 * fallthrough arm forwards the cloud's own account paths — `/_allauth`
 * and `/accounts`), then renderer assets (the app shell everywhere,
 * the web bundle on the `/web` mount plus the `/assistant/assets`
 * prefix its vite base requires) with an index.html
 * fallback that carries the injected config.
 */
const APP_PROTOCOL = "app";
const APP_HOST = "mycadet.ai";
/**
 * The web bundle's document mount: the app shell iframes it here
 * (`/web/assistant/*`), the same shape the gateway's app server and the
 * cloud's mirror serve. The web build's vite `base` stays `/assistant/`,
 * so its hashed assets are requested at `/assistant/assets/*` regardless
 * of the mount that served the document — that prefix is the web asset
 * arm below.
 */
const WEB_MOUNT = "/web";
const WEB_ASSET_PREFIX = "/assistant/assets/";

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
  // Read only when serving config or an assistant document. A hatch or
  // selection can change the served assistant after protocol registration.
  const configJson = () =>
    JSON.stringify({
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
      return new Response(configJson(), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // The operator routes ride ahead of the gateway proxy. The session
    // jar is the rows' cookie source and sink: the pair the hatch jars
    // (and every rotation since) attaches on each gateway dial.
    const operated = await forwardOperatorRequest(request, {
      cookieJar: authorityCookieJar,
    });
    if (operated) {
      return operated;
    }

    // The app shell owns every document route — `/assistant/*` included:
    // the shell frames the web bundle at `/web/assistant/*` instead of
    // being served BY it. The web bundle rides the `/web` mount (the
    // frame strips one and two segments deep, matching the gateway's
    // app server), plus the `/assistant/assets` prefix its vite `base`
    // bakes into the document's asset URLs.
    const webPrefix = pathname.startsWith("/web/assistant")
      ? "/web/assistant"
      : pathname.startsWith(WEB_MOUNT)
        ? WEB_MOUNT
        : pathname.startsWith(WEB_ASSET_PREFIX)
          ? "/assistant"
          : undefined;
    const asset = await planAppProtocolAssetRequest({
      rendererRoot: webPrefix ? webDistRoot : appDistRoot,
      indexHtml: webPrefix ? webIndexHtml : appIndexHtml,
      requestUrl: request.url,
      mountPrefix: webPrefix,
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
              `<script>window.__CADET_CONFIG__=${configJson()}</script></head>`,
            )
          : html;
      return new Response(finalHtml, { status: response.status, headers });
    }
    return new Response("Not Found", { status: 404 });
  };

  protocol.handle(APP_PROTOCOL, respond);
}
