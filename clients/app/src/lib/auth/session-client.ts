import { requestAccount } from "@app/lib/auth/auth-request";
import { SessionSchema } from "@app/lib/auth/auth-response";

export function getSession() {
  return requestAccount("auth/session", SessionSchema);
}
