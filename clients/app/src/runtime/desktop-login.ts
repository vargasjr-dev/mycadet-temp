import { getElectronBridge } from "@app/runtime/electron-bridge";
import { beginOAuthFlow } from "@app/runtime/oauth-flow-state";
import { nativeAuthContext } from "@app/runtime/native-auth-context";
import { DesktopSessionResponseSchema } from "@app/lib/auth/desktop-session-response";
import { useAuthStore } from "@app/stores/auth-store";
import { setMenuCloudSession } from "@app/runtime/menu";
import { resolveNativePostAuthDestination } from "@app/runtime/native-post-auth-destination";
import { sanitizeReturnTo } from "@app/utils/return-to";
import { routes } from "@app/utils/routes";

export async function startDesktopLogin(
  options: {
    loginHint?: string;
    intent?: string;
    returnTo?: string | null;
  } = {},
): Promise<void> {
  const auth = getElectronBridge()?.auth;
  if (!auth?.startOAuth) {
    throw Object.assign(
      new Error(
        "The desktop auth bridge is unavailable. Update the app to sign in.",
      ),
      {
        code: "AUTH_ERROR",
        data: { authError: "desktop_update_required" },
      },
    );
  }
  const finish = beginOAuthFlow();
  const finishComposed = nativeAuthContext.beginComposedOAuth();
  try {
    const response: unknown = await auth.startOAuth({
      loginHint: options.loginHint,
      intent: options.intent,
    });
    const parsed = DesktopSessionResponseSchema.safeParse(response);
    if (!parsed.success) {
      throw new Error("The desktop auth bridge returned an invalid session.");
    }
    // App reads the main-process token directly; web still caches it per page.
    nativeAuthContext.primeComposedSession(parsed.data.sessionToken);
    await useAuthStore.getState().refreshSession();
    await nativeAuthContext.waitComposedSession();
    await setMenuCloudSession(true);
    const destination = sanitizeReturnTo(
      resolveNativePostAuthDestination(
        options.intent,
        options.returnTo,
        nativeAuthContext.read(),
      ),
      routes.assistant,
    );
    window.location.href = destination;
  } finally {
    finishComposed();
    finish();
  }
}
