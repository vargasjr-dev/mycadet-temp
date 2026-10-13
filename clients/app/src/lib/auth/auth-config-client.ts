import { requestAccount } from "@app/lib/auth/auth-request";
import { AuthConfigurationSchema } from "@app/lib/auth/auth-config-schema";

export type { AuthConfiguration } from "@app/lib/auth/auth-config-schema";
export type { AllauthResult } from "@app/lib/auth/auth-response";

/** Public account configuration; failures preserve the hook's fail-open policy. */
export function getAuthConfig() {
  return requestAccount("config", AuthConfigurationSchema);
}
