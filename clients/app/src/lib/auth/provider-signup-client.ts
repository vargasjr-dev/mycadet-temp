import { requestAccount } from "@app/lib/auth/auth-request";
import {
  ProviderSignupSchema,
  SessionSchema,
  type AllauthResult,
} from "@app/lib/auth/auth-response";

export function getProviderSignup() {
  return requestAccount("auth/provider/signup", ProviderSignupSchema);
}
export function submitProviderSignup(body: {
  email: string;
  username: string;
}) {
  return requestAccount("auth/provider/signup", SessionSchema, body);
}
export function isConflict(result: AllauthResult<unknown>): boolean {
  return !result.ok && result.status === 409;
}
