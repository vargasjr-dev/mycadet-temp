import type { AssistantState } from "@/assistant/types";
import type { AssistantStatus } from "@/runtime/is-electron";
import type { TurnPhase } from "@/domains/chat/turn-store";

export interface AssistantStatusInputs {
  /** Lifecycle phase the assistant is in (`useAssistantLifecycleStore`). */
  lifecycleKind: AssistantState["kind"];
  /** Session bits from the gateway-session seam. */
  sessionSettled: boolean;
  /** Whether a user is signed in (cloud or local gateway). */
  sessionLive: boolean;
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
  sessionSettled,
  sessionLive,
  isSSEConnected,
  turnPhase,
}: AssistantStatusInputs): AssistantStatus {
  // Auth is the outermost gate: a settled probe with no live session means
  // the renderer can't reach the assistant on the user's behalf at all. An
  // unsettled probe is still booting rather than failing, so it falls
  // through to disconnected below.
  if (!sessionLive && sessionSettled) {
    return "authFailed";
  }

  // A terminal lifecycle error outranks connection state — the assistant
  // itself failed to come up.
  if (lifecycleKind === "error") {
    return "error";
  }

  // Session still settling, or the assistant hasn't reached `active` yet
  // (loading / initializing / hosted-but-not-connected):
  // there's no live data plane, so the honest state is disconnected.
  if (!sessionLive || lifecycleKind !== "active") {
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
