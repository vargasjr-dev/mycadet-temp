import { useState } from "react";
import { createBrowserRouter, Navigate, Outlet } from "react-router";
import { Toaster } from "@mycadet/design-library/components/toast";
import { CreateAssistantDialog } from "@app/components/create-assistant-dialog";
import { RouteErrorBoundary } from "@app/components/route-error-boundary";
import { RootHydrateFallback } from "@app/components/root-hydrate-fallback";
import { useCadetCommands } from "@app/runtime/cadet-commands";
import { useConnectDeepLinkDrain } from "@app/domains/account/hooks/use-connect-deep-link-drain";
import { accountRoute } from "@app/domains/account/account-route";
import { AssistantPage } from "@app/shell/assistant-page";

export function DesktopChrome() {
  const [createOpen, setCreateOpen] = useState(false);
  useCadetCommands({ createAssistant: () => setCreateOpen(true) });
  useConnectDeepLinkDrain();
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
