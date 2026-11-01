import { matchOperatorRequest } from "@mycadet/local-mode";

/**
 * The operator mount: the headless lifecycle operations the `app://` handler
 * serves BEFORE the gateway data-plane planner. An on-machine entry's retire
 * DELETE is answered host-side by the retire operation (in-process — no CLI
 * spawn), so the bundle's one endpoint holds for every entry type; a pass
 * (unknown id, platform-hosted entry) falls through to the planner
 * untouched.
 *
 * Lives apart from `gateway-forward.ts` on purpose: the operator mount
 * outlives the gateway proxy, which a future operations tranche deletes.
 */
export async function forwardOperatorRequest(
  request: Request,
): Promise<Response | null> {
  const match = matchOperatorRequest(
    new URL(request.url).pathname,
    request.method,
  );
  if (!match) return null;
  return match.route.run(match.assistantId);
}
