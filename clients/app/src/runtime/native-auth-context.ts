import {
  nativeAuthReturningUser,
  nativeCheckoutHandoff,
} from "@web/domains/account/login-flow";
import {
  beginCloudAccountOAuth,
  primeCloudAccountSessionToken,
  whenCloudSessionSettled,
} from "@web/stores/auth-store";
import type { NativePostAuthContext } from "@app/runtime/native-post-auth-destination";

/** Assistant facts, checkout storage, and web reconciliation for the composed client. */
export const nativeAuthContext = {
  checkout: nativeCheckoutHandoff,
  read(): NativePostAuthContext {
    return {
      returningUser: nativeAuthReturningUser(),
      checkout: nativeCheckoutHandoff,
    };
  },
  beginComposedOAuth: beginCloudAccountOAuth,
  primeComposedSession: primeCloudAccountSessionToken,
  waitComposedSession: whenCloudSessionSettled,
};
