/**
 * The selected assistant's gateway connection lifecycle: establish it at
 * boot (riding out the gateway's startup window) and re-verify it when the
 * app resumes. The web bundle manages no gateway session — the primed
 * tokenless same-origin slot is all the credential there is — so this is
 * connection maintenance, not authentication: keep the selected assistant's
 * gateway connection live whenever one can exist.
 */
import { subscribe } from "@/lib/event-bus";
import {
  getActiveAssistant,
  hasLocalGateway,
  hasPairedGateway,
  primeLocalGatewayConnection,
  primeLocalGatewayConnectionWithStartupRetry,
} from "@/lib/local-mode";
import { endSession } from "@/lib/auth/session-hygiene";

/**
 * Whether the app booted on the public `/assistant/pair` route (prefix-
 * tolerant: tunnel-served deployments live under `/assistant-123/…`).
 */
function onPublicPairingRoute(): boolean {
  return /\/assistant\/pair\/?$/.test(window.location.pathname);
}

/**
 * Boot establishment. The public pair page establishes its session through
 * the pairing flow itself, so retained account-scoped caches are torn down
 * instead of a connection being primed. A selected assistant carrying
 * gateway machinery gets its connection primed through the startup-retry
 * primitive: on reboot the gateway (a Login Item) restarts concurrently
 * with the app, so a single prime would surface recovery controls for an
 * assistant that reconnects on its own. Still no `wake`: app launch must
 * not spawn assistant processes.
 */
export async function establishGatewayConnection(): Promise<void> {
  if (onPublicPairingRoute()) {
    await endSession();
    return;
  }
  if (
    hasLocalGateway(getActiveAssistant()) ||
    hasPairedGateway(getActiveAssistant())
  ) {
    try {
      await primeLocalGatewayConnectionWithStartupRetry();
    } catch {
      await endSession();
    }
  }
}

/**
 * Re-verification: a selection with a resolvable gateway gets its
 * connection re-primed — the prime rebuilds a dead slot. Everything else
 * has no connection to re-verify.
 */
export async function reverifyGatewayConnection(): Promise<void> {
  const selectedAssistant = getActiveAssistant();
  if (
    selectedAssistant &&
    (hasPairedGateway(selectedAssistant) ||
      hasLocalGateway(selectedAssistant))
  ) {
    try {
      await primeLocalGatewayConnection();
    } catch {
      await endSession();
    }
  }
}

/**
 * Subscribe to app-resume signals so the connection is re-verified when the
 * app comes back to the foreground. Call once at app startup.
 */
export function watchGatewayConnectionOnResume(): () => void {
  return subscribe("app.resume", () => {
    void reverifyGatewayConnection().catch((err: unknown) =>
      console.warn("gateway connection re-verification failed", err),
    );
  });
}
