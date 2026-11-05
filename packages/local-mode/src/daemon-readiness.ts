import { z } from "zod";
import type { IncomingHttpHeaders } from "node:http";

import { cloudAuthHeaders, readCloudToken } from "./cloud-auth";
import { readBasetenSandboxToken } from "./guardian-token";
import { loopbackSafeFetch } from "./loopback-fetch";
import { getGatewayUrl, isCloudEntry } from "./lockfile-contract";
import type { LockfileAssistant } from "./lockfile-contract";

export type HttpProbeEndpoint = "healthz" | "readyz";

/**
 * Build the base URL for the daemon HTTP server.
 */
export function buildDaemonUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function httpProbe(
  port: number,
  endpoint: HttpProbeEndpoint,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const url = `${buildDaemonUrl(port)}/${endpoint}`;
    const response = await loopbackSafeFetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Perform an HTTP health check against the daemon's `/healthz` endpoint.
 * Returns true if the daemon responds with HTTP 200, false otherwise.
 */
export async function httpHealthCheck(
  port: number,
  timeoutMs = 1500,
): Promise<boolean> {
  return httpProbe(port, "healthz", timeoutMs);
}

/**
 * Poll a daemon probe endpoint until it responds with 200 or the timeout is
 * reached.
 *
 * Returns true if the daemon became ready within the timeout, false otherwise.
 */
export async function waitForDaemonReady(
  port: number,
  timeoutMs = 60000,
  endpoint: HttpProbeEndpoint = "healthz",
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await httpProbe(port, endpoint, 1500)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * Migration-aware daemon readiness, derived from the `/readyz` BODY rather
 * than its status code. The status code is the k8s contract — 200 while
 * migrations run so the pod stays in service, 503 only on migration failure —
 * so `response.ok` alone cannot distinguish ready from still migrating.
 */
export type DaemonReadiness = "ready" | "migrating" | "failed" | "unreachable";

/**
 * Classify a `/readyz` response (daemon-direct or proxied through the
 * gateway, which forwards the assistant's readiness body). Shared by the
 * local daemon probe and the docker upgrade/hatch readiness waits so there is
 * exactly one reader of the readiness wire shape.
 *
 * Any HTTP-answered response proves the daemon is alive, so a non-ready
 * answer without a failed-migrations body classifies as "migrating" — this
 * covers legacy daemons whose strict `/readyz` returns 503 with a `notReady`
 * body throughout startup. "unreachable" is reserved for the no-answer case
 * (the caller's fetch threw).
 */
export function classifyReadyzResponse(
  ok: boolean,
  body: unknown,
): Exclude<DaemonReadiness, "unreachable"> {
  const readiness = body as {
    ready?: boolean;
    dbMigrations?: { state?: string };
  } | null;
  if (readiness?.dbMigrations?.state === "failed") return "failed";
  // A 200 with no explicit `ready: false` counts as ready — this also
  // covers daemons that predate the migration-state body.
  if (ok && readiness?.ready !== false) return "ready";
  return "migrating";
}

/** Single `/readyz` probe, classified from the response body. */
export async function probeDaemonReadiness(
  port: number,
  timeoutMs = 1500,
): Promise<DaemonReadiness> {
  try {
    const response = await loopbackSafeFetch(`${buildDaemonUrl(port)}/readyz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await response.json().catch(() => null)) as unknown;
    return classifyReadyzResponse(response.ok, body);
  } catch {
    return "unreachable";
  }
}

/**
 * `probeDaemonReadiness` with one retry on a transient timeout: a single
 * probe's 1.5s budget can elapse while a synchronous migration step blocks
 * the daemon's event loop, misreporting a live daemon as unreachable.
 */
export async function probeDaemonReadinessWithRetry(
  port: number,
): Promise<DaemonReadiness> {
  const first = await probeDaemonReadiness(port);
  if (first !== "unreachable") {
    return first;
  }
  return probeDaemonReadiness(port);
}

/**
 * Poll `/readyz` until the daemon is ready, its migrations have terminally
 * FAILED (returned immediately — failed never recovers without a restart, so
 * waiting out the deadline would be pure delay), or `deadlineMs` passes.
 * Returns the last observed readiness.
 */
export async function waitForDaemonMigrationsReady(
  port: number,
  deadlineMs: number,
): Promise<DaemonReadiness> {
  let last: DaemonReadiness = "unreachable";
  for (;;) {
    last = await probeDaemonReadiness(port);
    if (last === "ready" || last === "failed") return last;
    if (Date.now() >= deadlineMs) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
}

export const GatewayHealthSchema = z.object({
  /** The gateway's own version stamp, when it serves one. */
  version: z.string().min(1).optional(),
  /**
   * The runtime's own health verdict from the detailed body ("healthy",
   * "unhealthy", ...) — the gateway and the runtime share one process in the
   * topologies this probe serves, so the alias answers with the runtime's
   * full detailed-health shape. Absent on servers that predate the field.
   */
  status: z.string().optional(),
  /**
   * Whether the caller's own credentials (the browser access cookie, or a
   * bearer) authenticate against the gateway. A server that does not answer
   * the field (the cloud's /healthz, older gateways) gives no verdict and
   * reads as `true` — the /v1 routes' own 401s stay the signal there. Only a
   * gateway that answers the field can deliver the strict verdict: the
   * served /v1 routes can respond 200 unauthenticated (loopback trust).
   */
  authenticated: z.boolean().default(true),
});

/**
 * The one health answer. `status` is always present: the runtime's own
 * verdict from the detailed body when it served one, "healthy" when the
 * gateway answered with a body that predates the field, and the way the
 * probe failed otherwise — "unreachable", or "timeout" when the probe's own
 * deadline fired.
 */
export type GatewayHealth = {
  version?: string;
  status: string;
  authenticated: boolean;
};

/** The caller's own headers, in either mount spelling: a fetch Request's
 * Headers, or the connect record's IncomingHttpHeaders. */
type GatewayHealthHeaders = Headers | IncomingHttpHeaders;

/**
 * THE health check for one assistant entry — the package's and the CLI's
 * single probe. The URL and the headers both derive from the entry:
 * `getGatewayUrl` resolves the address inside, and a cloud-managed entry
 * authenticates the probe with the cloud URL stack's own credentials while
 * every other remote probes bare — so one method routes every remote and
 * there is no cloud-specific health check. The caller's own headers (the
 * auth-verdict callers) ride on top of the derived ones.
 *
 * Best-effort: an unreachable endpoint, a non-2xx, or a malformed body all
 * read as "no version, no verdict" (`authenticated: true`), so callers on
 * servers without the field keep today's behavior.
 */
export async function checkHealth(
  entry: LockfileAssistant,
  opts: { signal?: AbortSignal; headers?: GatewayHealthHeaders } = {},
): Promise<GatewayHealth> {
  const runtimeUrl = getGatewayUrl(entry);
  const down = (status: "unreachable" | "timeout"): GatewayHealth => ({
    version: undefined,
    status,
    authenticated: true,
  });
  try {
    const healthUrl = new URL(
      "healthz",
      runtimeUrl.endsWith("/") ? runtimeUrl : `${runtimeUrl}/`,
    );
    // The derived auth headers spread under our own Accept, and the
    // caller's headers spread after them — later entries win, so the
    // caller's credentials (if any) override the derived ones and its
    // Accept overrides ours; the record spelling's array values join and
    // its undefined values drop, exactly what a Headers instance would
    // have done for them.
    const callerEntries: [string, string][] = [];
    if (opts.headers instanceof Headers) {
      for (const headerEntry of opts.headers) {
        callerEntries.push(headerEntry);
      }
    } else {
      for (const [key, value] of Object.entries(opts.headers ?? {})) {
        if (value !== undefined) {
          callerEntries.push([
            key,
            Array.isArray(value) ? value.join(", ") : value,
          ]);
        }
      }
    }
    const resp = await loopbackSafeFetch(healthUrl.href, {
      headers: [
        ["accept", "application/json"],
        ...Object.entries(await gatewayAuthHeaders(entry)),
        ...callerEntries,
      ],
      signal: opts.signal ?? AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const parsed = GatewayHealthSchema.safeParse(await resp.json());
      if (parsed.success) {
        // A body without the field is an older gateway — answering at all
        // is what "healthy" means there.
        return { ...parsed.data, status: parsed.data.status ?? "healthy" };
      }
    }
    return down("unreachable");
  } catch (error) {
    return down(
      error instanceof Error && error.name === "AbortError"
        ? "timeout"
        : "unreachable",
    );
  }
}

/**
 * The credentials the health probe itself should present, derived from the
 * entry: a cloud-managed entry presents the cloud URL stack's own token, a
 * baseten entry presents the sandbox access token (the sandbox edge guards
 * the /port route the gateway rides), every other remote probes bare.
 * Best-effort — a missing token or a failed derivation probes without
 * credentials (the /v1 routes' own 401s stay the signal there).
 */
async function gatewayAuthHeaders(
  entry: LockfileAssistant,
): Promise<Record<string, string>> {
  // The baseten sandbox edge authenticates every route with the sandbox
  // access token the hatch saved — the /port/<PORT>/ route the gateway
  // rides included — so without the token the probe 401s before the inner
  // gateway ever answers.
  if (entry.cloud === "baseten") {
    const sandboxToken = readBasetenSandboxToken(entry.assistantId);
    if (sandboxToken.ok) {
      return { Authorization: `Bearer ${sandboxToken.accessToken}` };
    }
    return {};
  }
  if (!isCloudEntry(entry)) return {};
  const token = readCloudToken();
  if (!token) return {};
  try {
    return await cloudAuthHeaders(token, getGatewayUrl(entry));
  } catch {
    return {};
  }
}

/**
 * Remote-agnostic liveness for one assistant entry: the assistant is up
 * exactly when its gateway answers the health probe with a served version
 * (the detailed body always carries one while the runtime is up). The sleep
 * operation's was-running signal rides this — no per-cloud pid-file or
 * container inspection. Module-level export only: it stays off the
 * package's public surface.
 */
export async function isAssistantHealthy(
  entry: LockfileAssistant,
): Promise<boolean> {
  return (await checkHealth(entry)).version !== undefined;
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

/**
 * Cadet Cloud process listing for an entry. The gateway address derives
 * from the entry's topology — cloud-managed entries resolve through the
 * environment's cloud URL stack.
 */
export async function fetchCloudPs(
  entry: LockfileAssistant,
): Promise<ManagedPsResponse | null> {
  const runtimeUrl = getGatewayUrl(entry);

  const token = readCloudToken();
  if (!token) return null;

  let headers: Record<string, string>;
  try {
    headers = await cloudAuthHeaders(token, runtimeUrl);
  } catch {
    return null;
  }

  // Try the /ps endpoint first; fall back to legacy /connection-status
  // for platform versions that haven't rolled it out yet.
  try {
    const psUrl = `${runtimeUrl}/v1/assistants/${encodeURIComponent(entry.assistantId)}/ps/`;
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
      return fetchLegacyConnectionStatus(
        runtimeUrl,
        entry.assistantId,
        headers,
      );
    }

    return null;
  } catch {
    return null;
  }
}

/** The docker containers' readiness budget: image pulls and first-boot migrations ride the same deadline. */
export const DOCKER_READY_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Poll the gateway's `/readyz` until the assistant answers ready, migrations
 * fail outright, or the budget runs out. A "failed" readiness is reported as
 * not-ready so recovery can run.
 */
export async function waitForReady(runtimeUrl: string): Promise<boolean> {
  const readyUrl = `${runtimeUrl}/readyz`;
  const start = Date.now();

  while (Date.now() - start < DOCKER_READY_TIMEOUT_MS) {
    try {
      const resp = await loopbackSafeFetch(readyUrl, {
        signal: AbortSignal.timeout(5000),
      });
      const body = (await resp.json().catch(() => null)) as {
        status?: string;
        upstream?: number;
      } | null;
      const readiness = classifyReadyzResponse(resp.ok, body);
      if (readiness === "ready") {
        const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`Assistant ready after ${elapsedSec}s`);
        return true;
      }
      if (readiness === "failed") {
        console.log(
          "Assistant database migrations FAILED — treating the assistant as not ready so recovery can run.",
        );
        return false;
      }
      const parts = [body?.status].filter(Boolean);
      if (body?.upstream != null) parts.push(`upstream=${body.upstream}`);
      const detail = parts.length > 0 ? ` — ${parts.join(", ")}` : "";
      console.log(`Readiness check: ${resp.status}${detail}, retrying...`);
    } catch {
      // Connection refused / timeout — not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  return false;
}
