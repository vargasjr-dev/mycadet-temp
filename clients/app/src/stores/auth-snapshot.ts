import type {
  AccountAuthSnapshot,
  AccountAuthSource,
} from "@app/stores/auth-state";

/** Stable account projection: unrelated source changes do not invalidate React snapshots. */
export function createAccountAuthReader(
  source: AccountAuthSource,
): AccountAuthSource {
  let previous: AccountAuthSnapshot | undefined;
  return {
    subscribe: (listener) => source.subscribe(listener),
    getSnapshot() {
      const state = source.getSnapshot();
      const next: AccountAuthSnapshot = {
        user: state.user,
        sessionStatus: state.sessionStatus,
        cloudSession: state.cloudSession,
        initSession: state.initSession,
        refreshSession: state.refreshSession,
        logout: state.logout,
      };
      if (
        previous &&
        (Object.keys(next) as (keyof AccountAuthSnapshot)[]).every((key) =>
          Object.is(previous![key], next[key]),
        )
      )
        return previous;
      previous = next;
      return next;
    },
  };
}
