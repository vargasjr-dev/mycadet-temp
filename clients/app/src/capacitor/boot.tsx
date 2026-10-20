import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Network } from "@capacitor/network";
import { RootHydrateFallback } from "@app/components/root-hydrate-fallback";
import { AppI18nProvider } from "@app/i18n/provider";
import { useTranslation } from "@app/i18n/react";
import { readCapacitorBootConfig } from "./boot-config";
import "../index.css";

/**
 * The Capacitor boot shell. The mobile apps bake this bundle as their
 * `webDir`, so it renders the initial Cadet screens from local assets with
 * zero network, then hands off to the environment's session-gated assistant
 * entry (`__CADET_CONFIG__.handoffUrl`, stamped by `build:capacitor`). Login,
 * session cookies, and the Capacitor plugin bridge all live on the entry
 * origin — the handoff changes none of that; it only moves where the first
 * paint comes from.
 *
 * While the boot bundle runs, the host bridge is the only Capacitor surface
 * that exists, so the shell never iframes remote content: it either hands off
 * (top-level navigation, exactly what the baked `server.url` used to do at
 * startup) or renders the honest offline state until connectivity returns.
 */
function Boot() {
  const { t } = useTranslation("account");
  const handoffUrl = readCapacitorBootConfig()?.handoffUrl;
  const [offline, setOffline] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!handoffUrl) return;
    let active = true;
    let listener: { remove: () => void } | undefined;
    const leave = () => {
      window.location.replace(handoffUrl);
    };
    void Network.getStatus()
      .then((status) => {
        if (!active) return;
        if (!status.connected) {
          setOffline(true);
          // Auto-resume the handoff when connectivity returns — the splash
          // must never wedge because a launch raced a dead network.
          void Network.addListener("networkStatusChange", (change) => {
            if (change.connected) leave();
          }).then((handle) => {
            if (active) {
              listener = handle;
            } else {
              void handle.remove();
            }
          });
          return;
        }
        leave();
      })
      .catch(() => {
        // No Capacitor bridge (plain-browser dev against the built bundle) —
        // there is no connectivity signal to wait on, so hand off.
        if (active) leave();
      });
    return () => {
      active = false;
      void listener?.remove();
    };
  }, [handoffUrl, attempt]);

  if (offline || !handoffUrl) {
    return (
      <div className="flex min-h-svh items-center justify-center" role="status">
        <div className="flex flex-col items-center gap-4">
          <p className="text-sm text-[var(--content-tertiary)]">
            {t("appShell.error")}
          </p>
          {handoffUrl && (
            <button
              type="button"
              onClick={() => {
                setOffline(false);
                setAttempt((n) => n + 1);
              }}
            >
              {t("appShell.retry")}
            </button>
          )}
        </div>
      </div>
    );
  }
  return <RootHydrateFallback />;
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("App root element is missing.");
}
createRoot(root).render(
  <StrictMode>
    <AppI18nProvider>
      <Boot />
    </AppI18nProvider>
  </StrictMode>,
);
