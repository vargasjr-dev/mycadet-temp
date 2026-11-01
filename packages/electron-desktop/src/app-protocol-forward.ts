import { net, protocol } from "electron";
import { pathToFileURL } from "node:url";
import path from "node:path";

import { forwardGatewayRequest } from "./gateway-forward";
import { forwardOperatorRequest } from "./operator-forward";
import {
  forwardCloudRequest,
  type CloudForwardLogger,
} from "./cloud-forward";
import type { AllowedOrigin } from "./app-origin";
import { planAppProtocolAssetRequest } from "@mycadet/electron-utils/app-protocol";

/**
 * The `app://` protocol handler shared by the web-bundle desktop clients
 * (linux, windows): an ordered pass — the operator routes, the id-keyed
 * gateway proxy, the cloud forward, then the built renderer's static
 * assets with an index.html fallback so React Router handles client-side
 * routes on reload.
 *
 * The web-bundle clients are byte-identical here: they differ only in
 * WHERE the built renderer lives (dev tree vs the packaged resources
 * layout), so the renderer root is a caller-provided path. The macOS
 * client keeps its own handler — it serves two dist roots (app shell +
 * `/assistant` web mount) and injects `window.__CADET_CONFIG__` into the
 * HTML, which the web-bundle clients don't do.
 *
 * Touches Electron directly (`protocol`, `net`) like `cadet-protocol.ts`;
 * tests mock the module (bun cannot import Electron's API at module
 * scope).
 */
export interface AppProtocolForwardingOptions {
  /** The `app://` scheme the client registered as standard + secure. */
  appProtocol: string;
  /** The scheme's host (e.g. `mycadet.ai`). */
  appHost: string;
  /** Directory the built renderer lives in (dev tree or packaged layout). */
  rendererRoot: string;
  /** The cloud API base for the login + managed-mode forwards. */
  cloudUrl: string;
  /**
   * The renderer's origin, resolved at request time — dev honors a
   * mid-process `CADET_DEV_URL` change (see `app-origin.ts`).
   */
  resolveAllowedOrigin: () => AllowedOrigin;
  /** Receives the forward failures (see `cloud-forward.ts`). */
  log?: CloudForwardLogger;
}

/** The clients/web Vite `base` — asset URLs carry this prefix on disk-less paths. */
const RENDERER_MOUNT = "/assistant";

export function registerAppProtocolForwarding(
  options: AppProtocolForwardingOptions,
): void {
  const {
    appProtocol,
    appHost,
    rendererRoot,
    cloudUrl,
    resolveAllowedOrigin,
    log,
  } = options;
  const indexHtml = path.join(rendererRoot, "index.html");

  protocol.handle(appProtocol, async (request) => {
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

    const asset = await planAppProtocolAssetRequest({
      rendererRoot,
      indexHtml,
      requestUrl: request.url,
      mountPrefix: RENDERER_MOUNT,
      allowedOrigin: { protocol: `${appProtocol}:`, host: appHost },
    });
    if (asset.kind === "forbidden") {
      return new Response("Forbidden", { status: 403 });
    }
    if (asset.kind === "fetch") {
      return net.fetch(pathToFileURL(asset.path).toString());
    }
    return new Response("Not Found", { status: 404 });
  });
}
