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

/** Account browser handoff. Native session/destination reconciliation remains in web. */
export async function startAuthFlow(
  providerId: string,
  callbackUrl: string,
  options: ProviderRedirectOptions & { returnTo?: string | null } = {},
): Promise<void> {
  if (isNativePlatform() || getElectronBridge()) {
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
