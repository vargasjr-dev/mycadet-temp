import { Capacitor } from "@capacitor/core";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  ShareFeedbackModal as FeedbackDialog,
  type FeedbackReport,
  type FeedbackTimeRange as TimeRange,
} from "../../../app/src/components/share-feedback-modal";
import { ExternalAnchor } from "@/components/external-anchor";
import type { ChatDebugEventsApi } from "@/domains/chat/api/debug-api";
import type { ChatDebugApi } from "@/domains/chat/utils/debug-api";
import { logsExportPost } from "@/generated/daemon/sdk.gen";
import type { LogsExportPostData } from "@/generated/daemon/types.gen";
import { buildAssetDiagnosticsSnapshot } from "@/lib/asset-query-diagnostics";
import {
  buildFeedbackForm,
  type FeedbackClient,
  submitFeedbackForm,
} from "@/lib/feedback-api";
import { buildDiagnosticsSnapshot } from "@/lib/diagnostics";
import { isElectron } from "@/runtime/is-electron";
import { saveFile } from "@/runtime/native-file";
import { Trans, useTranslation } from "@/i18n";
import { CADET_COMMUNITY_URL } from "@/utils/external-urls";
import type { FeedbackReason } from "@/components/share-feedback-types";

interface TimeRangeDef {
  value: TimeRange;
  cutoffMs: number | null;
}

const TIME_RANGES: TimeRangeDef[] = [
  { value: "past_hour", cutoffMs: 60 * 60 * 1000 },
  {
    value: "past_24_hours",
    cutoffMs: 24 * 60 * 60 * 1000,
  },
  { value: "all_time", cutoffMs: null },
];

/**
 * Which client this feedback is being sent from.
 */
function getFeedbackClient(): FeedbackClient {
  if (isElectron()) {
    return "electron";
  }
  const platform = Capacitor.getPlatform();
  if (platform === "ios" || platform === "android") {
    return platform;
  }
  return "web";
}

function isFeedbackClientValidationError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "client" in error;
}

type FeedbackDiagnosticsProvider = () => Record<string, unknown> | null;

interface ExtraLogFile {
  filename: string;
  contents: string;
}

interface LogExportWindow {
  startTime: number | null;
  endTime: number;
}

const BULK_BASE64_MIN_CHARS = 8192;

const DATA_URI_RE = /^data:([^;,]+);base64,/i;
const PURE_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Marker (or transformed leaf) to emit in place of `value`, or `null` to
 * leave primitives as-is and descend into objects/arrays.
 */
type CaptureVisitor = (value: unknown) => { replacement: unknown } | null;

/**
 * Depth-first structural map over a diagnostics snapshot.
 *
 * The `path` set holds only the current recursion ancestry, so a true cycle
 * is replaced with `"[cyclic]"` while shared (sibling) references are
 * traversed in full. The capture leans on shared references by construction:
 * transcript items embed the same message objects `clientMessages` lists.
 * JSON.stringify duplicates shared references the same way.
 *
 * Every capture pass (base64 stripping, message deduplication) is a visitor
 * over this one walker, so traversal and cycle handling have a single home.
 */
function deepMapCapture(
  value: unknown,
  visit: CaptureVisitor,
  path = new WeakSet<object>(),
): unknown {
  const hit = visit(value);
  if (hit) {
    return hit.replacement;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (path.has(value)) {
    return "[cyclic]";
  }
  path.add(value);
  let out: unknown;
  if (Array.isArray(value)) {
    out = value.map((v) => deepMapCapture(v, visit, path));
  } else {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      obj[k] = deepMapCapture(v, visit, path);
    }
    out = obj;
  }
  path.delete(value);
  return out;
}

/**
 * Replace bulk binary payloads in a diagnostics snapshot with size markers.
 *
 * Message state carries image bytes in two shapes: `data:` URIs (derived
 * preview URLs) and long raw base64 fields (inline attachment data). Neither
 * is diagnostic signal, and a handful of photos otherwise dominates the
 * bundle the cloud accepts. Matching is content-based, not field-name
 * based, so any future field that carries a data URI or a long pure-base64
 * string is stripped too. Prose is never touched: text with spaces or
 * punctuation fails the base64 test, and short strings (ids, hashes,
 * tokens) are below the length floor. The marker keeps the mime type and
 * length, which is the diagnostically useful part.
 */
export function stripBulkBase64(value: unknown): unknown {
  return deepMapCapture(value, (v) => {
    if (typeof v !== "string") {
      return null;
    }
    const dataUri = DATA_URI_RE.exec(v);
    if (dataUri) {
      return {
        replacement: `[stripped data URI ${dataUri[1]}, ${v.length} chars]`,
      };
    }
    if (v.length >= BULK_BASE64_MIN_CHARS && PURE_BASE64_RE.test(v)) {
      return { replacement: `[stripped base64, ${v.length} chars]` };
    }
    return null;
  });
}

/**
 * Replace transcript-item message objects that are identical (by reference)
 * to a `clientMessages` entry with a pointer marker, so the capture carries
 * each message once. Matching is object identity, which is exactly how the
 * duplication arises: transcript items embed the same `DisplayMessage`
 * instances `clientMessages` lists. A structurally-equal copy is not
 * identity-matched and is captured in full, so any divergence between the
 * two surfaces survives; only true duplicates collapse.
 */
export function dedupeAgainstClientMessages(
  transcriptItems: unknown,
  clientMessages: unknown,
): unknown {
  if (!Array.isArray(clientMessages)) {
    return transcriptItems;
  }
  const refs = new Map<object, string>();
  clientMessages.forEach((m, i) => {
    if (m && typeof m === "object") {
      const id = (m as { id?: unknown }).id;
      refs.set(m, typeof id === "string" ? id : `index ${i}`);
    }
  });

  return deepMapCapture(transcriptItems, (v) => {
    if (v === null || typeof v !== "object") {
      return null;
    }
    const ref = refs.get(v);
    return ref !== undefined
      ? { replacement: `[deduplicated: see clientMessages ${ref}]` }
      : null;
  });
}

function buildTarEntry(filename: string, data: Uint8Array): Uint8Array {
  const blockSize = 512;
  const dataBlocks = Math.ceil(data.length / blockSize);
  const buffer = new Uint8Array(blockSize + dataBlocks * blockSize);
  const encoder = new TextEncoder();

  const writeAscii = (text: string, offset: number, length: number) => {
    const bytes = encoder.encode(text);
    buffer.set(bytes.slice(0, length), offset);
  };
  const writeOctal = (num: number, offset: number, length: number) => {
    const text = num.toString(8).padStart(length - 1, "0");
    writeAscii(text + "\0", offset, length);
  };

  writeAscii(filename, 0, 100);
  writeOctal(0o644, 100, 8);
  writeOctal(0, 108, 8);
  writeOctal(0, 116, 8);
  writeOctal(data.length, 124, 12);
  writeOctal(Math.floor(Date.now() / 1000), 136, 12);
  for (let i = 148; i < 156; i++) {
    buffer[i] = 0x20;
  }
  buffer[156] = 0x30;
  writeAscii("ustar\0", 257, 6);
  writeAscii("00", 263, 2);

  let checksum = 0;
  for (let i = 0; i < blockSize; i++) {
    checksum += buffer[i]!;
  }
  writeOctal(checksum, 148, 7);
  buffer[155] = 0x20;

  buffer.set(data, blockSize);
  return buffer;
}

async function fetchPlatformLogs(
  assistantId: string,
  opts: {
    window: LogExportWindow;
    activeConversationId?: string | null;
  },
): Promise<Uint8Array | null> {
  try {
    const body: LogsExportPostData["body"] = {};
    if (opts.window.startTime != null) {
      body.startTime = opts.window.startTime;
      body.endTime = opts.window.endTime;
    }
    // Forward the active conversation key as `conversationId` so the backend
    // can scope the export to messages / LLM request logs / usage events /
    // tool invocations for that conversation. The backend accepts any
    // non-empty string here — conversation keys take many shapes
    // (e.g. `slack-thread:C123:1700000000.000000`), so we deliberately do
    // NOT gate on UUID format.
    if (opts.activeConversationId) {
      body.conversationId = opts.activeConversationId;
    }
    const { data, error } = await logsExportPost({
      path: { assistant_id: assistantId },
      body,
      parseAs: "blob",
      throwOnError: false,
    });
    if (error || !(data instanceof Blob)) {
      return null;
    }
    const buf = await data.arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

/**
 * Native shell identity, or `null` off a Capacitor shell.
 *
 * Pins which store/TestFlight build hosted this report. It also settles native
 * shell versus home-screen PWA, which the user agent cannot: `WKWebView` drops
 * the `Version/` and `Safari/` tokens in both cases, so the two are
 * indistinguishable from the UA string alone.
 *
 * `@capacitor/app` is a plugin Proxy, so it is destructured inline per
 * `docs/CAPACITOR.md` § "Capacitor plugins must be destructured inline".
 */
async function collectNativeAppInfo(): Promise<Record<string, unknown> | null> {
  if (!Capacitor.isNativePlatform()) {
    return null;
  }
  try {
    const { App } = await import("@capacitor/app");
    const { id, name, version, build } = await App.getInfo();
    return { id, name, version, build };
  } catch {
    // Diagnostics are best-effort and must never block a support submission.
    return null;
  }
}

async function buildClientLogsFile(
  timeRange: TimeRange,
  assistantId: string | null,
  activeConversationId: string | null,
  options: {
    diagnosticsProvider?: FeedbackDiagnosticsProvider;
    doctorSessionId?: string | null;
    extraLogFiles?: readonly ExtraLogFile[];
    queryClient?: QueryClient;
  } = {},
): Promise<File | null> {
  if (typeof CompressionStream === "undefined") {
    return null;
  }
  const { diagnosticsProvider, doctorSessionId, extraLogFiles = [] } = options;
  const now = new Date();
  const range = TIME_RANGES.find((t) => t.value === timeRange);
  const endTime = now.getTime();
  const startTime = range?.cutoffMs != null ? endTime - range.cutoffMs : null;
  const cutoff = startTime != null ? new Date(startTime).toISOString() : null;
  let currentChatState: Record<string, unknown> | null = null;
  try {
    currentChatState = diagnosticsProvider?.() ?? null;
  } catch {
    currentChatState = null;
  }
  const chatDiagnostics = buildDiagnosticsSnapshot(currentChatState);
  const payload = {
    collected_at: now.toISOString(),
    time_range: timeRange,
    cutoff,
    log_window: {
      start_time_ms: startTime,
      end_time_ms: endTime,
    },
    assistant_id: assistantId,
    active_conversation_id: activeConversationId,
    doctor_session_id: doctorSessionId ?? null,
    // Which web bundle produced this report. The archive already carries the
    // assistant's version, but the two ship on entirely separate cadences: the
    // native shells load this bundle over the network at runtime, so a report
    // can pair an arbitrarily new assistant with an arbitrarily old (or cached)
    // client, and without this there is no way to tell which client fix was
    // actually present.
    client_version: import.meta.env.VITE_APP_VERSION ?? null,
    native_app: await collectNativeAppInfo(),
    user_agent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    language: typeof navigator !== "undefined" ? navigator.language : "",
    platform: typeof navigator !== "undefined" ? navigator.platform : "",
    url: typeof window !== "undefined" ? window.location.href : "",
    viewport:
      typeof window !== "undefined"
        ? { width: window.innerWidth, height: window.innerHeight }
        : null,
    screen:
      typeof screen !== "undefined"
        ? { width: screen.width, height: screen.height }
        : null,
    connection:
      typeof navigator !== "undefined" && "connection" in navigator
        ? {
            effectiveType: (navigator.connection as { effectiveType?: string })
              .effectiveType,
            downlink: (navigator.connection as { downlink?: number }).downlink,
            rtt: (navigator.connection as { rtt?: number }).rtt,
          }
        : null,
    deviceMemory:
      typeof navigator !== "undefined" && "deviceMemory" in navigator
        ? (navigator as { deviceMemory?: number }).deviceMemory
        : null,
    hardwareConcurrency:
      typeof navigator !== "undefined" ? navigator.hardwareConcurrency : null,
  };
  const encoder = new TextEncoder();
  const contextBytes = encoder.encode(JSON.stringify(payload, null, 2));
  const diagnosticsBytes = encoder.encode(
    JSON.stringify(chatDiagnostics, null, 2),
  );
  const tarParts: Uint8Array[] = [
    buildTarEntry("web-client-context.json", contextBytes),
    buildTarEntry("web-chat-diagnostics.json", diagnosticsBytes),
  ];
  if (options.queryClient) {
    try {
      tarParts.push(
        buildTarEntry(
          "web-asset-diagnostics.json",
          encoder.encode(
            JSON.stringify(
              buildAssetDiagnosticsSnapshot(options.queryClient),
              null,
              2,
            ),
          ),
        ),
      );
    } catch {
      // A diagnostic snapshot must never block a support submission.
    }
  }

  for (const file of extraLogFiles) {
    const contents = file.contents.trim();
    if (contents) {
      tarParts.push(buildTarEntry(file.filename, encoder.encode(contents)));
    }
  }

  // Capture the live chat debug API state for indicator-stuck and
  // stuck-prompt reports. This is a separate file so support can diff it
  // against the main diagnostics snapshot without cross-contamination.
  try {
    const debugApi =
      typeof window !== "undefined"
        ? (window as unknown as { _cadetDebug?: { chat?: ChatDebugApi } })
            ._cadetDebug?.chat
        : null;
    if (debugApi) {
      const clientMessages = debugApi.getClientMessages?.() ?? null;
      const transcriptItems = debugApi.getTranscriptItems?.() ?? null;
      const triagePayload = {
        clientMessages,
        // Transcript items embed the same message objects `clientMessages`
        // lists; carry the item-layer structure (kinds, keys, ordering) with
        // pointers instead of a second full copy of every message.
        transcriptItems: dedupeAgainstClientMessages(
          transcriptItems,
          clientMessages,
        ),
        // Ephemeral interaction prompts (secret / confirmation /
        // contact-request / question) render as transcript trailer rows
        // outside any message's `contentBlocks`, so they're invisible in
        // `clientMessages`/`transcriptItems` payloads above. Capture the
        // interaction-store snapshot to triage stuck-prompt reports. Carries
        // prompt metadata only — never the entered secret value.
        pendingInteractions: debugApi.listPendingInteractions?.() ?? null,
        thinkingIndicator: debugApi.thinkingIndicator?.() ?? null,
        streamingRing: debugApi.streamingRing?.() ?? null,
        reconciliationDiagnostics:
          debugApi.getReconciliationDiagnostics?.() ?? null,
      };
      // Message state embeds attachment previews as data URIs and inline
      // base64; strip them to size markers so the capture scales with the
      // conversation's text, not its images.
      const triageBytes = new TextEncoder().encode(
        JSON.stringify(stripBulkBase64(triagePayload), null, 2),
      );
      tarParts.push(
        buildTarEntry("web-chat-debug-api-triage.json", triageBytes),
      );
    }
  } catch {
    // Debug API is best-effort; if it's missing or throws, don't block the
    // feedback submission. This can happen during SSR, in tests, or if the
    // chat page hasn't mounted the API yet.
  }

  // SSE clients/events + focus/visibility, read through the same live debug
  // API. Per-client traffic ages (no bytes for minutes but never errored)
  // plus a `hasFocus:false` + `visibilityState:"visible"` capture are the
  // fingerprint of the "stale after refocus" report — `visibilitychange`
  // only fires on tab-switch / minimize / full occlusion, not when the
  // browser window merely loses focus to another app.
  try {
    const eventsApi =
      typeof window !== "undefined"
        ? (
            window as unknown as {
              _cadetDebug?: { events?: ChatDebugEventsApi };
            }
          )._cadetDebug?.events
        : null;
    if (eventsApi) {
      const triagePayload = {
        focus:
          typeof document !== "undefined"
            ? {
                hasFocus:
                  typeof document.hasFocus === "function"
                    ? document.hasFocus()
                    : null,
                visibilityState: document.visibilityState,
              }
            : null,
        // `AbortSignal` isn't JSON-serializable, so project it to an
        // `aborted` flag and keep the rest of each client verbatim.
        clients: eventsApi.getClients().map(({ abortSignal, ...rest }) => ({
          ...rest,
          aborted: abortSignal.aborted,
        })),
        events: eventsApi.getEvents(),
      };
      // SSE event payloads can quote message deltas that embed inline
      // base64; the same strip keeps this member text-sized.
      const triageBytes = new TextEncoder().encode(
        JSON.stringify(stripBulkBase64(triagePayload), null, 2),
      );
      tarParts.push(buildTarEntry("web-sse-liveness-triage.json", triageBytes));
    }
  } catch {
    // Debug API is best-effort; if it's missing or throws, don't block the
    // feedback submission. This can happen during SSR, in tests, or if the
    // chat page hasn't mounted the API yet.
  }

  if (isElectron() && window.cadet?.feedback) {
    try {
      const electronDiagnostics = await window.cadet.feedback.diagnostics();
      const diagBytes = new TextEncoder().encode(
        JSON.stringify(electronDiagnostics, null, 2),
      );
      tarParts.push(buildTarEntry("electron-diagnostics.json", diagBytes));
    } catch {
      /* best-effort */
    }

    try {
      const redactedLogs = await window.cadet.feedback.logs();
      if (redactedLogs) {
        const logBytes = new TextEncoder().encode(redactedLogs);
        tarParts.push(buildTarEntry("electron-main-logs.txt", logBytes));
      }
    } catch {
      /* best-effort */
    }
  }

  if (assistantId) {
    const platformLogsData = await fetchPlatformLogs(assistantId, {
      window: { startTime, endTime },
      activeConversationId,
    });
    if (platformLogsData) {
      tarParts.push(buildTarEntry("platform-logs.tar.gz", platformLogsData));
    }
  }

  tarParts.push(new Uint8Array(1024));
  const totalLength = tarParts.reduce((sum, part) => sum + part.length, 0);
  const tarBuffer = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of tarParts) {
    tarBuffer.set(part, offset);
    offset += part.length;
  }
  const tarBlob = new Blob([tarBuffer.buffer]);

  const compressed = await new Response(
    tarBlob.stream().pipeThrough(new CompressionStream("gzip")),
  ).blob();
  return new File([compressed], `web-client-logs-${now.getTime()}.tar.gz`, {
    type: "application/gzip",
  });
}

export interface ShareFeedbackModalProps {
  open: boolean;
  onClose: () => void;
  initialReason?: FeedbackReason;
  initialMessage?: string;
  onSubmitted?: () => void;
  assistantId?: string | null;
  assistantVersion?: string | null;
  activeConversationId?: string | null;
  doctorSessionId?: string | null;
  doctorSessionLog?: string | null;
  getDiagnosticsSnapshot?: FeedbackDiagnosticsProvider;
}

export function ShareFeedbackModal(props: ShareFeedbackModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const {
    assistantId,
    assistantVersion,
    doctorSessionId,
    doctorSessionLog,
    getDiagnosticsSnapshot,
  } = props;

  async function submit({
    message,
    classification,
    logsFile,
    attachments,
  }: FeedbackReport) {
    const client = getFeedbackClient();
    let clientVersion = import.meta.env.VITE_APP_VERSION ?? undefined;
    if (client === "electron") {
      try {
        clientVersion =
          (await window.cadet?.app.versionInfo())?.version ?? clientVersion;
      } catch {
        // Older shells can still report the web bundle version.
      }
    }
    const send = (reportClient: FeedbackClient) =>
      submitFeedbackForm(
        buildFeedbackForm({
          message,
          classification,
          client: reportClient,
          client_version: clientVersion,
          ...(assistantId ? { assistant_id: assistantId } : {}),
          ...(assistantVersion ? { assistant_version: assistantVersion } : {}),
          ...(doctorSessionId ? { doctor_session_id: doctorSessionId } : {}),
          ...(logsFile ? { logs_file: logsFile } : {}),
          ...(attachments.length ? { attachments } : {}),
        }),
      );
    try {
      await send(client);
    } catch (error) {
      if (client !== "android" || !isFeedbackClientValidationError(error))
        throw error;
      await send("web");
    }
  }

  return (
    <FeedbackDialog
      {...props}
      t={t}
      desktop={isElectron()}
      bugTip={
        <Trans
          ns="common"
          i18nKey="shareFeedbackModal.bugTip"
          components={{
            discordLink: (
              <ExternalAnchor
                href={CADET_COMMUNITY_URL}
                tone="quiet"
                className="text-[var(--content-default)]"
                glyph={false}
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
              <ExternalAnchor
                href="https://mycadet.ai/roadmap"
                tone="quiet"
                className="text-[var(--content-default)]"
                glyph={false}
              />
            ),
          }}
        />
      }
      collectDiagnostics={(range, conversationId) =>
        buildClientLogsFile(range, assistantId ?? null, conversationId, {
          queryClient,
          doctorSessionId,
          diagnosticsProvider: getDiagnosticsSnapshot,
          extraLogFiles: doctorSessionLog?.trim()
            ? [{ filename: "doctor-session.txt", contents: doctorSessionLog }]
            : [],
        })
      }
      submit={submit}
      saveDiagnostics={(file) => saveFile(file, file.name)}
    />
  );
}
