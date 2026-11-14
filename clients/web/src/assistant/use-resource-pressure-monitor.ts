import type { ResourcePressureStatus } from "@mycadet/assistant-api";

import { getAssistantResourcePressureStatus } from "@/lib/assistant-status-api";
import {
  RESOURCE_PRESSURE_POLL_INTERVAL_MS,
  areResourcePressureStatusesEqual,
  getResourcePressureMonitorMode,
  type ResourcePressureMonitorMode,
} from "@/assistant/resource-pressure";
import { useAssistantStatusMonitor } from "@/assistant/use-assistant-status-monitor";

export interface UseResourcePressureMonitorResult {
  status: ResourcePressureStatus | null;
  mode: ResourcePressureMonitorMode;
}

export function useResourcePressureMonitor(): UseResourcePressureMonitorResult {
  const { status, mode } = useAssistantStatusMonitor({
    cadenceMs: RESOURCE_PRESSURE_POLL_INTERVAL_MS,
    fetchStatus: getAssistantResourcePressureStatus,
    areStatusesEqual: areResourcePressureStatusesEqual,
    deriveMode: getResourcePressureMonitorMode,
    extractSseStatus: (event) =>
      event.type === "resource_pressure_status_changed"
        ? event.status
        : undefined,
  });

  return { status, mode };
}
