import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router";

import { useTranslation } from "@app/i18n";
import { assistantAuthHandoff } from "@app/domains/account/assistant-auth-handoff";
import { registerLocalCloudSession } from "@app/runtime/cloud-session-host";
import { setMenuCloudSession } from "@app/runtime/menu";
import { useAuthStore } from "@app/stores/auth-store";
import { routes } from "@app/utils/routes";

const LOOPBACK_STATE_KEY = "cadet:loopback:state";
const LOOPBACK_RETURN_TO_KEY = "cadet:loopback:returnTo";

/**
 * Receive the session token from the cloud's CLI callback redirect.
 *
 * Flow:
 *   1. Welcome screen stores a random state nonce in sessionStorage
 *      and navigates to the cloud login with
 *      `returnTo=/accounts/cli/callback?port={localPort}&state={nonce}`
 *   2. After authentication, the cloud redirects to
 *      `http://localhost:{port}/callback?state={nonce}&session_token={token}`
 *   3. The local web server redirects `/callback` → this SPA page
 *   4. This page validates the state, registers the token with the local
 *      server (which authenticates its cloud proxy with it — no browser
 *      cookie), checks for existing assistants, and navigates accordingly
 */
export function CloudLoopbackPage() {
  const { t } = useTranslation("account");
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const state = searchParams.get("state");
    const sessionToken = searchParams.get("session_token");
    const expectedState = sessionStorage.getItem(LOOPBACK_STATE_KEY);
    const returnTo =
      sessionStorage.getItem(LOOPBACK_RETURN_TO_KEY) || routes.assistant;

    sessionStorage.removeItem(LOOPBACK_STATE_KEY);
    sessionStorage.removeItem(LOOPBACK_RETURN_TO_KEY);

    if (!state || state !== expectedState) {
      setError(t("authErrors.loopbackStateMismatch"));
      return;
    }

    if (!sessionToken) {
      setError(t("authErrors.loopbackNoToken"));
      return;
    }

    if (!/^[a-zA-Z0-9]+$/.test(sessionToken)) {
      setError(t("authErrors.loopbackInvalidToken"));
      return;
    }

    void (async () => {
      // Hand the validated token to the local web server; its proxy uses it to
      // authenticate to the cloud. No browser session cookie is involved, so
      // a stale HttpOnly `sessionid` from the local platform can't block login.
      const registered = await registerLocalCloudSession(sessionToken);
      if (!registered) {
        setError(
          "Login failed: couldn't reach the local Cadet server to store the " +
            "session. Please try again.",
        );
        return;
      }

      // Refresh both account and composed web session state now that the proxy is authenticated — this moves
      // sessionStatus to "authenticated" so the auth middleware lets
      // navigation through.
      await useAuthStore.getState().refreshSession();
      await setMenuCloudSession(true);

      if (await assistantAuthHandoff.hasAssistants()) {
        void navigate(routes.assistant, { replace: true });
        return;
      }
      void navigate(returnTo, { replace: true });
    })();
  }, [searchParams, navigate, t]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--surface-base)] text-[var(--content-default)]">
        <div className="max-w-md text-center">
          <p className="text-body-medium-default">{error}</p>
          <button
            type="button"
            className="mt-4 rounded-lg border border-[var(--border-disabled)] px-4 py-2 text-sm hover:bg-[var(--surface-lift)]"
            onClick={() => void navigate(routes.welcome)}
          >
            {t("platformLoopbackPage.backToWelcome")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--surface-base)] text-[var(--content-default)]">
      <p className="text-body-medium-default">
        {t("platformLoopbackPage.completing")}
      </p>
    </div>
  );
}
