/**
 * Runtime wrapper for the dictation overlay bridge surface.
 *
 * The Electron main process owns a system-wide panel pinned
 * top-center of the active display that shows the user's words live while
 * they dictate via push-to-talk into another app (the Electron port of the
 * native Swift client's `DictationOverlayWindow`).
 *
 * Feature code imports these functions instead of touching
 * `window.cadet.dictationOverlay` directly. Off-Electron (web, Capacitor
 * iOS) and on older shells that predate the channel they are no-ops, so the
 * dictation flow degrades gracefully.
 */

import { isElectron } from "@/runtime/is-electron";
import type { DictationOverlayHitRegion } from "@mycadet/ipc-contract";
import type { DictationOverlayMessage } from "@mycadet/ipc-contract";
import type { DictationOverlayState } from "@mycadet/ipc-contract";

/**
 * Publish the current dictation lifecycle state to the overlay.
 * Fire-and-forget — interim transcription updates are high-frequency.
 */
export function setDictationOverlayState(state: DictationOverlayMessage): void {
  if (!isElectron()) {
    return;
  }
  window.cadet?.dictationOverlay?.setState(state);
}

/**
 * Subscribe to overlay states. Only the dictation overlay window's own
 * renderer route consumes this. Returns an unsubscribe function.
 */
export function subscribeToDictationOverlayState(
  callback: (state: DictationOverlayState) => void,
): () => void {
  if (!isElectron() || !window.cadet?.dictationOverlay) {
    return () => undefined;
  }
  return window.cadet.dictationOverlay.onState(callback);
}

/**
 * Read the latest overlay state (null when no session is active, off
 * Electron, or on shells that predate the channel). The overlay route
 * loads lazily, so states pushed before its subscription registers are
 * dropped — pull this once subscribed to catch up.
 */
export async function getDictationOverlayState(): Promise<DictationOverlayState | null> {
  if (!isElectron() || !window.cadet?.dictationOverlay?.getState) {
    return null;
  }
  return window.cadet.dictationOverlay.getState();
}

export function requestDictationOverlayStop(): void {
  if (!isElectron()) {
    return;
  }
  window.cadet?.dictationOverlay?.requestStop?.();
}

export function subscribeToDictationOverlayStop(
  callback: () => void,
): () => void {
  if (!isElectron() || !window.cadet?.dictationOverlay?.onStopRequested) {
    return () => undefined;
  }
  return window.cadet.dictationOverlay.onStopRequested(callback);
}

export function setDictationOverlayInteractive(interactive: boolean): void {
  if (!isElectron()) {
    return;
  }
  window.cadet?.dictationOverlay?.setInteractive?.(interactive);
}

/**
 * Report where the Stop control sits (window-relative CSS pixels), or null
 * when there is none. Main hit-tests the cursor against it on platforms
 * where forwarded mouse moves never reach the click-through overlay
 * (Windows). No-ops on shells that predate the channel.
 */
export function setDictationOverlayHitRegion(
  region: DictationOverlayHitRegion | null,
): void {
  if (!isElectron()) {
    return;
  }
  window.cadet?.dictationOverlay?.setHitRegion?.(region);
}
