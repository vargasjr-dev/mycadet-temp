import { getActiveAssistantId } from "@/stores/resolved-assistant-store";
import { useCallback, useEffect, useState } from "react";

import type { DiskPressureStatus } from "@mycadet/assistant-api";

import {
  acknowledgeAssistantDiskPressure,
  getAssistantDiskPressureStatus,
} from "@/assistant/api";
import {
  DISK_PRESSURE_POLL_INTERVAL_MS,
  areDiskPressureStatusesEqual,
  getDiskPressureMonitorMode,
  type DiskPressureMonitorMode,
} from "@/assistant/disk-pressure";
import { useAssistantStatusMonitor } from "@/assistant/use-assistant-status-monitor";

export interface UseDiskPressureMonitorOptions {
  refreshKey?: unknown;
  cadenceMs?: number;
}

export type DiskPressureStatusEventPayload = DiskPressureStatus | null;

export interface UseDiskPressureMonitorResult {
  status: DiskPressureStatus | null;
  mode: DiskPressureMonitorMode;
  hasResolvedStatus: boolean;
  isAcknowledging: boolean;
  acknowledgeError: Error | null;
  acknowledge: () => Promise<void>;
  applyStatusEvent: (payload: DiskPressureStatusEventPayload) => void;
  refresh: () => Promise<void>;
}

const ACKNOWLEDGE_FAILURE_MESSAGE =
  "Failed to acknowledge assistant disk pressure.";

function errorFromUnknown(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

export function useDiskPressureMonitor({
  refreshKey,
  cadenceMs = DISK_PRESSURE_POLL_INTERVAL_MS,
}: UseDiskPressureMonitorOptions = {}): UseDiskPressureMonitorResult {
  const [isAcknowledging, setIsAcknowledging] = useState(false);
  const [acknowledgeError, setAcknowledgeError] = useState<Error | null>(null);

  const resetAcknowledgement = useCallback(() => {
    setIsAcknowledging(false);
    setAcknowledgeError(null);
  }, []);

  const monitor = useAssistantStatusMonitor({
    refreshKey,
    cadenceMs,
    fetchStatus: getAssistantDiskPressureStatus,
    areStatusesEqual: areDiskPressureStatusesEqual,
    deriveMode: getDiskPressureMonitorMode,
    extractSseStatus: (event) =>
      event.type === "disk_pressure_status_changed" ? event.status : undefined,
    onStatusEvent: resetAcknowledgement,
  });

  const { applyStatusForAssistant, bumpGeneration, isCurrentRequest } = monitor;

  useEffect(() => {
    resetAcknowledgement();
  }, [resetAcknowledgement]);

  const acknowledge = useCallback(async () => {
    const requestedAssistantId = getActiveAssistantId();
    const generation = bumpGeneration();
    setIsAcknowledging(true);
    setAcknowledgeError(null);

    try {
      const result =
        await acknowledgeAssistantDiskPressure(requestedAssistantId);
      if (!result.ok) {
        throw new Error(ACKNOWLEDGE_FAILURE_MESSAGE);
      }

      if (!isCurrentRequest(generation)) {
        return;
      }

      applyStatusForAssistant(result.data.status, true, bumpGeneration());
      setIsAcknowledging(false);
    } catch (error) {
      if (isCurrentRequest(generation)) {
        setAcknowledgeError(
          errorFromUnknown(error, ACKNOWLEDGE_FAILURE_MESSAGE),
        );
      }
    } finally {
      if (isCurrentRequest(generation)) {
        setIsAcknowledging(false);
      }
    }
  }, [applyStatusForAssistant, bumpGeneration, isCurrentRequest]);

  return {
    status: monitor.status,
    mode: monitor.mode,
    hasResolvedStatus: monitor.hasResolvedStatus,
    isAcknowledging,
    acknowledgeError,
    acknowledge,
    applyStatusEvent: monitor.applyStatusEvent,
    refresh: monitor.refresh,
  };
}
