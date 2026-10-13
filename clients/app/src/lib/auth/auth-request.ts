import { z } from "zod";
import { currentLocale } from "@app/i18n";
import { authEndpoint } from "@app/lib/auth/auth-endpoint";
import {
  authErrorResult,
  type AllauthResult,
} from "@app/lib/auth/auth-response";
import { getElectronBridge } from "@app/runtime/electron-bridge";
import { getElectronSessionToken } from "@app/runtime/session-token";

function csrfToken(): string | undefined {
  const key = import.meta.env.PROD ? "__Secure-csrftoken" : "csrftoken";
  return document.cookie
    .split("; ")
    .findLast((entry) => entry.startsWith(`${key}=`))
    ?.split("=")
    .slice(1)
    .join("=");
}
let bootstrap: Promise<void> | undefined;
async function ensureCsrfCookie(): Promise<void> {
  if (csrfToken()) return;
  bootstrap ??= (async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await fetch(authEndpoint("auth/session"), {
          credentials: "same-origin",
        });
        if (csrfToken()) return;
      } catch {
        if (attempt === 0)
          await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  })().finally(() => {
    bootstrap = undefined;
  });
  await bootstrap;
}

export async function requestAccount<T>(
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
): Promise<AllauthResult<T>> {
  try {
    const headers = new Headers({
      Accept: "application/json",
      "Accept-Language": currentLocale(),
    });
    const token = getElectronSessionToken();
    if (token) headers.set("X-Session-Token", token);
    if (body !== undefined) {
      headers.set("Content-Type", "application/json");
      if (getElectronBridge()) {
        headers.set(
          "X-Cadet-Electron-Renderer-Origin",
          `${window.location.protocol}//${window.location.host}`,
        );
      } else {
        await ensureCsrfCookie();
        const csrf = csrfToken();
        if (csrf) headers.set("X-CSRFToken", csrf);
      }
    }
    const response = await fetch(authEndpoint(path), {
      method: body === undefined ? "GET" : "POST",
      headers,
      credentials: "same-origin",
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
