import { mintRandomId } from "@/lib/random-id";

const DEVICE_ID_STORAGE_KEY = "cadet.deviceId";

let cached: string | null = null;

/**
 * The device id — the daemon's platform-path identity (`Cadet-Device-Id`).
 *
 * Generated and managed client side, like every other client's: a UUID
 * minted on first call and persisted to `localStorage`, stable across
 * reloads and browser restarts for the install. Best-effort persistence —
 * a storage refusal (privacy mode, quota) degrades to a per-page-load id,
 * never a thrown error on the boot import chain.
 */
export function getDeviceId(): string {
  if (cached) {
    return cached;
  }
  try {
    const stored = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (stored && stored.length > 0) {
      cached = stored;
      return cached;
    }
  } catch {
    /* best-effort read */
  }
  const id = mintRandomId();
  try {
    localStorage.setItem(DEVICE_ID_STORAGE_KEY, id);
  } catch {
    /* best-effort write — the in-memory id still serves this page load */
  }
  cached = id;
  return cached;
}
