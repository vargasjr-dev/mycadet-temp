// Run localStorage migrations before any other app import — the modules
// below read localStorage at module level.
import "@/utils/run-storage-migrations";

import { useState } from "react";
import { createBrowserRouter, Outlet } from "react-router";

import { CreateAssistantDialog } from "@/components/create-assistant-dialog";
import { RouteErrorBoundary } from "@/components/route-error-boundary";
import { RootHydrateFallback } from "@/components/root-hydrate-fallback";
import { start } from "@/boot";
import { useCadetCommands } from "@/runtime/cadet-commands";
import { getRouterBasename, routeTree } from "@/routes";

import { accountRoute } from "@/domains/account/account-route";

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
      import("@/domains/account/pages/logout-page").then((m) => m.LogoutPage),
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

start(router);
