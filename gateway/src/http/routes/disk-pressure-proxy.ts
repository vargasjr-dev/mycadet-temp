/**
 * Gateway proxy endpoints for the disk-pressure surface.
 *
 * The daemon owns the snapshot (safe storage limits, the lock/cleanup
 * policy) — the gateway only relays it, root + assistant-scoped, the same
 * dual registration the channel-readiness proxy rides. Without these rows
 * the web bundle's disk-pressure banner 404s: the SPA dials
 * /v1/assistants/{id}/disk-pressure/status, the cloud data-plane forwards
 * it faithfully, and nothing here answered.
 */

import { proxyForwardToResponse } from "@mycadet/assistant-client";

import { getConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("disk-pressure-proxy");

async function proxyToRuntime(
  req: Request,
  upstreamPath: string,
  upstreamSearch: string,
): Promise<Response> {
  const config = getConfig();
  const start = performance.now();
  const response = await proxyForwardToResponse(req, {
    baseUrl: config.assistantRuntimeBaseUrl,
    path: upstreamPath,
    search: upstreamSearch || undefined,
    timeoutMs: config.runtimeTimeoutMs,
    fetchImpl,
  });
  const duration = Math.round(performance.now() - start);

  if (response.status >= 500) {
    log.error(
      { path: upstreamPath, status: response.status, duration },
      "Disk pressure proxy upstream error",
    );
  } else if (response.status >= 400) {
    log.warn(
      { path: upstreamPath, status: response.status, duration },
      "Disk pressure proxy upstream error",
    );
  }

  return response;
}

export async function handleGetDiskPressureStatus(
  req: Request,
): Promise<Response> {
  const url = new URL(req.url);
  return proxyToRuntime(req, "/v1/disk-pressure/status", url.search);
}

export async function handleAcknowledgeDiskPressure(
  req: Request,
): Promise<Response> {
  return proxyToRuntime(req, "/v1/disk-pressure/acknowledge", "");
}

export async function handleOverrideDiskPressure(
  req: Request,
): Promise<Response> {
  return proxyToRuntime(req, "/v1/disk-pressure/override", "");
}

export async function handleGetResourcePressureStatus(
  req: Request,
): Promise<Response> {
  const url = new URL(req.url);
  return proxyToRuntime(req, "/v1/resource-pressure/status", url.search);
}

export const ROUTES: RouteDefinition[] = [
  {
    path: "/disk-pressure/status",
    method: "get",
    auth: "edge",
    handler: (req) => handleGetDiskPressureStatus(req),
  },
  {
    path: /^\/assistants\/([^/]+)\/disk-pressure\/status$/,
    method: "get",
    auth: "edge",
    handler: (req) => handleGetDiskPressureStatus(req),
  },
  {
    path: "/disk-pressure/acknowledge",
    method: "post",
    auth: "edge",
    handler: (req) => handleAcknowledgeDiskPressure(req),
  },
  {
    path: /^\/assistants\/([^/]+)\/disk-pressure\/acknowledge$/,
    method: "post",
    auth: "edge",
    handler: (req) => handleAcknowledgeDiskPressure(req),
  },
  {
    path: "/disk-pressure/override",
    method: "post",
    auth: "edge",
    handler: (req) => handleOverrideDiskPressure(req),
  },
  {
    path: /^\/assistants\/([^/]+)\/disk-pressure\/override$/,
    method: "post",
    auth: "edge",
    handler: (req) => handleOverrideDiskPressure(req),
  },
  {
    path: "/resource-pressure/status",
    method: "get",
    auth: "edge",
    handler: (req) => handleGetResourcePressureStatus(req),
  },
  {
    path: /^\/assistants\/([^/]+)\/resource-pressure\/status$/,
    method: "get",
    auth: "edge",
    handler: (req) => handleGetResourcePressureStatus(req),
  },
];
