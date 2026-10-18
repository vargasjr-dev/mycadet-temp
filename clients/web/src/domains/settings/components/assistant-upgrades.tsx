import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import {
  assistantsRetrieveOptions,
  assistantsRetrieveQueryKey,
  releasesListOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import { assistantsUpgradeDetailCreate } from "@/generated/api/sdk.gen";
import type { ReleaseListItem } from "@/generated/api/types.gen";
import { useLocalRuntimeUpgrade } from "@/hooks/use-local-runtime-upgrade";
import { t, useTranslation } from "@/i18n";
import {
  LOCAL_RUNTIME_RELEASES_FETCH_LIMIT,
  getLatestRuntimeRelease,
  isRuntimeUpgradeAvailable,
} from "@/lib/local-runtime-upgrade";
import { compareParsed, parseSemver } from "@/utils/semver";
import { Button } from "@mycadet/design-library/components/button";
import { ConfirmDialog } from "@mycadet/design-library/components/confirm-dialog";
import { toast } from "@mycadet/design-library/components/toast";

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
  assistantId: string;
  currentVersion?: string | null;
  onUpgradeComplete?: () => void;
}

export function AssistantUpgrades({
  assistantId,
  currentVersion,
  onUpgradeComplete,
}: AssistantUpgradesProps) {
  const { t } = useTranslation("settings");
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
    ...assistantsRetrieveOptions({ path: { id: assistantId } }),
    refetchInterval: isPollingUpgrade
      ? (query) =>
          pollRefetchInterval(query.state.data?.current_release_version)
      : false,
  });

  const { data: releases, isLoading: releasesLoading } = useQuery(
    releasesListOptions({
      query: { channel: "stable" },
    }),
  );

  const latestRelease =
    releases?.find((r) => r.is_stable !== false) ?? releases?.[0];
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
    mutationFn: async (body: { version?: string }) => {
      const { data } = await assistantsUpgradeDetailCreate({
        path: { id: assistantId },
        body,
        throwOnError: true,
      });
      return data;
    },
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
      const isNoOp = result.detail?.includes("Already on the latest");
      if (isNoOp) {
        // Not a success — nothing actually happened. Surface a warning so the
        // user understands why the modal closed without kicking off an update.
        toast.warning(result.detail);
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
        queryKey: assistantsRetrieveQueryKey({
          path: { id: assistantId },
        }),
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

interface LocalAssistantUpgradesProps {
  assistantId: string;
  currentVersion?: string | null;
  onUpgradeComplete?: () => void;
}

export function LocalAssistantUpgrades({
  assistantId,
  currentVersion,
  onUpgradeComplete,
}: LocalAssistantUpgradesProps) {
  const { t } = useTranslation("settings");
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const { data: releases, isLoading: releasesLoading } = useQuery(
    releasesListOptions({
      query: { stable: true, limit: LOCAL_RUNTIME_RELEASES_FETCH_LIMIT },
    }),
  );

  const latestRelease = useMemo(
    () => getLatestRuntimeRelease(releases),
    [releases],
  );
  const targetVersion = latestRelease?.version;
  const upgradeAvailable = !currentVersion
    ? !!targetVersion
    : isRuntimeUpgradeAvailable(currentVersion, targetVersion);
  const upgradeCreate = useLocalRuntimeUpgrade({ assistantId, targetVersion });

  const handleUpgrade = async () => {
    setShowConfirmation(false);
    setSuccessMessage(null);
    try {
      const result = await upgradeCreate.upgrade();
      setSuccessMessage(
        t("assistantUpgrades.successUpdated", {
          version:
            result.version ?? targetVersion ?? t("assistantUpgrades.latest"),
        }),
      );
      toast.success(t("assistantUpgrades.toastUpdateComplete"), {
        id: "runtime-upgrade-complete",
        tone: "strong",
      });
      onUpgradeComplete?.();
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("assistantUpgrades.toastUpdateFailed"),
      );
    }
  };

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
            {t("assistantUpgrades.updateTo")}
          </span>
          <span className="block min-w-0 break-all text-body-medium-lighter text-[var(--content-default)]">
            {releasesLoading
              ? t("assistantUpgrades.loading")
              : targetVersion && latestRelease
                ? releaseLabel(latestRelease, currentVersion, targetVersion)
                : t("assistantUpgrades.noReleases")}
          </span>
        </div>
      </div>

      <Button
        variant="primary"
        className="min-w-[160px]"
        loading={upgradeCreate.isPending}
        leftIcon={<RefreshCw />}
        onClick={() => setShowConfirmation(true)}
        disabled={
          upgradeCreate.isPending ||
          releasesLoading ||
          !targetVersion ||
          !upgradeAvailable
        }
      >
        {upgradeCreate.isPending
          ? t("assistantUpgrades.updating")
          : targetVersion
            ? t("assistantUpgrades.updateToVersion", { version: targetVersion })
            : t("assistantUpgrades.update")}
      </Button>

      {successMessage && (
        <p className="text-body-medium-lighter text-[var(--system-positive-strong)]">
          {successMessage}
        </p>
      )}
      {!successMessage &&
        !upgradeAvailable &&
        targetVersion &&
        !releasesLoading && (
          <p className="text-body-medium-lighter text-[var(--system-positive-strong)]">
            {t("assistantUpgrades.alreadyOnVersion")}
          </p>
        )}

      <ConfirmDialog
        open={showConfirmation}
        title={t("assistantUpgrades.confirmUpdateTitle")}
        message={t("assistantUpgrades.confirmUpdateMessage", {
          version: targetVersion ?? t("assistantUpgrades.latest"),
        })}
        confirmLabel={t("assistantUpgrades.update")}
        onConfirm={handleUpgrade}
        onCancel={() => setShowConfirmation(false)}
      />
    </div>
  );
}
