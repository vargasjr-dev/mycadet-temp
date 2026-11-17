import type { TurnContext } from "../../types.js";
import { isMemoryInjectionOff } from "./conversation-mode-store.js";

/**
 * Gates fresh retrieval only; history and static memory remain available.
 * A conversation whose memory-injection mode is `"off"` (the memory plugin's
 * per-conversation opt-out, `conversation-mode-store.ts`) gets no fresh
 * retrieval of any engine this turn — every retrieval caller (the hook's
 * legacy path and the v3 orchestrator) asks this helper, so the opt-out is
 * engine-independent. The static/PKB injectors gate on the same store.
 */
export function shouldRetrieveTurnMemory(
  ctx: Pick<TurnContext, "callSite" | "skipMemoryRetrieval" | "conversationId">,
): boolean {
  return (
    ctx.callSite !== "voiceFrontDoor" &&
    ctx.skipMemoryRetrieval !== true &&
    !isMemoryInjectionOff(ctx.conversationId)
  );
}
