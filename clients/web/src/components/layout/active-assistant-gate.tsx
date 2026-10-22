import { CloudOff, Loader2 } from "lucide-react";
import { Outlet, useNavigate } from "react-router";

import { Typography } from "@mycadet/design-library";
import { Button } from "@mycadet/design-library/components/button";

import { useAssistantResolution } from "@/assistant/queries";
import { useOnboardingLogin } from "@/hooks/use-onboarding-login";
import { useTranslation } from "@/i18n";
import { handleLogout } from "@/lib/auth/handle-logout";
import { useHasCloudSession } from "@/stores/auth-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

/**
 * Layout route that defers rendering of its child `<Outlet />` until
 * the assistant lifecycle has resolved: the selection store has a
 * non-null `activeAssistantId` AND the lifecycle store reports
 * `assistantState.kind` is `"active"` or `"self_hosted"`. Until both
 * are true a placeholder is rendered.
 *
 * Without this gate, every route that reads `activeAssistantId` from
 * the store and feeds it to a `useQuery` (e.g. home, identity,
 * library, workspace, contacts, intelligence) suffers a
 * silent-degradation bug on cold navigation: the query stays
 * `enabled: false`, `isLoading` is false, and the page renders its
 * fully-empty fallback state instead of waiting for the lifecycle to
 * resolve.
 *
 * Inside this gate, child routes use `useActiveAssistantId()` from
 * `@/assistant/use-active-assistant-id` to read a non-null
 * `assistantId: string`. Non-gated routes (`ChatPage`,
 * `DocumentViewerPage`) intentionally render across pre-active
 * lifecycle states and read `useResolvedAssistantsStore.use.activeAssistantId()`
 * directly, handling the null case themselves.
 */
export function ActiveAssistantGate() {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const { state: assistantState, refetch } = useAssistantResolution();

  // A resolution error is terminal (or retryable via the button below) — it
  // must surface as an honest error, never as the connecting placeholder:
  // an unreachable assistant left on an eternal spinner is the one failure
  // mode a user can't self-diagnose.
  if (assistantState.kind === "error") {
    return <ActiveAssistantError message={assistantState.message} />;
  }

  if (
    !assistantId ||
    (assistantState.kind !== "active" && assistantState.kind !== "self_hosted")
  ) {
    return <ActiveAssistantPlaceholder />;
  }

  return <Outlet />;
}

function ActiveAssistantError({ message }: { message: string }) {
  const { t } = useTranslation();

  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-[var(--app-spacing-md)] px-6 text-center text-[var(--content-tertiary)]"
      role="alert"
    >
      <CloudOff className="size-6" aria-hidden="true" />
      <Typography variant="body-medium-default">
        {t("activeAssistantGate.errorTitle")}
      </Typography>
      <p className="text-body-medium-lighter max-w-md text-[var(--content-secondary)]">
        {message}
      </p>
      <RetryButton />
    </div>
  );
}

function RetryButton() {
  const { t } = useTranslation();
  const { refetch } = useAssistantResolution();
  return (
    <Button
      variant="ghost"
      onClick={() => {
        void refetch();
      }}
    >
      {t("activeAssistantGate.retry")}
    </Button>
  );
}

function ActiveAssistantPlaceholder() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // Keep an auth escape hatch reachable while the assistant lifecycle is
  // unresolved: Log Out with a cloud session, Log In without one.
  const hasCloudSession = useHasCloudSession();
  const { login } = useOnboardingLogin();

  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-[var(--app-spacing-md)] text-[var(--content-tertiary)]"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="size-6 animate-spin" aria-hidden="true" />
      <Typography variant="body-medium-default">
        {t("activeAssistantGate.connecting")}
      </Typography>
      {hasCloudSession ? (
        <Button variant="ghost" onClick={() => void handleLogout(navigate)}>
          {t("activeAssistantGate.logOut")}
        </Button>
      ) : (
        <Button variant="ghost" onClick={() => void login()}>
          {t("activeAssistantGate.logIn")}
        </Button>
      )}
    </div>
  );
}
