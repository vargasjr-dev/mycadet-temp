/**
 * Generic status monitor for the active assistant: polls a daemon status
 * endpoint on a fixed cadence, refetches on `app.resume`, and applies
 * daemon-pushed SSE updates, with generation race guards so a stale response
 * can never overwrite a newer snapshot after an assistant switch mid-flight.
 *
 * `useDiskPressureMonitor` and `useResourcePressureMonitor` are the
 * instantiations; parameterize by status type, fetch function, equality,
 * mode derivation, and SSE narrowing instead of copying this state machine.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { AssistantEventEnvelope } from "@mycadet/assistant-api";

import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";

type AssistantEvent = AssistantEventEnvelope["message"];

export type AssistantStatusFetchResult<TStatus> =
  | { ok: true; data: { status: TStatus } }
  | { ok: false };

export interface UseAssistantStatusMonitorOptions<TStatus, TMode> {
  /** A new identity restarts the poll interval and refreshes immediately. */
  refreshKey?: unknown;
  cadenceMs: number;
  /** Fetches the current status snapshot for the assistant. */
  fetchStatus: (
    assistantId: string,
  ) => Promise<AssistantStatusFetchResult<TStatus>>;
  /** Structural equality used to skip no-op snapshot updates. */
  areStatusesEqual: (left: TStatus | null, right: TStatus | null) => boolean;
  /** Derives the render-facing mode from the current status. */
  deriveMode: (status: TStatus | null) => TMode;
  /**
   * Narrows a bus SSE event to this monitor's status payload. Return
   * `undefined` for events that belong to other monitors.
   */
  extractSseStatus: (event: AssistantEvent) => TStatus | null | undefined;
  /**
   * Called when a pushed status event passes the enabled/assistant guard,
   * just before the status is applied. Lets a wrapping hook reset
   * request-scoped state (e.g. an in-flight acknowledgement).
   */
  onStatusEvent?: () => void;
}

export interface UseAssistantStatusMonitorResult<TStatus, TMode> {
  status: TStatus | null;
  mode: TMode;
  hasResolvedStatus: boolean;
  applyStatusEvent: (payload: TStatus | null) => void;
  refresh: () => Promise<void>;
  /**
   * Invalidates every in-flight request and returns the new generation.
   * For wrapping hooks that run their own guarded requests.
   */
  bumpGeneration: () => number;
  /**
   * True while `generation` is still the current one; a wrapping hook checks
   * this before applying the result of one of its own requests.
   */
  isCurrentRequest: (generation: number) => boolean;
  /** Applies a fetched status if the request is still current. */
  applyStatusForAssistant: (
    nextStatus: TStatus | null,
    hasResolvedStatus: boolean,
    generation: number,
  ) => void;
  clearStatus: () => void;
}

interface AssistantStatusMonitorSnapshot<TStatus> {
  status: TStatus | null;
  hasResolvedStatus: boolean;
}

const EMPTY_MONITOR_SNAPSHOT: AssistantStatusMonitorSnapshot<never> = {
  status: null,
  hasResolvedStatus: false,
};

export function useAssistantStatusMonitor<TStatus, TMode>({
  refreshKey,
  cadenceMs,
  fetchStatus,
  areStatusesEqual,
  deriveMode,
  extractSseStatus,
  onStatusEvent,
}: UseAssistantStatusMonitorOptions<
  TStatus,
  TMode
>): UseAssistantStatusMonitorResult<TStatus, TMode> {
  // The web bundle has one assistant loaded — the active one.
  const assistantId = useActiveAssistantId();
  const [snapshot, setSnapshot] = useState<
    AssistantStatusMonitorSnapshot<TStatus>
  >(EMPTY_MONITOR_SNAPSHOT);
  const generationRef = useRef(0);
  const pollRequestIdRef = useRef(0);

  // Ref-stabilized so `refresh` / `applyStatusForAssistant` keep the
  // identity cadence of their explicit deps even if a caller passes
  // inline functions.
  const fetchStatusRef = useRef(fetchStatus);
  const areStatusesEqualRef = useRef(areStatusesEqual);
  const onStatusEventRef = useRef(onStatusEvent);

  useLayoutEffect(() => {
    fetchStatusRef.current = fetchStatus;
    areStatusesEqualRef.current = areStatusesEqual;
    onStatusEventRef.current = onStatusEvent;
  });

  useEffect(() => {
    generationRef.current += 1;
    setSnapshot(EMPTY_MONITOR_SNAPSHOT);
  }, [assistantId]);

  const bumpGeneration = useCallback(() => {
    generationRef.current += 1;
    return generationRef.current;
  }, []);

  const isCurrentRequest = useCallback(
    (generation: number) => generationRef.current === generation,
    [],
  );

  const applyStatusForAssistant = useCallback(
    (
      nextStatus: TStatus | null,
      hasResolvedStatus: boolean,
      generation: number,
    ) => {
      if (!isCurrentRequest(generation)) {
        return;
      }

      setSnapshot((current) => {
        if (
          current.hasResolvedStatus === hasResolvedStatus &&
          areStatusesEqualRef.current(current.status, nextStatus)
        ) {
          return current;
        }

        return {
          status: nextStatus,
          hasResolvedStatus,
        };
      });
    },
    [isCurrentRequest],
  );

  const clearStatus = useCallback(() => {
    generationRef.current += 1;
    setSnapshot(EMPTY_MONITOR_SNAPSHOT);
  }, []);

  const refresh = useCallback(async () => {
    const generation = generationRef.current;
    const pollRequestId = pollRequestIdRef.current + 1;
    pollRequestIdRef.current = pollRequestId;

    try {
      const result = await fetchStatusRef.current(assistantId);
      if (pollRequestIdRef.current !== pollRequestId) {
        return;
      }

      if (!result.ok) {
        applyStatusForAssistant(null, false, generation);
        return;
      }

      applyStatusForAssistant(result.data.status, true, generation);
    } catch {
      if (pollRequestIdRef.current !== pollRequestId) {
        return;
      }

      applyStatusForAssistant(null, false, generation);
    }
  }, [assistantId, applyStatusForAssistant]);

  useEffect(() => {
    void refresh();

    const intervalId = window.setInterval(() => {
      void refresh();
    }, cadenceMs);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [assistantId, cadenceMs, refresh, refreshKey]);

  // The bus's `"app.resume"` channel fans in browser visibility,
  // Capacitor foreground, and `window.online`, so a single
  // subscription drives the focus-style refetch.
  useBusSubscription("app.resume", () => {
    void refresh();
  });

  const applyStatusEvent = useCallback(
    (payload: TStatus | null) => {
      const generation = bumpGeneration();
      onStatusEventRef.current?.();
      applyStatusForAssistant(payload, true, generation);
    },
    [applyStatusForAssistant, bumpGeneration],
  );

  // React to daemon-pushed status events via the event bus. Complements
  // the polling interval and resume-refresh above so status changes are
  // reflected immediately without waiting for the next poll tick.
  useBusSubscription("sse.event", (envelope) => {
    const payload = extractSseStatus(envelope.message);
    if (payload === undefined) {
      return;
    }
    applyStatusEvent(payload);
  });

  const status = snapshot.status;
  const { hasResolvedStatus } = snapshot;
  const mode = useMemo(() => deriveMode(status), [deriveMode, status]);

  return {
    status,
    mode,
    hasResolvedStatus,
    applyStatusEvent,
    refresh,
    bumpGeneration,
    isCurrentRequest,
    applyStatusForAssistant,
    clearStatus,
  };
}
