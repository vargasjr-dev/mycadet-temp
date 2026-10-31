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
import { StartupFailure } from "@/components/startup-failure";
import { WindowDragRegion } from "@/components/window-drag-region";
import { initI18n } from "@/i18n";
import { setupRemoteGatewayNavBridge } from "@/lib/auth/remote-gateway-nav-bridge";
import { isChunkLoadError } from "@/lib/chunk-errors";
import { captureError } from "@/lib/error-reporting/capture-error";
import { installTranslateDomGuard } from "@/lib/translate-dom-guard";
import { ErrorBoundary } from "@/components/error-boundary";
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
  // The cloud host mirrors iframe navigations into the browser URL and
  // drives back/forward back down — register before the first render so the
  // boot route is announced.
  setupRemoteGatewayNavBridge();
  // The resolved assistant stamped itself: the store derives its boot entry
  // from the served synthesis at module init (the host stamped the one
  // assistant this surface serves). Local mode awaits `initSession()` above,
  // so this separates "session was the boot cost" from "the app tree was".

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

  // Render the styled `StartupFailure` through React rather than a hand-rolled
  // DOM alert: boot failed before the app's own `createRoot` ran, so `#root`
  // is still empty and a fresh root here is safe. The boolean guards a
  // double-fire (two awaited stages can both reject).
  try {
    const rootEl = document.getElementById("root");
    if (!rootEl || bootFailureRendered) {
      return;
    }
    bootFailureRendered = true;
    createRoot(rootEl).render(<StartupFailure error={error} />);
  } catch (renderError) {
    console.error("Unable to show the startup error", renderError);
  }
}

let bootFailureRendered = false;
