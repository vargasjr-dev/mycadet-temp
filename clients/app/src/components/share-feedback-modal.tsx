import {
  Bug,
  Download,
  Info,
  Lightbulb,
  Loader2,
  type LucideIcon,
  MessageCircle,
  Paperclip,
  Send,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { Button } from "@mycadet/design-library/components/button";
import {
  Select,
  type SelectOption,
} from "@mycadet/design-library/components/select";
import { Textarea } from "@mycadet/design-library/components/input";
import { Notice } from "@mycadet/design-library/components/notice";
import { Toggle } from "@mycadet/design-library/components/toggle";
import { useBodyScrollLock } from "./feedback-scroll-lock";
import type common from "../i18n/locales/en/common.json";

export type FeedbackReason = "bug_report" | "feature_request" | "other";
export type FeedbackTimeRange = "past_hour" | "past_24_hours" | "all_time";
type TranslateFeedback = (
  key: `shareFeedbackModal.${keyof typeof common.shareFeedbackModal}`,
  options?: { name: string },
) => string;

export interface FeedbackReport {
  message: string;
  classification: FeedbackReason;
  logsFile: File | null;
  attachments: File[];
}

interface ShareFeedbackModalProps {
  open: boolean;
  onClose: () => void;
  initialReason?: FeedbackReason;
  initialMessage?: string;
  onSubmitted?: () => void;
  t: TranslateFeedback;
  bugTip: React.ReactNode;
  featureTip: React.ReactNode;
  collectDiagnostics(range: FeedbackTimeRange): Promise<File | null>;
  submit(report: FeedbackReport): Promise<void>;
  saveDiagnostics(file: File): Promise<void>;
}

const BACKDROP_CLASS =
  "fixed inset-0 z-50 flex items-center justify-center bg-black/50";

const PANEL_CLASS =
  "mx-4 flex w-full max-w-lg flex-col rounded-xl border p-6 shadow-xl";

const PANEL_STYLE: CSSProperties = {
  backgroundColor: "var(--surface-lift)",
  borderColor: "var(--border-base)",
  maxHeight: "calc(100vh - 2rem)",
};

interface ReasonOption {
  value: FeedbackReason;
  icon: LucideIcon;
}

const REASON_OPTIONS: ReasonOption[] = [
  {
    value: "bug_report",
    icon: Bug,
  },
  {
    value: "feature_request",
    icon: Lightbulb,
  },
  {
    value: "other",
    icon: MessageCircle,
  },
];

const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);
const ALLOWED_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "mp4",
  "mov",
  "webm",
]);
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

function isAllowedFile(file: File): boolean {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return false;
  }
  if (file.type && ALLOWED_MIME_TYPES.has(file.type)) {
    return true;
  }
  if (!file.type) {
    const ext = file.name.split(".").pop()?.toLowerCase();
    return ext ? ALLOWED_EXTENSIONS.has(ext) : false;
  }
  return false;
}

/** Strings at or past this length are candidates for base64 stripping. */
export function ShareFeedbackModal({
  open,
  onClose,
  initialReason,
  initialMessage,
  onSubmitted,
  collectDiagnostics,
  submit,
  saveDiagnostics,
  t,
  bugTip,
  featureTip,
}: ShareFeedbackModalProps) {
  const titleId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);

  const timeRangeOptions: SelectOption<FeedbackTimeRange>[] = useMemo(
    () => [
      {
        value: "past_hour",
        label: t("shareFeedbackModal.timeRangePastHour"),
      },
      {
        value: "past_24_hours",
        label: t("shareFeedbackModal.timeRangePast24Hours"),
      },
      {
        value: "all_time",
        label: t("shareFeedbackModal.timeRangeAllTime"),
      },
    ],
    [t],
  );

  const [selectedReason, setSelectedReason] = useState<FeedbackReason>(
    initialReason ?? "bug_report",
  );
  const [message, setMessage] = useState("");
  const [includeLogs, setIncludeLogs] = useState(false);
  const [logTimeRange, setLogTimeRange] =
    useState<FeedbackTimeRange>("past_hour");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  // Optional: build the diagnostics archive locally and download it
  // instead of submitting feedback (which notifies Slack).
  const [downloadMode, setDownloadMode] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);

  const canSend = message.trim().length > 0;

  useEffect(() => {
    if (!open) {
      return;
    }
    const reason = initialReason ?? "bug_report";
    setSelectedReason(reason);
    setMessage(initialMessage ?? "");
    setIncludeLogs(false);
    setLogTimeRange("past_hour");
    setAttachments([]);
    setDownloadMode(false);
    setSubmitError(null);
    setIsSubmitting(false);
    const t = setTimeout(() => {
      messageRef.current?.focus();
    }, 50);
    return () => clearTimeout(t);
  }, [open]);

  useBodyScrollLock(open);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !isSubmitting) {
        e.preventDefault();
        onClose();
      }
    },
    [onClose, isSubmitting],
  );

  const handleBackdropClick = useCallback(
    (e: MouseEvent) => {
      if (e.target === overlayRef.current && !isSubmitting) {
        onClose();
      }
    },
    [onClose, isSubmitting],
  );

  const addFiles = useCallback((files: File[]) => {
    setAttachments((current) => {
      const remaining = MAX_ATTACHMENTS - current.length;
      if (remaining <= 0) {
        return current;
      }
      const existingKeys = new Set(current.map((f) => `${f.name}:${f.size}`));
      const accepted: File[] = [];
      for (const file of files) {
        if (accepted.length >= remaining) {
          break;
        }
        if (!isAllowedFile(file)) {
          continue;
        }
        const key = `${file.name}:${file.size}`;
        if (existingKeys.has(key)) {
          continue;
        }
        existingKeys.add(key);
        accepted.push(file);
      }
      return accepted.length > 0 ? [...current, ...accepted] : current;
    });
  }, []);

  const onFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      addFiles(Array.from(e.target.files));
    }
    e.target.value = "";
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files?.length) {
      addFiles(Array.from(e.dataTransfer.files));
    }
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.currentTarget === e.target) {
      setIsDragging(false);
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments((current) => current.filter((_, i) => i !== index));
  };

  const handleSubmit = async () => {
    if (!canSend || isSubmitting) {
      return;
    }
    setSubmitError(null);
    setIsSubmitting(true);
    try {
      const logsFile =
        includeLogs && selectedReason !== "feature_request"
          ? await collectDiagnostics(logTimeRange)
          : null;
      await submit({
        message: message.trim(),
        classification: selectedReason,
        logsFile,
        attachments,
      });
      onSubmitted?.();
      onClose();
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : "Failed to submit feedback. Please try again.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  // Build the diagnostics archive client-side and hand it to the browser
  // as a download. No feedback submission and no Slack notification.
  const handleDownload = async () => {
    if (isSubmitting) {
      return;
    }
    setSubmitError(null);
    setIsSubmitting(true);
    try {
      const logsFile = await collectDiagnostics(logTimeRange);
      if (!logsFile) {
        setSubmitError("Diagnostics export isn't supported in this browser.");
        return;
      }
      await saveDiagnostics(logsFile);
      onClose();
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : "Failed to build diagnostics. Please try again.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className={BACKDROP_CLASS}
      onKeyDown={handleKeyDown}
      onClick={handleBackdropClick}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <div className={PANEL_CLASS} style={PANEL_STYLE}>
        <div
          className="flex items-center justify-between border-b pb-4"
          style={{ borderColor: "var(--border-subtle)" }}
        >
          <h2
            id={titleId}
            className="!m-0 text-title-small text-[var(--content-default)]"
          >
            {t("shareFeedbackModal.title")}
          </h2>
          <Button
            variant="ghost"
            iconOnly={<X />}
            onClick={onClose}
            disabled={isSubmitting}
            aria-label={t("shareFeedbackModal.closeAria")}
            tintColor="var(--content-secondary)"
          />
        </div>

        <div
          className={`flex flex-col gap-3.5 overflow-y-auto pt-4 ${isSubmitting ? "pointer-events-none opacity-60" : ""}`}
        >
          <div className="flex flex-col gap-1.5 rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] px-3 py-2.5">
            <label className="flex cursor-pointer items-center gap-3">
              <Toggle
                checked={downloadMode}
                onChange={() => setDownloadMode((v) => !v)}
                aria-label={t("shareFeedbackModal.downloadDiagnosticsAria")}
              />
              <span className="text-body-medium-lighter text-[var(--content-default)]">
                {t("shareFeedbackModal.downloadDiagnostics")}
              </span>
            </label>
          </div>

          {downloadMode ? (
            <div className="flex items-center gap-3">
              <span className="text-body-medium-lighter text-[var(--content-default)]">
                {t("shareFeedbackModal.timeRange")}
              </span>
              <Select
                options={timeRangeOptions}
                value={logTimeRange}
                onChange={setLogTimeRange}
                aria-label={t("shareFeedbackModal.timeRangeAria")}
              />
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <span className="text-body-small-default text-[var(--content-secondary)]">
                  {t("shareFeedbackModal.category")}
                </span>
                <div className="flex gap-2">
                  {REASON_OPTIONS.map((option) => (
                    <ReasonChip
                      key={option.value}
                      t={t}
                      option={option}
                      isSelected={selectedReason === option.value}
                      onSelect={() => setSelectedReason(option.value)}
                    />
                  ))}
                </div>
              </div>

              <hr className="border-[var(--border-subtle)]" />

              {selectedReason === "bug_report" && (
                <Notice tone="info">{bugTip}</Notice>
              )}

              {selectedReason === "feature_request" && (
                <Notice tone="info">{featureTip}</Notice>
              )}

              <Textarea
                id={`${titleId}-message`}
                ref={messageRef}
                label={
                  selectedReason === "bug_report"
                    ? t("shareFeedbackModal.messageLabelBug")
                    : selectedReason === "feature_request"
                      ? t("shareFeedbackModal.messageLabelFeature")
                      : t("shareFeedbackModal.messageLabelOther")
                }
                rows={3}
                placeholder={
                  selectedReason === "bug_report"
                    ? t("shareFeedbackModal.messagePlaceholderBug")
                    : selectedReason === "feature_request"
                      ? t("shareFeedbackModal.messagePlaceholderFeature")
                      : t("shareFeedbackModal.messagePlaceholderOther")
                }
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                fullWidth
              />

              {selectedReason !== "feature_request" && (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <label className="flex cursor-pointer items-center gap-2.5">
                      <Toggle
                        checked={includeLogs}
                        onChange={() => setIncludeLogs((value) => !value)}
                        aria-label={t(
                          "shareFeedbackModal.includeDiagnosticsAria",
                        )}
                      />
                      <span className="text-body-medium-lighter leading-6 text-[var(--content-default)]">
                        {t("shareFeedbackModal.includeDiagnostics")}
                      </span>
                    </label>
                    <Button
                      variant="ghost"
                      size="compact"
                      iconOnly={<Info />}
                      expandOnMobile={false}
                      aria-label={t("shareFeedbackModal.aboutDiagnosticsAria")}
                      tooltip={t("shareFeedbackModal.diagnosticsTooltip")}
                    />
                  </div>
                  {includeLogs && (
                    <Select
                      options={timeRangeOptions}
                      value={logTimeRange}
                      onChange={setLogTimeRange}
                      aria-label={t("shareFeedbackModal.timeRangeAria")}
                    />
                  )}
                </div>
              )}

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-body-small-default text-[var(--content-secondary)]">
                    {t("shareFeedbackModal.attachments")}
                    {attachments.length > 0 && (
                      <span className="text-[var(--content-tertiary)]">
                        {" · "}
                        {attachments.length}/{MAX_ATTACHMENTS}
                      </span>
                    )}
                  </span>
                  <Button
                    variant="outlined"
                    size="compact"
                    leftIcon={<Paperclip />}
                    onClick={() => fileInputRef.current?.click()}
                    disabled={attachments.length >= MAX_ATTACHMENTS}
                  >
                    {t("shareFeedbackModal.addFiles")}
                  </Button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/quicktime,video/webm"
                    onChange={onFileInputChange}
                    className="hidden"
                  />
                </div>
                {attachments.length > 0 && (
                  <div className="flex gap-2 overflow-x-auto">
                    {attachments.map((file, idx) => (
                      <AttachmentThumbnail
                        key={`${file.name}-${idx}`}
                        t={t}
                        file={file}
                        onRemove={() => removeAttachment(idx)}
                      />
                    ))}
                  </div>
                )}
                {isDragging && (
                  <p className="text-body-small-default text-[var(--content-tertiary)]">
                    {t("shareFeedbackModal.dropFiles")}
                  </p>
                )}
              </div>
            </>
          )}

          {submitError && (
            <p className="text-body-medium-lighter text-[var(--system-negative-strong)]">
              {submitError}
            </p>
          )}
        </div>

        <div
          className="mt-4 flex items-center justify-end gap-2 border-t pt-4"
          style={{ borderColor: "var(--border-subtle)" }}
        >
          {isSubmitting ? (
            <span className="inline-flex items-center gap-2 text-body-medium-lighter text-[var(--content-secondary)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              {downloadMode
                ? t("shareFeedbackModal.preparingDiagnostics")
                : t("shareFeedbackModal.sendingFeedback")}
            </span>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                {t("shareFeedbackModal.cancel")}
              </Button>
              {downloadMode ? (
                <Button
                  variant="primary"
                  leftIcon={<Download />}
                  onClick={handleDownload}
                >
                  {t("shareFeedbackModal.downloadDiagnosticsButton")}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  leftIcon={<Send />}
                  onClick={handleSubmit}
                  disabled={!canSend}
                >
                  {t("shareFeedbackModal.submit")}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ReasonChip({
  t,
  option,
  isSelected,
  onSelect,
}: {
  t: TranslateFeedback;
  option: ReasonOption;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const Icon = option.icon;
  const label =
    option.value === "bug_report"
      ? t("shareFeedbackModal.reasonBugReport")
      : option.value === "feature_request"
        ? t("shareFeedbackModal.reasonFeatureRequest")
        : t("shareFeedbackModal.reasonOther");
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={isSelected}
      className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-left transition-colors"
      style={{
        borderColor: isSelected ? "var(--primary-base)" : "var(--border-base)",
        backgroundColor: isSelected
          ? "color-mix(in oklab, var(--primary-base) 10%, transparent)"
          : "transparent",
      }}
    >
      <Icon
        className="h-3.5 w-3.5 shrink-0"
        style={{
          color: isSelected
            ? "var(--primary-base)"
            : "var(--content-secondary)",
        }}
      />
      <span
        className="text-body-small-default"
        style={{
          color: isSelected ? "var(--primary-base)" : "var(--content-default)",
        }}
      >
        {label}
      </span>
    </button>
  );
}

function AttachmentThumbnail({
  t,
  file,
  onRemove,
}: {
  t: TranslateFeedback;
  file: File;
  onRemove: () => void;
}) {
  const isImage = file.type.startsWith("image/");
  const previewUrl = useMemo(
    () => (isImage ? URL.createObjectURL(file) : null),
    [file, isImage],
  );

  useEffect(() => {
    if (!previewUrl) {
      return;
    }
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  return (
    <div
      className="relative flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)]"
      title={file.name}
    >
      {isImage && previewUrl ? (
        <img
          src={previewUrl}
          alt={file.name}
          className="h-full w-full object-cover"
        />
      ) : (
        <Paperclip className="h-5 w-5 text-[var(--content-secondary)]" />
      )}
      <Button
        shape="pill"
        variant="ghost"
        size="compact"
        iconOnly={<X />}
        onClick={onRemove}
        aria-label={t("shareFeedbackModal.removeAttachmentAria", {
          name: file.name,
        })}
        className="absolute top-0.5 right-0.5 h-4 w-4 bg-black/60 text-white hover:bg-black/70"
        tintColor="#fff"
      />
    </div>
  );
}
