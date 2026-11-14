import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { z } from "zod";
import { t, useTranslation } from "@/i18n";
import { compareParsed, parseSemver } from "@/utils/semver";
import { Button } from "@mycadet/design-library/components/button";
import { ConfirmDialog } from "@mycadet/design-library/components/confirm-dialog";
import { toast } from "@mycadet/design-library/components/toast";

/** A release as the platform's `/v1/releases/` row offers it. */
interface ReleaseListItem {
  version: string;
  released_at: string;
  is_stable?: boolean;
}

interface UpgradeDetail {
  detail?: string;
  version?: string;
}

/** The assistant's own record, read for its release version while polling. */
const AssistantRuntimeSchema = z.object({
  current_release_version: z.string().nullable(),
});

const runtimeVersionKey = (assistantId: string) =>
  ["assistantRuntimeVersion", assistantId] as const;
const releasesKey = ["runtimeReleases"] as const;

async function fetchRuntimeVersion(assistantId: string): Promise<string | null> {
  // Same-origin scoped dials — the serving host authenticates the path; the
  // tts voice catalog and the backups module are the precedents for the swap.
  // eslint-disable-next-line no-restricted-syntax -- same-origin swap of the generated cloud dial; see above
  const response = await fetch(
    `/v1/assistants/${encodeURIComponent(assistantId)}/`,
  );
  if (!response.ok) {
    throw new Error(`The assistant read failed (${response.status})`);
  }
  return AssistantRuntimeSchema.parse(await response.json())
    .current_release_version;
}

async function fetchReleases(): Promise<ReleaseListItem[]> {
  // eslint-disable-next-line no-restricted-syntax -- same-origin swap of the generated cloud dial; see above
  const response = await fetch("/v1/releases/");
  if (!response.ok) {
    throw new Error(`The releases read failed (${response.status})`);
  }
  return (await response.json()) as ReleaseListItem[];
}

async function createUpgrade(
  assistantId: string,
  body: { version?: string },
): Promise<UpgradeDetail> {
  // eslint-disable-next-line no-restricted-syntax -- same-origin swap of the generated cloud dial; see above
  const response = await fetch(
    `/v1/assistants/${encodeURIComponent(assistantId)}/upgrade/`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new Error(`The upgrade dial failed (${response.status})`);
  }
  return (await response.json()) as UpgradeDetail;
}

function releaseLabel(
  release: ReleaseListItem,
  currentVersion: string | null | undefined,
  latestVersion: string | undefined,
): string {
  const parts = [release.version];
  if (release.version === latestVersion) {
    parts.push(t("settings:assistantUpgrades.latestSuffix"));
  }
  if (currentVersion && release.version === currentVersion) {
    parts.push(t("settings:assistantUpgrades.currentSuffix"));
  }
  return parts.join(" ");
}

const POLL_INTERVAL_MS = 3000;

function CurrentVersionValue({
  version,
}: {
  version: string | null | undefined;
}) {
  return (
    <div className="min-w-0">
      <span className="block min-w-0 break-all text-body-medium-lighter text-[var(--content-default)]">
        {version ?? "—"}
      </span>
    </div>
  );
}

interface AssistantUpgradesProps {
  currentVersion?: string | null;
  onUpgradeComplete?: () => void;
}

export function AssistantUpgrades({
  currentVersion,
  onUpgradeComplete,
}: AssistantUpgradesProps) {
  const { t } = useTranslation("settings");
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();
  const [isPollingUpgrade, setIsPollingUpgrade] = useState(false);
  const targetVersionRef = useRef<string | null>(null);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const pollRefetchInterval = (version: string | null | undefined) => {
    if (
      version &&
      targetVersionRef.current &&
      version === targetVersionRef.current
    ) {
      queueMicrotask(() => {
        const msg = t("assistantUpgrades.successUpdated", {
          version: targetVersionRef.current,
        });
        setSuccessMessage(msg);
        setIsPollingUpgrade(false);
        targetVersionRef.current = null;
        toast.success(t("assistantUpgrades.toastUpdateComplete"), {
          id: "runtime-upgrade-complete",
          tone: "strong",
        });
        onUpgradeComplete?.();
      });
      return false as const;
    }
    return POLL_INTERVAL_MS;
  };

  useQuery({
    queryKey: runtimeVersionKey(assistantId ?? ""),
    enabled: assistantId != null,
    queryFn: async () => fetchRuntimeVersion(assistantId ?? ""),
    refetchInterval: isPollingUpgrade
      ? (query) => pollRefetchInterval(query.state.data ?? null)
      : false,
  });

  const { data: releases, isLoading: releasesLoading } = useQuery({
    queryKey: releasesKey,
    queryFn: fetchReleases,
  });

  const latestRelease = releases?.[0];
  const latestVersion = latestRelease?.version ?? null;

  const upgradeAvailable = useMemo(() => {
    if (!latestVersion) {
      return false;
    }
    if (!currentVersion) {
      return true;
    }
    const target = parseSemver(latestVersion);
    const current = parseSemver(currentVersion);
    if (!target || !current) {
      return latestVersion !== currentVersion;
    }
    return compareParsed(target, current) > 0;
  }, [latestVersion, currentVersion]);

  const upgradeCreate = useMutation({
    mutationFn: async (body: { version?: string }) =>
      createUpgrade(assistantId ?? "", body),
  });

  const handleUpgrade = async () => {
    setShowConfirmation(false);
    setSuccessMessage(null);
    // No picker: nothing is on screen to honour, so the server resolves
    // latest. That is deliberately not the same as this component's
    // `latestRelease`, which does not filter `local` pre-release builds the
    // way `getLatestRuntimeRelease` does.
    try {
      const result = await upgradeCreate.mutateAsync({});
      const detail = result.detail;
      const isNoOp = detail?.includes("Already on the latest");
      if (isNoOp && detail !== undefined) {
        // Not a success — nothing actually happened. Surface a warning so the
        // user understands why the modal closed without kicking off an update.
        toast.warning(detail);
        return;
      }
      targetVersionRef.current = result.version ?? null;
      toast.success(
        result.detail ||
          t("assistantUpgrades.toastUpdateInitiated", {
            version: result.version ?? t("assistantUpgrades.latest"),
          }),
      );
      setIsPollingUpgrade(true);
      queryClient.invalidateQueries({
        queryKey: runtimeVersionKey(assistantId ?? ""),
      });
    } catch {
      toast.error(t("assistantUpgrades.toastUpdateFailed"));
    }
  };

  const targetLabel = !upgradeAvailable
    ? t("assistantUpgrades.selected")
    : t("assistantUpgrades.updateTo");

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 md:grid md:grid-cols-[auto_minmax(0,1fr)] md:items-center md:gap-x-8 md:gap-y-4">
        <div className="flex flex-col gap-1 md:contents">
          <span className="text-body-medium-default text-[var(--content-tertiary)]">
            {t("assistantUpgrades.current")}
          </span>
          <CurrentVersionValue version={currentVersion} />
        </div>

        <div className="flex flex-col gap-1 md:contents">
          <span className="text-body-medium-default text-[var(--content-tertiary)]">
            {targetLabel}
          </span>
          {/* The action belongs to the version it acts on, so it shares the
              row on desktop. Narrow screens stack it to keep both the version
              string and the button at full width. */}
          <div className="flex min-w-0 flex-col gap-3 md:flex-row md:items-center md:gap-4">
            <span className="block min-w-0 flex-1">
              {releasesLoading ? (
                <span className="flex items-center gap-1 text-body-medium-lighter text-[var(--content-tertiary)]">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t("assistantUpgrades.loading")}
                </span>
              ) : releases && releases.length > 0 ? (
                <span className="block min-w-0 break-all text-body-medium-lighter text-[var(--content-default)]">
                  {latestRelease
                    ? releaseLabel(
                        latestRelease,
                        currentVersion,
                        latestRelease.version,
                      )
                    : "—"}
                </span>
              ) : (
                t("assistantUpgrades.noReleases")
              )}
            </span>
            <Button
              variant="primary"
              className="min-w-[160px] shrink-0"
              loading={upgradeCreate.isPending || isPollingUpgrade}
              leftIcon={<RefreshCw />}
              onClick={() => setShowConfirmation(true)}
              disabled={
                !upgradeAvailable ||
                upgradeCreate.isPending ||
                isPollingUpgrade ||
                releasesLoading ||
                !releases?.length
              }
            >
              {isPollingUpgrade
                ? t("assistantUpgrades.updating")
                : t("assistantUpgrades.update")}
            </Button>
          </div>
        </div>
      </div>

      {!upgradeAvailable && currentVersion && !releasesLoading && (
        <p className="text-body-medium-lighter text-[var(--system-positive-strong)]">
          {successMessage ?? t("assistantUpgrades.alreadyOnVersion")}
        </p>
      )}

      <ConfirmDialog
        open={showConfirmation}
        title={t("assistantUpgrades.confirmUpdateTitle")}
        message={t("assistantUpgrades.confirmUpdateMessage", {
          version: latestVersion ?? t("assistantUpgrades.latest"),
        })}
        confirmLabel={t("assistantUpgrades.update")}
        onConfirm={handleUpgrade}
        onCancel={() => setShowConfirmation(false)}
      />
    </div>
  );
}
