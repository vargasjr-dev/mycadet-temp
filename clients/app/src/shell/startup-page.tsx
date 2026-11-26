import { Navigate } from "react-router";
import { useEffect, useState } from "react";
import { useAssistantRequest } from "@app/assistant/use-assistant-request";
import { assistantSelectionState } from "@app/assistant/assistant-selection";
import { RootHydrateFallback } from "@app/components/root-hydrate-fallback";
import { WelcomeScreen } from "@app/domains/onboarding/pages/welcome-screen";
import { routes } from "@app/utils/routes";
import { detectVellumOffer } from "@app/shell/vellum-offer";

/** "checking" while the desktop bridge probes for a pending vellum root. */
type VellumOffer = "checking" | "offer" | "none";

/**
 * The desktop app detects a pending vellum migration and navigates
 * straight to the migration screen — before any other screen an upgrader
 * would see. Web builds have no bridge and resolve to "none" at once.
 */
function useVellumOffer(): VellumOffer {
  const [offer, setOffer] = useState<VellumOffer>(() =>
    window.cadet?.vellumMigration ? "checking" : "none",
  );
  useEffect(() => {
    if (offer !== "checking") return;
    let disposed = false;
    void detectVellumOffer().then((probe) => {
      if (!disposed) setOffer(probe ? "offer" : "none");
    });
    return () => {
      disposed = true;
    };
  }, [offer]);
  return offer;
}

/** Resume the host's saved assistant; welcome is only for an empty host. */
export function StartupPage() {
  const { state } = useAssistantRequest({});
  const offer = useVellumOffer();

  if (offer === "checking" || state.status === "loading") {
    return <RootHydrateFallback />;
  }
  if (offer === "offer") {
    return <Navigate to={routes.account.onboarding.vellum} replace />;
  }
  if (state.status === "empty") return <WelcomeScreen />;
  if (state.status === "selection") {
    return <Navigate to={routes.account.selectAssistant} replace />;
  }
  if (state.status === "unauthenticated") {
    return <Navigate to={routes.account.pair} replace />;
  }
  return (
    <Navigate
      to={routes.assistant}
      replace
      state={
        state.status === "ready"
          ? assistantSelectionState(state.assistant.id)
          : undefined
      }
    />
  );
}
