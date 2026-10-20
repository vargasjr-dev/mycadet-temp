import { useQuery } from "@tanstack/react-query";

import { type DateRange } from "@/components/charts/date-range-select";
import {
  organizationsBillingUsageSeriesRetrieveOptions,
  organizationsBillingUsageTotalsRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import type {
  OrganizationsBillingUsageSeriesRetrieveData,
  OrganizationsBillingUsageTotalsRetrieveData,
} from "@/generated/api/types.gen";
import {
  type CloudGateState,
  useActiveAssistantIsCloudHosted,
  useCloudGate,
} from "@/hooks/use-cloud-gate";
import { getEffectiveTimezone } from "@/utils/effective-timezone";
import {
  DEFAULT_LLM_USAGE_DIMENSION,
  type LlmUsageDimension,
  toBillingGroupBy,
} from "@/utils/llm-dimension";
import { useEffectiveTimezone } from "@/utils/use-effective-timezone";

export type UsageChartState = {
  dateRange: DateRange;
  drilldown: BillingUsageDrilldown | null;
  setDrilldown: (d: BillingUsageDrilldown | null) => void;
};

export type BillingUsageSourceFilter = "runtime_proxy" | "oauth_proxy";
export type BillingUsageDrilldown = {
  usageSource: BillingUsageSourceFilter;
  llmDimension?: LlmUsageDimension;
};

export function getBillingUsageGroupBy(
  drilldown: BillingUsageDrilldown | null,
):
  | NonNullable<
      OrganizationsBillingUsageSeriesRetrieveData["query"]
    >["group_by"]
  | undefined {
  if (!drilldown) {
    return undefined;
  }
  if (drilldown.usageSource === "oauth_proxy") {
    return "oauth_provider";
  }

  return toBillingGroupBy(
    drilldown.llmDimension ?? DEFAULT_LLM_USAGE_DIMENSION,
  );
}

export function buildBillingUsageSeriesQuery(
  state: UsageChartState,
  tz: string = getEffectiveTimezone(),
): NonNullable<OrganizationsBillingUsageSeriesRetrieveData["query"]> {
  return {
    from: state.dateRange.from,
    to: state.dateRange.to,
    tz,
    ...(state.drilldown
      ? {
          usage_source: state.drilldown.usageSource,
          group_by: getBillingUsageGroupBy(state.drilldown),
        }
      : {}),
  };
}

export function buildBillingUsageTotalsQuery(
  state: UsageChartState,
  tz: string = getEffectiveTimezone(),
): NonNullable<OrganizationsBillingUsageTotalsRetrieveData["query"]> {
  return {
    from: state.dateRange.from,
    to: state.dateRange.to,
    tz,
    ...(state.drilldown ? { usage_source: state.drilldown.usageSource } : {}),
  };
}

/**
 * Whether the organization-scoped platform billing queries may fire.
 *
 * These fetches only make sense when two things hold:
 *   - the active assistant is cloud-hosted (`cloudHostedOnly` gate is
 *     "full"), and
 *   - the assistant is positively resolved as cloud-hosted.
 *
 * The `cloudHostedOnly` gate reports "full" during the lifecycle loading
 * window, so the strict `isCloudHosted` check is what keeps a fetch from
 * kicking off before hosting is resolved.
 */
export function isBillingUsageDataEnabled(
  cloudGate: CloudGateState,
  isCloudHosted: boolean,
): boolean {
  return cloudGate === "full" && isCloudHosted;
}

export function useBillingUsageData(state: UsageChartState) {
  const tz = useEffectiveTimezone();

  const cloudGate = useCloudGate({ cloudHostedOnly: true });
  const isCloudHosted = useActiveAssistantIsCloudHosted();
  const enabled = isBillingUsageDataEnabled(cloudGate, isCloudHosted);

  const seriesQuery = useQuery({
    ...organizationsBillingUsageSeriesRetrieveOptions({
      query: buildBillingUsageSeriesQuery(state, tz),
    }),
    enabled,
  });

  const totalsQuery = useQuery({
    ...organizationsBillingUsageTotalsRetrieveOptions({
      query: buildBillingUsageTotalsQuery(state, tz),
    }),
    enabled,
  });

  return {
    series: seriesQuery.data,
    totals: totalsQuery.data,
    isLoading: seriesQuery.isLoading || totalsQuery.isLoading,
    isError: seriesQuery.isError || totalsQuery.isError,
  };
}
