/**
 * The web bundle's one raw-fetch dial. Every hand-rolled same-origin
 * caller (email, domains, push tokens, the voice catalog, the device
 * probe) used to keep its own `fetch` + error-shaping wrapper — this is
 * the consolidation point until generated clients cover these routes.
 *
 * The core only fetches and shapes; adapters in each caller keep their
 * own result contracts. A path argument never trips the raw-`/v1` fetch
 * lint — the ban exists to stop literals skipping the generated
 * clients' interceptors, and this module is the deliberate host-plane
 * exception the adapters route through.
 *
 * The serving host's chain (gateway proxy, then whatever it forwards)
 * carries these calls — the browser itself holds no auth-header logic.
 */

export interface DialOutcome {
  /** The response, or `null` when the fetch itself threw. */
  response: Response | null;
  /** The response's parsed JSON body; `null` when absent or unparseable. */
  data: unknown;
  /** The server's `detail` string, when an error body carried one. */
  detail: string | null;
  /** The thrown value, when the fetch itself failed. */
  networkError: unknown;
}

/** Read a `detail` string off a parsed error body, tolerating other shapes. */
function readDetail(data: unknown): string | null {
  if (data === null || typeof data !== "object") {
    return null;
  }
  const detail = (data as { detail?: unknown }).detail;
  return typeof detail === "string" ? detail : null;
}

/**
 * Dial the path at the serving origin and normalize the outcome — the
 * one place the web bundle touches raw `fetch` for API paths.
 */
export async function dial(
  path: string,
  init?: RequestInit,
): Promise<DialOutcome> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (networkError) {
    return {
      response: null,
      data: null,
      detail: null,
      networkError,
    };
  }
  // One body read: JSON-parse it once, then shape `detail` from the same
  // parsed value — a Response body can't be consumed twice.
  const bodyText = await response.text().catch(() => null);
  let data: unknown = null;
  if (bodyText !== null) {
    try {
      data = JSON.parse(bodyText) as unknown;
    } catch {
      data = null;
    }
  }
  return {
    response,
    data,
    detail: response.ok ? null : readDetail(data),
    networkError: null,
  };
}

/**
 * Demand success from an outcome: throws the server's `detail`, else the
 * caller's fallback message with the status attached. The shaping half
 * of `dial` for callers whose contract is "data or throw".
 */
export function okOrThrow(outcome: DialOutcome, fallback: string): unknown {
  if (!outcome.response?.ok) {
    throw new Error(
      outcome.detail ?? `${fallback} (${outcome.response?.status ?? 0})`,
    );
  }
  return outcome.data;
}
