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
import { RetireConfirmDialog } from "@app/components/retire-confirm-dialog";
import { retireAssistant } from "@app/assistant/retire-assistant";
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
import { listAssistants } from "@app/assistant/api";
import { useTranslation } from "@app/i18n";
import { routes } from "@app/utils/routes";

export function DesktopChrome() {
  const [createOpen, setCreateOpen] = useState(false);
  // Id of the assistant a tray "Retire <assistant>…" command targets. The
  // retire lives here in the shell — the chooser's dialog is the cloud row's
  // path; the command carries the id so the retire runs without routing
  // through the chooser screen first.
  const [retireTargetId, setRetireTargetId] = useState<string | null>(null);
  const [retirePending, setRetirePending] = useState(false);
  const [retireError, setRetireError] = useState<string | null>(null);
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
      // The palette switch resolves through the list assistants api — the
      // platform's rows are the roster (registered local assistants included);
      // the bundle never reads a lockfile.
      const result = await listAssistants();
      const entry = result.ok
        ? result.data.find((candidate) => candidate.id === assistantId)
        : undefined;
      if (entry) {
        // The shell owns recovery: an entry whose gateway can't resolve
        // lands on the not-ready panel's wake, whatever its remote type.
        navigate(routes.assistant, {
          state: assistantSelectionState(entry.id),
        });
        return;
      }
      // Not a listed row (an unregistered local, or no session): the chooser
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
    retireAssistant: (command) => {
      if (command.kind === "retireAssistant") {
        setRetireTargetId(command.assistantId);
      }
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
  const handleRetireConfirm = async () => {
    if (!retireTargetId || retirePending) {
      return;
    }
    setRetirePending(true);
    setRetireError(null);
    // One endpoint for every entry type: the same-origin retire route, whose
    // serving host (the desktop proxy for on-machine entries, the cloud for
    // platform rows) decides how to honor it.
    const outcome = await retireAssistant(retireTargetId);
    setRetirePending(false);
    if (!outcome.ok) {
      setRetireError(outcome.error || "Failed to retire assistant.");
      return;
    }
    setRetireTargetId(null);
    navigate(routes.account.selectAssistant);
  };

  useDeepLinkConsumer();
  return (
    <>
      <CreateAssistantDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
      <Toaster />
      <RetireConfirmDialog
        open={retireTargetId !== null}
        error={retireError}
        isPending={retirePending}
        onConfirm={() => void handleRetireConfirm()}
        onCancel={() => {
          if (!retirePending) {
            setRetireTargetId(null);
            setRetireError(null);
          }
        }}
      />
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
        {
          path: "/",
          lazy: {
            Component: () =>
              import("@app/domains/onboarding/pages/welcome-screen").then(
                (m) => m.WelcomeScreen,
              ),
          },
        },
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
