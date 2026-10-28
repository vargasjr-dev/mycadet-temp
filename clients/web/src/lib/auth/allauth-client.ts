/**
 * Thin adapter around the generated allauth HeyAPI SDK.
 *
 * Normalizes responses into a discriminated union so callers
 * don't have to scatter null-checks across every call site.
 *
 * Reference: https://docs.allauth.org/en/latest/headless/openapi-specification/
 */
import type { Authenticated, Flow } from "@/generated/auth/types.gen";
import { getAllauthByClientV1AuthSession } from "@/generated/auth/sdk.gen";
import { isElectron } from "@/runtime/is-electron";

// Electron authenticates via the session-token header → allauth's "app" client.
// Web/iOS use cookie sessions → the "browser" client.
const allauthClient = (): "app" | "browser" =>
  isElectron() ? "app" : "browser";

export type AllauthResult<T = unknown> =
  | { ok: true; data: T }
  | {
      ok: false;
      status?: number;
      errors: Array<{ code: string; message: string; param?: string }>;
      flows?: Array<Flow>;
    };

function errorResult(error: unknown, status?: number): AllauthResult<never> {
  const err = error as Record<string, unknown> | undefined;
  if (err && Array.isArray(err.errors)) {
    return { ok: false, status, errors: err.errors };
  }
  const data = err?.data as Record<string, unknown> | undefined;
  if (data && Array.isArray(data.flows)) {
    return { ok: false, status, errors: [], flows: data.flows as Array<Flow> };
  }
  return { ok: false, status, errors: [] };
}

export async function getSession(): Promise<AllauthResult<Authenticated>> {
  const { data, error, response } = await getAllauthByClientV1AuthSession({
    path: { client: allauthClient() },
  });

  if (data) {
    return { ok: true, data: data.data };
  }

  return errorResult(error, response?.status);
}
