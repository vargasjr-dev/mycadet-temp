import type { z } from "zod";
import type { AllauthResult, SessionSchema } from "@app/lib/auth/auth-response";
import type {
  AccountAuthSnapshot,
  AccountAuthSource,
  AccountUser,
} from "@app/stores/auth-state";
import { accountUser } from "@app/stores/account-user";
import { isAccountSessionRejected } from "@app/stores/account-session-policy";

interface Dependencies {
  getSession(
    signal?: AbortSignal,
  ): Promise<AllauthResult<z.infer<typeof SessionSchema>>>;
  snapshot: {
    read(): AccountUser | null;
    write(user: AccountUser): void;
    clear(): void;
  };
  logout(): Promise<void>;
  probeTimeoutMs?: number;
}

/** Cloud-account authority; gateway identities never enter this source. */
export function createAccountSessionSource(
  deps: Dependencies,
): AccountAuthSource & {
  observeSession(): Promise<boolean>;
} {
  const listeners = new Set<() => void>();
  let initialization: Promise<void> | undefined;
  let generation = 0;
  let probeVersion = 0;
  let logoutLocks = 0;
  let pending: Promise<boolean> | undefined;
  let probeController: AbortController | undefined;
  let refreshPending: Promise<boolean> | undefined;
  let state: AccountAuthSnapshot;
  function publish(patch: Partial<AccountAuthSnapshot>) {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  }
  function beginLogout(): () => void {
    generation++;
    logoutLocks++;
    probeController?.abort();
    pending = undefined;
    refreshPending = undefined;
    deps.snapshot.clear();
    publish({
      user: null,
      sessionStatus: "unauthenticated",
      cloudSession: "absent",
    });
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      generation++;
      logoutLocks--;
      deps.snapshot.clear();
    };
  }
  function observeSession(force = false): Promise<boolean> {
    if (logoutLocks > 0) return Promise.resolve(false);
    if (pending && !force) return pending;
    if (force) probeController?.abort();
    const controller = new AbortController();
    probeController = controller;
    const current = generation;
    const version = ++probeVersion;
    const request = (async () => {
      let result: Awaited<ReturnType<Dependencies["getSession"]>>;
      const timeout = setTimeout(
        () => controller.abort(),
        deps.probeTimeoutMs ?? 5_000,
      );
      try {
        result = await deps.getSession(controller.signal);
      } catch {
        result = { ok: false, errors: [] };
      } finally {
        clearTimeout(timeout);
      }
      if (current !== generation || version !== probeVersion) return false;
      if (result.ok && result.data.user) {
        const user = accountUser(result.data.user);
        deps.snapshot.write(user);
        publish({
          user,
          sessionStatus: "authenticated",
          cloudSession: "present",
        });
        return true;
      }
      if (result.ok || isAccountSessionRejected(result)) {
        deps.snapshot.clear();
        publish({
          user: null,
          sessionStatus: "unauthenticated",
          cloudSession: "absent",
        });
        return false;
      }
      // Preserve the live or restored account on an outage/rate limit. A
      // fresh boot without an identity may show login without claiming a
      // confirmed rejection; the account gate bounds that unknown window.
      if (state.sessionStatus === "initializing") {
        const saved = deps.snapshot.read();
        const cached = saved?.kind === "cloud" ? saved : null;
        publish({
          user: cached,
          sessionStatus: cached ? "authenticated" : "unauthenticated",
          cloudSession: cached ? "present" : "unknown",
        });
      }
      return state.sessionStatus === "authenticated";
    })();
    pending = request;
    const clear = () => {
      if (pending === request) pending = undefined;
      if (probeController === controller) probeController = undefined;
    };
    void request.then(clear, clear);
    return request;
  }
  state = {
    user: null,
    sessionStatus: "initializing",
    cloudSession: "unknown",
    initSession() {
      initialization ??= observeSession().then(() => {});
      return initialization;
    },
    refreshSession() {
      if (logoutLocks > 0) return Promise.resolve(false);
      if (refreshPending) return refreshPending;
      const current = generation;
      const request = (async () => {
        await observeSession(true);
        if (current !== generation || logoutLocks > 0) return false;
        return (
          current === generation && state.sessionStatus === "authenticated"
        );
      })();
      refreshPending = request;
      const clear = () => {
        if (refreshPending === request) refreshPending = undefined;
      };
      void request.then(clear, clear);
      return request;
    },
    async logout() {
      const finish = beginLogout();
      try {
        await deps.logout();
      } finally {
        finish();
      }
    },
  };
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    observeSession,
  };
}
