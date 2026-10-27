import { redirect, type MiddlewareFunction } from "react-router";

import { resolveNavigation } from "@/lib/navigation/navigation-resolver";
import { hardNavigateIfCrossBundle } from "@/lib/navigation/shell-consent-bounce";
import { buildNavigationState } from "@/lib/navigation/build-state";

export const authMiddleware: MiddlewareFunction = (args, next) =>
  resolveWithGuard(args, next);

const resolveWithGuard = async (
  { request }: Parameters<MiddlewareFunction>[0],
  next: Parameters<MiddlewareFunction>[1],
): Promise<Awaited<ReturnType<MiddlewareFunction>>> => {
  const url = new URL(request.url);

  const decision = resolveNavigation(buildNavigationState(), {
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
