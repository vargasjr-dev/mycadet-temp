/**
 * Proxy cloud-owned device and Live Activity token routes.
 *
 * Remote-gateway clients register APNs/FCM and ActivityKit tokens on
 * `/v1/assistants/{id}/push-tokens/` and
 * `/v1/assistants/{id}/live-activity/tokens/`. Those paths are not daemon
 * routes. Without this handler they fall through to the runtime-proxy
 * catch-all and 404.
 *
 * The hop itself is the shared cloud forward ({@link forwardToCloud}):
 * the bound cloud assistant UUID rides the upstream path, and the cloud
 * authenticates it with the stored assistant API key.
 */

import { forwardToCloud } from "./cloud-hop.js";
import type { RouteDefinition } from "./types.js";

// Cloud-owned registration. Remote-gateway clients hit these
// same-origin; without a dedicated route they fall through to the
// runtime-proxy catch-all and 404.
export function handleUpsertPushToken(req: Request): Promise<Response> {
  return forwardToCloud(req, "/push-tokens/");
}

export function handleDeletePushToken(
  req: Request,
  token: string,
): Promise<Response> {
  return forwardToCloud(req, `/push-tokens/${encodeURIComponent(token)}/`);
}

export function handleUpsertLiveActivityToken(req: Request): Promise<Response> {
  return forwardToCloud(req, "/live-activity/tokens/");
}

export function handleDeleteLiveActivityToken(
  req: Request,
  token: string,
): Promise<Response> {
  return forwardToCloud(req, `/live-activity/tokens/${encodeURIComponent(token)}/`);
}

export const ROUTES: RouteDefinition[] = [
  {
    path: /^\/assistants\/[^/]+\/push-tokens\/?$/,
    method: "post",
    auth: "edge-scoped",
    scope: "settings.write",
    handler: (req) => handleUpsertPushToken(req),
  },
  {
    path: /^\/assistants\/[^/]+\/push-tokens\/([^/]+)\/?$/,
    method: "delete",
    auth: "edge-scoped",
    scope: "settings.write",
    handler: (req, params) => handleDeletePushToken(req, params[0]!),
  },
  {
    path: /^\/assistants\/[^/]+\/live-activity\/tokens\/?$/,
    method: "post",
    auth: "edge-scoped",
    scope: "settings.write",
    handler: (req) => handleUpsertLiveActivityToken(req),
  },
  {
    path: /^\/assistants\/[^/]+\/live-activity\/tokens\/([^/]+)\/?$/,
    method: "delete",
    auth: "edge-scoped",
    scope: "settings.write",
    handler: (req, params) => handleDeleteLiveActivityToken(req, params[0]!),
  },
];
