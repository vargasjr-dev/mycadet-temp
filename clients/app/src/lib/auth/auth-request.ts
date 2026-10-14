import { z } from "zod";
import { currentLocale } from "@app/i18n";
import { ensureCsrfCookie, getCsrfToken } from "@app/lib/auth/csrf";
import { authEndpoint } from "@app/lib/auth/auth-endpoint";
import {
  authErrorResult,
  type AllauthResult,
} from "@app/lib/auth/auth-response";
import { getElectronBridge } from "@app/runtime/electron-bridge";
import { getElectronSessionToken } from "@app/runtime/session-token";

export async function requestAccount<T>(
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
  options?: { method?: "GET" | "POST" | "DELETE"; signal?: AbortSignal },
): Promise<AllauthResult<T>> {
  try {
    const headers = new Headers({
      Accept: "application/json",
      "Accept-Language": currentLocale(),
    });
    const method = options?.method ?? (body === undefined ? "GET" : "POST");
    const token = getElectronSessionToken();
    if (token) headers.set("X-Session-Token", token);
    if (method !== "GET") {
      if (body !== undefined) headers.set("Content-Type", "application/json");
      if (getElectronBridge()) {
        headers.set(
          "X-Cadet-Electron-Renderer-Origin",
          `${window.location.protocol}//${window.location.host}`,
        );
      } else {
        await ensureCsrfCookie();
        const csrf = getCsrfToken();
        if (csrf) headers.set("X-CSRFToken", csrf);
      }
    }
    const response = await fetch(authEndpoint(path), {
      method,
      headers,
      credentials: "same-origin",
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload: unknown = await response.json().catch(() => null);
    const parsed = z.object({ data: schema }).safeParse(payload);
    if (response.ok && parsed.success)
      return { ok: true, data: parsed.data.data };
    return authErrorResult(payload, response.status);
  } catch {
    return { ok: false, errors: [] };
  }
}
