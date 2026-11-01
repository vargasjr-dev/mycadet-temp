import { app, net, protocol } from "electron";
import { pathToFileURL } from "node:url";
import path from "node:path";

import { getVersionInfo } from "./about";
import log from "./app-logger";
import { createAllowedOriginResolver, type AllowedOrigin } from "./app-origin";
import { forwardCloudRequest } from "./cloud-forward";
import { getDeviceId } from "./device-id";
import { forwardGatewayRequest } from "./gateway-forward";
import { forwardOperatorRequest } from "./operator-forward";
import {
  readLockfile,
  resolveLocalConfigFromEnv,
  servedConfigFromLockfile,
} from "@mycadet/local-mode";
import { planAppProtocolAssetRequest } from "@mycadet/electron-utils/app-protocol";

/**
 * The `app://` protocol handler all three desktop clients share: one
 * ordered pass — host check, `/__config`, operator routes, gateway proxy,
 * cloud forward, renderer assets with an index.html fallback.
 */
export interface AppProtocolForwardingOptions {
  /** The `/assistant` web-bundle root (every client serves it). */
  webDistRoot: string;
  /**
   * The app-shell root (macOS): non-`/assistant` paths ride it, and the
   * handler serves `/__config` + injects `window.__CADET_CONFIG__` into
   * the HTML. The web-bundle clients pass none — their renderer gets its
   * config over IPC.
   */
  appDistRoot?: string;
}

const APP_PROTOCOL = "app";
const APP_HOST = "mycadet.ai";
const RENDERER_MOUNT = "/assistant";
const DEV_SERVER_FALLBACK_URL = "http://localhost:5173/assistant";

// The app-shell client packs even dev into the same `app://mycadet.ai`
// origin as packaged builds, so its allowed origin is a constant; the
// web-bundle clients load dev from the Vite/edge dev base, so theirs
// follows `CADET_DEV_URL` (via the same `usesAppProtocolRenderer` gate
// each client's app-config re-derives for its own navigation guard).
const devAwareAllowedOrigin = createAllowedOriginResolver({
  appHost: APP_HOST,
  appProtocol: APP_PROTOCOL,
  getDevRendererBase: () =>
    (process.env.CADET_DEV_URL ?? DEV_SERVER_FALLBACK_URL).replace(/\/+$/, ""),
  isPackaged: () =>
    Boolean(app.isPackaged || process.env.CADET_LOCAL_RENDERER === "true"),
});

const appOrigin = (): AllowedOrigin => ({
  protocol: `${APP_PROTOCOL}:`,
  host: APP_HOST,
});

export function registerAppProtocolForwarding(
  options: AppProtocolForwardingOptions,
): void {
  const { webDistRoot, appDistRoot } = options;
  const webIndexHtml = path.join(webDistRoot, "index.html");
  const appIndexHtml = appDistRoot
    ? path.join(appDistRoot, "index.html")
    : webIndexHtml;
  const cloudUrl = resolveLocalConfigFromEnv().cloudUrl;
  const resolveAllowedOrigin = appDistRoot ? appOrigin : devAwareAllowedOrigin;
  // Single origin: the injected config carries THIS host's origin as
  // `baseUrl` — the renderer's one origin for API, auth, and the assistant
  // mount. `cloudUrl` stays a host-side forward target only; it never
  // crosses into the renderer.
  const configJson = appDistRoot
    ? JSON.stringify({
        baseUrl: `${APP_PROTOCOL}://${APP_HOST}`,
        deviceId: getDeviceId() ?? undefined,
        version: getVersionInfo().version,
        ...servedConfigFromLockfile(readLockfile()),
      }).replace(/</g, "\\u003c")
    : undefined;

  protocol.handle(APP_PROTOCOL, async (request) => {
    if (new URL(request.url).host !== APP_HOST) {
      return new Response("Forbidden", { status: 403 });
    }
    const pathname = new URL(request.url).pathname;
    if (
      configJson &&
      (pathname === "/assistant/__config" || pathname === "/__config")
    ) {
      return new Response(configJson, {
        headers: { "Content-Type": "application/json" },
      });
    }

    // The operator routes ride ahead of the gateway proxy.
    const operated = await forwardOperatorRequest(request);
    if (operated) {
      return operated;
    }

    // Forward the id-keyed gateway proxy to its lockfile-resolved target
    // (mirrors the Vite dev-server proxy).
    const proxied = await forwardGatewayRequest(request, net.fetch);
    if (proxied) {
      return proxied;
    }

    // `/v1/*`, `/_allauth/*`, `/accounts/*` forward to the
    // cloud so managed mode and desktop replay ingest work.
    const cloudProxied = await forwardCloudRequest({
      request,
      cloudBase: cloudUrl,
      fetcher: net.fetch,
      allowedOrigin: resolveAllowedOrigin(),
      log,
    });
    if (cloudProxied) {
      return cloudProxied;
    }

    // The `/assistant` mount serves the web bundle; when an app shell
    // rides the same scheme, every other path is the shell.
    const isWebMount = appDistRoot ? pathname.startsWith(RENDERER_MOUNT) : true;
    const asset = await planAppProtocolAssetRequest({
      rendererRoot: isWebMount ? webDistRoot : (appDistRoot ?? webDistRoot),
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
      if (
        !configJson ||
        (asset.path !== appIndexHtml && asset.path !== webIndexHtml)
      ) {
        return response;
      }
      const html = await response.text();
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.set("content-type", "text/html; charset=utf-8");
      return new Response(
        html.replace(
          "</head>",
          `<script>window.__CADET_CONFIG__=${configJson}</script></head>`,
        ),
        { status: response.status, headers },
      );
    }
    return new Response("Not Found", { status: 404 });
  });
}
