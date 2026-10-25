/**
 * A confirmed platform session marker for offline boot continuity (LUM-2412).
 * No account identity is stored here. Offline restore also requires the host's
 * session credential, and a settled rejection or logout removes the marker.
 */
const SNAPSHOT_KEY = "cadet:auth:sessionSnapshot";

export function persistSessionSnapshot(): void {
  try {
    localStorage.setItem(SNAPSHOT_KEY, "true");
  } catch {
    // Storage unavailable — offline restore won't have a marker.
  }
}

export function readSessionSnapshot(): boolean {
  try {
    return localStorage.getItem(SNAPSHOT_KEY) === "true";
  } catch {
    return false;
  }
}

export function clearSessionSnapshot(): void {
  try {
    localStorage.removeItem(SNAPSHOT_KEY);
  } catch {
    // Storage unavailable.
  }
}
