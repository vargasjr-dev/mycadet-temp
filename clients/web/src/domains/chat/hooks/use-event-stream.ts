/**
 * Conversation-scoped wiring for the bus-owned SSE stream.
 *
 * React adapter that connects four concerns:
 *
 * 1. `sse.event` → `sseEventConsumer` (cross-conversation filter,
 *    seq-gap detection, dispatch into the chat domain).
 * 2. `sse.opened` → `reconcileOnReopen` (post-reconnect reconcile,
 *    epoch bump, watchdog rescue telemetry).
 * 3. `sse.closed` → end the in-flight turn. Recovery rides the
 *    stream's own reconnect plus the reconcile-on-reopen handler.
 *
 * Bus subscriptions use `useBusSubscription` per EVENT_BUS.md. The
 * stream-context lifecycle (setup / teardown of the stream-store
 * sentinel) remains in a plain `useEffect` since it is resource
 * management, not event handling.
 *
 * Visibility / app-state are owned by `useEventBusInit`. This hook
 * does not register any `visibilitychange` listener of its own.
 */

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useStreamStore } from "@/domains/chat/stream-store";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { createReconcileOnReopen } from "@/domains/chat/streaming/reconcile-on-reopen";
import { createSseEventConsumer } from "@/domains/chat/streaming/sse-event-consumer";
import { endTurn } from "@/domains/chat/turn-coordinator";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { recordLifecycleDiagnostic } from "@/lib/diagnostics";
import type { EventStream } from "@/lib/streaming/stream-transport";
import type {
  ReconcileActiveConversationResult,
  ReconcileTrigger,
} from "@/domains/chat/hooks/use-message-reconciliation";
import type { AssistantEvent } from "@/types/event-types";

/** Params accepted by {@link useEventStream}. */
export interface UseEventStreamParams {
  /** Resolved assistant ID (null when not yet loaded). */
  assistantId: string | null;
  /** Currently active conversation key. */
  activeConversationId: string | null;
  /** Whether the active conversation has been persisted on the server. */
  conversationExistsOnServer: boolean;

  // Callbacks from useStreamEventHandler / useMessageReconciliation
  handleStreamEvent: (
    event: AssistantEvent,
    epoch: number,
    envelopeConversationId: string | undefined,
  ) => void;
  reconcileActiveConversation: (
    trigger: ReconcileTrigger,
    authoritative?: boolean,
  ) => Promise<ReconcileActiveConversationResult>;
  startReconciliationLoop: (epoch: number) => void;
  cancelReconciliation: () => void;
}

export function useEventStream({
  assistantId,
  activeConversationId,
  conversationExistsOnServer,
  handleStreamEvent,
  reconcileActiveConversation,
  startReconciliationLoop,
  cancelReconciliation,
}: UseEventStreamParams): void {
  // ---- Ref-stabilize unstable callback params ----
  //
  // Updated in `useLayoutEffect` (commit phase) so refs only ever
  // hold values from committed renders — matching the pattern used
  // by `useBusSubscription` and `activeConversationIdLatestRef`.
  // Under concurrent React a render can be aborted; a render-phase
  // mutation would leave the ref pointing at an uncommitted value.
  // See https://react.dev/reference/react/useRef#caveats
  const handleStreamEventRef = useRef(handleStreamEvent);
  const reconcileActiveConversationRef = useRef(reconcileActiveConversation);
  const startReconciliationLoopRef = useRef(startReconciliationLoop);
  const cancelReconciliationRef = useRef(cancelReconciliation);
  useLayoutEffect(() => {
    handleStreamEventRef.current = handleStreamEvent;
    reconcileActiveConversationRef.current = reconcileActiveConversation;
    startReconciliationLoopRef.current = startReconciliationLoop;
    cancelReconciliationRef.current = cancelReconciliation;
  });

  // Track the latest active conversation key in a ref synced during
  // the commit phase. The bus subscriber filters against this ref
  // instead of the closure-captured value so an `assistant_text_delta`
  // published in the gap between a conversation switch and the effect
  // cleanup is rejected as soon as React commits the new active key.
  // Without this, in-flight deltas for the previous conversation can
  // merge into the new conversation's messages.
  //
  // The ref is updated in `useLayoutEffect` (commit phase) rather than
  // during render. Under concurrent React a render can be aborted; a
  // render-phase mutation would leave the ref pointing at a value
  // from an uncommitted render and the filter would reject events
  // for what is still the actually-committed conversation.
  const activeConversationIdLatestRef = useRef(activeConversationId);
  useLayoutEffect(() => {
    activeConversationIdLatestRef.current = activeConversationId;
  }, [activeConversationId]);

  // --------------------------------------------------------------------------
  // Stream context lifecycle — setup / teardown of the stream-store
  // sentinel. Not a bus subscription; resource management that must
  // track the active conversation's identity.
  // --------------------------------------------------------------------------
  useEffect(() => {
    if (!assistantId || !activeConversationId) {
      return;
    }
    if (!conversationExistsOnServer) {
      return;
    }

    const capturedAssistantId = assistantId;
    const capturedConversationId = activeConversationId;

    const ss = useStreamStore.getState();
    ss.setStreamContext({
      assistantId: capturedAssistantId,
      conversationId: capturedConversationId,
    });
    // `use-send-message.ts` reads `stream` as a presence bit to decide
    // whether SSE will deliver the response. We write a sentinel whose
    // `cancel()` is a no-op — the real teardown is the bus unsubscribe
    // in `useBusSubscription`.
    const presence: EventStream = { cancel: () => {} };
    ss.setStream(presence);

    return () => {
      useStreamStore.getState().bumpEpoch();
      // Clear stream/context only if they still belong to this
      // subscription — a newer subscription may have already replaced
      // them. Uses identity check (stream) and value check (context),
      // matching the original ref-based ownership checks.
      const s = useStreamStore.getState();
      if (s.stream === presence) {
        s.setStream(null);
      }
      const ctx = s.streamContext;
      if (
        ctx?.assistantId === capturedAssistantId &&
        ctx.conversationId === capturedConversationId
      ) {
        s.setStreamContext(null);
      }
    };
  }, [assistantId, activeConversationId, conversationExistsOnServer]);

  // --------------------------------------------------------------------------
  // SSE event consumer — recreated per conversation so internal seq-
  // tracking state resets on switch. Reads callback params from stable
  // refs at call time, so the factory deps are only the identity keys.
  // --------------------------------------------------------------------------
  const consumer = useMemo(() => {
    if (
      !assistantId ||
      !activeConversationId ||
      !conversationExistsOnServer
    ) {
      return null;
    }
    // Refs read inside closures that run at event-dispatch time, not during render.
    // eslint-disable-next-line react-hooks/refs
    return createSseEventConsumer({
      activeConversationIdRef: activeConversationIdLatestRef,
      handleStreamEvent: (event, epoch, envelopeConversationId) =>
        handleStreamEventRef.current(event, epoch, envelopeConversationId),
      // Seq-gap reconcile: a proven out-of-ring gap means the live suffix
      // is non-contiguous, so re-bootstrap authoritatively from the server
      // snapshot rather than keeping the holey local rows.
      reconcileActive: () => {
        // The gap also dropped events from this conversation's subagents, so
        // their histories are refetched rather than advanced with holes.
        useSubagentStore.getState().invalidateHistories(activeConversationId);
        return reconcileActiveConversationRef.current("seq_gap", true);
      },
    });
  }, [assistantId, activeConversationId, conversationExistsOnServer]);

  // --------------------------------------------------------------------------
  // Post-reconnect reconcile handler — recreated per conversation so
  // diagnostics capture the correct assistant/conversation pair and the
  // handler's captured-id filter stays current.
  // --------------------------------------------------------------------------
  const reconcileHandler = useMemo(() => {
    if (!assistantId || !activeConversationId) {
      return null;
    }
    // Refs read inside closures that run at event-dispatch time, not during render.
    // eslint-disable-next-line react-hooks/refs
    return createReconcileOnReopen({
      assistantId,
      conversationId: activeConversationId,
      // Reopen reconcile: a warm resume usually replays the buffered suffix
      // contiguously, so reconcile non-authoritatively and let the
      // keep-local rule protect the freshly streamed tail the debounced
      // `/messages` snapshot has not persisted yet. A genuine out-of-ring
      // gap is healed authoritatively by the consumer's seq-gap detector.
      reconcileActive: () => reconcileActiveConversationRef.current("reopen"),
      startReconciliationLoop: (epoch) =>
        startReconciliationLoopRef.current(epoch),
    });
  }, [assistantId, activeConversationId]);

  // --------------------------------------------------------------------------
  // Bus subscriptions — per EVENT_BUS.md, React code uses
  // `useBusSubscription` instead of raw `subscribe` inside useEffect.
  // The helper auto-stabilizes the handler ref (useLayoutEffect) so
  // inline closures are safe and subscriptions are never torn down /
  // re-registered on re-render.
  // --------------------------------------------------------------------------

  useBusSubscription("sse.event", (envelope) => {
    consumer?.handleSseEvent(envelope);
    // Fold the active conversation's events into the materialized snapshot.
    // Idempotent by seq; a no-op until the snapshot is seeded — the seed
    // replays the ring tail, so events that arrive first aren't lost. Gated on
    // the same commit-phase active-conversation ref the consumer's filter uses.
    if (
      envelope.conversationId &&
      envelope.conversationId === activeConversationIdLatestRef.current
    ) {
      useChatSessionStore.getState().applyEnvelopeToSnapshot(envelope);
      // A subagent's own events ride this conversation's stream inside
      // `subagent_event`; they fold into that subagent's history the same way.
      useSubagentStore.getState().applySubagentEnvelope(envelope);
    }
  });

  useBusSubscription("sse.opened", (payload) => {
    reconcileHandler?.handleSseOpened(payload);
  });

  useBusSubscription("sse.closed", ({ reason }) => {
    if (!assistantId || !activeConversationId) {
      return;
    }
    const streamState = useStreamStore.getState();
    recordLifecycleDiagnostic("sse_stream_error", {
      assistantId,
      conversationId: activeConversationId,
      epoch: streamState.streamEpoch,
      messageLength: reason.length,
    });
    endTurn({
      conversationId: streamState.streamContext?.conversationId,
      reason: "session_error",
    });
  });

  // --------------------------------------------------------------------------
  // Unmount cleanup.
  // --------------------------------------------------------------------------
  useEffect(() => {
    return () => {
      cancelReconciliationRef.current();
    };
  }, []);
}
