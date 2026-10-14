import { nativeAuthReturningUser } from "@web/domains/account/login-flow";
import {
  beginCloudAccountOAuth,
  primeCloudAccountSessionToken,
  whenCloudSessionSettled,
} from "@web/stores/auth-store";
import { checkoutHandoff } from "@app/lib/billing/checkout-intent-storage";
import type { NativePostAuthContext } from "@app/runtime/native-post-auth-destination";

/** Assistant facts, checkout storage, and web reconciliation for the composed client. */
export const nativeAuthContext = {
  checkout: checkoutHandoff,
  read(): NativePostAuthContext {
    return {
      returningUser: nativeAuthReturningUser(),
      checkout: checkoutHandoff,
    };
  },
  beginComposedOAuth: beginCloudAccountOAuth,
  primeComposedSession: primeCloudAccountSessionToken,
  waitComposedSession: whenCloudSessionSettled,
};
