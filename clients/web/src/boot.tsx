// Shared renderer boot: web's own entry and the desktop shell's composed
// entry both call `start` with their router.
//
// Run localStorage migrations before any other app import — the modules
// below (onboarding store, client flag scope) read localStorage at module
// level.
import "@/utils/run-storage-migrations";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";

import { AppProviders } from "@/components/providers";
import {
  STARTUP_FAILURE_MESSAGE,
  STARTUP_FAILURE_TITLE,
  StartupFailure,
} from "@/components/startup-failure";
import { WindowDragRegion } from "@/components/window-drag-region";
import { initI18n } from "@/i18n";
import { setupCameraGateHudAccessSync } from "@/lib/camera/frame-gate-debug-access";
import { setupRemoteGatewayNavBridge } from "@/lib/auth/remote-gateway-nav-bridge";
import { isChunkLoadError } from "@/lib/chunk-errors";
import { installConsentRefreshListeners } from "@/lib/consent/consent-refresh";
import { isLocalClient, loadLockfile } from "@/lib/local-mode";
import { captureError } from "@/lib/error-reporting/capture-error";
import { installTranslateDomGuard } from "@/lib/translate-dom-guard";
import { ErrorBoundary } from "@/components/error-boundary";
import { setupCloudAssistantsSync } from "@/assistant/cloud-assistants-sync";
import { setupAuthListeners, useAuthStore } from "@/stores/auth-store";
import { setupOrganizationStore } from "@/stores/organization-store";
import { createBrowserRouter } from "react-router";

type Router = ReturnType<typeof createBrowserRouter>;

import "@/lib/api-interceptors";
import "./index.css";

import { initWindowsTitleBarOverlay } from "@/runtime/electron-window-chrome";
import { initNativeKeyboard } from "@/runtime/native-keyboard";
import { initNativePlatformAttributes } from "@/runtime/native-platform-attributes";
import { initSafeAreaBridge } from "@/runtime/native-safe-area";
import { restorePendingNativeLogin } from "@/runtime/native-auth";
import { markNativeLaunchScreenReady } from "@/runtime/native-launch-screen";
import { initInputModality } from "@mycadet/design-library";

export function start(router: Router): void {
  void boot(router).catch(showBootFailure);
}

async function boot(router: Router) {
  // Install before React first commits so the reconciler survives DOM
  // mutations from browser page translation.
  installTranslateDomGuard();

  initInputModality();
  initNativePlatformAttributes();
  initWindowsTitleBarOverlay();
  await initSafeAreaBridge();
  // First render waits on this bridge, so it is the first boot gate worth a
  void initNativeKeyboard();
  // Awaited before the first render so no component observes an uninitialized
  // i18next and no raw key path is ever painted. English is bundled in this
  // entry chunk, so the floor is reachable with no network; `initI18n` reports
  // and degrades to it when another locale's chunk cannot be fetched. The
  // guard here covers the rest: no i18n failure is worth a blank screen, and
  // rendering English beats rendering nothing.
  try {
    await initI18n();
  } catch (error) {
    captureError(error, { context: "init_i18n" });
  }
  try {
    await restorePendingNativeLogin();
  } catch (error) {
    captureError(error, { context: "restore_pending_native_login" });
  }
  installConsentRefreshListeners();

  setupOrganizationStore();
  // Register before initSession so the boot `unknown → present` transition it
  // drives is caught and the cloud assistants list is loaded.
  setupCloudAssistantsSync();
  // The camera gates are built outside React, so what a restored tuning
  // session applies to them is decided here rather than by a mounted panel.
  setupCameraGateHudAccessSync();
  // The cloud host mirrors iframe navigations into the browser URL and
  // drives back/forward back down — register before the first render so the
  // boot route is announced.
  setupRemoteGatewayNavBridge();
  if (isLocalClient()) {
    await loadLockfile();
    await useAuthStore.getState().initSession();
  } else {
    useAuthStore.getState().initSession();
  }
  setupAuthListeners();
  // Local mode awaits the lockfile read and `initSession()` above, so this
  // separates "session was the boot cost" from "the app tree was".

  const rootEl = document.getElementById("root");
  if (!rootEl) {
    throw new Error("Root element #root not found");
  }
  createRoot(rootEl).render(
    <StrictMode>
      <ErrorBoundary fallback={<StartupFailure />}>
        <AppProviders>
          <WindowDragRegion />
          <RouterProvider
            router={router}
            onError={(error) => {
              // Single report point for every router error.
              // `RouteErrorBoundary` (used at every layer of the tree) owns
              // only the UI variant and intentionally does NOT report again
              // to avoid duplicate reports.
              captureError(error, {
                context: "RouterProvider",
                tags: {
                  boundary: isChunkLoadError(error)
                    ? "lazy-route"
                    : "route-render",
                },
              });
            }}
          />
        </AppProviders>
      </ErrorBoundary>
    </StrictMode>,
  );
}

function showBootFailure(error: unknown): void {
  try {
    captureError(error, { context: "app_boot" });
  } catch (captureFailure) {
    console.error("Unable to report the startup failure", captureFailure);
  }
  void markNativeLaunchScreenReady("system");

  try {
    const root = document.getElementById("root");
    if (!root) {
      return;
    }
    const container = document.createElement("main");
    container.setAttribute("role", "alert");
    container.style.cssText =
      "min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;font-family:system-ui,sans-serif";
    const content = document.createElement("div");
    const heading = document.createElement("h1");
    heading.textContent = STARTUP_FAILURE_TITLE;
    const message = document.createElement("p");
    message.textContent = STARTUP_FAILURE_MESSAGE;
    const reload = document.createElement("button");
    reload.type = "button";
    reload.textContent = "Reload app";
    reload.addEventListener("click", () => window.location.reload());
    content.append(heading, message, reload);
    container.append(content);
    root.replaceChildren(container);
  } catch (renderError) {
    console.error("Unable to show the startup error", renderError);
  }
}
