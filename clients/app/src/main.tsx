// Shared-infra side effects the account tree reads at module level: storage
// migrations run before anything touches localStorage, and the api
// interceptors must wrap fetch before any allauth client call.
import "@/utils/run-storage-migrations";
import "@/lib/api-interceptors";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";

import { ErrorBoundary } from "@/components/error-boundary";
import { NotFound } from "@/components/not-found";
import { StartupFailure } from "@/components/startup-failure";
import { initI18n } from "@/i18n";
import { setupAuthListeners } from "@/stores/auth-store";

import { accountRoute } from "@/domains/account/account-route";

import "./index.css";

const router = createBrowserRouter([
  // The account bundle is the /account surface; bare visits land on it.
  { path: "/", element: <Navigate to="/account" replace /> },
  accountRoute,
  { path: "*", element: <NotFound /> },
]);

async function boot() {
  // Awaited before the first render so no component observes an
  // uninitialized i18next and no raw key path is ever painted — same
  // rationale as web's boot.
  await initI18n();
  setupAuthListeners();

  const rootEl = document.getElementById("root");
  if (!rootEl) throw new Error("Account bundle: no #root element");
  createRoot(rootEl).render(
    <StrictMode>
      <ErrorBoundary fallback={<StartupFailure />}>
        <RouterProvider router={router} />
      </ErrorBoundary>
    </StrictMode>,
  );
}

void boot();
