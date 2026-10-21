import { useNavigate } from "react-router";

import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { routes } from "@/utils/routes";

/**
 * Sends the session to the assistant route when the local gateway rejects it
 * past what the renderer can repair on its own.
 *
 * The chooser that used to own the re-provision is gone — the app bundle's
 * recovery flows took it — so the iframe lands on its assistant route, where
 * the shell's error surfaces describe the dead session.
 *
 * Mounted once in `RootLayout`, so a session that dies mid-conversation lands
 * there from whichever route it was on. It replaces that route rather than
 * stacking on it: the route it came from renders against a session the
 * gateway refuses, so Back would return the user to a dead page that cannot
 * heal.
 */
export function useGuardianRepairRoute(): void {
  const navigate = useNavigate();
  useBusSubscription("gateway.guardian-repair-required", () => {
    void navigate(routes.assistant, { replace: true });
  });
}
