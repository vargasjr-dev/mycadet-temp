/**
 * Who may reach the camera frame gate's tuning readout, as React reads it.
 *
 * The predicate itself lives in `lib/camera/frame-gate-debug-access.ts`, which
 * also applies it outside React so the thresholds a session runs match what it
 * is allowed even with nothing mounted.
 */

import { useCameraGateDebugStore } from "@/stores/camera-gate-debug-store";
import { useGatewaySessionStore } from "@/stores/gateway-session-store";

/**
 * Whether this session may turn the readout on at all. The camera's view
 * options gate the row's presence on this, so a session that can never see
 * the readout is not offered a switch for it.
 */
export function useCameraGateHudAvailable(): boolean {
  return useGatewaySessionStore.use.isStaff();
}

/** Whether the panel should be collecting and on screen. */
export function useCameraGateHudEnabled(): boolean {
  const available = useCameraGateHudAvailable();
  const hudEnabled = useCameraGateDebugStore.use.hudEnabled();
  return available && hudEnabled;
}
