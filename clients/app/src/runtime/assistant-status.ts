import type { AssistantRequestState } from "../assistant/use-assistant-request";
import type { AssistantStatus } from "@mycadet/ipc-contract";

import { getElectronBridge } from "./electron-bridge";

/**
 * Map the app shell's own resolution state onto the five-state menu-bar
 * status the native app shows (`AssistantStatus` in
 * `clients/macos/src/main/status.ts`). Pure so the mapping is unit-tested
 * without standing up stores.
 *
 * The shell resolves the assistant BEFORE anything mounts: the web assistant
 * iframe exists only once the resolution came back `ready`, so the web bundle
 * carries no status notion at all — by the time it loads, the assistant is
 * fully loaded. The dot therefore reads the shell's own resolution, which is
 * the only place the pre-mount states can ever be observed:
 *
 *   authFailed → error → disconnected → idle
 *
 * The old in-conversation `thinking` pulse dies here: turn phase and SSE
 * liveness were web's facts, and web no longer reports them. The dot rests at
 * `idle` while the assistant works; per-turn granularity returns with the
 * desktop layer's own vantage (it routes the gateway traffic), which is the
 * stated endgame for all electron logic.
 */
export function deriveAssistantStatus(
  state: AssistantRequestState,
): AssistantStatus {
  // The resolution request itself failed (network, timeout, contract
  // mismatch) — the assistant failed to come up.
  if (state.status === "error") {
    return "error";
  }

  switch (state.status) {
    // The platform rejected the shell's credential while resolving — that IS
    // the auth failure; there is no separate session question to ask.
    case "unauthenticated":
      return "authFailed";
    // An assistant is resolved and hosting the web bundle — the assistant is
    // fully loaded.
    case "ready":
      return "idle";
    // Still resolving, or nothing to host: the chooser owns the window, no
    // assistant is paired, or the assistant isn't usable. No live data plane.
    default:
      return "disconnected";
  }
}

/**
 * Per-capability wrapper for the Electron host's menu-bar (Tray) status
 * indicator, matching the app bridge's other capabilities: the renderer never
 * touches `window.cadet.*` directly — feature code calls this named function.
 *
 * Publishes the assistant's connection status so the main process can drive
 * the Tray status dot. The app shell holds the resolution (it resolved the
 * assistant), so it is the source of truth; main owns only the presentation.
 * Fire-and-forget — no acknowledgement.
 *
 * Safe to call from any host — no-op off Electron.
 */
export function setAssistantStatus(status: AssistantStatus): void {
  getElectronBridge()?.status?.setConnection(status);
}
