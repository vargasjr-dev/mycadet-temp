/**
 * Zustand auth store.
 *
 * Session lifecycle: probes the allauth session on `initSession()`,
 * re-validates when the app resumes (foreground / visibility / online,
 * delivered via the layout-scoped event bus), and synchronizes logout
 * across tabs via BroadcastChannel. Middleware, loaders, and API
 * interceptors read state synchronously via `useAuthStore.getState()`.
 *
 * References:
 * - https://zustand.docs.pmnd.rs/guides/reading-and-writing-state-outside-components
 * - https://docs.allauth.org/en/latest/headless/openapi-specification/
 */
import { create } from "zustand";

import { setSelectedAssistant } from "@/assistant/selection";
import { createSelectors } from "@/utils/create-selectors";
import {
  isAuthenticated,
  isSessionSettled,
  isSettledSessionRejection,
  hasLiveCloudSession,
  isCloudSessionSettled,
  type CloudSessionStatus,
  type SessionStatus,
} from "@/stores/session-status";

import { getSession, logout as allauthLogout } from "@/lib/auth/allauth-client";
import {
  clearSessionSnapshot,
  persistSessionSnapshot,
  readSessionSnapshot,
} from "@/lib/auth/session-snapshot";
import { getElectronSessionToken } from "@/runtime/session-token";
import { clearWidgetSnapshot } from "@/runtime/widget-snapshot";
import { resetNotificationIdentitySession } from "@/runtime/notification-avatar";
import {
  isLocalClient,
  isCadetCloudRemote,
  isServedGatewayRuntime,
  hasGatewayAssistant,
  hasLocalGateway,
  hasPairedGateway,
  getActiveAssistant,
  primeLocalGatewayConnection,
  primeLocalGatewayConnectionWithStartupRetry,
} from "@/lib/local-mode";
import { getSelfHostedIngressUrl } from "@/lib/self-hosted/connection";
import { bootstrapLocalAssistantCloudIdentity } from "@/lib/local-cloud-identity";

import { listAssistants } from "@/assistant/api";
import { deleteBiometricToken } from "@/runtime/native-biometric";
import { unregisterLiveActivityPushToken } from "@/domains/chat/voice/live-voice/live-activity-push-registration";
import { unregisterFromRemotePush } from "@/runtime/push-registration";
import {
  clearOrganization,
  useOrganizationStore,
} from "@/stores/organization-store";
import { clearUserScopedStorage } from "@/lib/auth/session-cleanup";
import {
  setSelfHostedConnection,
} from "@/lib/self-hosted/connection";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { subscribe } from "@/lib/event-bus";
import { isElectron } from "@/runtime/is-electron";
import { clearLocalCloudSession } from "@/runtime/local-mode-host";
import {
  isNativePlatform,
  isOAuthFlowInFlight,
  installSessionCookies,
  waitForNativeSessionCookie,
} from "@/runtime/native-auth";
import {
  isBiometricEnabled,
  retrieveBiometricToken,
} from "@/runtime/native-biometric";

interface AuthState {
  sessionStatus: SessionStatus;
  cloudSession: CloudSessionStatus;
}

interface AuthActions {
  initSession: () => Promise<void>;
  refreshSession: () => Promise<boolean>;
  /** App can supply cloud revocation while retaining shared native/assistant cleanup. */
  logout: (options?: {
    cloudAccount?: { revokeSession(): Promise<void> };
  }) => Promise<void>;
}

type AuthStore = AuthState & AuthActions;

/**
 * The store's `set`, narrowed to what the probe needs: a partial patch or a
 * functional updater that reads current state (used to resolve the first
 * settle without clobbering a value a newer probe already wrote).
 */
type AuthSet = (
  partial: Partial<AuthState> | ((state: AuthState) => Partial<AuthState>),
) => void;

let broadcastChannel: BroadcastChannel | null = null;
let suppressPlatformProbe = false;

/**
 * Whether the app booted on the public `/assistant/pair` route (prefix-
 * tolerant: tunnel-served deployments live under `/assistant-123/…`).
 */
function onPublicPairingRoute(): boolean {
  return /\/assistant\/pair\/?$/.test(window.location.pathname);
}

// Monotonic id stamped on every transition INTO an authenticated session.
// `endSession` awaits the widget-snapshot clear before it writes, and auth work
// overlaps: the app-resume listener can fire a second `refreshSession`, and an
// interactive sign-in can land, while an earlier conclusive rejection is still
// waiting on that bridge call. A session authenticated inside that window is
// the newer truth, so the delayed write compares the epoch it captured against
// this counter and skips itself rather than sending a freshly signed-in user
// back to login. Latest-wins, the same rule `latestCloudProbe` applies to
// overlapping platform probes.
//
// Latest-wins only settles races between *observations* of the session. An
// explicit `logout()` is not one, so it ends the session through
// `endSession(set, { authoritative: true })` and lands its write regardless.
let authEpoch = 0;

// Bumped by every explicit `logout()`, once when it starts and once when the
// session has ended. `authEpoch` settles races between observations; this
// settles the other direction, because a decision also invalidates the
// observations already in flight. A `refreshSession` that entered before the
// logout can still be inside `reconcileCloudAssistants()` or
// `organization fetch` when the authoritative session-ending write lands,
// and its later `set(authenticatedPlatformSession())` would restore signed-in
// surfaces (and re-persist the departing user's snapshot) from a
// response obtained while the credentials still existed. So each refresh
// snapshots this counter on entry and re-checks it before every authenticated
// write, abandoning the write when a logout has moved it. Bumping at both ends
// makes the invariant "no logout began or ended while I was running", which
// covers a refresh that started midway through the logout too.
//
// Nothing resets it, and nothing can wedge on it: the snapshot is taken on
// entry, so a refresh (or a connect action, or the loopback page's
// `initSession`) that starts after a logout captures the current value and
// commits normally. A fresh sign-in always works.
let logoutGeneration = 0;

/**
 * Stamp a new auth epoch and hand back the patch unchanged, so every write that
 * enters an authenticated session supersedes a session-ending write that is
 * still mid-await in {@link endSession}.
 */
function enteringAuthenticatedSession(
  patch: Partial<AuthState>,
): Partial<AuthState> {
  authEpoch += 1;
  return patch;
}

/**
 * Named state transitions — the store declares *which session it is entering*
 * instead of re-listing the same field combinations at every call site. Each
 * returns the patch for `set()`, so the actions read as a state machine.
 *
 * `cloudSession` is left untouched by transitions that don't know it yet
 * (a follow-up probe settles it); transitions that do know it set it inline.
 */
const authenticatedPlatformSession = (): Partial<AuthState> => {
  // Entering this state is the one place a cloud session is freshly
  // confirmed — persist the snapshot here so every confirmation path
  // (boot, refresh, connect, biometric retry) feeds the offline restore
  // (LUM-2412) without each call site remembering to.
  persistSessionSnapshot();
  return enteringAuthenticatedSession({
    sessionStatus: "authenticated",
    cloudSession: "present",
  });
};

const authenticatedLocalUser = (): Partial<AuthState> =>
  enteringAuthenticatedSession({
    sessionStatus: "authenticated",
  });

const sessionEnded = (): Partial<AuthState> => ({
  sessionStatus: "unauthenticated",
  cloudSession: "absent",
});

/**
 * Apply the {@link sessionEnded} transition. Every path that ends a session
 * goes through here, not through a bare `set(sessionEnded())`, because a
 * session ends far more often without an explicit `logout()` than with one:
 * a revoked or expired session settles through `refreshSession`'s 401 branch,
 * and a boot that finds no session settles through `initSession`.
 *
 * Two user-owned caches are cleared off-store. Notification identity memory is
 * invalidated synchronously so in-flight compositor work becomes stale before
 * any await. A Home Screen widget is readable without unlocking the device, so
 * the previous account's conversation titles must not outlive the session that
 * produced them, whichever way it ended. Its clear is a no-op off Capacitor
 * iOS.
 *
 * Awaited BEFORE the state write: the write is what flips signed-in surfaces
 * to the login screen, and on the logout path that can end in a hard
 * navigation that tears the page down before a detached bridge call would
 * reach the shell.
 *
 * Awaited, but not gated on: a sign-out the bridge could refuse to complete
 * would be worse than a snapshot that outlives it by one launch. It is not
 * fire-and-forget either, because a clear that does not land persists the
 * obligation and the next use of the module finishes it, so the drop is
 * at-least-once rather than best-effort. That is why nothing here reads the
 * reported outcome.
 *
 * That await is bounded but not instant (2s on an unanswering iOS bridge), so
 * the write is guarded by {@link authEpoch}: an authentication that lands while
 * the clear is outstanding supersedes this transition, and the resumed call
 * skips its write instead of reverting the newer session. The clear itself
 * still stands, being idempotent, and the fresh session's next sync rewrites
 * the snapshot.
 *
 * `authoritative` opts out of that guard, for the callers whose session end is
 * a decision rather than an observation: an explicit `logout()` has already
 * dropped the credentials, the selection, the organization and the user-scoped
 * storage by the time it gets here, so a refresh that authenticated inside the
 * clear's window is describing a session that no longer exists. Letting the
 * guard skip the write there would leave the user on signed-in surfaces after
 * pressing Log Out. Every passive path (a boot probe, a refresh 401, an
 * exhausted gateway prime) keeps the guard, because those are reports about a
 * session that a newer report is entitled to supersede.
 *
 * The decision runs the other way too: an observation already in flight when
 * the decision is made describes a session that no longer exists, so it must
 * not land either. That half lives in {@link logoutGeneration}, which
 * `refreshSession` re-checks before each of its authenticated writes.
 *
 * `keepCloudSession` omits the `cloudSession: "absent"` half of the
 * transition for the one caller that ends the session with a cloud probe
 * still in flight. Writing `"absent"` there would settle
 * {@link isCloudSessionSettled} on a value the probe is about to replace,
 * and consumers that gate on the settle (the billing tab rewrite,
 * hosting-driven UI) would act on it. The snapshot drop is unconditional.
 */
async function endSession(
  set: AuthSet,
  options?: { keepCloudSession?: boolean; authoritative?: boolean },
): Promise<void> {
  const epoch = authEpoch;
  resetNotificationIdentitySession();
  await clearWidgetSnapshot();
  if (!options?.authoritative && epoch !== authEpoch) {
    return;
  }
  set(
    options?.keepCloudSession
      ? { sessionStatus: "unauthenticated" }
      : sessionEnded(),
  );
}

/**
 * A `getSession()` outcome that says nothing about the session itself —
 * the request threw (fetch rejection), never completed, or failed for a
 * non-auth reason (429 rate limiting, 5xx outages, the Electron proxy's
 * offline 502). Distinct from a settled "no session" answer (2xx without
 * user, or an explicit 401/403/410 rejection), which is the only thing
 * allowed to end the session. Callers handle the 2xx cases themselves;
 * by the time they consult this, an ok result was already judged unusable
 * (user missing, or platform-rejected evidence), a settled negative.
 */
const isInconclusiveProbe = (
  result: Awaited<ReturnType<typeof getSession>> | null,
): boolean =>
  result === null || (!result.ok && !isSettledSessionRejection(result));

/**
 * Settle the session from the persisted user snapshot after a
 * transport-failed boot probe (offline launch, tray reopen before Wi-Fi
 * reassociates — LUM-2412). Requires a local credential: the Electron
 * session token lives in the main process, so its presence means the
 * user never signed out — the probe merely couldn't reach the cloud.
 * Web builds have no readable credential (cookie sessions), so they
 * keep the conservative login-screen behavior.
 *
 * Restores through the full `authenticatedPlatformSession` transition —
 * including `cloudSession: "present"` — rather than leaving the
 * tri-state `"unknown"`: the snapshot is only ever written when a
 * platform session was confirmed, and no probe runs offline to settle
 * an `"unknown"`, so consumers gated on it (the auth middleware's
 * no-assistant wait, the onboarding fork) would stall against their
 * timeouts. "Present" is the believed state; the app-resume/online
 * refresh revalidates once the network returns, and a settled "no
 * session" answer there ends the session (and drops the snapshot)
 * through the normal path.
 */
async function restoreOfflineSession(set: AuthSet): Promise<boolean> {
  if (!getElectronSessionToken()) {
    return false;
  }
  if (!readSessionSnapshot()) {
    return false;
  }
  set(authenticatedPlatformSession());
  return true;
}

function broadcastAuthChange(): void {
  broadcastChannel?.postMessage("auth-changed");
}

/**
 * Probe the cloud assistants endpoint and report whether the cloud API
 * conclusively rejected the session (a settled 401/403/410 from
 * the org or assistants call). Only that settled evidence may end a cloud
 * session; transport failures and other errors prove nothing (LUM-2412) and
 * leave cached lockfile data standing. Loading the cloud assistants list
 * is a separate concern outside this evidence rule.
 */
async function reconcileCloudAssistants(
  syncIsCurrent?: () => boolean,
  sessionIsCurrent?: () => boolean,
): Promise<boolean> {
  try {
    // `sessionIsCurrent` is the looser gate: it stays true past the probe's
    // race timeout as long as no newer probe superseded this one, letting a
    // slow-but-successful org fetch for the still-active session commit
    // instead of stranding readiness. Destructive writes stay on the strict
    // `syncIsCurrent`.
    const orgOutcome = await useOrganizationStore
      .getState()
      .fetchOrganizations(syncIsCurrent, sessionIsCurrent);
    if (!orgOutcome.ok && orgOutcome.kind === "rejected") {
      return true;
    }
    const apiAssistants = await listAssistants();
    if (isSettledSessionRejection(apiAssistants)) {
      // The org fetch self-clears on its own rejection; an assistants-only
      // rejection must clear the org state too, or the request interceptor
      // keeps stamping the rejected account's Cadet-Organization-Id. The
      // currency guard matches the sync below: a timed-out or superseded
      // probe settled "present" from cached data, and its dangling call must
      // not strip the org header out from under that session.
      if (syncIsCurrent?.() ?? true) {
        useOrganizationStore.getState().clearOrganization();
      }
      return true;
    }
  } catch {
    // A throw is non-settled evidence: continue with cached lockfile data.
  }
  return false;
}

// Monotonic id stamped on each cloud-session probe. Probes can overlap
// (an app-resume refresh firing while the initial probe is still in flight),
// and a stale completion must not mutate session state — most importantly it
// must not move `cloudSession` while a newer probe is still pending, which
// would resurface the very race this state guards. Only the latest probe's id
// matches `latestCloudProbe`, so older probes no-op.
let latestCloudProbe = 0;

// Settle promise for the most recently launched probe, reassigned on every
// launch. Because re-probes keep the last `"present"`/`"absent"` rather than
// reopening `"unknown"` (so reactive consumers don't flicker), the displayed
// `cloudSession` can be a prior result while a fresh probe is still in
// flight. Imperative readers that must not act on a not-yet-refreshed value
// (the onboarding route fork) await `whenCloudSessionSettled`, which chases
// this reference so a probe that becomes latest mid-wait is awaited too.
// Initialized resolved: before any probe runs the status is `"unknown"`, which
// those callers already gate on separately.
let cloudProbeSettled: Promise<void> = Promise.resolve();

/**
 * Run the fire-and-forget cloud-session probe used by the local gateway
 * auth paths, which return control before the session is known.
 *
 * The probe never reopens the `"unknown"` window: a re-run (app-resume
 * refresh, return from a provider callback) leaves the last `"present"` /
 * `"absent"` in place until the new result lands, so reactive consumers keep
 * showing the last-known session instead of flickering on every resume. Only
 * the initial boot probe starts from `"unknown"`, and the `.finally` settle
 * resolves that first `"unknown"` to `"absent"` when neither branch confirmed
 * a session.
 *
 * Overlapping probes are resolved latest-wins: each call captures a probe id
 * and only the newest probe is allowed to settle state, so a slower earlier
 * probe cannot overwrite the result of a later one.
 *
 * `rememberOnSuccess` records the probed session for the offline restore (the
 * no-platform-assistant local path, which starts as the placeholder local
 * user). `clearOnFailure` drives the status to `"absent"` on a negative
 * result (the refresh path, which must retract a session that has ended);
 * init paths leave a prior optimistic value untouched.
 */
function probeCloudSession(
  set: AuthSet,
  options: { rememberOnSuccess?: boolean; clearOnFailure?: boolean } = {},
): void {
  if (isServedGatewayRuntime()) {
    ++latestCloudProbe;
    cloudProbeSettled = Promise.resolve();
    set({ cloudSession: "absent" });
    return;
  }
  const probeId = ++latestCloudProbe;
  const isStale = (): boolean => probeId !== latestCloudProbe;
  cloudProbeSettled = getSession()
    .then(async (result) => {
      if (isStale()) {
        return;
      }
      if (result.ok && result.data.user) {
        // A settled cloud API rejection invalidates the session. Bound the
        // reconciliation to 3s; stale or timed-out probes cannot commit state.
        let sessionRejected = false;
        if (isLocalClient()) {
          let timedOut = false;
          const syncIsCurrent = (): boolean => !timedOut && !isStale();
          let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              (async () => {
                sessionRejected = await reconcileCloudAssistants(
                  syncIsCurrent,
                  () => !isStale(),
                );
              })(),
              new Promise<never>((_, reject) => {
                timeoutHandle = setTimeout(() => {
                  timedOut = true;
                  reject(new Error("sync timeout"));
                }, 3_000);
              }),
            ]);
          } catch {
            // Sync failed or timed out; continue with cached lockfile data
          } finally {
            clearTimeout(timeoutHandle);
          }
        }
        if (isStale()) {
          return;
        }
        if (sessionRejected) {
          // The cloud API conclusively rejected the allauth-confirmed
          // credential: settle absent and drop the snapshot so
          // `restoreOfflineSession` cannot resurrect the account. Transport
          // failures and the race timeout never reach here (LUM-2412).
          clearSessionSnapshot();
          const demotion = isAuthenticated(
            useAuthStore.getState().sessionStatus,
          )
            ? authenticatedLocalUser()
            : {};
          set({
            ...demotion,
            cloudSession: "absent",
          });
          return;
        }
        // A confirmed session outside the `authenticatedPlatformSession`
        // transition persists here too, to feed the local-mode offline
        // restore (LUM-2412).
        if (options.rememberOnSuccess) {
          persistSessionSnapshot();
        }
        set({
          cloudSession: "present",
        });
        bootstrapLocalAssistantCloudIdentity();
      } else if (options.clearOnFailure) {
        set({ cloudSession: "absent" });
      }
    })
    .catch(() => {
      if (isStale()) {
        return;
      }
      if (options.clearOnFailure) {
        set({ cloudSession: "absent" });
      }
    })
    .finally(() => {
      if (isStale()) {
        return;
      }
      set((state) =>
        state.cloudSession === "unknown" ? { cloudSession: "absent" } : {},
      );
    });
}

/**
 * Resolve once no cloud-session probe is in flight, or immediately when none
 * is running.
 *
 * Reactive consumers read `cloudSession` directly and rely on re-probes
 * leaving the last `"present"`/`"absent"` in place (no flicker). Imperative
 * one-shot readers that must not branch on a stale value — the onboarding
 * hosting/welcome fork — await this instead, so they observe the fresh probe
 * result regardless of what the tri-state currently shows.
 *
 * A probe can become the latest *after* the wait begins (an app-resume refresh
 * firing while we await the current probe). Awaiting a single captured promise
 * would let the resolver proceed when that probe settles even though a newer
 * one is still pending. Instead this chases `cloudProbeSettled`: after each
 * await it re-checks whether a newer probe replaced the reference and waits that
 * one out too, returning only once the reference is unchanged across an await —
 * i.e. no probe launched while waiting for the last one.
 */
export async function whenCloudSessionSettled(): Promise<void> {
  let awaited = cloudProbeSettled;
  await awaited;
  while (cloudProbeSettled !== awaited) {
    awaited = cloudProbeSettled;
    await awaited;
  }
}

/**
 * Probe the cloud session when one could exist: non-local mode, or gateway
 * auth enabled. Gateway auth always probes because the user may have logged
 * into the platform (e.g. via the login flow) without having added platform
 * assistants yet; plain local clients without a gateway session hold no
 * platform roster for a probe to illuminate (the app bundle's chooser owns
 * that list). When nothing qualifies, settle to `"absent"`.
 */
function probeCloudSessionIfReachable(
  set: AuthSet,
  options?: { rememberOnSuccess?: boolean; clearOnFailure?: boolean },
): void {
  if (!isLocalClient() || hasGatewayAssistant()) {
    probeCloudSession(set, options);
  } else {
    set({ cloudSession: "absent" });
  }
}


/**
 * Session commit seams for the connect path (`@/assistant/connect-assistant`).
 *
 * The selection write re-keys the boot resolution query, which refetches and
 * republishes the active id; the state patch marks the session the connect
 * established. These exist so the connect orchestration can live in the
 * assistant domain without reaching into the store's internals — and they
 * re-home to the app bundle together with the session state itself.
 */
export async function commitLocalSession(assistantId: string): Promise<void> {
  await setSelectedAssistant(assistantId);
  useAuthStoreBase.setState(authenticatedLocalUser());
}

export async function commitCloudSession(assistantId: string): Promise<void> {
  await setSelectedAssistant(assistantId);
  useAuthStoreBase.setState(authenticatedPlatformSession());
}

export function probeCloudSessionForConnect(): void {
  probeCloudSessionIfReachable(useAuthStoreBase.setState);
}

const useAuthStoreBase = create<AuthStore>()((set, get) => ({
  sessionStatus: "initializing",
  cloudSession: "unknown",

  // Deliberately not guarded by `logoutGeneration`, unlike `refreshSession`.
  // Its two callers can't overlap a logout: the boot path runs before any
  // signed-in surface exists to press Log Out on, and the cloud loopback
  // page runs it from the logged-out login flow as the commit step of a
  // deliberate sign-in: a decision, which the guard exists to protect, rather
  // than an observation the guard should be able to discard.
  initSession: async () => {
    // Cloud remote: the cloud session cookie is the credential — no
    // gateway session exists to establish or rotate.
    if (isCadetCloudRemote()) {
      set({ ...authenticatedLocalUser(), cloudSession: "present" });
      return;
    }

    // The public pair page establishes its session through the pairing flow
    // itself (device-code exchange). The boot ping below is a
    // guaranteed-wasted 401 there — an unpaired device holds no credential
    // the guardian-refresh endpoint accepts — and the cloud-session probe
    // has no /_allauth to reach through a cadet's edge. Settle
    // unauthenticated; an approved pairing activates the session directly
    // from the page.
    if (onPublicPairingRoute()) {
      await endSession(set, { keepCloudSession: true });
      return;
    }
    // Served gateway: the cookie is the session and the edge arbitrates it per request.
    if (isServedGatewayRuntime()) {
      set({ ...authenticatedLocalUser(), cloudSession: "absent" });
      return;
    }
    // Local client: restore or prime the gateway connection below.
    if (hasGatewayAssistant()) {
      try {
        // Ride out the gateway's startup window: on reboot the gateway (a
        // Login Item) restarts concurrently with the app. The mint fails to
        // fetch while the port is unbound, then answers a transient 503 or
        // 401 before the guardian binding lands. A single prime there would
        // drop the session to unauthenticated and surface the recovery
        // controls for an assistant that reconnects on its own. Still no
        // `wake`: app launch must not spawn assistant processes.
        await primeLocalGatewayConnectionWithStartupRetry();
        set(authenticatedLocalUser());
      } catch {
        // Gateway prime failed: settle to unauthenticated but leave
        // `cloudSession` for the follow-up probe to resolve.
        await endSession(set, { keepCloudSession: true });
      }
      probeCloudSessionIfReachable(set);
      return;
    }

    if (isLocalClient() && !hasGatewayAssistant()) {
      // The app owns the platform roster. A local session remains usable
      // while the cloud probe settles.
      set(authenticatedLocalUser());
      if (!suppressPlatformProbe) {
        probeCloudSession(set, { rememberOnSuccess: true });
      } else {
        set({ cloudSession: "absent" });
      }
      suppressPlatformProbe = false;
      return;
    }

    let result: Awaited<ReturnType<typeof getSession>> | null = null;
    try {
      result = await getSession();
      if (result.ok && result.data.user) {
        set(authenticatedPlatformSession());
        return;
      }
    } catch (err) {
      console.error("auth.initSession failed", err);
    }

    // Offline boot (tray reopen recreating the window, app launch before
    // Wi-Fi reassociates): a transport-failed probe says nothing about
    // the session, so restore it from the snapshot instead of bouncing a
    // logged-in user to the login screen (LUM-2412).
    if (isInconclusiveProbe(result) && (await restoreOfflineSession(set))) {
      return;
    }

    // Biometric recovery: on iOS, the session cookie may have been lost
    // when WKWebView was killed. Try to restore from Keychain via Face ID.
    if (isNativePlatform() && isBiometricEnabled()) {
      try {
        const token = await retrieveBiometricToken();
        if (token) {
          installSessionCookies(token);
          await waitForNativeSessionCookie();
          const retryResult = await getSession();
          if (retryResult.ok && retryResult.data.user) {
            set(authenticatedPlatformSession());
            return;
          }
        }
      } catch (err) {
        console.warn("auth.initSession biometric recovery failed", err);
      }
    }

    clearOrganization();
    // Only a settled "no session" answer invalidates the snapshot — a
    // revoked session must not be resurrected by a later offline boot.
    // Transport failures keep it (web builds land here too; without a
    // readable credential they stay on the login-screen behavior).
    if (!isInconclusiveProbe(result)) {
      clearSessionSnapshot();
    }
    await endSession(set);
  },

  refreshSession: async () => {
    // Captured before the first await. This action is an *observation* of the
    // session, and an explicit logout taken while it is suspended supersedes
    // it: the response it is carrying describes credentials that logout has
    // since dropped. Every authenticated write below re-checks the snapshot
    // and abandons itself on a mismatch; see `logoutGeneration`. Session-
    // ending writes need no check, because they agree with the logout.
    const generation = logoutGeneration;
    const supersededByLogout = (): boolean => logoutGeneration !== generation;
    // Report the session as the store now holds it rather than as this
    // superseded response describes it, mirroring the inconclusive-probe
    // branch below, so no caller reads an abandoned refresh as a verdict.
    const abandon = (): boolean => isAuthenticated(get().sessionStatus);

    if (isCadetCloudRemote()) {
      // The cloud cookie is the only credential here: re-verify it
      // authoritatively instead of pinging a gateway session that does
      // not exist. A settled rejection ends the session (the recovery
      // flow then routes to login); an ok probe re-stamps liveness.
      let ok = false;
      try {
        ok = (await getSession()).ok;
      } catch {
        ok = false;
      }
      if (supersededByLogout()) {
        return abandon();
      }
      if (ok) {
        set({ ...authenticatedLocalUser(), cloudSession: "present" });
        return true;
      }
      await endSession(set);
      return false;
    }
    // Served gateway: the cookie is the session and the edge arbitrates it per request.
    if (isServedGatewayRuntime()) {
      set({ ...authenticatedLocalUser(), cloudSession: "absent" });
      return true;
    }
    // Gateway machinery, not a session question — the web bundle holds no
    // gateway session. A selection with a resolvable gateway re-verifies
    // through the prime (the prime rebuilds a dead slot); everything else
    // re-verifies the platform session.
    const selectedAssistant = getActiveAssistant();
    if (
      selectedAssistant &&
      (hasPairedGateway(selectedAssistant) ||
        hasLocalGateway(selectedAssistant))
    ) {
      try {
        // Both selection kinds collapse into the prime: it probes the
        // gateway through the host-routed readyz route and seeds the
        // tokenless same-origin slot — the trusted host mints and injects
        // the bearer itself, so the renderer holds no credential.
        await primeLocalGatewayConnection();
        if (supersededByLogout()) {
          // Abandon the cloud probe below too: launching it would settle
          // `cloudSession` from the session the logout just ended.
          return abandon();
        }
        set(enteringAuthenticatedSession({ sessionStatus: "authenticated" }));
      } catch {
        await endSession(set);
        return false;
      }
      probeCloudSessionIfReachable(set, { clearOnFailure: true });
      return true;
    }

    let result: Awaited<ReturnType<typeof getSession>> | null = null;
    try {
      result = await getSession();
      if (result.ok && result.data.user) {
        // Reconcile the lockfile mirror on refresh too, not just cold
        // `initSession`: app resume, profile save, and the provider callback
        // all route through here, and the macOS tray and CLI would otherwise
        // keep a stale managed-assistant list until the next full boot.
        // Local-mode only (platform mode has no lockfile host). The rejection
        // A rejection must settle the session before any state is reinstalled.
        const sessionRejected = isLocalClient()
          ? await reconcileCloudAssistants()
          : false;
        if (!sessionRejected) {
          // A logout during reconciliation or the organization fetch supersedes
          // this observation. The org fetch guards its own writes as well.
          if (supersededByLogout()) {
            return abandon();
          }
          if (!isLocalClient()) {
            await useOrganizationStore
              .getState()
              .fetchOrganizations(() => !supersededByLogout());
          }
          if (supersededByLogout()) {
            return abandon();
          }
          set(authenticatedPlatformSession());
          return true;
        }
        // A settled org/assistants rejection is a rejected session even
        // though allauth answered 200: fall through to the settled-rejection
        // handling below, same as a settled getSession 401.
      }
    } catch (err) {
      console.warn("auth.refreshSession failed", err);
    }
    // Offline resume (un-minimizing fires visibilitychange → app.resume →
    // this refresh): a transport-failed probe must not tear a logged-in
    // surface down to the login screen (LUM-2412). Keep the current state;
    // the next resume/online refresh revalidates for real, and a settled
    // "no session" answer below still ends the session normally.
    if (isInconclusiveProbe(result)) {
      return isAuthenticated(get().sessionStatus);
    }
    // A settled "no platform session" (401) ends the cloud session, not the
    // local one. Demote an authenticated session to the local user and mark the
    // platform session absent, dropping the stale offline
    // snapshot so platform-gated surfaces stop treating it as signed in, while
    // keeping `sessionStatus` "authenticated": a 401 must not log a local-only
    // user out. (The successful probe above still confirms the cloud session, so
    // provider sign-in keeps working.) An unauthenticated session, e.g. mid
    // cold-start hatch, is left for the gateway to settle once its token mints.
    //
    // Holding `sessionStatus` "authenticated" is load-bearing: in-app consumers
    // read `useIsAuthenticated()` directly to scope the QueryClient cache and
    // gate signed-in UI, so ending the session would drop them into the
    // anonymous cache scope and hide that UI.
    //
    // The predicate asks whether the local session can stand on its own,
    // mirroring how `initSession` branches: a local gateway answers for itself,
    // and so does a client with no platform assistant to reach. Web holds
    // no platform roster (the app bundle's chooser owns that list), so any
    // local client's session stands alone.
    //
    // The demotion needs no `supersededByLogout` check: it writes only when
    // the store still reads authenticated, which a completed logout has
    // already made false.
    if (isLocalClient()) {
      const wasAuthenticated = isAuthenticated(get().sessionStatus);
      if (wasAuthenticated) {
        clearSessionSnapshot();
        set({ ...authenticatedLocalUser(), cloudSession: "absent" });
      }
      return wasAuthenticated;
    }
    clearSessionSnapshot();
    clearOrganization();
    await endSession(set);
    return false;
  },

  logout: async (options) => {
    // Bumped before anything else: the steps below drop the credentials, the
    // selection, the organization and the user-scoped storage, and a refresh
    // that resumes partway through would otherwise re-persist the departing
    // user's snapshot on its way to an authenticated write.
    logoutGeneration += 1;
    if (getSelfHostedIngressUrl() != null && !options?.cloudAccount) {
      // Clear lifecycle state BEFORE `sessionStatus` leaves `authenticated`
      // so the assistant sync hooks don't observe a stale assistant id in
      // their first re-render, and BEFORE the selection clear so the
      // lifecycle's selection subscription (guarded on `loading`) doesn't
      // resurrect an active state mid-logout. The `respondToInputs`
      // not-authenticated branch is the safety net for token-expiry-style
      // flips.
      useResolvedAssistantsStore.getState().setActiveAssistantId(null);
      setSelfHostedConnection(null);
      await setSelectedAssistant(null);
      clearOrganization();
      clearUserScopedStorage();
      await endSession(set, { authoritative: true });
      // Bumped again now the session has ended: a refresh that entered partway
      // through this logout captured the first bump, and its response is just
      // as stale as one captured before it.
      logoutGeneration += 1;
      broadcastAuthChange();
      return;
    }

    suppressPlatformProbe = true;
    // Delete the APNs device token from the cloud BEFORE clearing the
    // session — the cloud delete is authenticated by the still-valid
    // session cookie. No-ops off native iOS. Best-effort: never blocks logout.
    await unregisterFromRemotePush();
    // Same window, same reason: a Live Activity registered for a voice session
    // outlives the session that owns it unless something retires it, and after
    // logout there is no authenticated request left that could.
    await unregisterLiveActivityPushToken();
    try {
      if (options?.cloudAccount) {
        await options.cloudAccount.revokeSession();
      } else {
        await allauthLogout();
      }
    } finally {
      // Clean up session token in the main process.
      if (isElectron()) {
        await window.cadet?.auth?.signOut?.();
      }
      // Web loopback: drop the token the local server's proxy authenticates with.
      if (isLocalClient() && !isElectron()) {
        await clearLocalCloudSession();
      }
      void deleteBiometricToken();
      if (options?.cloudAccount && getSelfHostedIngressUrl() != null) {
        setSelfHostedConnection(null);
      }
      clearOrganization();
      clearUserScopedStorage();
      useResolvedAssistantsStore.getState().setActiveAssistantId(null);
      // Clear the selection slice too — `clearUserScopedStorage` already
      // removed the persisted key, and a surviving slice would resolve the
      // previous user's assistant after re-login.
      await setSelectedAssistant(null);
      await endSession(set, { authoritative: true });
      // See the gateway branch: the second bump also supersedes a refresh that
      // entered partway through this logout.
      logoutGeneration += 1;
      broadcastAuthChange();
    }
  },
}));

export const useAuthStore = createSelectors(useAuthStoreBase);

/**
 * Semantic read hooks — the reactive public API for components.
 *
 * Each subscribes to one atomic field and answers a single domain question, so
 * components never re-encode the enum (`sessionStatus === "authenticated"`,
 * `cloudSession === "present"`) and never juggle a pair of booleans. They
 * compose the pure `session-status` predicates over the atomic selectors
 * generated by `createSelectors`, keeping Zustand's `Object.is` snapshot
 * equality stable.
 */
export const useIsAuthenticated = (): boolean =>
  isAuthenticated(useAuthStore.use.sessionStatus());

export const useIsSessionInitializing = (): boolean =>
  !isSessionSettled(useAuthStore.use.sessionStatus());

export const useHasCloudSession = (): boolean =>
  hasLiveCloudSession(useAuthStore.use.cloudSession());

/**
 * Reactive: the cloud-session probe has settled (`cloudSession` is no
 * longer `"unknown"`). Gate behavior that must not act on the pre-settle
 * window — where {@link useHasCloudSession} still reads `false` for a
 * session that will resolve to `"present"` — on this rather than on
 * {@link useIsSessionInitializing}, which can clear first.
 */
export const useIsCloudSessionSettled = (): boolean =>
  isCloudSessionSettled(useAuthStore.use.cloudSession());

/**
 * Subscribe to app-resume signals on the layout-scoped event bus and to
 * cross-tab BroadcastChannel messages. Call once at app startup.
 *
 * The bus's `"app.resume"` payload fans in page visibility flipping to
 * "visible", a Capacitor `appStateChange` going active on native, and
 * `window.online`, so a single subscription drives the session refresh.
 */
export function setupAuthListeners(): () => void {
  const { refreshSession } = useAuthStore.getState();
  const cleanups: Array<() => void> = [];

  const safeRefresh = () =>
    refreshSession().catch((err: unknown) =>
      console.warn("auth.refreshSession failed", err),
    );

  const unsubResume = subscribe("app.resume", () => {
    // Mid-OAuth refocus — an unauthenticated probe would tear down state.
    if (isOAuthFlowInFlight()) {
      return;
    }
    void safeRefresh();
  });
  cleanups.push(unsubResume);

  if (typeof BroadcastChannel !== "undefined") {
    broadcastChannel = new BroadcastChannel("auth");
    broadcastChannel.onmessage = () => {
      clearUserScopedStorage();
      window.location.reload();
    };
    cleanups.push(() => {
      broadcastChannel?.close();
      broadcastChannel = null;
    });
  }

  return () => cleanups.forEach((fn) => fn());
}
