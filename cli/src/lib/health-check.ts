import { loopbackSafeFetch } from "./loopback-fetch.js";
import { z } from "zod";

const HealthResponseSchema = z.object({
  status: z.string().optional(),
  message: z.string().optional(),
  version: z.string().optional(),
});

export const HEALTH_CHECK_TIMEOUT_MS = 1500;

export interface HealthCheckResult {
  status: string;
  detail: string | null;
  version?: string;
}

export async function checkManagedHealth(
  runtimeUrl: string,
  assistantId: string,
): Promise<HealthCheckResult> {
  const { readPlatformToken } = await import("./platform-client.js");
  const token = readPlatformToken();
  if (!token) {
    return {
      status: "error (auth)",
      detail: "not logged in — run `cadet login`",
    };
  }

  let headers: Record<string, string>;
  try {
    const { authHeaders } = await import("./platform-client.js");
    headers = await authHeaders(token, runtimeUrl);
  } catch (err) {
    return {
      status: "error (auth)",
      detail: err instanceof Error ? err.message : "org lookup failed",
    };
  }

  try {
    const url = `${runtimeUrl}/v1/assistants/${encodeURIComponent(assistantId)}/healthz/`;
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      HEALTH_CHECK_TIMEOUT_MS,
    );

    const response = await loopbackSafeFetch(url, {
      signal: controller.signal,
      headers,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { status: `error (${response.status})`, detail: null };
    }

    const data = HealthResponseSchema
      .catch({})
      .parse(await response.json());
    const status = data.status || "unknown";
    return {
      status,
      detail: status !== "healthy" ? (data.message ?? null) : null,
      version: data.version,
    };
  } catch (error) {
    const status =
      error instanceof Error && error.name === "AbortError"
        ? "timeout"
        : "unreachable";
    return { status, detail: null };
  }
}

export interface ManagedProcessEntry {
  name: string;
  status: "running" | "not_running" | "unreachable";
  children?: ManagedProcessEntry[];
  info?: string;
}

export interface ManagedPsResponse {
  processes: ManagedProcessEntry[];
}

/**
 * Fetch the gateway's `/v1/ps` process tree — the daemon's real process
 * table (assistant + every child it owns) with the gateway's own entry
 * appended. Returns null when the gateway is unreachable or the route is
 * missing (older gateway versions), so callers can fall back to local
 * process detection.
 */
export async function fetchGatewayPs(
  gatewayUrl: string,
  bearerToken?: string,
): Promise<ManagedProcessEntry[] | null> {
  try {
    const url = `${gatewayUrl.replace(/\/+$/, "")}/v1/ps`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (bearerToken) {
      headers["Authorization"] = `Bearer ${bearerToken}`;
    }

    const response = await loopbackSafeFetch(url, {
      signal: controller.signal,
      headers,
    });

    clearTimeout(timeoutId);

    if (!response.ok) return null;

    const data = (await response.json()) as ManagedPsResponse;
    return Array.isArray(data.processes) ? data.processes : null;
  } catch {
    return null;
  }
}

export async function fetchManagedPs(
  runtimeUrl: string,
  assistantId: string,
): Promise<ManagedPsResponse | null> {
  const { readPlatformToken, authHeaders } =
    await import("./platform-client.js");
  const token = readPlatformToken();
  if (!token) return null;

  let headers: Record<string, string>;
  try {
    headers = await authHeaders(token, runtimeUrl);
  } catch {
    return null;
  }

  // Try the /ps endpoint first; fall back to legacy /connection-status
  // for platform versions that haven't rolled it out yet.
  try {
    const psUrl = `${runtimeUrl}/v1/assistants/${encodeURIComponent(assistantId)}/ps/`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await loopbackSafeFetch(psUrl, {
      signal: controller.signal,
      headers,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      return (await response.json()) as ManagedPsResponse;
    }

    // /ps not available — fall back to legacy connection-status
    if (response.status === 404 || response.status === 405) {
      return fetchLegacyConnectionStatus(runtimeUrl, assistantId, headers);
    }

    return null;
  } catch {
    return null;
  }
}

const LegacyConnectionStatusSchema = z.object({
  state: z.string(),
  is_awake: z.boolean(),
  pod_status: z.string().nullable(),
  detail: z.string().nullable(),
});

async function fetchLegacyConnectionStatus(
  runtimeUrl: string,
  assistantId: string,
  headers: Record<string, string>,
): Promise<ManagedPsResponse | null> {
  try {
    const url = `${runtimeUrl}/v1/assistants/${encodeURIComponent(assistantId)}/connection-status/`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await loopbackSafeFetch(url, {
      method: "POST",
      signal: controller.signal,
      headers,
    });

    clearTimeout(timeoutId);
    if (!response.ok) return null;

    const parsed = LegacyConnectionStatusSchema.safeParse(
      await response.json(),
    );
    if (!parsed.success) return null;
    const data = parsed.data;

    // Translate legacy shape into the ps process tree
    const status: ManagedProcessEntry["status"] = data.is_awake
      ? "running"
      : "not_running";
    return {
      processes: [
        { name: "assistant", status, info: data.detail ?? undefined },
      ],
    };
  } catch {
    return null;
  }
}

export async function checkHealth(
  runtimeUrl: string,
  bearerToken?: string,
): Promise<HealthCheckResult> {
  try {
    const url = `${runtimeUrl}/v1/health`;
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      HEALTH_CHECK_TIMEOUT_MS,
    );

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (bearerToken) {
      headers["Authorization"] = `Bearer ${bearerToken}`;
    }

    const response = await loopbackSafeFetch(url, {
      signal: controller.signal,
      headers,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { status: `error (${response.status})`, detail: null };
    }

    const data = HealthResponseSchema
      .catch({})
      .parse(await response.json());
    const status = data.status || "unknown";
    return {
      status,
      detail: status !== "healthy" ? (data.message ?? null) : null,
      version: data.version,
    };
  } catch (error) {
    const status =
      error instanceof Error && error.name === "AbortError"
        ? "timeout"
        : "unreachable";
    return { status, detail: null };
  }
}
