/**
 * Feedback for the standalone shell and Doctor panel. The cloud endpoint
 * accepts either the Doctor transcript or opt-in redacted desktop logs
 * as the multipart `logs_file` attachment.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "@mycadet/design-library/components/button";
import { useTranslation } from "@app/i18n";
import { postCloudForm } from "@app/lib/cloud/request";
import { getElectronBridge } from "@app/runtime/electron-bridge";

import type { FeedbackReason } from "./doctor-feedback-types";

type ReasonKey =
  | "shareFeedbackModal.reasonBugReport"
  | "shareFeedbackModal.reasonFeatureRequest"
  | "shareFeedbackModal.reasonOther";
type PlaceholderKey =
  | "shareFeedbackModal.messagePlaceholderBug"
  | "shareFeedbackModal.messagePlaceholderFeature"
  | "shareFeedbackModal.messagePlaceholderOther";

const REASON_OPTIONS: {
  value: FeedbackReason;
  labelKey: ReasonKey;
  placeholderKey: PlaceholderKey;
}[] = [
  {
    value: "bug_report",
    labelKey: "shareFeedbackModal.reasonBugReport",
    placeholderKey: "shareFeedbackModal.messagePlaceholderBug",
  },
  {
    value: "feature_request",
    labelKey: "shareFeedbackModal.reasonFeatureRequest",
    placeholderKey: "shareFeedbackModal.messagePlaceholderFeature",
  },
  {
    value: "other",
    labelKey: "shareFeedbackModal.reasonOther",
    placeholderKey: "shareFeedbackModal.messagePlaceholderOther",
  },
];

export interface DoctorFeedbackModalProps {
  open: boolean;
  onClose: () => void;
  initialReason?: FeedbackReason;
  initialMessage?: string;
  onSubmitted?: () => void;
  client?: "web" | "electron";
  /** The doctor session the report is about, if one is active. */
  doctorSessionId?: string | null;
  /** The session transcript, attached to the report when present. */
  doctorSessionLog?: string | null;
}

export function DoctorFeedbackModal({
  open,
  onClose,
  initialReason,
  initialMessage,
  onSubmitted,
  client = "web",
  doctorSessionId,
  doctorSessionLog,
}: DoctorFeedbackModalProps) {
  const { t } = useTranslation("doctor");
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const [selectedReason, setSelectedReason] = useState<FeedbackReason>(
    initialReason ?? "bug_report",
  );
  const [message, setMessage] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [includeDesktopLogs, setIncludeDesktopLogs] = useState(false);
  const includeSessionLog = !!doctorSessionLog?.trim();
  const desktopFeedback =
    client === "electron" ? getElectronBridge()?.feedback : undefined;

  useEffect(() => {
    if (!open) {
      return;
    }
    setSelectedReason(initialReason ?? "bug_report");
    setMessage(initialMessage ?? "");
    setSubmitError(null);
    setIsSubmitting(false);
    setIncludeDesktopLogs(false);
    const focus = setTimeout(() => messageRef.current?.focus(), 50);
    return () => clearTimeout(focus);
  }, [open, initialReason, initialMessage]);

  if (!open) {
    return null;
  }

  const canSend = message.trim().length > 0;

  const handleSubmit = async () => {
    if (!canSend || isSubmitting) {
      return;
    }
    setSubmitError(null);
    setIsSubmitting(true);
    try {
      const form = new FormData();
      form.append("message", message.trim());
      form.append("classification", selectedReason);
      form.append("client", client);
      if (doctorSessionId) {
        form.append("doctor_session_id", doctorSessionId);
      }
      if (includeSessionLog) {
        const log = new Blob([doctorSessionLog ?? ""], {
          type: "text/plain",
        });
        form.append("logs_file", log, "doctor-session.txt");
      } else if (includeDesktopLogs && desktopFeedback) {
        const logs = await desktopFeedback.logs();
        if (logs) {
          const log = new Blob([logs.slice(-2_000_000)], { type: "text/plain" });
          form.append("logs_file", log, "cadet.log");
        }
      }
      const result = await postCloudForm("/v1/feedback/", form);
      if (!result.ok) {
        setSubmitError(result.error.detail);
        return;
      }
      onSubmitted?.();
      onClose();
    } catch {
      setSubmitError(
        t("shareFeedbackModal.desktopLogsFailed", {
          defaultValue:
            "Couldn’t collect desktop logs. Try again or submit without diagnostics.",
        }),
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("shareFeedbackModal.title")}
        className="flex w-full max-w-lg flex-col gap-4 rounded-xl border border-[var(--border-base)] bg-[var(--surface-raised)] p-6 shadow-xl"
      >
        <h2
          id="doctor-feedback-title"
          className="text-title-small text-[var(--content-default)]"
        >
          {t("shareFeedbackModal.title")}
        </h2>

        <div className="flex flex-col gap-2">
          {REASON_OPTIONS.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer items-center gap-2 text-body-medium text-[var(--content-default)]"
            >
              <input
                type="radio"
                name="doctor-feedback-reason"
                value={option.value}
                checked={selectedReason === option.value}
                onChange={() => setSelectedReason(option.value)}
              />
              {t(option.labelKey)}
            </label>
          ))}
        </div>

        <textarea
          ref={messageRef}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={t(
            REASON_OPTIONS.find((option) => option.value === selectedReason)
              ?.placeholderKey ?? "shareFeedbackModal.messagePlaceholderOther",
          )}
          rows={5}
          className="w-full resize-y rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] p-3 text-body-medium text-[var(--content-default)]"
        />

        {includeSessionLog && (
          <p className="text-body-small-lighter text-[var(--content-tertiary)]">
            {t("shareFeedbackModal.doctorSessionAttached")}
          </p>
        )}
        {desktopFeedback && !includeSessionLog && (
          <label className="flex items-center gap-2 text-body-medium">
            <input
              type="checkbox"
              checked={includeDesktopLogs}
              onChange={(event) => setIncludeDesktopLogs(event.target.checked)}
            />
            {t("shareFeedbackModal.includeDiagnostics")}
          </label>
        )}

        {submitError && (
          <p className="text-body-small text-[var(--system-negative-strong)]">
            {submitError}
          </p>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("shareFeedbackModal.cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!canSend || isSubmitting}
          >
            {t("shareFeedbackModal.submit")}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
