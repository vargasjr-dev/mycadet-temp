import { currentLocale } from "@app/i18n";
import { authConfigEndpoint } from "@app/lib/auth/auth-endpoint";
import {
  AuthConfigurationResponseSchema,
  type AuthConfiguration,
} from "@app/lib/auth/auth-config-schema";
import { getElectronSessionToken } from "@app/runtime/session-token";

export type { AuthConfiguration } from "@app/lib/auth/auth-config-schema";
export type AllauthResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      status?: number;
      errors: { code: string; message: string; param?: string }[];
    };

/** Public account configuration; failures preserve the hook's fail-open policy. */
export async function getAuthConfig(): Promise<
  AllauthResult<AuthConfiguration>
> {
  try {
    const headers = new Headers({
      Accept: "application/json",
      "Accept-Language": currentLocale(),
    });
    const token = getElectronSessionToken();
    if (token) headers.set("X-Session-Token", token);
    const response = await fetch(authConfigEndpoint(), {
      headers,
      credentials: "same-origin",
    });
    const parsed = AuthConfigurationResponseSchema.safeParse(
      await response.json(),
    );
    if (response.ok && parsed.success)
      return { ok: true, data: parsed.data.data };
    return { ok: false, status: response.status, errors: [] };
  } catch {
    return { ok: false, errors: [] };
  }
}
