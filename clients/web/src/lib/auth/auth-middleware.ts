import { redirect, type MiddlewareFunction } from "react-router";

import { useAuthStore } from "@/stores/auth-store";
import { isLocalClient, hasAssistants } from "@/lib/local-mode";
import { resolveNavigation } from "@/lib/navigation/navigation-resolver";
import { hardNavigateIfCrossBundle } from "@/lib/navigation/shell-consent-bounce";
import { buildNavigationState } from "@/lib/navigation/build-state";
import { captureError } from "@/lib/error-reporting/capture-error";
import { probeBootResolution } from "@/assistant/queries";
import { whenStoreState } from "@/utils/when-store-state";

const PLATFORM_SESSION_PROBE_TIMEOUT_MS = 5_000;

/** Whether a late probe result already has a guard re-run waiting on it. */
let probeRevalidationPending = false;

/**
 * Re-run the route guard once a timed-out platform probe reports its result.
 *
 * The timeout decides on a forced `"absent"`, which is the right fallback for
 * an org with no platform account and the wrong one for an org whose probe was
 * merely slow — a paid checkout return is then admitted to billing, which has
 * no cloud assistant to apply the purchase to and no way out. Nothing else
 * re-runs middleware on a store change, so the correction has to be driven
 * from here.
 *
 * `cloudSession` leaves `"unknown"` at most once (re-probes keep the last
 * settled value), the subscription is one-shot, and the re-run reads a settled
 * session — so it never waits on the probe, never times out, and never arms
 * another re-run.
 */
function revalidateWhenPlatformProbeSettles(): void {
  if (probeRevalidationPending) {
    return;
  }
  probeRevalidationPending = true;
  const unsubscribe = useAuthStore.subscribe((state) => {
    if (state.cloudSession === "unknown") {
      return;
    }
    unsubscribe();
    probeRevalidationPending = false;
    // Lazily imported: `@/routes` builds the router out of this middleware, so
    // a static import is a cycle.
    void import("@/routes")
      .then(({ router }) => router.revalidate())
      .catch((error: unknown) => {
        captureError(error, {
          context: "authMiddleware.platformProbeRevalidation",
        });
      });
  });
}

/** Waits that ran out on an earlier pass; each stays forced from then on. */
interface TimedOutWaits {
  platformProbe: boolean;
}

const NO_TIMED_OUT_WAITS: TimedOutWaits = { platformProbe: false };

export const authMiddleware: MiddlewareFunction = (args, next) =>
  resolveWithGuard(args, next, NO_TIMED_OUT_WAITS);

const resolveWithGuard = async (
  { request, context }: Parameters<MiddlewareFunction>[0],
  next: Parameters<MiddlewareFunction>[1],
  timedOut: TimedOutWaits,
): Promise<Awaited<ReturnType<MiddlewareFunction>>> => {
  const url = new URL(request.url);

  // After a timed-out wait, force that wait's own flag so the resolver decides
  // on whatever state exists instead of returning another "wait" — a fetch that
  // hangs (never reaching any settle path) must degrade to a decision, not loop
  // navigation in timeout-sized chunks. A platform probe that outran its wait
  // degrades to `"absent"`: every step that reads the probe treats an
  // unsettled session as "no decision yet" and a settled-absent one as "no
  // platform account", so forcing it can only turn a non-decision into that
  // documented fallback. A result that lands after the timeout re-runs the
  // guard (see `revalidateWhenPlatformProbeSettles`), so a slow-but-successful
  // probe still reaches its cloud-session destination.
  const state = buildNavigationState({
    ...(timedOut.platformProbe ? { cloudSession: "absent" as const } : {}),
  });

  const decision = resolveNavigation(state, {
    kind: "route-guard",
    pathname: url.pathname + url.search,
  });

  if (decision.action === "wait") {
    // The boot resolution is the settle fact behind every session question
    // the resolver asks. One probe replaces the former session-probe wait
    // and the assistant-list hydration wait — the hydration flag that wait
    // awaited has no writer off the local arm, so off the local arm it was
    // a clock; the projection this probe performs is what it was
    // simulating. The probe settles in one fetch (a transport failure
    // records as non-authoritative, LUM-2412): a settled rejection
    // redirects at `requireAuth`, and everything else leaves the resolver a
    // decided world instead of a looping one.
    await probeBootResolution();
    // Two local-mode cases hang on the cloud probe: the cold boot with an
    // empty lockfile, and any step that names the signal on its wait — a
    // checkout return whose org already has a self-hosted assistant reaches
    // the latter with `hasAssistants()` already true.
    let platformProbeStillUnknown = false;
    if (
      !timedOut.platformProbe &&
      isLocalClient() &&
      (!hasAssistants() || decision.waitFor === "cloud-session")
    ) {
      await whenStoreState(useAuthStore, (s) => s.cloudSession !== "unknown", {
        timeoutMs: PLATFORM_SESSION_PROBE_TIMEOUT_MS,
      });
      platformProbeStillUnknown =
        useAuthStore.getState().cloudSession === "unknown";
      if (platformProbeStillUnknown) {
        revalidateWhenPlatformProbeSettles();
      }
    }
    return resolveWithGuard(
      { request, context } as Parameters<MiddlewareFunction>[0],
      next,
      {
        platformProbe: timedOut.platformProbe || platformProbeStillUnknown,
      },
    );
  }

  if (decision.action === "redirect") {
    if (hardNavigateIfCrossBundle(decision.to)) {
      return next();
    }
    throw redirect(decision.to);
  }

  return next();
};
