import { z } from "zod";
import { requestAccount } from "@app/lib/auth/auth-request";
import { SessionSchema } from "@app/lib/auth/auth-response";

export function getSession(signal?: AbortSignal) {
  return requestAccount("auth/session", SessionSchema, undefined, { signal });
}

/** Cloud logout is a CSRF-protected DELETE, including when a gateway is also connected. */
export async function logoutAccountSession(): Promise<void> {
  const result = await requestAccount("auth/session", z.unknown(), undefined, {
    method: "DELETE",
  });
  if (
    result.ok ||
    (!result.ok &&
      (result.status === 401 ||
        (result.status !== undefined &&
          result.status >= 200 &&
          result.status < 300)))
  )
    return;
  throw new Error("Unable to sign out of the cloud account.");
}
