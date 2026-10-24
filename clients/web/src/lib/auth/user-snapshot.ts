/**
 * Last-known platform session's account id, persisted so an offline boot
 * can restore the session optimistically instead of bouncing a
 * still-logged-in user to the login screen (LUM-2412).
 *
 * The key uses the `cadet:` user-scoped prefix, so logout's
 * `clearUserScopedStorage` sweep (and the cross-tab logout broadcast)
 * removes it automatically; the auth store also clears it explicitly
 * whenever a session check comes back with a settled "no session"
 * answer, so a revoked session can't be resurrected by a later
 * offline boot.
 */

const SNAPSHOT_KEY = "cadet:auth:sessionSnapshot";
// Pre-reshape snapshots carried the full user object under this key; the
// account id is migrated out of it so an upgrade never loses the
// offline-restore path mid-flight.
const LEGACY_SNAPSHOT_KEY = "cadet:auth:userSnapshot";

export function persistSessionSnapshot(accountId: string | null): void {
  if (!accountId) {
    return;
  }
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ accountId }));
    localStorage.removeItem(LEGACY_SNAPSHOT_KEY);
  } catch {
    // Storage unavailable — offline restore just won't have a snapshot.
  }
}

export function readSessionSnapshot(): string | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { accountId?: unknown } | null;
      if (parsed && typeof parsed.accountId === "string") {
        return parsed.accountId;
      }
      return null;
    }
    // Legacy shape: `{"id": ...}` described the signed-in user. Only the
    // account id survives the reshape.
    const legacyRaw = localStorage.getItem(LEGACY_SNAPSHOT_KEY);
    if (!legacyRaw) {
      return null;
    }
    const legacy = JSON.parse(legacyRaw) as { id?: unknown } | null;
    const accountId = typeof legacy?.id === "string" ? legacy.id : null;
    if (accountId) {
      persistSessionSnapshot(accountId);
    }
    return accountId;
  } catch {
    return null;
  }
}

export function clearSessionSnapshot(): void {
  try {
    localStorage.removeItem(SNAPSHOT_KEY);
    localStorage.removeItem(LEGACY_SNAPSHOT_KEY);
  } catch {
    // Storage unavailable.
  }
}
