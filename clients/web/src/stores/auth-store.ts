/**
 * Zustand auth store.
 *
 * Session lifecycle: probes the allauth session on `initSession()`,
 * re-validates when the app resumes (foreground / visibility / online,
 * delivered via the layout-scoped event bus), and synchronizes logout
 * across tabs via BroadcastChannel.
 *
 * The store carries NO session state. The routing that reacted to it died
 * with #579, the reactive readers re-homed to the probe answer, and the
 * store's own flows decide from their local control flow — so there is
 * nothing left to write. The one session fact that outlives the flows is
 * the cloud-probe answer, which lives in the probe's promise (latest-wins,
 * chased by `whenCloudSessionProbed`) rather than in reactive state.
 *
 * References:
 * - https://zustand.docs.pmnd.rs/guides/reading-and-writing-state-outside-components
 * - https://docs.allauth.org/en/latest/headless/openapi-specification/
 */
import { create } from "zustand";

import { setSelectedAssistant } from "@/assistant/selection";

import { getSession, logout as allauthLogout } from "@/lib/auth/allauth-client";
import { clearWidgetSnapshot } from "@/runtime/widget-snapshot";
import { resetNotificationIdentitySession } from "@/runtime/notification-avatar";
import {
  isLocalClient,
  isCadetCloudRemote,
  isServedGatewayRuntime,
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
import { clearUserScopedStorage } from "@/lib/auth/session-cleanup";
import { setSelfHostedConnection } from "@/lib/self-hosted/connection";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { subscribe } from "@/lib/event-bus";
import { isElectron } from "@/runtime/is-electron";
import { clearLocalCloudSession } from "@/runtime/local-mode-host";
import { isOAuthFlowInFlight } from "@/runtime/native-auth";

interface AuthActions {
  initSession: () => Promise<void>;
  refreshSession: () => Promise<void>;
  /** App can supply cloud revocation while retaining shared native/assistant cleanup. */
  logout: (options?: {
    cloudAccount?: { revokeSession(): Promise<void> };
  }) => Promise<void>;
}

type AuthStore = AuthActions;

let broadcastChannel: BroadcastChannel | null = null;
let suppressPlatformProbe = false;

/**
 * Whether the app booted on the public `/assistant/pair` route (prefix-
 * tolerant: tunnel-served deployments live under `/assistant-123/…`).
 */
function onPublicPairingRoute(): boolean {
  return /\/assistant\/pair\/?$/.test(window.location.pathname);
}

// Bumped by every explicit `logout()`, once when it starts and once when the
// session has ended. Nothing here is written to a store anymore, but the
// flows still launch probes — and a probe's success side effect
// (`bootstrapLocalAssistantCloudIdentity`) must not run for a session the
// logout just ended. A `refreshSession` that entered before the logout
// snapshots this counter on entry and re-checks it before launching that
// work, abandoning it when a logout has moved the counter. Bumping at both
// ends makes the invariant "no logout began or ended while I was running",
// which covers a refresh that started midway through the logout too.
//
// Nothing resets it, and nothing can wedge on it: the snapshot is taken on
// entry, so a refresh (or a connect action, or the loopback page's
// `initSession`) that starts after a logout captures the current value and
// commits normally.
let logoutGeneration = 0;

/**
 * Statuses where the server itself said "no session": allauth's 401 for
 * an unauthenticated probe, a 403, or 410 Gone (session invalidated).
 */
const SETTLED_SESSION_REJECTION_STATUSES = new Set([401, 403, 410]);

/**
 * A settled negative answer from a session check — the only failures
 * allowed to end the session. Everything else that isn't ok says nothing
 * about the session and must be treated as non-authoritative (LUM-2412):
 * a request that never completed (`status` undefined), rate limiting
 * (429), and gateway/outage 5xx including the Electron cloud proxy's
 * synthesized offline 502 (`proxy_network_error` — see
 * `clients/macos/src/main/cloud-forward.ts`). A session check that
 * throws outright (fetch rejection) is classified the same way by
 * callers.
 */
const isSettledSessionRejection = (result: {
  ok: boolean;
  status?: number;
}): boolean =>
  !result.ok &&
  result.status !== undefined &&
  SETTLED_SESSION_REJECTION_STATUSES.has(result.status);

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
 * Probe the cloud assistants endpoint and report whether the cloud API
 * conclusively rejected the session (a settled 401/403/410 from
 * the assistants call). Only that settled evidence may reject a session the
 * allauth probe confirmed; transport failures and other errors prove
 * nothing (LUM-2412).
 */
async function reconcileCloudAssistants(): Promise<boolean> {
  try {
    const apiAssistants = await listAssistants();
    if (isSettledSessionRejection(apiAssistants)) {
      return true;
    }
  } catch {
    // A throw is non-settled evidence: continue.
  }
  return false;
}

/**
 * The cloud-session probe's answer. The probe is the only authority on
 * whether a platform session exists; its answer is delivered as a promise
 * (latest-wins), never as reactive state.
 */
export type CloudSessionAnswer = "present" | "absent";

// Monotonic id stamped on each cloud-session probe. Probes can overlap
// (an app-resume refresh firing while the initial probe is still in flight),
// and only the latest probe may run its success side effect — the identity
// bootstrap — so a stale probe completing after a newer launch no-ops.
let latestCloudProbe = 0;

// Settle promise for the most recently launched probe (or the answer a flow
// settled directly), reassigned on every launch. Awaiters go through
// `whenCloudSessionProbed`, which chases this reference so a probe that
// becomes latest mid-wait is awaited too. Initialized never-settling: no
// flow has answered yet, and the first boot flow settles one before any
// consumer can observe it (the local arm awaits `initSession` before
// render; the pair page, the one arm that never settles, has no awaiters).
let cloudProbeSettled: Promise<CloudSessionAnswer> = new Promise(() => {});

/**
 * Settle the probe answer without launching a network probe — for the
 * flows that KNOW the answer from the plane they are on (the cloud cookie
 * is the credential; the served edge arbitrates; nothing qualifies).
 */
function settleCloudAnswer(answer: CloudSessionAnswer): void {
  cloudProbeSettled = Promise.resolve(answer);
}

/**
 * Run the cloud-session probe: validate the allauth session, reconcile a
 * conclusive assistants-API rejection, and bootstrap the local assistant's
 * cloud identity on a confirmed session.
 *
 * Overlapping probes are resolved latest-wins: each call captures a probe
 * id, and only the newest probe may run the identity bootstrap, so a slower
 * earlier probe cannot act after a later one launched. The returned promise
 * is also published to `cloudProbeSettled` for `whenCloudSessionProbed`.
 */
function probeCloudSession(): Promise<CloudSessionAnswer> {
  if (isServedGatewayRuntime()) {
    // The edge arbitrates the session per request; there is no platform
    // session behind this bundle. Stale any in-flight probe.
    ++latestCloudProbe;
    settleCloudAnswer("absent");
    return cloudProbeSettled;
  }
  const probeId = ++latestCloudProbe;
  const isStale = (): boolean => probeId !== latestCloudProbe;
  const settled: Promise<CloudSessionAnswer> = getSession()
    .then(async (result): Promise<CloudSessionAnswer> => {
      if (!(result.ok && result.data.user)) {
        return "absent";
      }
      // A settled cloud API rejection invalidates the allauth-confirmed
      // credential. Bound the reconciliation to 3s; stale or timed-out
      // probes cannot act. Transport failures and the race timeout never
      // reach the rejection arm (LUM-2412).
      let sessionRejected = false;
      if (isLocalClient()) {
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            (async () => {
              sessionRejected = await reconcileCloudAssistants();
            })(),
            new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(() => {
                reject(new Error("sync timeout"));
              }, 3_000);
            }),
          ]);
        } catch {
          // Sync failed or timed out; continue.
        } finally {
          clearTimeout(timeoutHandle);
        }
      }
      if (isStale()) {
        return "absent";
      }
      if (sessionRejected) {
        return "absent";
      }
      bootstrapLocalAssistantCloudIdentity();
      return "present";
    })
    .catch((): CloudSessionAnswer => "absent");
  cloudProbeSettled = settled;
  return settled;
}

/**
 * Resolve once no cloud-session probe is in flight, and answer with its
 * result.
 *
 * A probe can become the latest *after* the wait begins (an app-resume refresh
 * firing while we await the current probe). Awaiting a single captured promise
 * would let the resolver proceed when that probe settles even though a newer
 * one is still pending. Instead this chases `cloudProbeSettled`: after each
 * await it re-checks whether a newer probe replaced the reference and waits that
 * one out too, returning only once the reference is unchanged across an await —
 * i.e. no probe launched while waiting for the last one.
 */
export async function whenCloudSessionProbed(): Promise<CloudSessionAnswer> {
  let awaited = cloudProbeSettled;
  let answer = await awaited;
  while (cloudProbeSettled !== awaited) {
    awaited = cloudProbeSettled;
    answer = await awaited;
  }
  return answer;
}

/**
 * Probe the cloud session when one could exist: the platform plane, or a
 * local selection carrying gateway machinery (the user may have logged into
 * the platform, e.g. via the login flow, without having added platform
 * assistants yet). Plain local clients without gateway machinery hold no
 * platform roster for a probe to illuminate (the app bundle's chooser owns
 * that list). When nothing qualifies, settle `"absent"`.
 */
function probeCloudSessionIfReachable(): void {
  const activeAssistant = getActiveAssistant();
  if (
    !isLocalClient() ||
    hasLocalGateway(activeAssistant) ||
    hasPairedGateway(activeAssistant)
  ) {
    probeCloudSession();
  } else {
    settleCloudAnswer("absent");
  }
}

/**
 * Session-end teardown. Every path that ends a session goes through here.
 *
 * Two user-owned caches are cleared off-store. Notification identity memory is
 * invalidated synchronously so in-flight compositor work becomes stale before
 * any await. A Home Screen widget is readable without unlocking the device, so
 * the previous account's conversation titles must not outlive the session that
 * produced them, whichever way it ended. Its clear is a no-op off Capacitor
 * iOS.
 *
 * Awaited, but not gated on: a sign-out the bridge could refuse to complete
 * would be worse than a snapshot that outlives it by one launch. It is not
 * fire-and-forget either, because a clear that does not land persists the
 * obligation and the next use of the module finishes it, so the drop is
 * at-least-once rather than best-effort. That is why nothing here reads the
 * reported outcome. The clears are idempotent, so a superseded observation
 * running them after a logout is harmless.
 */
async function endSession(): Promise<void> {
  resetNotificationIdentitySession();
  await clearWidgetSnapshot();
}

/** Test hook: arrange the probe answer without running a flow. */
export function __settleCloudProbeForTesting(answer: CloudSessionAnswer): void {
  cloudProbeSettled = Promise.resolve(answer);
}

/**
 * Session commit seams for the connect path (`@/assistant/connect-assistant`).
 *
 * The selection write re-keys the boot resolution query, which refetches and
 * republishes the active id; the answer settle marks the session the connect
 * established. These exist so the connect orchestration can live in the
 * assistant domain without reaching into the store's internals.
 */
export function commitCloudSessionAnswer(): void {
  settleCloudAnswer("present");
}

export function probeCloudSessionForConnect(): void {
  probeCloudSessionIfReachable();
}

const useAuthStoreBase = create<AuthStore>()(() => ({
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
      settleCloudAnswer("present");
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
      await endSession();
      settleCloudAnswer("absent");
      return;
    }
    // Served gateway: the cookie is the session and the edge arbitrates it per request.
    if (isServedGatewayRuntime()) {
      settleCloudAnswer("absent");
      return;
    }
    // Local client: restore or prime the gateway connection below. The
    // prime arm is the selection's own machinery question — a gateway to
    // prime exists only when the selected assistant carries one.
    if (
      hasLocalGateway(getActiveAssistant()) ||
      hasPairedGateway(getActiveAssistant())
    ) {
      try {
        // Ride out the gateway's startup window: on reboot the gateway (a
        // Login Item) restarts concurrently with the app. The mint fails to
        // fetch while the port is unbound, then answers a transient 503 or
        // 401 before the guardian binding lands. A single prime there would
        // drop the session to unauthenticated and surface the recovery
        // controls for an assistant that reconnects on its own. Still no
        // `wake`: app launch must not spawn assistant processes.
        await primeLocalGatewayConnectionWithStartupRetry();
      } catch {
        // Gateway prime failed: the follow-up probe settles the cloud
        // session answer.
        await endSession();
      }
      probeCloudSessionIfReachable();
      return;
    }

    if (isLocalClient()) {
      // No gateway machinery on the selection: the cloud-connected local
      // client. The app owns the platform roster.
      if (!suppressPlatformProbe) {
        probeCloudSession();
      } else {
        settleCloudAnswer("absent");
      }
      suppressPlatformProbe = false;
      return;
    }

    // Not local and not cloud-remote is unrepresentable: every injected
    // `remote` value is consumed by the arms above (`cloud` by the first,
    // `docker`/`custom` by the served arm, everything else — including no
    // injection — reads as local). There is no platform-plane boot probe.
  },

  refreshSession: async () => {
    // Captured before the first await. This action is an *observation* of the
    // session, and an explicit logout taken while it is suspended supersedes
    // it: the response it is carrying describes credentials that logout has
    // since dropped. The probe launch below re-checks this and abandons
    // itself on a mismatch — launching it would bootstrap the identity of a
    // session the logout just ended.
    const generation = logoutGeneration;
    const supersededByLogout = (): boolean => logoutGeneration !== generation;

    if (isCadetCloudRemote()) {
      // The cloud cookie is the only credential here: re-verify it
      // authoritatively instead of pinging a gateway session that does
      // not exist. A settled rejection ends the session; an ok probe
      // re-stamps liveness.
      let ok = false;
      try {
        ok = (await getSession()).ok;
      } catch {
        ok = false;
      }
      if (supersededByLogout()) {
        return;
      }
      settleCloudAnswer(ok ? "present" : "absent");
      return;
    }
    // Served gateway: the cookie is the session and the edge arbitrates it per request.
    if (isServedGatewayRuntime()) {
      settleCloudAnswer("absent");
      return;
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
          // Abandon the cloud probe below too: launching it would bootstrap
          // the identity of the session the logout just ended.
          return;
        }
      } catch {
        await endSession();
        settleCloudAnswer("absent");
        return;
      }
      probeCloudSessionIfReachable();
      return;
    }

    // The local, no-machinery arm: the cloud-connected local client. The
    // allauth probe is the session question here.
    let result: Awaited<ReturnType<typeof getSession>> | null = null;
    try {
      result = await getSession();
      if (result.ok && result.data.user) {
        if (supersededByLogout()) {
          return;
        }
        // A settled cloud API rejection is a rejected session even though
        // allauth answered 200; the probe answer must not read "present".
        if (await reconcileCloudAssistants()) {
          settleCloudAnswer("absent");
          return;
        }
        // A logout landing during the reconciliation supersedes this
        // observation too — re-checked after the await, before the settle.
        if (supersededByLogout()) {
          return;
        }
        settleCloudAnswer("present");
        return;
      }
    } catch (err) {
      console.warn("auth.refreshSession failed", err);
    }
    // Offline resume (un-minimizing fires visibilitychange → app.resume →
    // this refresh): a transport-failed probe says nothing about the
    // session. Leave the last answer standing; the next resume/online
    // refresh revalidates for real, and a settled "no session" answer below
    // still settles the session normally.
    if (isInconclusiveProbe(result)) {
      return;
    }
    // A settled "no platform session" (401) settles the cloud answer absent:
    // platform-gated surfaces stop treating it as signed in, while the local
    // session stands — a 401 must not log a local-only user out, and there
    // is no local state here to tear down.
    settleCloudAnswer("absent");
  },

  logout: async (options) => {
    // Bumped before anything else: the steps below drop the credentials,
    // the selection and the user-scoped storage, and a refresh that resumes
    // partway through would otherwise launch probe work for the departing
    // user's session.
    logoutGeneration += 1;
    if (getSelfHostedIngressUrl() != null && !options?.cloudAccount) {
      // Clear lifecycle state BEFORE the teardown
      // so the assistant sync hooks don't observe a stale assistant id in
      // their first re-render, and BEFORE the selection clear so the
      // lifecycle's selection subscription (guarded on `loading`) doesn't
      // resurrect an active state mid-logout. The `respondToInputs`
      // not-authenticated branch is the safety net for token-expiry-style
      // flips.
      useResolvedAssistantsStore.getState().setActiveAssistantId(null);
      setSelfHostedConnection(null);
      await setSelectedAssistant(null);
      clearUserScopedStorage();
      await endSession();
      settleCloudAnswer("absent");
      // Bumped again now the session has ended: a refresh that entered
      // partway through this logout captured the first bump, and its
      // response is just as stale as one captured before it.
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
      clearUserScopedStorage();
      useResolvedAssistantsStore.getState().setActiveAssistantId(null);
      // Clear the selection slice too — `clearUserScopedStorage` already
      // removed the persisted key, and a surviving slice would resolve the
      // previous user's assistant after re-login.
      await setSelectedAssistant(null);
      await endSession();
      settleCloudAnswer("absent");
      // See the gateway branch: the second bump also supersedes a refresh
      // that entered partway through this logout.
      logoutGeneration += 1;
      broadcastAuthChange();
    }
  },
}));

export const useAuthStore = useAuthStoreBase;

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

function broadcastAuthChange(): void {
  broadcastChannel?.postMessage("auth-changed");
}
