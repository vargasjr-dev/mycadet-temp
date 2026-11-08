/**
 * Gateway proxy endpoints for Telegram integration control-plane routes.
 *
 * These routes are registered as explicit gateway routes for dedicated
 * auth handling rather than falling through to the catch-all proxy.
 */

import { proxyForward } from "@mycadet/assistant-client";

import { getConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("telegram-control-plane-proxy");

async function forward(
  req: Request,
  upstreamPath: string,
  upstreamSearch?: string,
): Promise<Response> {
  const config = getConfig();
  const start = performance.now();
  const result = await proxyForward(req, {
    baseUrl: config.assistantRuntimeBaseUrl,
    path: upstreamPath,
    search: upstreamSearch,
    timeoutMs: config.runtimeTimeoutMs,
    fetchImpl,
  });

  const duration = Math.round(performance.now() - start);

  if (result.gatewayError) {
    log.error(
      { path: upstreamPath, duration },
      result.status === 504
        ? "Telegram control-plane proxy upstream timed out"
        : "Telegram control-plane proxy upstream connection failed",
    );
  } else if (result.status >= 400) {
    log.warn(
      { path: upstreamPath, status: result.status, duration },
      "Telegram control-plane proxy upstream error",
    );
  } else {
    log.info(
      { path: upstreamPath, status: result.status, duration },
      "Telegram control-plane proxy completed",
    );
  }

  return new Response(result.body, {
    status: result.status,
    headers: result.headers,
  });
}

export function handleGetTelegramConfig(req: Request): Promise<Response> {
  return forward(req, "/v1/integrations/telegram/config");
}

export function handleSetTelegramConfig(req: Request): Promise<Response> {
  return forward(req, "/v1/integrations/telegram/config");
}

export function handleClearTelegramConfig(req: Request): Promise<Response> {
  return forward(req, "/v1/integrations/telegram/config");
}

export function handleSetTelegramCommands(req: Request): Promise<Response> {
  return forward(req, "/v1/integrations/telegram/commands");
}

export function handleSetupTelegram(req: Request): Promise<Response> {
  return forward(req, "/v1/integrations/telegram/setup");
}

export const ROUTES: RouteDefinition[] = [
  {
    path: "/integrations/telegram/config",
    method: "get",
    auth: "edge",
    handler: (req) => handleGetTelegramConfig(req),
  },
  {
    path: "/integrations/telegram/config",
    method: "post",
    auth: "edge",
    handler: (req) => handleSetTelegramConfig(req),
  },
  {
    path: "/integrations/telegram/config",
    method: "delete",
    auth: "edge",
    handler: (req) => handleClearTelegramConfig(req),
  },
  {
    path: "/integrations/telegram/commands",
    method: "post",
    auth: "edge",
    handler: (req) => handleSetTelegramCommands(req),
  },
  {
    path: "/integrations/telegram/setup",
    method: "post",
    auth: "edge",
    handler: (req) => handleSetupTelegram(req),
  },
];
