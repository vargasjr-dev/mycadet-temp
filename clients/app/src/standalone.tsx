import { useState } from "react";
import {
  createBrowserRouter,
  Navigate,
  Outlet,
  useLocation,
  useNavigate,
} from "react-router";
import { toast, Toaster } from "@mycadet/design-library/components/toast";
import { CreateAssistantDialog } from "@app/components/create-assistant-dialog";
import { RouteErrorBoundary } from "@app/components/route-error-boundary";
import { RootHydrateFallback } from "@app/components/root-hydrate-fallback";
import { useCadetCommands } from "@app/runtime/cadet-commands";
import { useDeepLinkConsumer } from "@app/runtime/deep-links";
import { accountRoute } from "@app/domains/account/account-route";
import { OnboardingFlowRoute } from "@app/domains/onboarding/pages/onboarding-flow-route";
import { consentRoute } from "@app/domains/consent/consent-route";
import { AssistantPage } from "@app/shell/assistant-page";
import {
  assistantSelectionState,
  selectedAssistantState,
} from "@app/assistant/assistant-selection";
import { useLocalLockfileStore } from "@app/stores/local-lockfile-store";
import { useTranslation } from "@app/i18n";
import { routes } from "@app/utils/routes";

export function DesktopChrome() {
  const [createOpen, setCreateOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation("account");

  /**
   * The shell's assistant commands (the palette's switch action and the
   * re-pair menu item) drive the same connect flow the chooser's
   * card-select owns: resolve the lockfile entry, connect by navigating
   * with the selection state, and route any failure to the chooser — whose
   * connect path owns the recovery dialog — under a toast, mirroring web's
   * command-failure shape.
   */
  const connectAssistantById = (assistantId: string): void => {
    void (async () => {
      await useLocalLockfileStore.load();
      const entry = useLocalLockfileStore
        .getState()
        .lockfile?.assistants.find(
          (candidate) => candidate.assistantId === assistantId,
        );
      if (entry) {
        // The shell owns recovery: an entry whose gateway can't resolve
        // lands on the not-ready panel's wake, whatever its remote type.
        navigate(routes.assistant, {
          state: assistantSelectionState(entry.assistantId),
        });
        return;
      }
      // Not a lockfile entry (a cloud id, or no lockfile arm): the chooser
      // owns the full list.
      toast.error(t("appShell.assistantSwitchFailed"));
      navigate(routes.account.selectAssistant);
    })();
  };

  useCadetCommands({
    createAssistant: () => setCreateOpen(true),
    selectAssistant: (command) => {
      if (command.kind !== "selectAssistant") {
        return;
      }
      connectAssistantById(command.assistantId);
    },
    rePair: () => {
      // The current selection is the thing to re-pair; nothing selected
      // means nothing to re-pair (web's guard).
      const id = selectedAssistantState(location.state)?.id;
      if (!id) {
        return;
      }
      connectAssistantById(id);
    },
  });
  useDeepLinkConsumer();
  return (
    <>
      <CreateAssistantDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
      {/* Single app-wide toast outlet. Sonner only renders toasts when a
          <Toaster /> is mounted in the tree; without this every `toast.*`
          call (the create dialog's confirmations, "Assistant retired", etc.)
          silently no-ops. Every route renders through this layout, and both
          entries (standalone and capacitor) boot through it. */}
      <Toaster />
      <Outlet />
    </>
  );
}

export const router = createBrowserRouter(
  [
    {
      Component: DesktopChrome,
      ErrorBoundary: RouteErrorBoundary,
      HydrateFallback: RootHydrateFallback,
      children: [
        accountRoute,
        consentRoute,
        { path: "/", Component: () => <Navigate to="/assistant" replace /> },
        {
          // The onboarding funnel's post-hatch steps — claimed before the
          // /assistant/* shell catch-all so the funnel renders app-native
          // (web's research route died with the research turn).
          path: routes.onboarding.research,
          Component: OnboardingFlowRoute,
        },
        { path: "/assistant/*", Component: AssistantPage },
        {
          path: "/logout",
          lazy: {
            Component: () =>
              import("@app/domains/account/pages/logout-page").then(
                (m) => m.LogoutPage,
              ),
          },
        },
      ],
    },
  ],
  { future: { v8_middleware: true } },
);
