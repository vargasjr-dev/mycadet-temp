import { requestAccount } from "@app/lib/auth/auth-request";
import { AuthConfigurationSchema } from "@app/lib/auth/auth-config-schema";

/** Public account configuration; failures preserve the hook's fail-open policy. */
export function getAuthConfig() {
  return requestAccount("config", AuthConfigurationSchema);
}
