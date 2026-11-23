import {
  ShareFeedbackModal,
  type FeedbackReport,
  type FeedbackTimeRange,
} from "./share-feedback-modal";
import { Trans, useTranslation } from "@app/i18n";
import { postCloudForm } from "@app/lib/cloud/request";
import { getElectronBridge } from "@app/runtime/electron-bridge";

const LOG_WINDOW_MS = {
  past_hour: 60 * 60 * 1000,
  past_24_hours: 24 * 60 * 60 * 1000,
};

function filterLogs(logs: string, range: FeedbackTimeRange): string {
  if (range === "all_time") return logs;
  const cutoff = new Date(Date.now() - LOG_WINDOW_MS[range]);
  const localCutoff = new Date(
    cutoff.getTime() - cutoff.getTimezoneOffset() * 60_000,
  )
    .toISOString()
    .replace("T", " ")
    .slice(0, 23);
  let withinRange = false;
  return logs
    .split("\n")
    .filter((line) => {
      const timestamp = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})\]/.exec(
        line,
      )?.[1];
      if (timestamp) withinRange = timestamp >= localCutoff;
      return withinRange;
    })
    .join("\n");
}

async function collectDiagnostics(
  range: FeedbackTimeRange,
): Promise<File | null> {
  const bridge = getElectronBridge()?.feedback;
  if (!bridge) return null;
  const [logs, diagnostics] = await Promise.all([
    bridge.logs(),
    bridge.diagnostics().catch(() => null),
  ]);
  return new File(
    [
      JSON.stringify(diagnostics, null, 2),
      "\n\n",
      filterLogs(logs, range).slice(-2_000_000),
    ],
    "cadet-desktop-diagnostics.txt",
    { type: "text/plain" },
  );
}

async function submit({
  message,
  classification,
  logsFile,
  attachments,
}: FeedbackReport) {
  const form = new FormData();
  form.set("message", message);
  form.set("classification", classification);
  form.set("client", "electron");
  const versionInfo = await getElectronBridge()
    ?.app?.versionInfo()
    .catch(() => null);
  if (versionInfo?.version) form.set("client_version", versionInfo.version);
  if (logsFile) form.set("logs_file", logsFile);
  for (const file of attachments) form.append("attachments", file);
  const result = await postCloudForm("/v1/feedback/", form);
  if (!result.ok) throw new Error(result.error.detail);
}

async function saveDiagnostics(file: File) {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DesktopShareFeedback({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation("common");
  return (
    <ShareFeedbackModal
      open={open}
      onClose={onClose}
      t={t}
      bugTip={
        <Trans
          ns="common"
          i18nKey="shareFeedbackModal.bugTip"
          components={{
            discordLink: (
              <a
                className="underline"
                href="https://mycadet.ai/community"
                target="_blank"
                rel="noreferrer"
              />
            ),
          }}
        />
      }
      featureTip={
        <Trans
          ns="common"
          i18nKey="shareFeedbackModal.featureTip"
          components={{
            roadmapLink: (
              <a
                className="underline"
                href="https://mycadet.ai/roadmap"
                target="_blank"
                rel="noreferrer"
              />
            ),
          }}
        />
      }
      collectDiagnostics={collectDiagnostics}
      submit={submit}
      saveDiagnostics={saveDiagnostics}
    />
  );
}
