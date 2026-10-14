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

import { startDesktopLogin } from "@app/runtime/desktop-login";
import { nativeAuthContext } from "@app/runtime/native-auth-context";
import { resolveNativePostAuthDestination } from "@app/runtime/native-post-auth-destination";

/** Account auth handoff for native shells, localhost, and cloud browsers. */
export async function startAuthFlow(
  providerId: string,
  callbackUrl: string,
  options: ProviderRedirectOptions & { returnTo?: string | null } = {},
): Promise<void> {
  if (isNativePlatform()) {
    try {
      await startNativeLogin({
        returnTo: resolveNativePostAuthDestination(
          options.intent,
          options.returnTo,
          nativeAuthContext.read(),
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
    await startDesktopLogin(options);
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
