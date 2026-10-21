import { session, type WebRequestFilter } from "electron";

import { isAllowedOrigin, type AllowedOrigin } from "./app-origin";

export interface GatewayRequestGuardOptions {
  appOrigin: AllowedOrigin;
  resolveAllowedOrigin: () => AllowedOrigin;
}

const createGatewayRequestFilter = (
  appOrigin: AllowedOrigin,
): WebRequestFilter => ({
  urls: [
    `${appOrigin.protocol}//${appOrigin.host}/assistant/__gateway/*`,
    `${appOrigin.protocol}//${appOrigin.host}/__gateway/*`,
  ],
});

/**
 * Restrict the packaged app's gateway proxy to requests initiated by a trusted
 * renderer frame. Electron custom protocol requests omit Origin, Referer, and
 * Fetch Metadata headers, while WebRequest retains the requesting frame's
 * browser-controlled origin.
 */
export function installGatewayRequestGuard({
  appOrigin,
  resolveAllowedOrigin,
}: GatewayRequestGuardOptions): () => void {
  const webRequest = session.defaultSession.webRequest;
  const filter = createGatewayRequestFilter(appOrigin);
  webRequest.onBeforeRequest(filter, (details, callback) => {
    callback({
      cancel: !isAllowedOrigin(details.frame?.origin, resolveAllowedOrigin()),
    });
  });

  return () => {
    webRequest.onBeforeRequest(filter, null);
  };
}
