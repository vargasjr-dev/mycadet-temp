import type { CredentialBackend } from "../../security/credential-backend.js";
import { setSecureKeyBackendForTesting } from "../../security/secure-keys.js";

export function memorySecureKeyBackend(
  store: Record<string, string>,
): CredentialBackend {
  return {
    name: "memory-test",
    isAvailable: () => true,
    async get(account) {
      return { value: store[account], unreachable: false };
    },
    async set(account, value) {
      store[account] = value;
      return true;
    },
    async delete(account) {
      return account in store
        ? (delete store[account], "deleted")
        : "not-found";
    },
    async list() {
      return { accounts: Object.keys(store), unreachable: false };
    },
  };
}

/**
 * Pin the memory backend and return its backing store. Seed it up front or
 * mutate the returned record inside tests — both are live immediately.
 */
export function useMemorySecureKeys(
  seed: Record<string, string> = {},
): Record<string, string> {
  const store: Record<string, string> = { ...seed };
  setSecureKeyBackendForTesting(memorySecureKeyBackend(store));
  return store;
}

/**
 * Repoint the pinned backend at a fresh store — the replacement for the old
 * `mockSecureKeyStore = { ... }` reassignments. Pass a seed to pre-load keys.
 */
export function reseedMemorySecureKeys(
  store: Record<string, string>,
  seed: Record<string, string> = {},
): Record<string, string> {
  for (const k of Object.keys(store)) {
    delete store[k];
  }
  Object.assign(store, seed);
  return store;
}
