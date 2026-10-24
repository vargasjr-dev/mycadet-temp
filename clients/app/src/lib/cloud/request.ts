import { addCloudMutationHeaders } from "@app/lib/cloud/mutation-headers";
import { z } from "zod";
import { currentLocale } from "@app/i18n";
import { getElectronSessionToken } from "@app/runtime/session-token";

export type CloudResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: { detail: string } };
const ErrorSchema = z.object({ detail: z.string() });

/** GET through the browser/native host's cloud proxy, independently of web clients. */
export async function getCloud<T>(
  path: string,
  schema: z.ZodType<T>,
  options: { organizationId?: string; signal?: AbortSignal } = {},
): Promise<CloudResult<T>> {
  return requestCloud(path, schema, options);
}

/** POST through the browser/native host's cloud proxy. */
export async function postCloud<T>(
  path: string,
  schema: z.ZodType<T>,
  body: unknown,
  options: { organizationId?: string; signal?: AbortSignal } = {},
): Promise<CloudResult<T>> {
  return requestCloud(path, schema, options, body);
}

/** PATCH through the browser/native host's cloud proxy. */
export async function patchCloud<T>(
  path: string,
  schema: z.ZodType<T>,
  body: unknown,
  options: { organizationId?: string; signal?: AbortSignal } = {},
): Promise<CloudResult<T>> {
  return requestCloud(path, schema, options, body, "PATCH");
}

/** Bodyless POST (e.g. the daemon's conversation archive route). A POST with
 * no body is still a distinct method from GET — the daemon 405s a GET archive. */
export async function postCloudEmpty<T>(
  path: string,
  schema: z.ZodType<T>,
  options: { organizationId?: string; signal?: AbortSignal } = {},
): Promise<CloudResult<T>> {
  return requestCloud(path, schema, options, undefined, "POST");
}

/** DELETE through the browser/native host's cloud proxy. A 204 body parses
 * as null, so the success data is always null. */
export async function deleteCloud(
  path: string,
  options: { organizationId?: string; signal?: AbortSignal } = {},
): Promise<CloudResult<null>> {
  return requestCloud(path, z.null(), options, undefined, "DELETE");
}

async function requestCloud<T>(
  path: string,
  schema: z.ZodType<T>,
  options: { organizationId?: string; signal?: AbortSignal },
  body?: unknown,
  method?: "DELETE" | "POST" | "PATCH",
): Promise<CloudResult<T>> {
  try {
    const headers = new Headers({
      Accept: "application/json",
      "Accept-Language": currentLocale(),
    });
    const token = getElectronSessionToken();
    if (token) {
      headers.set("X-Session-Token", token);
    }
    if (options.organizationId) {
      headers.set("Cadet-Organization-Id", options.organizationId);
    }
    // A bodyless DELETE is still a mutation: the cloud's CSRF gate covers
    // every unsafe method, not just the ones that carry JSON.
    if (body !== undefined || method === "DELETE") {
      await addCloudMutationHeaders(headers);
    }
    const response = await fetch(path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers,
      credentials: "same-origin",
      signal: options.signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = ErrorSchema.safeParse(payload);
      return {
        ok: false,
        status: response.status,
        error: {
          detail: error.success
            ? error.data.detail
            : `Cloud request failed (HTTP ${response.status}).`,
        },
      };
    }
    const parsed = schema.safeParse(payload);
    return parsed.success
      ? { ok: true, status: response.status, data: parsed.data }
      : {
          ok: false,
          status: response.status,
          error: { detail: "Invalid cloud response." },
        };
  } catch {
    return {
      ok: false,
      status: 0,
      error: { detail: "Cloud request unavailable." },
    };
  }
}
