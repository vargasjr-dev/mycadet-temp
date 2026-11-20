import type { ReactNode } from "react";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { CloudOff } from "lucide-react";

import { Typography } from "@mycadet/design-library";

import { healthzGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { markNativeLaunchScreenReady } from "@/runtime/native-launch-screen";

export const WAKING_GATE_TITLE = "Assistant is waking";
export const WAKING_GATE_MESSAGE =
  "The assistant's vm isn't answering yet — this screen leaves on its own once the services come up.";

// The waking cadence: the vm usually answers within about a minute of a
// wake, and each miss re-arms the query, so no manual refresh is needed.
const WAKING_POLL_MS = 5_000;

/**
 * The app bundle's health gate. The resolve layer stamps an assistant id
 * before the first render; until that assistant's runtime answers its
 * health check, the routes render nothing — a bundle booted against a
 * sleeping vm would just 404 its way through every call. The same gate
 * covers both worlds (self-hosted cadet or the cloud platform) because the
 * check rides each environment's own daemon transport.
 *
 * Once healthy the gate stays open: a later blip revalidates in the
 * background instead of yanking the routes back to the waking screen.
 */
export function AssistantWakingGate({ children }: { children: ReactNode }) {
  const assistantId = useActiveAssistantId();
  // Pre-resolution the id is empty — the gate waits for a stamped id
  // rather than probing with one that can't resolve to anything.
  const enabled = assistantId !== "";
  const healthz = useQuery({
    ...healthzGetOptions({ path: { assistant_id: assistantId } }),
    enabled,
    retry: false,
    staleTime: 0,
    refetchInterval: WAKING_POLL_MS,
  });

  if (!enabled || healthz.isSuccess) {
    return <>{children}</>;
  }
  return <AssistantWaking />;
}

/**
 * The waking screen itself — the same visual language as the boot floor
 * (`StartupFailure`): icon, honest copy, no dead ends. The query above
 * owns the retry, so the screen is static by design.
 */
function AssistantWaking() {
  useEffect(() => {
    void markNativeLaunchScreenReady("system");
  }, []);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[var(--background)] p-6 text-[var(--content-tertiary)]">
      <div
        role="status"
        className="flex max-w-md flex-col items-center gap-[var(--app-spacing-md)] text-center"
      >
        <CloudOff className="size-6" aria-hidden="true" />
        <Typography variant="body-medium-default">
          {WAKING_GATE_TITLE}
        </Typography>
        <p className="text-body-medium-lighter text-[var(--content-secondary)]">
          {WAKING_GATE_MESSAGE}
        </p>
      </div>
    </main>
  );
}
