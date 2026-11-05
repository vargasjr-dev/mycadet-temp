import { useCallback, useEffect, useMemo, useState } from "react";

import { useQuery } from "@tanstack/react-query";

import type { LockfileAssistant } from "@mycadet/local-mode/contract";
import { useResolvedAssistantStore } from "@/stores/resolved-assistant-store";
import { healthzGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import type { HealthzGetResponse } from "@/generated/daemon/types.gen";
import { t } from "@/i18n";
import { captureError } from "@/lib/error-reporting/capture-error";
import { isTransientNetworkError } from "@mycadet/design-library/utils/is-transient-network-error";
import { toast } from "@mycadet/design-library";
// A resize rolls the assistant pod, so the new allocation only appears once it
// comes back up. Poll /v1/health for a bounded window, tolerating the restart
// gap where the endpoint is briefly unreachable.
const HEALTHZ_POLL_INTERVAL_MS = 4_000;
const HEALTHZ_POLL_TIMEOUT_MS = 90_000;

/**
 * True when the reported CPU/memory allocation differs from `baseline` — i.e.
 * a resize has actually landed.
 */
function allocationChanged(
  next: HealthzGetResponse,
  baseline: HealthzGetResponse,
): boolean {
  return (
    (next.memory?.maxMb ?? null) !== (baseline.memory?.maxMb ?? null) ||
    (next.cpu?.maxCores ?? null) !== (baseline.cpu?.maxCores ?? null)
  );
}

/** What a post-resize watch is waiting for. */
export interface ResizeWatch {
  /**
   * The allocation to watch for a change from. Null when nothing had loaded
   * when the resize started: the first reading after that could still be the
   * pre-resize values, so it is adopted as the baseline rather than read as
   * the resized allocation.
   */
  baseline: HealthzGetResponse | null;
  /** Wall clock. The watch ends here whether or not the allocation moved. */
  until: number;
}

/**
 * The health query's `refetchInterval` decision: the cadence to poll at, or
 * `false` to stop.
 *
 * At module scope so the tests exercise the same code path the runtime does.
 * A copy of this rule in a test helper would let the two drift.
 */
export function resizePollInterval(
  data: HealthzGetResponse | undefined,
  watch: ResizeWatch | null,
  now: number,
): number | false {
  if (watch === null || now >= watch.until) {
    return false;
  }
  if (data === undefined || watch.baseline === null) {
    return HEALTHZ_POLL_INTERVAL_MS;
  }
  return allocationChanged(data, watch.baseline)
    ? false
    : HEALTHZ_POLL_INTERVAL_MS;
}

export interface AssistantWithHealthz {
  assistant: LockfileAssistant;
  healthz: HealthzGetResponse | null;
  healthzLoading: boolean;
  /** True while a request is in flight, including a refresh over existing values. */
  healthzFetching: boolean;
  /** True while a post-resize poll is waiting for the new allocation to appear. */
  healthzPolling: boolean;
  refetch: () => Promise<unknown>;
  /**
   * Watch for the reported CPU/memory allocation to differ from `baseline`,
   * meaning the resize has landed. The health query polls while the watch is
   * open and stops on its own once the allocation moves or the window
   * elapses, tolerating the pod restart where /v1/health is unreachable.
   */
  refetchUntilResized: (baseline: HealthzGetResponse | null) => void;
}

export function useAssistantWithHealthz(): AssistantWithHealthz {
  // The store IS the resolution: the entry projects straight to the
  // panel's shape — no fetch, no loading window. The selector returns the
  // entry itself (a stable reference); the projection runs outside it, so a
  // fresh mapped object can never re-trigger the subscription.
  const assistant = useResolvedAssistantStore((s) => s.assistant);
  /* Keyed on the active id rather than on the resolved record, so this read
     and the record's own go out together. The record can only ever report the
     id the hook already holds, so waiting for it would buy nothing and cost a
     round trip on a tunnel. */
  const healthzQueryOptions = useMemo(
    () => healthzGetOptions({ path: { assistant_id: assistant.assistantId } }),
    [assistant.assistantId],
  );
  const [resizeWatch, setResizeWatch] = useState<ResizeWatch | null>(null);
  const {
    data: healthz = null,
    isLoading: healthzQueryLoading,
    isFetching: healthzFetching,
    error: healthzError,
    refetch: refetchHealthz,
  } = useQuery({
    ...healthzQueryOptions,
    retry: false,
    /* Live readings, so a revisit revalidates rather than serving a frozen
       number. The cache is here to paint the last values immediately, not to
       stand in for a fresh one. */
    staleTime: 0,
    /* A resize rolls the pod, so the new allocation only appears once it comes
       back. The query owns that cadence: it already retries nothing, keeps the
       last good data across a failed attempt, and stops on its own when the
       allocation moves. */
    refetchInterval: (query) =>
      resizePollInterval(query.state.data, resizeWatch, Date.now()),
  });

  const healthzPolling = resizeWatch !== null;

  /* Reported only when there is nothing to show. A failure with values still
     on the cards is not worth interrupting for: the last reading stands as the
     truth of when it was taken, and a resize deliberately spends part of its
     window unreachable. Keyed on the error and the data rather than on whether
     a poll is running, so there is no flag whose flip can surface a failure
     after the fact. */
  useEffect(() => {
    if (healthzError === null || healthz !== null) {
      return;
    }
    if (isTransientNetworkError(healthzError)) {
      return;
    }
    captureError(healthzError, { context: "fetch_assistant_healthz" });
    toast.error(t("settings:assistantStatusPanel.loadHealthzFailed"));
  }, [healthzError, healthz]);

  /* Ends the watch, and adopts a baseline for a resize that started before any
     reading arrived. The cadence is the query's; this owns only when the watch
     is over, which is the allocation moving or the deadline passing. */
  useEffect(() => {
    if (resizeWatch === null) {
      return;
    }
    if (resizeWatch.baseline === null && healthz !== null) {
      setResizeWatch({ ...resizeWatch, baseline: healthz });
      return;
    }
    if (
      resizePollInterval(healthz ?? undefined, resizeWatch, Date.now()) ===
      false
    ) {
      setResizeWatch(null);
      return;
    }
    const timer = setTimeout(
      () => setResizeWatch(null),
      Math.max(0, resizeWatch.until - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [resizeWatch, healthz]);

  /* A watch belongs to the assistant that was resized. The reported health
     needs no cleanup of its own, being cached per assistant id, but a watch
     left running would hold the next assistant's resize controls disabled. */
  useEffect(() => {
    setResizeWatch(null);
  }, [assistant.assistantId]);

  /* Opens the watch; the query polls from there. The machine-size tag comes
     from the assistant record — the store's entry, live without a fetch. */
  const refetchUntilResized = useCallback(
    (baseline: HealthzGetResponse | null) => {
      setResizeWatch({ baseline, until: Date.now() + HEALTHZ_POLL_TIMEOUT_MS });
    },
    [],
  );

  return {
    assistant,
    healthz,
    healthzLoading: healthzQueryLoading,
    healthzFetching,
    healthzPolling,
    refetch: refetchHealthz,
    refetchUntilResized,
  };
}
