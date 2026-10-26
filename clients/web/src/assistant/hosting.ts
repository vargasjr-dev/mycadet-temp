import { useAssistantResolution } from "@/assistant/queries";

/**
 * Hosting facts about the active assistant, read from the assistant
 * resolution. These are properties of the assistant — not of the platform
 * session — so a surface gating on "does the cloud API even apply here"
 * reads one of these instead of a session state.
 */

/**
 * Is the currently-active assistant self-hosted? Reads from
 * `useAssistantResolution` so the answer reactively flips as the
 * lifecycle service projects new server resolutions or gateway-auth
 * short-circuits.
 *
 * Returns `true` when:
 *   - the server resolved `is_local: true` → `kind: "self_hosted"`, or
 *   - the gateway-auth short-circuit fired in local mode →
 *     `kind: "active", isLocal: true`.
 *
 * Returns `false` for every other lifecycle state (`loading`,
 * `initializing`, `cleaning_up`, `error`, and `active` with
 * `isLocal: false`).
 */
export function useActiveAssistantIsSelfHosted(): boolean {
  const { state } = useAssistantResolution();
  if (state.kind === "self_hosted") {
    return true;
  }
  if (state.kind === "active" && state.isLocal) {
    return true;
  }
  return false;
}

/**
 * Is the active assistant POSITIVELY resolved as cloud-hosted?
 *
 * Use this to gate network fetches that must not fire against a
 * self-hosted assistant. Rendering gates deliberately stay `true` during
 * the lifecycle `loading` window (when no server resolution has landed
 * yet) so UI doesn't flicker on a fresh deep-link — fine for rendering,
 * NOT fine for kicking off a doomed platform-API request on a settings
 * route that is not mounted under `<ActiveAssistantGate>`.
 *
 * This helper takes the stricter side: returns `true` only when the
 * lifecycle has positively projected a cloud-hosted assistant:
 *   - `kind: "active"` with `isLocal: false`.
 *
 * Returns `false` for every other state — including `loading`,
 * `initializing`, `cleaning_up`, `self_hosted`, `error`,
 * and `active` with `isLocal: true`.
 *
 * Pair with the gate value in a query's `enabled`:
 *
 * ```ts
 * const isCloudHosted = useActiveAssistantIsCloudHosted();
 * useQuery({
 *   ...someOrgScopedQueryOptions(),
 *   enabled: isCloudHosted,
 * });
 * ```
 */
export function useActiveAssistantIsCloudHosted(): boolean {
  const { state } = useAssistantResolution();
  if (state.kind === "active" && !state.isLocal) {
    return true;
  }
  return false;
}

/**
 * Is the active assistant's hosting still being resolved?
 *
 * Use this to compute the **race-window predicate** `isResolving` on
 * cloud-hosted-only surfaces. `useActiveAssistantIsCloudHosted()`
 * returns `false` for both *"resolving"* states AND *"already-resolved
 * non-hosted"* states (`error`, `self_hosted`,
 * `active`+`isLocal:true`). Conflating those breaks UX:
 * a permanent spinner / permanent disabled button in already-decided
 * non-hosted states is not "still loading," it's "no hosted assistant."
 *
 * This helper isolates the *genuinely loading* state — `kind: "loading"`,
 * before any server resolution or short-circuit has landed.
 *
 * Already-resolved non-hosted lifecycle kinds (`error`)
 * should fall through to whatever empty /
 * error UX the surface already has — these states aren't self-hosted,
 * they're absent / broken. Don't gate them as "still loading."
 *
 * Returns `true` for `kind: "loading"` and transitional states
 * (`initializing`, `cleaning_up`) where we don't yet know the terminal
 * outcome. Returns `false` for already-resolved non-hosted states
 * (`error`).
 */
export function useActiveAssistantLifecycleIsLoading(): boolean {
  const { state } = useAssistantResolution();
  return (
    state.kind === "loading" ||
    state.kind === "initializing" ||
    state.kind === "cleaning_up"
  );
}

/**
 * The active assistant's hosting as one value, for surfaces that branch on
 * it (render the feature, show the not-for-self-hosted fallback, hold a
 * loading state, or fall through to empty/error UX):
 *
 *   - `"cloud"`      — positively resolved cloud-hosted; managed features run.
 *   - `"self_hosted"` — resolved self-hosted (server `is_local: true` or the
 *     gateway-auth short-circuit); managed features have no meaning here.
 *   - `"resolving"`  — hosting not yet known (`loading`, `initializing`,
 *     `cleaning_up`); surfaces that must not flicker render and correct
 *     themselves, queries wait.
 *   - `"unavailable"` — resolution concluded with `error`; fall through to
 *     the surface's existing empty/error UX rather than reading it as
 *     "still loading" or "self-hosted".
 */
export type AssistantHosting =
  | "cloud"
  | "self_hosted"
  | "resolving"
  | "unavailable";

export function useAssistantHosting(): AssistantHosting {
  const { state } = useAssistantResolution();
  if (state.kind === "active") {
    return state.isLocal ? "self_hosted" : "cloud";
  }
  if (state.kind === "self_hosted") {
    return "self_hosted";
  }
  if (state.kind === "error") {
    return "unavailable";
  }
  return "resolving";
}
