import { useMemo, useState } from "react";

import { ArrowLeft, Coins, Loader2, Target } from "lucide-react";

import { Card } from "@mycadet/design-library/components/card";
import {
  SegmentControl,
  type SegmentControlItem,
} from "@mycadet/design-library/components/segment-control";
import { StatSquare } from "@mycadet/design-library/components/stat-square";
import { Typography } from "@mycadet/design-library/components/typography";

import {
  DEFAULT_PRESET_DAYS,
  DateRangeSelect,
  computeRangeInTimezone,
} from "@/components/charts/date-range-select";
import {
  DEFAULT_LLM_USAGE_DIMENSION,
  LLM_USAGE_DIMENSION_ITEMS,
  type LlmUsageDimension,
} from "@/utils/llm-dimension";
import { useTranslation } from "@/i18n";

import {
  InferenceUsageChart,
  type ChartMetric,
} from "@/domains/settings/components/inference-usage/inference-usage-chart";
import {
  type InferenceUsageSourceFilter,
  useInferenceUsageData,
} from "@/domains/settings/components/inference-usage/use-inference-usage-data";
import { useEffectiveTimezone } from "@/utils/use-effective-timezone";

/**
 * Format a USD amount string for display (e.g. "12.50" -> "$12.50").
 * Returns "$0.00" for unparseable values.
 */
function formatUsd(value: string | undefined): string {
  if (value === undefined) {
    return "—";
  }
  const num = parseFloat(value);
  if (Number.isNaN(num)) {
    return "$0.00";
  }
  return `$${num.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Format an event count for display with thousands separators. */
function formatEventCount(count: number | undefined): string {
  if (count === undefined) {
    return "—";
  }
  return count.toLocaleString("en-US");
}

export function InferenceUsagePanel() {
  const { t } = useTranslation("settings");
  const tz = useEffectiveTimezone();
  // Track the SELECTED PRESET IDENTITY (days), not its computed bounds, so a tz
  // change (even one that crosses a calendar-day rollover after the range was
  // first computed) yields the correct bounds for the active preset.
  const [presetDays, setPresetDays] = useState<number>(DEFAULT_PRESET_DAYS);

  const dateRange = useMemo(
    () => computeRangeInTimezone(presetDays, tz),
    [presetDays, tz],
  );

  const [drilldown, setDrilldown] = useState<{
    usageSource: InferenceUsageSourceFilter;
    llmDimension?: LlmUsageDimension;
  } | null>(null);
  const [metric, setMetric] = useState<ChartMetric>("spend");

  const metricItems: SegmentControlItem<ChartMetric>[] = useMemo(
    () => [
      { value: "spend", label: t("inferenceUsagePanel.metricSpend") },
      { value: "events", label: t("inferenceUsagePanel.metricEvents") },
    ],
    [t],
  );

  const { series, totals, isLoading, isError } = useInferenceUsageData({
    dateRange,
    drilldown,
    setDrilldown,
  });

  const handleBarClick = drilldown
    ? undefined
    : (groupKey: string) => {
        const usageSourceMap: Record<string, InferenceUsageSourceFilter> = {
          runtime_proxy_api: "runtime_proxy",
          oauth_proxy: "oauth_proxy",
        };
        const usageSource = usageSourceMap[groupKey];
        if (usageSource) {
          setDrilldown({
            usageSource,
            ...(usageSource === "runtime_proxy"
              ? { llmDimension: DEFAULT_LLM_USAGE_DIMENSION }
              : {}),
          });
        }
      };

  return (
    <Card padding="md">
      <div className="flex flex-col gap-4">
        {/* Header row: title block (left) + controls (right) */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Typography
              as="h2"
              variant="title-medium"
              className="text-[var(--content-default)]"
            >
              {t("inferenceUsagePanel.title")}
            </Typography>
            <Typography
              as="p"
              variant="body-small-default"
              className="mt-2 text-[var(--content-tertiary)]"
            >
              {t("inferenceUsagePanel.subtitle")}
            </Typography>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <DateRangeSelect value={presetDays} onChange={setPresetDays} />
            <div className="w-44">
              <SegmentControl
                items={metricItems}
                value={metric}
                onChange={setMetric}
                ariaLabel={t("inferenceUsagePanel.chartMetricAria")}
              />
            </div>
          </div>
        </div>

        {/* Stat squares: total spend + event count */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <StatSquare
            icon={<Coins />}
            value={
              isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                formatUsd(totals?.total_usd)
              )
            }
            label={t("inferenceUsagePanel.spendLabel")}
          />
          <StatSquare
            icon={<Target />}
            value={
              isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                formatEventCount(totals?.event_count)
              )
            }
            label={t("inferenceUsagePanel.eventsLabel")}
          />
        </div>

        {/* Drilldown breadcrumb + LLM dimension control */}
        {drilldown && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <button
                type="button"
                className="flex items-center gap-1.5 text-body-medium-lighter text-[var(--content-tertiary)] transition-colors hover:text-[var(--content-secondary)]"
                onClick={() => setDrilldown(null)}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                <span>{t("inferenceUsagePanel.backToAllUsage")}</span>
                <span className="text-[var(--content-tertiary)]">/</span>
                <span className="text-body-medium-default text-[var(--content-default)]">
                  {drilldown.usageSource === "runtime_proxy"
                    ? t("inferenceUsagePanel.llmSpend")
                    : t("inferenceUsagePanel.oauthSpend")}
                </span>
              </button>
            </div>
            {drilldown.usageSource === "runtime_proxy" && (
              <div className="w-56">
                <SegmentControl
                  items={LLM_USAGE_DIMENSION_ITEMS}
                  value={drilldown.llmDimension ?? DEFAULT_LLM_USAGE_DIMENSION}
                  onChange={(nextDimension) =>
                    setDrilldown({
                      usageSource: "runtime_proxy",
                      llmDimension: nextDimension,
                    })
                  }
                  ariaLabel={t("inferenceUsagePanel.llmDimensionAria")}
                />
              </div>
            )}
          </div>
        )}

        {/* Chart */}
        {isLoading ? (
          <div className="flex h-[345px] items-center justify-center rounded-xl bg-[var(--surface-base)]">
            <Loader2 className="h-6 w-6 animate-spin text-[var(--content-tertiary)]" />
          </div>
        ) : isError ? (
          <div className="flex h-[345px] items-center justify-center rounded-xl bg-[var(--surface-base)] text-body-medium-lighter text-[var(--content-tertiary)]">
            {t("inferenceUsagePanel.loadError")}
          </div>
        ) : series ? (
          <div className="rounded-xl bg-[var(--surface-base)] p-3">
            <InferenceUsageChart
              buckets={series.buckets}
              metric={metric}
              onBarClick={handleBarClick}
            />
          </div>
        ) : null}
      </div>
    </Card>
  );
}
