import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import {
  getAssistantHealth,
  type AssistantHealth,
} from "@app/domains/account/assistants/assistants-management-api";
import { useTranslation } from "@app/i18n";

const POLL_INTERVAL_MS = 30_000;

/**
 * The health marker for one assistant on the account's assistants-management
 * page: polls the same health checks the cloud admin console's infra tab
 * shows (row status, node GCP state, the vm gateway probe) through the
 * operator-proxied scoped dial, and renders a single honest dot — green
 * when every check passes, red with the failing check's detail otherwise.
 */
export function AssistantHealthBadge({ assistantId }: { assistantId: string }) {
  const { t } = useTranslation("account");
  const [health, setHealth] = useState<AssistantHealth | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void getAssistantHealth(assistantId)
        .then((result) => {
          if (cancelled) return;
          if (result.ok) {
            setHealth(result.data);
            setFailed(false);
          } else {
            setFailed(true);
          }
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    };
    load();
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [assistantId]);

  if (failed) {
    return (
      <span className="inline-flex items-center gap-1.5 text-body-medium-lighter text-[var(--content-tertiary)]">
        <span className="h-2 w-2 rounded-full bg-[var(--content-tertiary)]" />
        {t("assistantsPage.healthUnknown")}
      </span>
    );
  }
  if (health === null) {
    return (
      <span className="inline-flex items-center gap-1.5 text-body-medium-lighter text-[var(--content-tertiary)]">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t("assistantsPage.healthChecking")}
      </span>
    );
  }
  const failing = health.checks.find((check) => !check.ok);
  return (
    <span
      className="inline-flex items-center gap-1.5 text-body-medium-lighter text-[var(--content-default)]"
      title={
        health.checks.map((check) => `${check.name}: ${check.detail}`).join("\n")
      }
    >
      <span
        className={`h-2 w-2 rounded-full ${health.ok ? "bg-[var(--system-positive-strong)]" : "bg-[var(--system-negative-strong)]"}`}
      />
      {health.ok
        ? t("assistantsPage.healthHealthy")
        : t("assistantsPage.healthUnhealthy", { detail: failing?.detail ?? "" })}
    </span>
  );
}
