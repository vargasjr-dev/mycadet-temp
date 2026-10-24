import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { APP_VERSION } from "../version.js";

/**
 * Broadcast the daemon's current version to all connected clients.
 */
export function broadcastDaemonStatus(): void {
  broadcastMessage({
    type: "assistant_status",
    version: APP_VERSION,
  });
}
