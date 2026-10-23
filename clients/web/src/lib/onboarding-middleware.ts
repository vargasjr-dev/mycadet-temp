import { redirect, type MiddlewareFunction } from "react-router";

import { resolveNavigation } from "@/lib/navigation/navigation-resolver";
import { buildNavigationState } from "@/lib/navigation/build-state";
import { hardNavigateIfCrossBundle } from "@/lib/navigation/shell-consent-bounce";
import { routes } from "@/utils/routes";

export const onboardingCompletedMiddleware: MiddlewareFunction = async (
  { request },
  next,
) => {
  const url = new URL(request.url);
  // Developer "Replay Hatch Failure" tool: the hatching screen short-circuits
  // straight to its error UI when `fail` is present (no real hatch side
  // effects), so it's safe to let preview through for that one case only.
  const isHatchFailurePreview =
    url.searchParams.get("preview") === "true" &&
    url.pathname === routes.onboarding.hatching &&
    url.searchParams.get("fail") !== null;
  if (isHatchFailurePreview) {
    return next();
  }
  // Auth has already been verified by the parent auth middleware.
  // Path AND query, exactly as `authMiddleware` resolves: the guard reads the
  // query (the new-assistant marker, a paid hatch's `returnTo`), so resolving
  // on a bare pathname silently strips the evidence its own branches look for.
  const decision = resolveNavigation(
    buildNavigationState({ sessionSettled: true, isAuthenticated: true }),
    { kind: "route-guard", pathname: url.pathname + url.search },
  );
  // A "wait" decision (still-hydrating state) falls through to next(): the
  // parent auth middleware owns hydration waits, so rendering is the safe
  // fallback here.
  if (decision.action === "redirect") {
    if (hardNavigateIfCrossBundle(decision.to)) {
      return next();
    }
    throw redirect(decision.to);
  }
  return next();
};
