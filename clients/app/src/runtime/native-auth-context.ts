import { readReturningUser } from "@app/assistant/returning-user";
import { composedAccountSession } from "@app/runtime/composed-account-session";
import { checkoutHandoff } from "@app/lib/billing/checkout-intent-storage";
import type { NativePostAuthContext } from "@app/runtime/native-post-auth-destination";

/** Assistant facts, checkout storage, and web reconciliation for the composed client. */
export const nativeAuthContext = {
  checkout: checkoutHandoff,
  async read(): Promise<NativePostAuthContext> {
    return {
      returningUser: await readReturningUser(),
      checkout: checkoutHandoff,
    };
  },
  beginComposedOAuth: composedAccountSession.beginOAuth,
  primeComposedSession: composedAccountSession.primeSessionToken,
  waitComposedSession: composedAccountSession.waitSessionSettled,
};
