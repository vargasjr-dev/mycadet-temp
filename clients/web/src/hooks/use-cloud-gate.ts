import { useEffect, useState } from "react";

import {
  useHasCloudSession,
  useIsCloudSessionSettled,
} from "@/stores/auth-store";
import { useAssistantResolution } from "@/assistant/queries";

/**
 * How a cloud-dependent UI surface should behave, given the app mode,
 * platform session, and active assistant:
 *
 *   - `"full"`     — render the feature and let the user use it.
 *   - `"disabled"` — render the feature but block interaction (e.g. show
 *                    it greyed-out behind a "sign in to use this" prompt).
 *                    Reached when the cloud is reachable but there is
 *                    no platform session.
 *   - `"gated"`    — hide the feature entirely; it has no meaning in this
 *                    context — local mode with the cloud API disabled,
 *                    or (for `cloudHostedOnly` surfaces) a self-hosted
 *                    active assistant.
 */
export type CloudGateState = "full" | "disabled" | "gated";

/**
 * {@link CloudGateState} plus the pre-settle window as its own value.
 *
 *   - `"pending"` — the cloud-session probe has not settled, so "no session"
 *     is not an answer yet, only the absence of one. A surface whose decision
 *     is irreversible for the user (leaving the route, dropping stashed state,
 *     bouncing a paid entry point) must hold here rather than read it as
 *     `"disabled"`.
 *
 * {@link useCloudGate} collapses `"pending"` into `"disabled"`: the surfaces
 * it serves render either way and correct themselves when the probe lands, so
 * an extra state would only add a branch nothing acts on.
 */
export type CloudGateStateWithPending = CloudGateState | "pending";

/**
 * How long {@link useCloudGateWithPending} holds `"pending"` before deciding
 * on `"disabled"`.
 *
 * Every path that completes settles the probe itself; this bounds the one that
 * never completes. The fallback matches the route guard's: an unsettled session
 * means "no decision yet" and a settled-absent one means "no platform account",
 * so forcing the decision can only turn a non-decision into that documented
 * answer.
 */
export const PLATFORM_SESSION_SETTLE_TIMEOUT_MS = 5_000;

export interface CloudGateOptions {
  /**
   * When `true`, the feature is cloud-hosted only — gate it whenever
   * the **active assistant** is self-hosted, regardless of platform
   * session. Use for UI surfaces that manage
   * Cadet-hosted infrastructure (plan/billing tier, devices, machine
   * sizing, release channels, sleep policy, system events) which have
   * no meaningful behavior on a self-hosted assistant.
   *
   * The decision is "is the active assistant self-hosted?" — not "is
   * the app running in local mode?" Two cases this matters for:
   *
   *   1. A **local-mode app** can be acting on a cloud-hosted
   *      assistant (lockfile entry with `cloud === "cloud"`). The
   *      platform billing/plan UI for that assistant IS meaningful.
   *   2. A **platform-mode app** can be acting on a self-hosted
   *      assistant — when the cloud API returns `is_local: true`,
   *      `resolveAssistantLifecycleState` projects `kind: "self_hosted"`
   *      and the user is effectively connected to a daemon. The
   *      platform billing/plan UI for that assistant is NOT meaningful.
   *
   * The reactive source is `the assistant resolution`,
   * which is written by the lifecycle service from server resolutions
   * and gateway-auth short-circuits and covers both cases above.
   *
   * Truth table:
   *
   * | Active assistant            | Platform session | Result       |
   * | --------------------------- | ---------------- | ------------ |
   * | cloud-hosted             | yes              | `"full"`     |
   * | cloud-hosted             | no               | `"disabled"` |
   * | self-hosted                 | any              | `"gated"`    |
   * | none resolved (loading etc) | yes              | `"full"`     |
   * | none resolved               | no               | `"disabled"` |
   *
   * Defaults to `false` — the standard `"full" / "disabled" / "gated"`
   * behavior gated on the cloud session.
   */
  cloudHostedOnly?: boolean;
}

export interface PendingCloudGateOptions extends CloudGateOptions {
  /**
   * How long `"pending"` may hold before the gate decides on `"disabled"`.
   * Defaults to {@link PLATFORM_SESSION_SETTLE_TIMEOUT_MS}; tests shorten it.
   */
  settleTimeoutMs?: number;
}

/**
 * Is the currently-active assistant self-hosted? Reads from
 * `useAssistantLifecycleStore` so the answer reactively flips as the
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
 * self-hosted assistant. `useCloudGate({ cloudHostedOnly: true })`
 * deliberately returns `"full"` during the lifecycle `loading` window
 * (when no server resolution has landed yet) so UI doesn't flicker to
 * `gated` on a fresh deep-link — fine for rendering, NOT fine for
 * kicking off a doomed platform-API request on a settings route that
 * is not mounted under `<ActiveAssistantGate>`.
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
 * const cloudGate = useCloudGate({ cloudHostedOnly: true });
 * const isCloudHosted = useActiveAssistantIsCloudHosted();
 * useQuery({
 *   ...someOrgScopedQueryOptions(),
 *   enabled: cloudGate === "full" && isCloudHosted,
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
 * before any server resolution or short-circuit has landed. That's the
 * only state where the gate intentionally returns `"full"` despite
 * unknown hosting (to avoid chrome flicker on deep-links). Pair it with
 * the gate value to build `isResolving`:
 *
 * ```ts
 * const cloudGate = useCloudGate({ cloudHostedOnly: true });
 * const isResolving =
 *   cloudGate === "full" && useActiveAssistantLifecycleIsLoading();
 * ```
 *
 * Already-resolved non-hosted lifecycle kinds (`error`)
 * should fall through to whatever empty /
 * error UX the surface already has — the gate's `"gated"` branch is
 * reserved for *self-hosted* assistants, and these states aren't
 * self-hosted, they're absent / broken. Don't gate them as "still
 * loading."
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
 * Resolve how a cloud-dependent UI surface should behave — see
 * {@link CloudGateState} for what each result means.
 *
 * Two modes, selected by `options.cloudHostedOnly`:
 *
 *   - **Default** (most surfaces): the cloud session decides:
 *
 *     | Platform session | Result       |
 *     | ---------------- | ------------ |
 *     | no               | `"disabled"` |
 *     | yes              | `"full"`     |
 *
 *   - **`cloudHostedOnly: true`**: for surfaces that only make sense
 *     against a Cadet-hosted assistant (billing, devices, sleep policy,
 *     …). Gates on the active assistant's hosting instead of the app
 *     mode. See {@link CloudGateOptions.cloudHostedOnly} for its
 *     truth table and rationale.
 *
 * Both modes read the cloud-session pre-settle window as `"disabled"`:
 * these surfaces render either way and re-render when the probe lands. A
 * surface that instead acts irreversibly on `"disabled"` wants
 * {@link useCloudGateWithPending}, which keeps that window distinct.
 */
export function useCloudGate(options: CloudGateOptions = {}): CloudGateState {
  const state = useCloudGateDecision(options);
  return state === "pending" ? "disabled" : state;
}

/**
 * {@link useCloudGate} with the pre-settle window kept distinct — see
 * {@link CloudGateStateWithPending}.
 *
 * `"pending"` is bounded: it is held for at most `settleTimeoutMs` (default
 * {@link PLATFORM_SESSION_SETTLE_TIMEOUT_MS}) and then decides on `"disabled"`,
 * so a probe that never settles still reaches an answer instead of holding a
 * surface on its loading state forever.
 *
 * Use this only where reading the pre-settle window as `"disabled"` would take
 * an action the user can't undo — leaving the route, clearing stashed state,
 * bouncing a paid entry point. Everything else wants {@link useCloudGate},
 * which renders now and re-renders when the probe lands.
 */
export function useCloudGateWithPending(
  options: PendingCloudGateOptions = {},
): CloudGateStateWithPending {
  const state = useCloudGateDecision(options);
  const settleDeadlinePassed = useDeadlinePassed(
    state === "pending",
    options.settleTimeoutMs ?? PLATFORM_SESSION_SETTLE_TIMEOUT_MS,
  );
  if (state === "pending" && settleDeadlinePassed) {
    return "disabled";
  }
  return state;
}

/**
 * The gate's decision tree, with the cloud-session pre-settle window
 * reported as `"pending"`. The two public hooks differ only in what they do
 * with that value.
 */
function useCloudGateDecision(
  options: CloudGateOptions,
): CloudGateStateWithPending {
  // Atomic selectors — each returns a primitive so Zustand's default
  // `Object.is` snapshot equality is stable and `useSyncExternalStore`
  // does not loop. See CONVENTIONS.md § State management — `useShallow`
  // is not introduced in new code; atomic selectors avoid the need.
  //
  // Gate on the bare cloud-session signal — deliberately not a per-assistant
  // reachability check, which would fork on hosting type and change the
  // self-hosted rows (states 3–5) of the truth table.
  const hasCloudSession = useHasCloudSession();
  const cloudSessionSettled = useIsCloudSessionSettled();
  const activeIsSelfHosted = useActiveAssistantIsSelfHosted();

  // Only the negative branch consults the settle: `"present"` is a settled
  // value by construction, so a live session is decisive on its own.
  const noSession: CloudGateStateWithPending = cloudSessionSettled
    ? "disabled"
    : "pending";

  // Platform-hosted-only branch is fully self-contained: it only depends
  // on the active assistant's hosting and the cloud session.
  if (options.cloudHostedOnly) {
    if (activeIsSelfHosted) {
      return "gated";
    }
    if (!hasCloudSession) {
      return noSession;
    }
    return "full";
  }

  if (!hasCloudSession) {
    return noSession;
  }
  return "full";
}

/**
 * `true` once `timeoutMs` has elapsed with `armed` continuously set. Disarming
 * cancels the timer and clears the result, so a window that reopens gets a
 * fresh deadline rather than an already-expired one.
 */
function useDeadlinePassed(armed: boolean, timeoutMs: number): boolean {
  const [passed, setPassed] = useState(false);
  useEffect(() => {
    if (!armed) {
      setPassed(false);
      return;
    }
    const timer = setTimeout(() => setPassed(true), timeoutMs);
    return () => {
      clearTimeout(timer);
    };
  }, [armed, timeoutMs]);
  return passed;
}
