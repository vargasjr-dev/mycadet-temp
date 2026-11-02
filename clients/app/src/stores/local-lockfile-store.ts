/**
 * The roster arm: the serving host's assistant list read over the
 * `/v1/assistants/` operator route, published as a store so the chooser's
 * roster cards (entries imported through the connect flow and the
 * machine's own local assistants) render from one loaded snapshot.
 *
 * Connect's import writes the entry host-side in the same call that settles
 * the poll, so there is no second source of truth to reconcile — the store
 * just re-reads on demand (`load()` after an import, on mount, and when the
 * chooser wants a fresh look). A failed read leaves the previous snapshot
 * published and marks the store loaded anyway: a stale list still renders,
 * the same degradation web's lockfile store chooses.
 *
 * Port of web's lockfile arm of the resolved-assistants store, scoped to the
 * app bundle's one transport (the shell's operator routes). A failed read
 * leaves the previous snapshot published — `loaded` flips true and the arm
 * renders from whatever it last had.
 *
 * Leaf module: must not import from chooser/screen modules.
 */

import { useSyncExternalStore } from "react";

import { parseLockfile, type Lockfile } from "@mycadet/local-mode/contract";

export interface LocalLockfileState {
  /** The last successfully read lockfile, or `null` before the first read. */
  lockfile: Lockfile | null;
  /** True once a read has settled (successfully or not). */
  loaded: boolean;
}

interface LocalLockfileActions {
  /** Re-read the lockfile over the bridge and publish the snapshot. */
  load(): Promise<void>;
}

const EMPTY: LocalLockfileState = { lockfile: null, loaded: false };

let state: LocalLockfileState = EMPTY;

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(next: Partial<LocalLockfileState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) {
    listener();
  }
}

async function load(): Promise<void> {
  try {
    // The bare `/v1/assistants/` GET is the host's renderer-safe roster
    // read; the shared total validation parses it before publication.
    const res = await fetch("/v1/assistants/");
    if (!res.ok) {
      throw new Error(`assistant list fetch failed: ${res.status}`);
    }
    publish({ lockfile: parseLockfile(await res.json()), loaded: true });
  } catch (error) {
    console.error("localLockfileStore.load failed", error);
    // Loaded regardless: a failed read renders the arm from the previous
    // snapshot (or nothing) rather than a spinner that can never end.
    publish({ loaded: true });
  }
}

const actions: LocalLockfileActions = { load };

function useLocalLockfile<T>(selector: (state: LocalLockfileState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

/**
 * Reset hook for tests. Not intended for production callers.
 */
export function __resetLocalLockfileForTesting(): void {
  state = EMPTY;
}

/**
 * The local-lockfile store: call it with a selector inside React, reach
 * `getState()` / the actions outside one (the app's `auth-store` shape).
 */
export const useLocalLockfileStore = Object.assign(useLocalLockfile, {
  getState: (): LocalLockfileState & LocalLockfileActions => ({
    ...state,
    ...actions,
  }),
  ...actions,
  use: {
    lockfile: (): Lockfile | null => useLocalLockfile((s) => s.lockfile),
    loaded: (): boolean => useLocalLockfile((s) => s.loaded),
  },
});
