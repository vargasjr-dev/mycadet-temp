// Run localStorage migrations before any other app import — the modules
// below read localStorage at module level.
import "@web/utils/run-storage-migrations";

import { useState } from "react";
import { createBrowserRouter, Outlet } from "react-router";

import { CreateAssistantDialog } from "@web/components/create-assistant-dialog";
import { RouteErrorBoundary } from "@web/components/route-error-boundary";
import { RootHydrateFallback } from "@app/components/root-hydrate-fallback";
import { start } from "@web/boot";
import { useCadetCommands } from "@web/runtime/cadet-commands";
import { getRouterBasename, routeTree } from "@web/routes";

import { initI18n } from "@app/i18n";

import { accountRoute } from "@app/domains/account/account-route";

// The tray "New Assistant…" name-prompt — account-level chrome the desktop
// shell owns. The web module's served build never mounts it.
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

const logoutRoute = {
  path: "/logout",
  ErrorBoundary: RouteErrorBoundary,
  HydrateFallback: RootHydrateFallback,
  lazy: {
    Component: () =>
      import("@app/domains/account/pages/logout-page").then(
        (m) => m.LogoutPage,
      ),
  },
};

const router = createBrowserRouter(
  [
    {
      Component: DesktopChrome,
      children: [accountRoute, logoutRoute, ...routeTree],
    },
  ],
  { basename: getRouterBasename(), future: { v8_middleware: true } },
);

await initI18n();
start(router);
