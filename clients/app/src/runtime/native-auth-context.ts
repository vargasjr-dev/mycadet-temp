import { readReturningUser } from "@app/assistant/returning-user";
import { checkoutHandoff } from "@app/lib/billing/checkout-intent-storage";
import type { NativePostAuthContext } from "@app/runtime/native-post-auth-destination";

/** Account-owned checkout handoff and assistant facts for native login. */
export const nativeAuthContext = {
  checkout: checkoutHandoff,
  async read(): Promise<NativePostAuthContext> {
    return {
      returningUser: await readReturningUser(),
      checkout: checkoutHandoff,
    };
  },
};
