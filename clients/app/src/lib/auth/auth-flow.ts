import { startNativeLogin } from "@app/runtime/native-login";
import { isNativePlatform } from "@app/runtime/native-platform";
import { getElectronBridge } from "@app/runtime/electron-bridge";
import { isLocalClient } from "@app/lib/runtime-mode";
import {
  isPlatformLocal,
  startLoopbackAuth,
} from "@app/lib/auth/loopback-auth";
import {
  startProviderRedirect,
  type ProviderRedirectOptions,
} from "@app/lib/auth/provider-redirect";

import { resolveNativePostAuthDestination } from "@app/runtime/native-post-auth-destination";

/** Account auth handoff. Electron reconciliation remains in web. */
export async function startAuthFlow(
  providerId: string,
  callbackUrl: string,
  options: ProviderRedirectOptions & { returnTo?: string | null } = {},
): Promise<void> {
  if (isNativePlatform()) {
    const { nativeAuthReturningUser, nativeCheckoutHandoff } =
      await import("@web/runtime/native-auth");
    try {
      await startNativeLogin({
        returnTo: resolveNativePostAuthDestination(
          options.intent,
          options.returnTo,
          {
            returningUser: nativeAuthReturningUser(),
            checkout: nativeCheckoutHandoff,
          },
        ),
        loginHint: options.loginHint,
        intent: options.intent,
        attribution: options.attribution,
      });
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === "USER_CANCELLED") return;
      throw err;
    }
    return;
  }
  if (getElectronBridge()) {
    const nativeAuth = await import("@web/runtime/native-auth");
    await nativeAuth.startAuthFlow(providerId, callbackUrl, options);
    return;
  }
  if (isLocalClient() && !isPlatformLocal()) {
    await startLoopbackAuth(options.returnTo ?? undefined, {
      intent: options.intent,
    });
    return;
  }
  await startProviderRedirect(providerId, callbackUrl, options);
}
