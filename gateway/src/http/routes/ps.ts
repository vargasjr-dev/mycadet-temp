/**
 * Process status endpoint (GET /v1/ps).
 *
 * Returns a JSON summary of the assistant's process tree so the CLI
 * (and platform UI) can render `cadet ps` without SSH or local process
 * detection.  The gateway calls the daemon's own `/v1/ps` endpoint
 * (which dynamically probes qdrant, embed-worker, etc.) and appends
 * the gateway's own entry.
 */

import { forwardedIdentityHeaders } from "@mycadet/assistant-client";
import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import type { GatewayRouteDefinition } from "./types.js";
import { lazyRef } from "./lazy.js";

const log = getLogger("ps");

interface ProcessEntry {
  name: string;
  status: "running" | "not_running" | "unreachable";
  children?: ProcessEntry[];
  info?: string;
}

interface PsResponse {
  processes: ProcessEntry[];
}

export function createPsHandler(config: GatewayConfig) {
  async function handlePs(): Promise<Response> {
    const assistantProcesses = await fetchAssistantPs(config);

    const processes: ProcessEntry[] = [
      ...assistantProcesses,
      {
        name: "gateway",
        status: "running",
        info: `port ${config.port}`,
      },
    ];

    const body: PsResponse = { processes };
    return Response.json(body);
  }

  return { handlePs };
}

async function fetchAssistantPs(
  config: GatewayConfig,
): Promise<ProcessEntry[]> {
  try {
    const url = `${config.assistantRuntimeBaseUrl}/v1/ps`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: forwardedIdentityHeaders(),
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const data = (await response.json()) as PsResponse;
      return data.processes;
    }

    log.warn({ status: response.status }, "Daemon /v1/ps probe non-OK");
    return [{ name: "assistant", status: "not_running" }];
  } catch (err) {
    log.warn({ err }, "Daemon /v1/ps probe failed");
    return [{ name: "assistant", status: "unreachable" }];
  }
}

const routeProxy = lazyRef<ReturnType<typeof createPsHandler>>(
  "Process status handler used before initialization",
);

export function initPsRoutes(config: GatewayConfig): void {
  routeProxy.set(createPsHandler(config));
}

export const ROUTES: GatewayRouteDefinition[] = [
  {
    path: "/ps",
    method: "get",
    auth: "edge",
    handler: (_req, _params) => routeProxy.get().handlePs(),
  },
];
