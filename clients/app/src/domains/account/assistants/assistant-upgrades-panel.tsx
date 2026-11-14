import { Loader2, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  compareParsed,
  createUpgrade,
  type ReleaseListItem,
  fetchReleases,
  fetchRuntimeVersion,
  parseSemver,
} from "@app/domains/account/assistants/assistants-management-api";
import { useTranslation } from "@app/i18n";
import { Button } from "@design/components/button";
import { ConfirmDialog } from "@design/components/confirm-dialog";
import { toast } from "@design/components/toast";

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

/**
 * The upgrade management panel for one assistant, on the account's
 * assistants-management page. Reads the assistant's own record for its
 * current release version (same-origin scoped dial) and the platform's
 * release rows; the upgrade dial proxies to the cloud on the operator's
 * own credentials.
 */
export function AssistantUpgradesPanel({
  assistantId,
}: {
  assistantId: string;
}) {
  const { t } = useTranslation("account");
  const [runtimeVersion, setRuntimeVersion] = useState<
    string | null | undefined
  >(undefined);
  const [releases, setReleases] = useState<ReleaseListItem[] | null>(null);
  const [releasesLoading, setReleasesLoading] = useState(true);
  const [isPollingUpgrade, setIsPollingUpgrade] = useState(false);
  const [isUpgrading, setIsUpgrading] = useState(false);
  const targetVersionRef = useRef<string | null>(null);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRuntimeVersion(undefined);
    void fetchRuntimeVersion(assistantId)
      .then((version) => {
        if (!cancelled) {
          setRuntimeVersion(version);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRuntimeVersion(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [assistantId]);

  useEffect(() => {
    let cancelled = false;
    setReleases(null);
    setReleasesLoading(true);
    void fetchReleases()
      .then((rows) => {
        if (!cancelled) {
          setReleases(rows);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setReleases([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setReleasesLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // While an upgrade runs, poll the assistant's record until its release
  // version reaches the target, then report completion.
  useEffect(() => {
    if (!isPollingUpgrade) {
      return;
    }
    const timer = setInterval(() => {
      void fetchRuntimeVersion(assistantId)
        .then((version) => {
          if (
            version &&
            targetVersionRef.current &&
            version === targetVersionRef.current
          ) {
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
            void fetchRuntimeVersion(assistantId).then((fresh) => {
              setRuntimeVersion(fresh);
            });
          }
        })
        .catch(() => {
          // Transient dial failures ride out the next tick.
        });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [assistantId, isPollingUpgrade, t]);

  const latestRelease = releases?.[0];
  const latestVersion = latestRelease?.version ?? null;

  const upgradeAvailable = useMemo(() => {
    if (!latestVersion) {
      return false;
    }
    if (!runtimeVersion) {
      return true;
    }
    const target = parseSemver(latestVersion);
    const current = parseSemver(runtimeVersion);
    if (!target || !current) {
      return latestVersion !== runtimeVersion;
    }
    return compareParsed(target, current) > 0;
  }, [latestVersion, runtimeVersion]);

  const handleUpgrade = async () => {
    setShowConfirmation(false);
    setSuccessMessage(null);
    // No picker: nothing is on screen to honour, so the server resolves
    // latest. That is deliberately not the same as this panel's
    // `latestRelease`, which does not filter `local` pre-release builds.
    setIsUpgrading(true);
    try {
      const result = await createUpgrade(assistantId, {});
      const detail = result.detail;
      const isNoOp = detail?.includes("Already on the latest");
      if (isNoOp && detail !== undefined) {
        // Not a success — nothing actually happened. Surface a warning so
        // the user understands why the modal closed without kicking off
        // an update.
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
      void fetchRuntimeVersion(assistantId).then((fresh) => {
        setRuntimeVersion(fresh);
      });
    } catch {
      toast.error(t("assistantUpgrades.toastUpdateFailed"));
    } finally {
      setIsUpgrading(false);
    }
  };

  function releaseLabel(
    release: ReleaseListItem,
    currentVersion: string | null | undefined,
  ): string {
    const parts = [release.version];
    if (latestVersion && release.version === latestVersion) {
      parts.push(t("assistantUpgrades.latestSuffix"));
    }
    if (currentVersion && release.version === currentVersion) {
      parts.push(t("assistantUpgrades.currentSuffix"));
    }
    return parts.join(" ");
  }

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
          <CurrentVersionValue version={runtimeVersion} />
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
                    ? releaseLabel(latestRelease, runtimeVersion)
                    : "—"}
                </span>
              ) : (
                t("assistantUpgrades.noReleases")
              )}
            </span>
            <Button
              variant="primary"
              className="min-w-[160px] shrink-0"
              loading={isUpgrading || isPollingUpgrade}
              leftIcon={<RefreshCw />}
              onClick={() => setShowConfirmation(true)}
              disabled={
                !upgradeAvailable ||
                isUpgrading ||
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

      {!upgradeAvailable && runtimeVersion && !releasesLoading && (
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
        onConfirm={() => void handleUpgrade()}
        onCancel={() => setShowConfirmation(false)}
      />
    </div>
  );
}
