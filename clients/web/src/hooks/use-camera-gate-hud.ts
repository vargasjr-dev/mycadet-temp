/**
 * Who may reach the camera frame gate's tuning readout, as React reads it.
 *
 * Staff is projected once onto the gateway-session seam (`lib/auth/staff`'s
 * predicate), so this hook and `lib/camera/frame-gate-debug-access.ts` — which
 * applies the same answer outside React — can never disagree.
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
