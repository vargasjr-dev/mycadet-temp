import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useTranslation } from "@app/i18n";
import { captureError } from "@mycadet/design-library/utils/capture-error";

import { readAuthCallbackIntent } from "@app/domains/account/provider-callback";

import { AccountHeading } from "@app/components/account/account-form";
import { AccountShell } from "@app/components/account/account-shell";
import { listAssistants } from "@web/assistant/api";
import { refreshCloudAssistantsIfStale } from "@web/assistant/cloud-assistants-sync";
import { getSession } from "@app/lib/auth/session-client";
import { resolvePostAuthDestination } from "@web/domains/account/login-flow";
import { classifyCallbackFlows } from "@app/domains/account/callback-flows";
import { isLocalClient } from "@app/lib/runtime-mode";
import { useAuthStore } from "@web/stores/auth-store";
import { routes } from "@app/utils/routes";
import { cn } from "@mycadet/design-library/utils/cn";
import { textLinkVariants } from "@mycadet/design-library/components/text-link";

/**
 * OAuth provider callback handler for the **web** login flow.
 *
 * After the IdP redirect, probes the allauth session and routes the user
 * to the correct next step:
 * - Authenticated → navigate to returnTo or home
 * - Provider signup needed → redirect to provider signup page
 * - Error → display inline error with back-to-login link
 *
 * Native auth flows (iOS / macOS) no longer route through this page.
 * The server-side native auth flow redirects directly from the allauth
 * callback to `/accounts/native/callback` without loading any SPA.
 */
export function ProviderCallbackPage() {
  const { t } = useTranslation("account");
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const refreshSession = useAuthStore.use.refreshSession();
  const error = searchParams.get("error");
  const [fallbackError, setFallbackError] = useState<string | null>(null);
  const didRun = useRef(false);

  const returnTo = searchParams.get("returnTo");
  const authIntent = readAuthCallbackIntent(searchParams);

  useEffect(() => {
    if (didRun.current) {
      return;
    }
    if (error) {
      return;
    }
    didRun.current = true;

    (async () => {
      try {
        const result = await getSession();

        const isAuthenticated = result.ok && !!result.data.user;
        const pendingFlows = result.ok ? [] : (result.flows ?? []);
        const outcome = classifyCallbackFlows(isAuthenticated, pendingFlows);

        switch (outcome.kind) {
          case "authenticated": {
            await refreshSession();
            // Wait for the assistants list so post-auth can skip privacy and
            // research when the assistant is already onboarded.
            await refreshCloudAssistantsIfStale();

            if (isLocalClient()) {
              try {
                const assistants = await listAssistants();
                if (assistants.ok && assistants.data.length > 0) {
                  if (!returnTo) {
                    navigate(routes.assistant, { replace: true });
                    break;
                  }
                }
              } catch {
                // Fall through to normal destination
              }
            }

            const fallback = routes.assistant;
            const { destination, requiresFullPageNavigation } =
              resolvePostAuthDestination({ returnTo, fallback, authIntent });
            if (requiresFullPageNavigation) {
              window.location.href = destination;
            } else {
              navigate(destination, { replace: true });
            }
            break;
          }
          case "provider_signup": {
            const returnToParam = searchParams.get("returnTo");
            const signupUrl = returnToParam
              ? `${routes.account.providerSignup}?returnTo=${encodeURIComponent(returnToParam)}`
              : routes.account.providerSignup;
            navigate(signupUrl, { replace: true });
            break;
          }
          case "error":
            setFallbackError(outcome.message);
            break;
        }
      } catch (err) {
        captureError(err, { context: "provider_callback" });
        setFallbackError("Something went wrong. Please try signing in again.");
      }
    })();
  }, [authIntent, error, refreshSession, returnTo, navigate, searchParams]);

  if (error === "signup_closed") {
    return (
      <AccountShell>
        <AccountHeading
          title={t("providerCallbackPage.signupClosedTitle")}
          subtitle={t("providerCallbackPage.signupClosedSubtitle")}
        />
        <div className="flex flex-col items-center gap-4">
          <Link
            to={routes.account.login}
            className={cn(
              textLinkVariants({ tone: "quiet" }),
              "text-sm font-medium text-[var(--content-emphasised)]",
            )}
          >
            {t("providerCallbackPage.backToSignIn")}
          </Link>
        </div>
      </AccountShell>
    );
  }

  if (error || fallbackError) {
    return (
      <AccountShell>
        <AccountHeading
          title={t("providerCallbackPage.failedTitle")}
          subtitle={fallbackError ?? t("providerCallbackPage.failedSubtitle")}
        />
        <div className="flex flex-col items-center gap-4">
          <Link
            to={routes.account.login}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--primary-base)] px-6 py-3 text-sm font-medium text-[var(--content-inset)] no-underline transition-colors hover:bg-[var(--primary-hover)]"
          >
            {t("providerCallbackPage.backToSignIn")}
          </Link>
        </div>
      </AccountShell>
    );
  }

  return (
    <AccountShell>
      <AccountHeading
        title={t("providerCallbackPage.completingTitle")}
        subtitle={t("providerCallbackPage.completingSubtitle")}
      />
    </AccountShell>
  );
}
