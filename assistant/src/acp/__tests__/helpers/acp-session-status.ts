import type { AcpSessionManager } from "../../session-manager.js";
import type { AcpSessionState } from "../../types.js";

export function requireSessionStatus(
  manager: AcpSessionManager,
  sessionId: string,
): AcpSessionState {
  const state = manager.getStatus(sessionId);
  if (Array.isArray(state)) {
    throw new Error("Expected one ACP session state");
  }
  return state;
}
