/**
 * Remembered-origins store: the client-local list of remote assistant
 * origins the chooser can offer alongside its cloud-API assistants.
 *
 * Each entry is `{ name?, url, addedAt }` and nothing else. The `url` is the
 * assistant's public base (origin plus optional path prefix, e.g.
 * `https://host/assistant-123`) and never carries credentials: the
 * credential for an origin is its origin-scoped HttpOnly refresh cookie,
 * which never passes through this store.
 *
 * Port of web's remembered-origins store (zustand), re-homed on the app's
 * hand-rolled `useSyncExternalStore` store convention (see `auth-store`):
 * same shape and semantics, no store dependency. Web's persistence-provider
 * swap machinery (native shells point the store at a bridge-backed list) is
 * left out — this bundle keeps its origins device-local in localStorage,
 * which survives a hub logout like web's device-scoped default, and web's
 * cross-tab Web Locks mutex is folded into the same serialized in-tab
 * mutation queue (the chooser is single-window; cross-tab consistency comes
 * from the `storage`-event refresh below, not from writer arbitration).
 *
 * Leaf module: must not import from chooser/screen modules.
 */

import { useSyncExternalStore } from "react";

import { setLocalSetting, watchSetting } from "@app/utils/local-settings";

export interface RememberedOrigin {
  name?: string;
  /** Normalized public base URL: origin plus optional path prefix. */
  url: string;
  /** ISO-8601 timestamp of when the origin was first remembered. */
  addedAt: string;
}

export const REMEMBERED_ORIGINS_STORAGE_KEY = "cadet:remembered-origins";

/**
 * Normalize a candidate origin URL to its canonical stored form, or `null`
 * when it is not a usable `https:` base. Web's `normalizeOriginUrl`,
 * verbatim — the validation stance of the native shell's
 * `SelfHostedServer.validate` and the canonical form of
 * `SelfHostedServer.canonicalize`, so every store agrees on which strings
 * mean the same server.
 *
 * Canonical form: lowercase scheme and host (via `URL.origin`, which also
 * drops any userinfo), path prefix preserved with trailing slashes
 * stripped, query and hash dropped.
 */
export function normalizeOriginUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname === "") {
    return null;
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

/** Anything that isn't a JSON array reads as unusable, not as empty. */
function parseStoredEntries(raw: string): RememberedOrigin[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? toRememberedOrigins(parsed) : null;
}

/**
 * Defensive read of untrusted entry items (persisted JSON, a future bridge
 * payload): non-object items and urls failing {@link normalizeOriginUrl} are
 * dropped, and the first entry for a url wins. Every persistence path funnels
 * its raw items through here so the readers agree on entry identity.
 *
 * @param fallbackAddedAt Stamped on items carrying no `addedAt`. Defaults to
 *   now.
 */
export function toRememberedOrigins(
  items: unknown[],
  fallbackAddedAt?: string,
): RememberedOrigin[] {
  const entries: RememberedOrigin[] = [];
  const seen = new Set<string>();
  const fallback = fallbackAddedAt ?? new Date().toISOString();
  for (const item of items) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const { url, name, addedAt } = item as Record<string, unknown>;
    if (typeof url !== "string") {
      continue;
    }
    const normalized = normalizeOriginUrl(url);
    if (normalized === null || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    entries.push({
      url: normalized,
      ...(typeof name === "string" && name !== "" ? { name } : {}),
      addedAt: typeof addedAt === "string" ? addedAt : fallback,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Device-scoped: the remembered list is this device's client-local view of
 * its assistants, so it survives a hub logout. `setLocalSetting` reports
 * whether the write reached storage, and a rejected write fires no
 * notification of its own — both facts the mutations below lean on to honor
 * "publish state only after persistence succeeds".
 */
const localStorageProvider = {
  load: async (): Promise<RememberedOrigin[]> => {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(REMEMBERED_ORIGINS_STORAGE_KEY);
    } catch {
      // No web storage means nothing to read; the store stays unhydrated.
      throw new Error("storage unavailable");
    }
    if (raw === null) {
      return [];
    }
    const parsed = parseStoredEntries(raw);
    if (parsed === null) {
      throw new Error("unusable stored value");
    }
    return parsed;
  },
  save: async (entries: RememberedOrigin[]): Promise<boolean> =>
    setLocalSetting(REMEMBERED_ORIGINS_STORAGE_KEY, JSON.stringify(entries)),
  watch: (onChange: () => void): (() => void) =>
    watchSetting(REMEMBERED_ORIGINS_STORAGE_KEY, onChange),
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface RememberedOriginsState {
  origins: RememberedOrigin[];
  hydrated: boolean;
}

export type AddOriginResult =
  | { ok: true; origin: RememberedOrigin }
  | { ok: false };

let state: RememberedOriginsState = { origins: [], hydrated: false };
const listeners = new Set<() => void>();

function getState(): RememberedOriginsState {
  return state;
}

function publish(next: Partial<RememberedOriginsState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

/**
 * Mutations run one at a time through this chain so a slow async save can
 * never land after a later mutation's save and roll persisted state back.
 */
let mutationQueue: Promise<unknown> = Promise.resolve();

function enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(mutation, mutation);
  mutationQueue = run.catch(() => undefined);
  return run;
}

let hydrationPromise: Promise<void> | null = null;

/**
 * Set when a watch event arrives while the initial hydration load is still
 * pending: the refresh cannot publish yet (the store is unhydrated), so
 * hydration completion triggers a follow-up refresh instead of leaving the
 * store on its possibly older snapshot.
 */
let refreshSkippedWhileUnhydrated = false;

/**
 * Re-load the persisted value into already-hydrated state, e.g. after
 * another tab or window changed the stored list. Runs through the mutation
 * queue so a slow refresh load can never publish state that a later
 * mutation's save has already superseded.
 */
function refreshFromProvider(): Promise<void> {
  return enqueueMutation(async () => {
    try {
      const origins = await localStorageProvider.load();
      if (getState().hydrated) {
        publish({ origins });
      } else if (hydrationPromise === null) {
        // A failed hydration already settled, so nothing would consume the
        // skip flag; this event signals storage recovered, so retry
        // hydration now (its load is at least as fresh as this one).
        void hydrate();
      } else {
        refreshSkippedWhileUnhydrated = true;
      }
    } catch {
      // Keep current state; the next mutation or hydrate retries.
    }
  });
}

/**
 * Load from storage; concurrent calls share one promise. A failed load
 * leaves the store unhydrated and a later call retries.
 */
function hydrate(): Promise<void> {
  hydrationPromise ??= (async () => {
    // Yield before touching storage so a synchronous load() throw is caught
    // only after the ??= above has installed this promise; otherwise the
    // catch's reset would be overwritten and later hydrate() calls could
    // never retry.
    await Promise.resolve();
    try {
      const origins = await localStorageProvider.load();
      publish({ origins, hydrated: true });
      if (refreshSkippedWhileUnhydrated) {
        // A watch event fired mid-hydration; our snapshot may already be
        // stale, so reconcile with storage's latest.
        refreshSkippedWhileUnhydrated = false;
        void refreshFromProvider();
      }
    } catch {
      // Stay unhydrated so a later hydrate() retries; never persist a list
      // built from state the provider was not able to load.
      hydrationPromise = null;
    }
  })();
  return hydrationPromise;
}

/**
 * Remember an origin. Invalid urls return `{ ok: false }`, as does a
 * mutation attempted while storage cannot be read (so a failed load can
 * never be overwritten with a list built from empty state). Re-adding an
 * already-remembered url keeps its original `addedAt` and updates `name`
 * only when a new one is provided.
 */
async function addOrigin(input: {
  url: string;
  name?: string;
}): Promise<AddOriginResult> {
  const normalized = normalizeOriginUrl(input.url);
  if (normalized === null) {
    return { ok: false };
  }
  return enqueueMutation(async (): Promise<AddOriginResult> => {
    await hydrate();
    if (!getState().hydrated) {
      return { ok: false };
    }
    // Re-load so the working list includes entries another tab or window
    // persisted after this one hydrated.
    let current: RememberedOrigin[];
    try {
      current = await localStorageProvider.load();
    } catch {
      return { ok: false };
    }
    const trimmedName = input.name?.trim();
    const existing = current.find((o) => o.url === normalized);
    const base: RememberedOrigin = existing ?? {
      url: normalized,
      addedAt: new Date().toISOString(),
    };
    const origin = trimmedName ? { ...base, name: trimmedName } : base;
    const origins = existing
      ? current.map((o) => (o.url === normalized ? origin : o))
      : [...current, origin];
    // Publish state only after persistence succeeds so the chooser never
    // shows an entry storage does not actually hold.
    let saved = false;
    try {
      saved = await localStorageProvider.save(origins);
    } catch {
      saved = false;
    }
    if (!saved) {
      return { ok: false };
    }
    publish({ origins });
    return { ok: true, origin };
  });
}

/** Forget an origin. A failed write keeps the entry and leaves state alone. */
async function removeOrigin(url: string): Promise<void> {
  const normalized = normalizeOriginUrl(url);
  if (normalized === null) {
    return;
  }
  await enqueueMutation(async () => {
    await hydrate();
    if (!getState().hydrated) {
      return;
    }
    let current: RememberedOrigin[];
    try {
      current = await localStorageProvider.load();
    } catch {
      return;
    }
    const remaining = current.filter((o) => o.url !== normalized);
    if (remaining.length !== current.length) {
      let saved = false;
      try {
        saved = await localStorageProvider.save(remaining);
      } catch {
        saved = false;
      }
      if (!saved) {
        return;
      }
    }
    publish({ origins: remaining });
  });
}

// Watch storage from the start so a hydrated window picks up changes other
// tabs or windows persist.
localStorageProvider.watch(() => void refreshFromProvider());

function useRememberedOrigins<T>(
  selector: (state: RememberedOriginsState) => T,
): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

/**
 * The remembered-origins store: call it with a selector inside React, reach
 * `getState()` / the actions outside one (the app's `auth-store` shape).
 */
export const useRememberedOriginsStore = Object.assign(useRememberedOrigins, {
  getState,
  hydrate: (): Promise<void> => hydrate(),
  addOrigin,
  removeOrigin,
  use: {
    origins: (): RememberedOrigin[] =>
      useRememberedOrigins((s) => s.origins),
    hydrated: (): boolean => useRememberedOrigins((s) => s.hydrated),
  },
});
