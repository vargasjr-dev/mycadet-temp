import {
  ArrowLeft,
  CheckCircle2,
  Circle,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { AccountShell } from "@app/components/account/account-shell";
import { SETUP_NAVIGATE } from "@app/domains/onboarding/onboarding-navigation";
import { assistantSelectionState } from "@app/assistant/assistant-selection";
import { routes } from "@app/utils/routes";
import { useTranslation } from "@app/i18n";
import { formatSize } from "@mycadet/local-mode";
import type {
  VellumMigrationConfirmInfo,
  VellumMigrationProbe,
  VellumMigrationRunState,
  VellumMigrationStepEvent,
} from "@mycadet/ipc-contract";
import { Button } from "@mycadet/design-library/components/button";

type Phase = "preparing" | "consent" | "running" | "done" | "failed";

interface StepRow {
  key: string;
  name: string;
  status: "pending" | "running" | "completed" | "skipped" | "failed";
  summary?: string;
  warning?: string;
}

/**
 * The vellum → cadet migration's consent + run screen
 */
export function VellumMigrationScreen() {
  const { t } = useTranslation("account");
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("preparing");
  const [info, setInfo] = useState<VellumMigrationConfirmInfo | null>(null);
  const [neverAgain, setNeverAgain] = useState(false);
  const [steps, setSteps] = useState<StepRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const offerRef = useRef<VellumMigrationProbe | null>(null);

  useEffect(() => {
    let disposed = false;
    const bridge = window.cadet?.vellumMigration;
    if (!bridge) {
      // No bridge (web build, or an old shell): nothing to migrate with.
      setError(t("vellumMigration.unavailable"));
      setPhase("failed");
      return;
    }
    bridge
      .get()
      .then((probe) => {
        if (disposed) return;
        offerRef.current = probe;
        if (probe.status !== "offer") {
          setError(t("vellumMigration.nothingFound"));
          setPhase("failed");
          return;
        }
        return bridge.prepare().then((confirmInfo) => {
          if (disposed) return;
          if (!confirmInfo) {
            setError(t("vellumMigration.nothingFound"));
            setPhase("failed");
            return;
          }
          setInfo(confirmInfo);
          setPhase("consent");
        });
      })
      .catch(() => {
        if (disposed) return;
        setError(t("vellumMigration.unavailable"));
        setPhase("failed");
      });
    return () => {
      disposed = true;
    };
  }, [t]);

  const onStep = (event: VellumMigrationStepEvent) => {
    setSteps((prev) => {
      const next = [...prev];
      if (event.kind === "start") {
        next.push({
          key: `${event.step}:${next.length}`,
          name: event.step,
          status: "running",
        });
      } else if (event.kind === "done") {
        const idx = next.length - 1;
        if (idx >= 0 && next[idx].name === event.step) {
          next[idx] = {
            ...next[idx],
            status:
              event.status === "completed"
                ? "completed"
                : event.status === "skipped"
                  ? "skipped"
                  : "failed",
            summary: event.summary,
            warning: event.issues.find((i) => i.severity === "warning")
              ?.message,
          };
        }
      } else {
        const idx = next.length - 1;
        if (idx >= 0 && next[idx].name === event.step) {
          next[idx] = { ...next[idx], summary: describeItem(event) };
        }
      }
      return next;
    });
  };

  const onState = (state: VellumMigrationRunState) => {
    if (state.state === "done") {
      setPhase("done");
      // Land the user in their migrated assistant (the chooser's selection
      // convention — history state survives refresh).
      const handle =
        offerRef.current?.status === "offer"
          ? offerRef.current.assistantHandles[0]
          : undefined;
      window.setTimeout(() => {
        void navigate(
          routes.assistant,
          handle
            ? { ...SETUP_NAVIGATE, state: assistantSelectionState(handle) }
            : SETUP_NAVIGATE,
        );
      }, 1200);
    } else if (state.state === "failed") {
      setError(state.error ?? t("vellumMigration.runFailed"));
      setPhase("failed");
    }
  };

  const begin = () => {
    const bridge = window.cadet?.vellumMigration;
    if (!bridge) return;
    setPhase("running");
    void bridge.start().then(onState);
  };

  const decline = () => {
    const bridge = window.cadet?.vellumMigration;
    void bridge?.decline({ neverAgain });
    void navigate(routes.assistant, SETUP_NAVIGATE);
  };

  return (
    <AccountShell>
      <div className="flex w-full flex-col items-center text-center text-[var(--content-default)]">
        {phase === "preparing" && (
          <>
            <Loader2 className="h-6 w-6 animate-spin" />
            <p className="mt-4 text-body-medium-lighter text-[var(--content-tertiary)]">
              {t("vellumMigration.preparing")}
            </p>
          </>
        )}

        {phase === "consent" && info && (
          <>
            <h1 className="text-3xl font-semibold tracking-tight">
              {t("vellumMigration.title")}
            </h1>
            <p className="mt-3 max-w-md text-body-medium-lighter text-[var(--content-tertiary)]">
              {t("vellumMigration.body", {
                count: info.assistants.length,
                size: formatSize(info.rootSizeBytes),
              })}
            </p>
            <ul className="mt-6 w-full max-w-md space-y-1 text-left">
              {info.assistants.map((a) => (
                <li
                  key={a.name}
                  className="rounded-lg border border-[var(--border-base)] bg-[var(--surface-lift)]/60 p-3 text-body-medium-default"
                >
                  {a.name}
                </li>
              ))}
            </ul>
            <p className="mt-4 text-label-medium-default text-[var(--content-tertiary)]">
              {t("vellumMigration.sleepNote")}
            </p>
            <label className="mt-6 flex items-center gap-2 text-body-medium-default">
              <input
                type="checkbox"
                checked={neverAgain}
                onChange={(e) => setNeverAgain(e.target.checked)}
              />
              {t("vellumMigration.neverAgain")}
            </label>
            <div className="mt-8 w-full max-w-md">
              <Button variant="primary" size="large" fullWidth onClick={begin}>
                {t("vellumMigration.begin")}
              </Button>
            </div>
            <div className="mt-3">
              <Button
                variant="ghost"
                size="compact"
                className="text-[var(--content-tertiary)]"
                leftIcon={<ArrowLeft />}
                onClick={decline}
              >
                {t("vellumMigration.notNow")}
              </Button>
            </div>
          </>
        )}

        {(phase === "running" || phase === "done") && (
          <>
            <h1 className="text-3xl font-semibold tracking-tight">
              {phase === "done"
                ? t("vellumMigration.doneTitle")
                : t("vellumMigration.runningTitle")}
            </h1>
            <ul className="mt-6 w-full max-w-md space-y-2 text-left">
              {steps.map((row) => (
                <li key={row.key} className="flex items-start gap-2">
                  {row.status === "running" ? (
                    <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-[var(--content-tertiary)]" />
                  ) : row.status === "completed" ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--primary-base)]" />
                  ) : row.status === "failed" ? (
                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning-base)]" />
                  ) : (
                    <Circle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--content-tertiary)]" />
                  )}
                  <span className="min-w-0 text-body-medium-default">
                    {row.summary ?? row.name}
                    {row.warning ? (
                      <span className="block text-label-medium-default text-[var(--content-tertiary)]">
                        {row.warning}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        {phase === "failed" && (
          <>
            <h1 className="text-3xl font-semibold tracking-tight">
              {t("vellumMigration.failedTitle")}
            </h1>
            <p className="mt-3 text-body-medium-lighter text-[var(--content-tertiary)]">
              {error}
            </p>
            <div className="mt-8">
              <Button
                variant="ghost"
                size="compact"
                leftIcon={<ArrowLeft />}
                onClick={() => void navigate(routes.assistant, SETUP_NAVIGATE)}
              >
                {t("actions.back")}
              </Button>
            </div>
          </>
        )}
      </div>
    </AccountShell>
  );
}

function describeItem(
  event: Extract<VellumMigrationStepEvent, { kind: "item" }>,
): string {
  const { item } = event;
  if (item.status === "progress" && item.progress) {
    const { bytes, totalBytes } = item.progress;
    const soFar = formatSize(bytes);
    return totalBytes ? `${soFar} / ${formatSize(totalBytes)}` : soFar;
  }
  return item.summary ? `${item.name} — ${item.summary}` : item.name;
}
