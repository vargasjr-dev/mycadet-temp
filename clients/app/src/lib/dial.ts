/**
 * The app bundle's one raw-fetch dial. The account surfaces (assistants
 * management, doctor) used to keep their own `fetch` + error-shaping
 * wrappers — this is the consolidation point until generated clients
 * cover these routes.
 *
 * The core only fetches and shapes; adapters in each caller keep their
 * own result contracts ({@link ManagementResult} vs the doctor's
 * `OperatorResult`). Paths are built at the serving host's scoped
 * assistant routes — the host injects the gateway bearer on proxied
 * dials and the browser's session cookie covers the cloud-hosted case,
 * so no hand-built auth headers ride here.
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

/**
 * Dial the path at the serving origin and normalize the outcome — the
 * one place the app bundle touches raw `fetch` for API paths.
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
  let detail: string | null = null;
  if (!response.ok && data !== null && typeof data === "object") {
    const d = (data as { detail?: unknown }).detail;
    detail = typeof d === "string" ? d : null;
  }
  return { response, data, detail, networkError: null };
}
