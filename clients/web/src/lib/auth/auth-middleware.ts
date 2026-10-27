import { redirect, type MiddlewareFunction } from "react-router";

import { isLocalClient, hasAssistants } from "@/lib/local-mode";
import { resolveNavigation } from "@/lib/navigation/navigation-resolver";
import { hardNavigateIfCrossBundle } from "@/lib/navigation/shell-consent-bounce";
import { buildNavigationState } from "@/lib/navigation/build-state";
import { captureError } from "@/lib/error-reporting/capture-error";
import {
  whenCloudSessionProbed,
  type CloudSessionAnswer,
} from "@/stores/auth-store";

let PLATFORM_SESSION_PROBE_TIMEOUT_MS = 5_000;

/** Test hook: clamp the probe wait so timeout paths are testable without real 5s waits. */
export function __setProbeWaitTimeoutForTesting(ms: number): void {
  PLATFORM_SESSION_PROBE_TIMEOUT_MS = ms;
}

/** Test hook: clear the one-shot late-probe revalidation latch between tests. */
export function __resetProbeRevalidationForTesting(): void {
  probeRevalidationPending = false;
}

/**
 * Await the cloud-session probe's answer, bounded. The timeout decides on a
 * forced `"absent"`, which is the right fallback for an org with no platform
 * account and the wrong one for an org whose probe was merely slow — a paid
 * checkout return is then admitted to the welcome funnel with no way back.
 * The late result is not lost: `revalidateWhenPlatformProbeSettles` re-runs
 * the guard when it lands.
 */
function probeAnswerBounded(): Promise<
  { kind: "answered"; answer: CloudSessionAnswer } | { kind: "timeout" }
> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    whenCloudSessionProbed().then(
      (answer): { kind: "answered"; answer: CloudSessionAnswer } => ({
        kind: "answered",
        answer,
      }),
    ),
    new Promise<{ kind: "timeout" }>((resolve) => {
      timeoutHandle = setTimeout(
        () => resolve({ kind: "timeout" }),
        PLATFORM_SESSION_PROBE_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timeoutHandle));
}

/** Whether a late probe result already has a guard re-run waiting on it. */
let probeRevalidationPending = false;

/**
 * Re-run the route guard once a timed-out probe reports its result. Nothing
 * else re-runs middleware on a probe settling, so the correction has to be
 * driven from here.
 */
function revalidateWhenPlatformProbeSettles(): void {
  if (probeRevalidationPending) {
    return;
  }
  probeRevalidationPending = true;
  void whenCloudSessionProbed()
    .then(() => import("@/routes"))
    .then(({ router }) => router.revalidate())
    .catch((error: unknown) => {
      captureError(error, {
        context: "authMiddleware.platformProbeRevalidation",
      });
    })
    .finally(() => {
      probeRevalidationPending = false;
    });
}

export const authMiddleware: MiddlewareFunction = (args, next) =>
  resolveWithGuard(args, next);

const resolveWithGuard = async (
  { request }: Parameters<MiddlewareFunction>[0],
  next: Parameters<MiddlewareFunction>[1],
): Promise<Awaited<ReturnType<MiddlewareFunction>>> => {
  const url = new URL(request.url);

  // The local no-assistant fork is the only reader of the cloud-session
  // answer (hosting vs welcome), and the local-mode case that hangs on the
  // probe is the cold boot with an empty lockfile. Await the probe there —
  // bounded, so a fetch that hangs degrades to a decision instead of looping
  // navigation in timeout-sized chunks. Every other plane decides without
  // it: the served funnel routes on the roster, and the platform funnel
  // never reads the answer.
  let cloudSession: CloudSessionAnswer = "absent";
  if (isLocalClient() && !hasAssistants()) {
    const outcome = await probeAnswerBounded();
    if (outcome.kind === "timeout") {
      revalidateWhenPlatformProbeSettles();
    } else {
      cloudSession = outcome.answer;
    }
  }

  const decision = resolveNavigation(buildNavigationState(cloudSession), {
    kind: "route-guard",
    pathname: url.pathname + url.search,
  });

  if (decision.action === "redirect") {
    if (hardNavigateIfCrossBundle(decision.to)) {
      return next();
    }
    throw redirect(decision.to);
  }

  return next();
};
