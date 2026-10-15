import { useState } from "react";
import {
  createBrowserRouter,
  Navigate,
  Outlet,
  useLocation,
  useNavigate,
} from "react-router";
import { AppShell } from "@mycadet/app";
import { CreateAssistantDialog } from "@app/components/create-assistant-dialog";
import { RouteErrorBoundary } from "@app/components/route-error-boundary";
import { RootHydrateFallback } from "@app/components/root-hydrate-fallback";
import { useCadetCommands } from "@app/runtime/cadet-commands";
import { currentLocale, useTranslation } from "@app/i18n";
import { accountRoute } from "@app/domains/account/account-route";
import { readInjectedConfig } from "@app/lib/injected-config";

function AssistantPage() {
  useTranslation();
  const config = readInjectedConfig();
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <AppShell
      apiBaseUrl={config.cloudUrl}
      assistantId={config.assistantId}
      organizationId={config.organizationId}
      location={`${location.pathname}${location.search}${location.hash}`}
      origin={window.location.origin}
      locale={currentLocale()}
      onNavigate={(path, options) => {
        void navigate(path, options);
      }}
    />
  );
}

function DesktopChrome() {
  const [createOpen, setCreateOpen] = useState(false);
  useCadetCommands({ createAssistant: () => setCreateOpen(true) });
  return (
    <>
      <CreateAssistantDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
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
        { path: "/", Component: () => <Navigate to="/assistant" replace /> },
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
