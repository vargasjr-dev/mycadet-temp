import type { AssistantResolutionState } from "@/assistant/types";
import type { AssistantStatus } from "@/runtime/is-electron";
import type { TurnPhase } from "@/domains/chat/turn-store";

export interface AssistantStatusInputs {
  /** Resolution kind the assistant's boot resolve landed on. */
  lifecycleKind: AssistantResolutionState["kind"];
  /**
   * HTTP status the resolution failed with, when the boot resolve got a
   * server answer (`lifecycleKind === "error"` only). The platform's auth
   * rejection IS the auth fact — there is no separate session question.
   */
  lifecycleErrorStatus?: number;
  /** Whether the always-on SSE event stream is currently connected. */
  isSSEConnected: boolean;
  /** Phase of the active chat turn (`useTurnStore`). */
  turnPhase: TurnPhase;
}

/**
 * Map the renderer's live lifecycle / auth / connection / turn signals onto the
 * five-state menu-bar status the native app shows (`AssistantStatus` in
 * `clients/macos/src/main/status.ts`). Pure so the mapping is unit-tested without
 * standing up stores.
 *
 * Precedence is outermost-cause-first so the dot always names the most
 * fundamental reason the assistant isn't working:
 *
 *   authFailed → error → disconnected → thinking → idle
 *
 * `awaiting_user_input` is deliberately treated as idle, not thinking: the
 * agent is waiting on the user, so the pulse should rest rather than imply
 * active work.
 */
export function deriveAssistantStatus({
  lifecycleKind,
  lifecycleErrorStatus,
  isSSEConnected,
  turnPhase,
}: AssistantStatusInputs): AssistantStatus {
  // A terminal lifecycle error outranks connection state — the assistant
  // itself failed to come up. When the assistant's own resolution was
  // rejected by the platform's auth (401/403), that IS the auth failure:
  // there is no separate session question to ask.
  if (lifecycleKind === "error") {
    if (lifecycleErrorStatus === 401 || lifecycleErrorStatus === 403) {
      return "authFailed";
    }
    return "error";
  }

  // The assistant hasn't reached `active` yet (loading / initializing /
  // hosted-but-not-connected): there's no live data plane, so the honest
  // state is disconnected.
  if (lifecycleKind !== "active") {
    return "disconnected";
  }

  // Active assistant but the always-on SSE stream is down: authenticated to
  // the cloud, not to the live event plane.
  if (!isSSEConnected) {
    return "disconnected";
  }

  // Active + connected: a turn in flight pulses `thinking`, otherwise idle.
  if (
    turnPhase === "queued" ||
    turnPhase === "thinking" ||
    turnPhase === "streaming"
  ) {
    return "thinking";
  }

  return "idle";
}
