import { z } from "zod";

import { loopbackSafeFetch } from "./loopback-fetch";

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

const GatewayHealthSchema = z.object({
  /** The gateway's own version stamp, when it serves one. */
  version: z.string().min(1).optional(),
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

export type GatewayHealth = z.infer<typeof GatewayHealthSchema>;

/**
 * Read the gateway's `/healthz` and return its identity AND the caller's
 * own auth verdict in one round-trip: the version it serves, and whether the
 * request's credentials (the browser access cookie on a same-origin request)
 * authenticate. Best-effort — an unreachable endpoint, a non-2xx, or a
 * malformed body all read as "no version, no verdict" (`authenticated:
 * true`), so callers on servers without the field keep today's behavior.
 */
export async function getGatewayHealth(
  runtimeUrl: string,
  opts: { signal?: AbortSignal } = {},
): Promise<GatewayHealth> {
  try {
    const healthUrl = new URL(
      "healthz",
      runtimeUrl.endsWith("/") ? runtimeUrl : `${runtimeUrl}/`,
    );
    const resp = await loopbackSafeFetch(healthUrl.href, {
      headers: { Accept: "application/json" },
      signal: opts.signal ?? AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const parsed = GatewayHealthSchema.safeParse(await resp.json());
      if (parsed.success) {
        return parsed.data;
      }
    }
  } catch {
    // Best-effort: no version, no verdict.
  }
  return { version: undefined, authenticated: true };
}

/**
 * Best-effort fetch of the running service group version from the gateway
 * `/healthz` endpoint. Returns `undefined` when the endpoint is unreachable
 * or does not include a version field.
 */
export async function fetchCurrentVersion(
  runtimeUrl: string,
): Promise<string | undefined> {
  const health = await getGatewayHealth(runtimeUrl);
  return health.version;
}
