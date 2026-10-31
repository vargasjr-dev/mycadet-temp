import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { Box, render as inkRender, Text, useInput, useStdout } from "ink";

import { HATCH_ART, HATCHED_EMOJI } from "../lib/constants";
import {
  getAssistantDisplayName,
  lookupAssistantByIdentifier,
  type LockfileAssistant,
} from "../lib/assistant-config";
import { checkHealth } from "../lib/health-check";
import {
  guardianTokenDueForRenewal,
  loadGuardianToken,
  refreshGuardianToken,
} from "../lib/guardian-token";
import { trustedRefreshUrl } from "../lib/runtime-url";
import { getGatewayUrl } from "@mycadet/local-mode/contract";
import { appendHistory, loadHistory } from "../lib/input-history";
import { tuiLog } from "../lib/tui-log";
import {
  calculateHeaderHeight,
  COMPACT_THRESHOLD,
  DEFAULT_TERMINAL_COLUMNS,
  estimateItemHeight,
  formatConfirmationPreview,
  formatHeaderTitle,
  formatTimestamp,
  isRuntimeMessage,
  buildMessageParts,
  formatToolCallPreview,
  stripAnsi,
  truncateValue,
  HELP_COMMANDS,
  LEFT_PANEL_WIDTH,
  RIGHT_PANEL_LINE_COUNT,
  TIPS,
  type ErrorLine,
  type FeedItem,
  type HelpLine,
  type RuntimeMessage,
  type StatusLine,
} from "../lib/default-main-screen-formatting.js";
export {
  formatTimestamp,
  type RuntimeMessage,
} from "../lib/default-main-screen-formatting.js";
import type { ConversationMessageToolCall } from "@mycadet/assistant-api";
import { statusEmoji, withStatusEmoji } from "../lib/status-emoji";
import {
  getTerminalCapabilities,
  unicodeOrFallback,
} from "../lib/terminal-capabilities";
import TextInput from "./TextInput";
import { Tooltip } from "./Tooltip";

export const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
} as const;

/**
 * The completion catalog: the CLI's own commands plus the web client's set
 * (clients/web slash-command-catalog: /commands /compact /clean /models
 * /status /doctor /btw). /clean /commands /models /status resolve through
 * the daemon's meta-command endpoint; /compact and /doctor run as real
 * turns (same as web); /config is CLI-local (runtime config get/set).
 */
export const SLASH_COMMANDS = [
  "/btw",
  "/clean",
  "/clear",
  "/commands",
  "/compact",
  "/config",
  "/doctor",
  "/exit",
  "/help",
  "/models",
  "/q",
  "/quit",
  "/status",
];

/** Commands the daemon resolves via POST /v1/conversations/{id}/slash. */
const DAEMON_META_COMMANDS = new Set([
  "/clean",
  "/commands",
  "/models",
  "/status",
]);

const SEND_TIMEOUT_MS = 5000;
/** Fresh deadline for a request retried after a mid-session token refresh —
 *  the original caller signal may have already timed out during the refresh. */
const RETRY_TIMEOUT_MS = 30_000;

// ── Layout constants ──────────────────────────────────────
const MAX_TOTAL_WIDTH = 72;
const DEFAULT_TERMINAL_ROWS = 24;
// The header opens with a plain full-width rule (no word prefix).

// Left panel structure: HEADER lines + art + FOOTER lines
// Header chrome (borders around panel content)
const HEADER_TOP_BORDER_LINES = 1; // "── Cadet ───..." line

// Selection / Secret windows
const DIALOG_WINDOW_WIDTH = 60;
const DIALOG_TITLE_CHROME = 5; // "┌─ " (3) + " " (1) + "┐" (1)
const DIALOG_BORDER_CORNERS = 2; // └ and ┘
const SELECTION_OPTION_CHROME = 6; // "│ " (2) + marker (1) + " " (1) + padding‐adjust + "│" (1)
const SECRET_CONTENT_CHROME = 4; // "│ " (2) + padding + "│" (1) + adjustment

// Chat area heights
const TOOLTIP_HEIGHT = 3;
const INPUT_AREA_HEIGHT = 4; // separator + input row + separator + hint
const SELECTION_CHROME_LINES = 3; // title bar + bottom border + spacing
const SECRET_INPUT_HEIGHT = 5; // title bar + content row + bottom border + tooltip chrome
const SPINNER_HEIGHT = 1;
const MIN_FEED_ROWS = 3;

interface ListMessagesResponse {
  messages: RuntimeMessage[];
  nextCursor?: string;
}

interface SendMessageResponse {
  accepted: boolean;
  messageId: string;
}

interface AllowlistOption {
  label: string;
  pattern: string;
}

interface ScopeOption {
  label: string;
  scope: string;
}

interface PendingConfirmation {
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  riskLevel: string;
  executionTarget?: "sandbox" | "host";
  allowlistOptions?: AllowlistOption[];
  scopeOptions?: ScopeOption[];
  persistentDecisionsAllowed?: boolean;
}

interface SubmitDecisionResponse {
  accepted: boolean;
}

interface HealthResponse {
  status: string;
  message?: string;
}

/** Extract human-readable message from a daemon JSON error response. */
function friendlyErrorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed?.error?.message) {
      return parsed.error.message;
    }
  } catch {
    // Not JSON — fall through
  }
  return `HTTP ${status}: ${body || "Unknown error"}`;
}

/**
 * On a 401, refresh a stale PAIRED-assistant guardian token and update the
 * shared `auth` headers IN PLACE, returning true if the caller should retry.
 *
 * Scoped to paired assistants only (a remote assistant on another machine,
 * derived from its remote runtimeUrl) — the local/docker TUI flow and platform
 * sessions are left untouched. Also self-gating: skips platform session auth (no `Authorization`
 * header), ephemeral `--token` overrides (whose bearer won't match the store),
 * and access-only tokens. Because the TUI threads one shared `auth` object by
 * reference, mutating it here propagates to every later request and the SSE
 * reconnect — no callback threading needed.
 *
 * SECURITY: the refresh is bound to the paired entry's persisted runtime URL.
 * `cadet client` lets `--url`/`-u` override the runtime URL while still using
 * the selected paired entry's stored guardian token, so a victim pointed at an
 * attacker-controlled (or poisoned/redirected) URL that returns 401 must NOT
 * cause us to POST the long-lived refreshToken + deviceId to that origin. We
 * therefore (a) refuse to refresh unless `baseUrl` normalizes to one of the
 * entry's persisted URLs, and (b) send the refresh to the persisted URL rather
 * than the caller-supplied `baseUrl` — defense in depth if the gate is ever
 * bypassed.
 */
export async function maybeRefreshAuthHeaders(
  baseUrl: string,
  assistantId: string,
  auth?: Record<string, string>,
): Promise<boolean> {
  if (!auth) return false;
  const bearer = auth["Authorization"]?.replace(/^Bearer /, "");
  if (!bearer) return false;

  // The guardian-token lookup below gates what can refresh; refresh
  // mechanics that outgrow the stored refresh token come later.
  const lookup = lookupAssistantByIdentifier(assistantId);
  if (lookup.status !== "found") {
    return false;
  }

  // Bind the refresh origin to the persisted paired entry: refuse (and never
  // leak credentials) if `baseUrl` was overridden via --url or poisoned to an
  // origin that isn't one of the entry's persisted URLs. `refreshUrl` is the
  // trusted persisted URL we actually send to.
  const refreshUrl = trustedRefreshUrl(lookup.entry, baseUrl);
  if (!refreshUrl) return false;

  const stored = loadGuardianToken(assistantId);
  if (!stored || stored.accessToken !== bearer || !stored.refreshToken) {
    return false;
  }
  // Only refresh once the token is actually due for renewal, so a forged 401
  // on a still-valid token can't coax out the long-lived refresh credential.
  if (!guardianTokenDueForRenewal(stored)) return false;
  const refreshed = await refreshGuardianToken(refreshUrl, assistantId);
  if (!refreshed?.accessToken) return false;
  auth["Authorization"] = `Bearer ${refreshed.accessToken}`;
  return true;
}

async function runtimeRequest<T>(
  baseUrl: string,
  assistantId: string,
  path: string,
  init?: RequestInit,
  auth?: Record<string, string>,
): Promise<T> {
  const url = `${baseUrl}/v1/assistants/${assistantId}${path}`;
  const doFetch = (signalOverride?: AbortSignal) =>
    fetch(url, {
      ...init,
      // The retry overrides the caller's signal (see below); otherwise use it.
      signal: signalOverride ?? init?.signal,
      headers: {
        "Content-Type": "application/json",
        ...auth,
        ...(init?.headers as Record<string, string> | undefined),
      },
    });

  let response = await doFetch();
  // Mid-session token expiry → 401: refresh once and retry (auth headers are
  // mutated in place by the helper, so the retry carries the new token). The
  // refresh can take longer than the caller's timeout (lock wait + refresh
  // fetch), which would already have aborted the original signal — so give the
  // retry a fresh deadline instead of reusing the (likely-expired) one.
  if (
    response.status === 401 &&
    (await maybeRefreshAuthHeaders(baseUrl, assistantId, auth))
  ) {
    response = await doFetch(AbortSignal.timeout(RETRY_TIMEOUT_MS));
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(friendlyErrorMessage(response.status, body));
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

interface MetaSlashResponse {
  kind: "clean" | "info";
  text: string;
  contextUsage?: {
    tokens: number;
    maxTokens: number | null;
    fillRatio: number | null;
  };
}

/**
 * Resolve a local meta slash command (/clean, /commands, /models, /status)
 * through the daemon — no turn starts, nothing persists. The CLI addresses
 * its conversation by the client-minted conversation key (a uuid, web's
 * temp-client-id pattern).
 */
async function resolveMetaCommand(
  baseUrl: string,
  assistantId: string,
  conversationKey: string,
  command: string,
  auth?: Record<string, string>,
): Promise<MetaSlashResponse> {
  const url = `${baseUrl}/v1/conversations/${encodeURIComponent(conversationKey)}/slash`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({ command }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(friendlyErrorMessage(response.status, body));
  }
  return response.json() as Promise<MetaSlashResponse>;
}

async function fetchRuntimeConfig(
  baseUrl: string,
  auth?: Record<string, string>,
): Promise<unknown> {
  const url = `${baseUrl}/v1/config`;
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...auth },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(friendlyErrorMessage(response.status, body));
  }
  return response.json();
}

async function setRuntimeConfigValue(
  baseUrl: string,
  path: string,
  value: unknown,
  auth?: Record<string, string>,
): Promise<void> {
  const url = `${baseUrl}/v1/config/set`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({ path, value }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(friendlyErrorMessage(response.status, body));
  }
}

/** Resolve a dotted config path within the fetched config object. */
function resolveConfigPath(config: unknown, dottedPath: string): unknown {
  let current: unknown = config;
  for (const segment of dottedPath.split(".")) {
    if (
      current === null ||
      typeof current !== "object" ||
      !(segment in (current as Record<string, unknown>))
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Parse a /config value: JSON when it parses, plain string otherwise. */
function parseConfigValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function checkHealthRuntime(baseUrl: string): Promise<HealthResponse> {
  const url = `${baseUrl}/healthz`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000);

  const response = await fetch(url, {
    signal: controller.signal,
    headers: { "Content-Type": "application/json" },
  });

  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return response.json() as Promise<HealthResponse>;
}

async function pollMessages(
  baseUrl: string,
  assistantId: string,
  conversationKey: string,
  auth?: Record<string, string>,
): Promise<ListMessagesResponse> {
  const params = new URLSearchParams({ conversationKey });
  const response = await runtimeRequest<ListMessagesResponse>(
    baseUrl,
    assistantId,
    `/messages?${params.toString()}`,
    undefined,
    auth,
  );
  return {
    ...response,
    messages: response.messages.map((msg) => ({
      ...msg,
      contentBlocks: msg.contentBlocks,
    })),
  };
}

async function sendMessage(
  baseUrl: string,
  assistantId: string,
  conversationKey: string,
  content: string,
  signal?: AbortSignal,
  auth?: Record<string, string>,
): Promise<SendMessageResponse> {
  return runtimeRequest<SendMessageResponse>(
    baseUrl,
    assistantId,
    "/messages",
    {
      method: "POST",
      body: JSON.stringify({
        conversationKey,
        content,
        sourceChannel: "cadet",
        interface: "cli",
      }),
      signal,
    },
    auth,
  );
}

async function submitDecision(
  baseUrl: string,
  assistantId: string,
  requestId: string,
  decision: "allow" | "deny",
  auth?: Record<string, string>,
): Promise<SubmitDecisionResponse> {
  return runtimeRequest<SubmitDecisionResponse>(
    baseUrl,
    assistantId,
    "/confirm",
    {
      method: "POST",
      body: JSON.stringify({ requestId, decision }),
    },
    auth,
  );
}

// ── SSE event types ─────────────────────────────────────────────
interface SseEvent {
  type: string;
  text?: string;
  thinking?: string;
  /** identity_changed: the name the assistant adopted in IDENTITY.md. */
  name?: string;
  toolName?: string;
  toolUseId?: string;
  input?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  content?: string;
  chunk?: string;
  message?: string;
  conversationId?: string;
  messageId?: string;
  requestId?: string;
  // confirmation_request fields
  riskLevel?: string;
  riskReason?: string;
  executionTarget?: "sandbox" | "host";
  allowlistOptions?: Array<{
    label: string;
    description: string;
    pattern: string;
  }>;
  scopeOptions?: Array<{ label: string; scope: string }>;
  persistentDecisionsAllowed?: boolean;
  isContainerized?: boolean;
  // secret_request fields
  service?: string;
  field?: string;
  label?: string;
  description?: string;
  placeholder?: string;
  purpose?: string;
  allowOneTimeSend?: boolean;
  allowedTools?: string[];
  allowedDomains?: string[];
  // message_complete fields
  source?: "main" | "aux";
  // sync_changed fields
  tags?: string[];
  [key: string]: unknown;
}

/** One chunk of an in-flight turn: streamed text or a tool invocation. */
type StreamingPart =
  | { kind: "text"; text: string }
  | { kind: "tool"; toolCall: ConversationMessageToolCall };

/**
 * Open an SSE stream to the assistant's /events endpoint.
 * Yields unwrapped message payloads from `data:` lines, skipping
 * heartbeat comments. The /events endpoint emits AssistantEvent
 * envelopes (`{ id, assistantId, message: { type, ... } }`); this
 * generator unwraps the envelope so callers switch on `.type` directly.
 */
async function* streamEvents(
  baseUrl: string,
  assistantId: string,
  conversationKey: string,
  signal: AbortSignal,
  auth?: Record<string, string>,
): AsyncGenerator<SseEvent> {
  const params = new URLSearchParams({ conversationKey });
  const url = `${baseUrl}/v1/assistants/${assistantId}/events?${params.toString()}`;
  tuiLog.info("sse connect", { url, authHeaders: Object.keys(auth ?? {}) });
  // NOTE: the SSE connect deliberately does NOT refresh-on-401 — keeping the
  // stream path simple. After a mid-session token expiry, the REST path
  // (runtimeRequest) refreshes the shared `auth` on the next request, and the
  // existing reconnect (ensureConnected on the next message) re-opens the
  // stream with the refreshed token.
  const response = await fetch(url, {
    headers: {
      Accept: "text/event-stream",
      ...auth,
    },
    signal,
  });

  tuiLog.info("sse response", {
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get("content-type"),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    tuiLog.error("sse connection failed", {
      status: response.status,
      body: body.slice(0, 500),
    });
    throw new Error(
      `SSE connection failed (${response.status}): ${body || response.statusText}`,
    );
  }
  if (!response.body) {
    tuiLog.error("sse response has no body");
    throw new Error("No response body from SSE endpoint");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (!frame.trim() || frame.startsWith(":")) continue;
      let data: string | undefined;
      for (const line of frame.split("\n")) {
        if (line.startsWith("data: ")) {
          data = line.slice(6);
        }
      }
      if (!data) continue;
      try {
        const envelope = JSON.parse(data) as {
          message?: SseEvent;
          [key: string]: unknown;
        };
        // Unwrap the AssistantEvent envelope
        if (envelope.message && typeof envelope.message.type === "string") {
          yield envelope.message;
        }
      } catch {
        // skip malformed JSON
      }
    }
  }
}

async function handleConfirmationPrompt(
  baseUrl: string,
  assistantId: string,
  requestId: string,
  confirmation: PendingConfirmation,
  chatApp: ChatAppHandle,
  auth?: Record<string, string>,
): Promise<void> {
  const preview = formatConfirmationPreview(
    confirmation.toolName,
    confirmation.input,
  );
  chatApp.addStatus(`\u250C ${confirmation.toolName}: ${preview}`);
  chatApp.addStatus(`\u2502 Risk: ${confirmation.riskLevel}`);
  if (confirmation.executionTarget) {
    chatApp.addStatus(`\u2502 Target: ${confirmation.executionTarget}`);
  }
  chatApp.addStatus("\u2514");

  const options = ["Allow once", "Deny once"];

  const index = await chatApp.showSelection("Tool Approval", options);

  if (index === 0) {
    await submitDecision(baseUrl, assistantId, requestId, "allow", auth);
    chatApp.addStatus("\u2714 Allowed", "green");
    return;
  }

  await submitDecision(baseUrl, assistantId, requestId, "deny", auth);
  chatApp.addStatus("\u2718 Denied", "yellow");
}

export const TYPING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** ASCII-safe spinner frames for the connection screen. */
const CONNECTION_SPINNER_FRAMES = ["|", "/", "-", "\\"];

interface ToolCallDisplayProps {
  tc: ConversationMessageToolCall;
}

function ToolCallDisplay({ tc }: ToolCallDisplayProps): ReactElement {
  const preview = formatToolCallPreview(tc);
  const statusIcon = tc.isError ? "\u2718" : "\u2714";
  const statusColor = tc.isError ? "red" : "green";

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text dimColor>
        {"\u250C"} {tc.name}
        {preview ? `: ${preview}` : ""}
      </Text>
      {tc.result !== undefined ? (
        <Text dimColor>
          {"\u2502"} <Text color={statusColor}>{statusIcon}</Text>{" "}
          {truncateValue(tc.result, 70)}
        </Text>
      ) : null}
      <Text dimColor>{"\u2514"}</Text>
    </Box>
  );
}

interface MessageDisplayProps {
  msg: RuntimeMessage;
  /** Live assistant name — replaces the "Assistant:" default label. */
  assistantName?: string;
}

function MessageDisplay({
  msg,
  assistantName,
}: MessageDisplayProps): ReactElement {
  const time = formatTimestamp(msg.timestamp);
  const defaultLabel =
    msg.role === "user"
      ? "You:"
      : assistantName?.trim()
        ? `${assistantName.trim()}:`
        : "Assistant:";
  const label = msg.label ?? defaultLabel;
  const labelColor = msg.role === "user" ? "green" : "cyan";
  const parts = buildMessageParts(msg);
  const head = parts[0] && parts[0].kind === "text" ? parts[0] : undefined;
  const rest = head ? parts.slice(1) : parts;

  return (
    <Box flexDirection="column">
      <Text>
        {time ? <Text dimColor>{time} </Text> : null}
        <Text color={labelColor} bold>
          {label}{" "}
        </Text>
        {head ? <Text>{head.text}</Text> : null}
      </Text>
      {rest.map((part, i) =>
        part.kind === "tool" ? (
          <ToolCallDisplay key={i} tc={part.toolCall} />
        ) : (
          <Text key={i}>{part.text}</Text>
        ),
      )}
    </Box>
  );
}

function HelpDisplay(): ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold>Commands:</Text>
      {HELP_COMMANDS.map((entry) => (
        <Text key={entry.command}>
          {`  ${entry.command.padEnd(17)} `}
          <Text dimColor>{entry.description}</Text>
        </Text>
      ))}
    </Box>
  );
}

function SpinnerDisplay({ text }: { text: string }): ReactElement {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % TYPING_FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  return (
    <Text dimColor>
      {TYPING_FRAMES[frameIndex]} {text}
    </Text>
  );
}

type ConnectionState = "connecting" | "connected" | "error";

function ConnectionScreen({
  state,
  errorMessage,
  terminalRows,
  terminalColumns,
  onRetry,
  onExit,
}: {
  state: ConnectionState;
  errorMessage?: string;
  terminalRows: number;
  terminalColumns: number;
  onRetry: () => void;
  onExit: () => void;
}): ReactElement {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    if (state !== "connecting") return;
    const timer = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % CONNECTION_SPINNER_FRAMES.length);
    }, 150);
    return () => clearInterval(timer);
  }, [state]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onExit();
    }
    if (state === "error" && input === "r") {
      onRetry();
    }
  });

  const title = `Cadet ${HATCHED_EMOJI}`;
  const width = Math.min(terminalColumns, MAX_TOTAL_WIDTH);

  return (
    <Box
      flexDirection="column"
      height={terminalRows}
      width={width}
      justifyContent="center"
      alignItems="center"
    >
      <Text dimColor bold>
        {title}
      </Text>
      <Text> </Text>
      {state === "connecting" ? (
        <Text dimColor>
          {CONNECTION_SPINNER_FRAMES[frameIndex]} Connecting to assistant...
        </Text>
      ) : (
        <>
          <Text color="red">Failed to connect: {errorMessage}</Text>
          <Text> </Text>
          <Text dimColor>Press r to retry or Ctrl+C to quit</Text>
        </>
      )}
    </Box>
  );
}

export function renderErrorMainScreen(error: unknown): number {
  const msg = error instanceof Error ? error.message : String(error);
  console.log(
    `${ANSI.red}${ANSI.bold}Failed to render MainWindow${ANSI.reset}`,
  );
  console.log(`${ANSI.dim}${msg}${ANSI.reset}`);
  console.log(`${ANSI.dim}Run /clear to retry${ANSI.reset}`);
  return 3;
}

interface DefaultMainScreenProps {
  /** Identity and placement come from the entry; the header derives the
   *  assistant id, display name, and gateway URL from it. */
  entry: LockfileAssistant;
  /** Ad-hoc `--url` targets have no registered entry; their transport URL
   *  overrides the entry-derived one. */
  runtimeUrl?: string;
  healthStatus?: string;
}

interface StyledLine {
  text: string;
  style: "heading" | "dim" | "normal" | "title" | "art";
}

function CompactHeader({
  assistantName,
  healthStatus,
  totalWidth,
}: {
  assistantName?: string;
  healthStatus?: string;
  totalWidth: number;
}): ReactElement {
  const accentColor = "magenta";
  const status = healthStatus ?? "checking...";
  const identity = assistantName?.trim() || "assistant";
  const compactIdentity =
    identity.length > 18 ? `${identity.slice(0, 15)}...` : identity;
  const label = ` ${compactIdentity} ${statusEmoji(status)} `;
  const prefix = "── Cadet";
  const suffix = "──";
  const fillLen = Math.max(
    0,
    totalWidth - prefix.length - label.length - suffix.length,
  );
  return (
    <Box flexDirection="column" width={totalWidth}>
      <Text dimColor>
        {prefix}
        <Text color={accentColor}>{label}</Text>
        {"─".repeat(fillLen)}
        {suffix}
      </Text>
    </Box>
  );
}

function DefaultMainScreen({
  entry,
  runtimeUrl: runtimeUrlOverride,
  healthStatus,
}: DefaultMainScreenProps): ReactElement {
  const assistantId = entry.assistantId;
  const assistantName = getAssistantDisplayName(entry);
  const runtimeUrl = runtimeUrlOverride ?? getGatewayUrl(entry);
  const accentColor = "magenta";
  const caps = getTerminalCapabilities();
  const headerSep = caps.unicodeSupported ? "─" : "-";

  const { stdout } = useStdout();
  const terminalColumns = stdout.columns || DEFAULT_TERMINAL_COLUMNS;
  // The header spans the full terminal width (previously capped at 72).
  const totalWidth = terminalColumns;
  const isCompact = terminalColumns < COMPACT_THRESHOLD;

  if (isCompact) {
    return (
      <CompactHeader
        assistantName={assistantName}
        healthStatus={healthStatus}
        totalWidth={totalWidth}
      />
    );
  }

  const art = HATCH_ART;
  const rightPanelWidth = Math.max(1, totalWidth - LEFT_PANEL_WIDTH);

  const leftLines: StyledLine[] = [
    { text: " ", style: "normal" },
    { text: formatHeaderTitle(assistantName), style: "title" },
    { text: " ", style: "normal" },
    ...art.map((line) => ({
      text: `  ${stripAnsi(line)}`,
      style: "art" as const,
    })),
  ];

  const rightLines: StyledLine[] = [
    { text: " ", style: "normal" },
    { text: "Tips for getting started", style: "heading" },
    ...TIPS.map((t) => ({ text: t, style: "normal" as const })),
    { text: " ", style: "normal" },
    { text: "Assistant ID", style: "heading" },
    { text: assistantId, style: "dim" },
    { text: "Runtime", style: "heading" },
    { text: runtimeUrl, style: "dim" },
    { text: "Status", style: "heading" },
    { text: withStatusEmoji(healthStatus ?? "checking..."), style: "dim" },
  ];

  const maxLines = Math.max(leftLines.length, rightLines.length);

  return (
    <Box flexDirection="column" width={totalWidth}>
      <Text dimColor>{headerSep.repeat(totalWidth)}</Text>
      <Box flexDirection="row">
        <Box flexDirection="column" width={LEFT_PANEL_WIDTH}>
          {Array.from({ length: maxLines }, (_, i) => {
            const item = leftLines[i];
            if (!item) return <Text key={i}> </Text>;
            if (item.style === "title") {
              return (
                <Text
                  key={i}
                  bold
                  color={caps.isDumb ? undefined : accentColor}
                >
                  {item.text}
                </Text>
              );
            }
            if (item.style === "art") {
              return (
                <Text key={i} color={caps.isDumb ? undefined : accentColor}>
                  {item.text}
                </Text>
              );
            }
            if (item.style === "dim") {
              return (
                <Text key={i} dimColor>
                  {item.text}
                </Text>
              );
            }
            return <Text key={i}>{item.text}</Text>;
          })}
        </Box>
        <Box flexDirection="column" width={rightPanelWidth}>
          {Array.from({ length: maxLines }, (_, i) => {
            const item = rightLines[i];
            if (!item) return <Text key={i}> </Text>;
            if (item.style === "heading") {
              return (
                <Text key={i} color={accentColor}>
                  {item.text}
                </Text>
              );
            }
            if (item.style === "dim") {
              return (
                <Text key={i} dimColor>
                  {item.text}
                </Text>
              );
            }
            return <Text key={i}>{item.text}</Text>;
          })}
        </Box>
      </Box>
      <Text dimColor>{headerSep.repeat(totalWidth)}</Text>
      <Text> </Text>
    </Box>
  );
}

export interface SelectionRequest {
  title: string;
  options: string[];
  resolve: (index: number) => void;
}

const SCROLL_STEP = 5;

export function render(
  runtimeUrl: string,
  assistantId: string,
  assistantName?: string,
): number {
  const terminalColumns = process.stdout.columns || DEFAULT_TERMINAL_COLUMNS;
  const isCompact = terminalColumns < COMPACT_THRESHOLD;
  const headerHeight = calculateHeaderHeight(terminalColumns);

  const lookup = lookupAssistantByIdentifier(assistantId);
  const entry: LockfileAssistant =
    lookup.status === "found"
      ? lookup.entry
      : { assistantId, cloud: "cloud", name: assistantName };
  const { unmount } = inkRender(
    <DefaultMainScreen entry={entry} runtimeUrl={runtimeUrl} />,
    { exitOnCtrlC: false },
  );
  unmount();

  if (isCompact) {
    return headerHeight;
  }

  const statusCanvasLine = RIGHT_PANEL_LINE_COUNT + HEADER_TOP_BORDER_LINES;
  const statusCol = LEFT_PANEL_WIDTH + 1;
  checkHealth(runtimeUrl)
    .then((health) => {
      const statusText = health.detail
        ? `${withStatusEmoji(health.status)} (${health.detail})`
        : withStatusEmoji(health.status);
      process.stdout.write(
        `\x1b7\x1b[${statusCanvasLine};${statusCol}H\x1b[K${statusText}\x1b8`,
      );
    })
    .catch(() => {});

  return headerHeight;
}

interface SelectionWindowProps {
  title: string;
  options: string[];
  onSelect: (index: number) => void;
  onCancel: () => void;
}

function SelectionWindow({
  title,
  options,
  onSelect,
  onCancel,
}: SelectionWindowProps): ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput(
    (
      input: string,
      key: {
        upArrow: boolean;
        downArrow: boolean;
        return: boolean;
        escape: boolean;
        ctrl: boolean;
      },
    ) => {
      if (key.upArrow) {
        setSelectedIndex(
          (prev: number) => (prev - 1 + options.length) % options.length,
        );
      } else if (key.downArrow) {
        setSelectedIndex((prev: number) => (prev + 1) % options.length);
      } else if (key.return) {
        onSelect(selectedIndex);
      } else if (key.escape || (key.ctrl && input === "c")) {
        onCancel();
      }
    },
  );

  const borderH = "\u2500".repeat(
    Math.max(0, DIALOG_WINDOW_WIDTH - title.length - DIALOG_TITLE_CHROME),
  );

  return (
    <Box flexDirection="column" width={DIALOG_WINDOW_WIDTH}>
      <Text>{"\u250C\u2500 " + title + " " + borderH + "\u2510"}</Text>
      {options.map((option, i) => {
        const marker = i === selectedIndex ? "\u276F" : " ";
        const padding = " ".repeat(
          Math.max(
            0,
            DIALOG_WINDOW_WIDTH - option.length - SELECTION_OPTION_CHROME,
          ),
        );
        return (
          <Text key={i}>
            {"\u2502 "}
            <Text color={i === selectedIndex ? "cyan" : undefined}>
              {marker}
            </Text>{" "}
            <Text bold={i === selectedIndex}>{option}</Text>
            {padding}
            {"\u2502"}
          </Text>
        );
      })}
      <Text>
        {"\u2514" +
          "\u2500".repeat(DIALOG_WINDOW_WIDTH - DIALOG_BORDER_CORNERS) +
          "\u2518"}
      </Text>
      <Tooltip
        text="\u2191/\u2193 navigate  Enter select  Esc cancel"
        delay={1000}
      />
    </Box>
  );
}

interface SecretInputWindowProps {
  label: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

function SecretInputWindow({
  label,
  placeholder,
  onSubmit,
  onCancel,
}: SecretInputWindowProps): ReactElement {
  const [value, setValue] = useState("");

  useInput(
    (
      input: string,
      key: {
        return: boolean;
        escape: boolean;
        ctrl: boolean;
        backspace: boolean;
        delete: boolean;
      },
    ) => {
      if (key.return) {
        onSubmit(value);
      } else if (key.escape || (key.ctrl && input === "c")) {
        onCancel();
      } else if (key.backspace || key.delete) {
        setValue((prev) => prev.slice(0, -1));
      } else if (input && !key.ctrl) {
        setValue((prev) => prev + input);
      }
    },
  );

  const borderH = "\u2500".repeat(
    Math.max(0, DIALOG_WINDOW_WIDTH - label.length - DIALOG_TITLE_CHROME),
  );
  const masked = "\u2022".repeat(value.length);
  const displayText =
    value.length > 0 ? masked : (placeholder ?? "Enter secret...");
  const displayColor = value.length > 0 ? undefined : "gray";
  const contentPad = " ".repeat(
    Math.max(
      0,
      DIALOG_WINDOW_WIDTH - displayText.length - SECRET_CONTENT_CHROME,
    ),
  );

  return (
    <Box flexDirection="column" width={DIALOG_WINDOW_WIDTH}>
      <Text>{"\u250C\u2500 " + label + " " + borderH + "\u2510"}</Text>
      <Text>
        {"\u2502 "}
        <Text color={displayColor}>{displayText}</Text>
        {contentPad}
        {"\u2502"}
      </Text>
      <Text>
        {"\u2514" +
          "\u2500".repeat(DIALOG_WINDOW_WIDTH - DIALOG_BORDER_CORNERS) +
          "\u2518"}
      </Text>
      <Tooltip text="Enter submit  Esc cancel" delay={1000} />
    </Box>
  );
}

export interface SecretInputRequest {
  label: string;
  placeholder?: string;
  resolve: (value: string) => void;
}

export interface PendingSecret {
  requestId: string;
  service: string;
  field: string;
  label: string;
  description?: string;
  placeholder?: string;
  purpose?: string;
  allowOneTimeSend?: boolean;
}

export interface ChatAppHandle {
  addMessage: (msg: RuntimeMessage) => void;
  addStatus: (text: string, color?: string) => void;
  showSpinner: (text: string) => void;
  hideSpinner: () => void;
  showHelp: () => void;
  showError: (text: string) => void;
  showSelection: (title: string, options: string[]) => Promise<number>;
  showSecretInput: (label: string, placeholder?: string) => Promise<string>;
  handleSecretPrompt: (
    secret: PendingSecret,
    onSubmit: (
      value: string,
      delivery?: "store" | "transient_send",
    ) => Promise<void>,
  ) => Promise<void>;
  clearFeed: () => void;
  setBusy: (busy: boolean) => void;
  updateHealthStatus: (status: string) => void;
  /** Adopt a name the assistant chose for itself (IDENTITY.md) mid-session. */
  updateAssistantName: (name: string) => void;
}

interface ChatAppProps {
  runtimeUrl: string;
  assistantId: string;
  /** Client-minted conversation key the CLI addresses its conversation by. */
  conversationKey: string;
  assistantName?: string;
  /** Pre-built auth headers (e.g. { Authorization: "Bearer ..." } for local,
   *  { "X-Session-Token": "...", "Cadet-Organization-Id": "..." } for platform). */
  auth?: Record<string, string>;
  onExit: () => void;
  handleRef: (handle: ChatAppHandle) => void;
}

function ChatApp({
  runtimeUrl,
  assistantId,
  conversationKey,
  assistantName,
  auth,
  onExit,
  handleRef,
}: ChatAppProps): ReactElement {
  const [inputValue, setInputValue] = useState("");
  const historyRef = useRef<string[]>(loadHistory());
  const historyIndexRef = useRef(-1);
  const savedInputRef = useRef("");
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [spinnerText, setSpinnerText] = useState<string | null>(null);
  const [selection, setSelection] = useState<SelectionRequest | null>(null);
  const [secretInput, setSecretInput] = useState<SecretInputRequest | null>(
    null,
  );
  const [inputFocused, setInputFocused] = useState(true);
  const [scrollIndex, setScrollIndex] = useState<number | null>(null);
  const [healthStatus, setHealthStatus] = useState<string | undefined>(
    undefined,
  );
  const [liveAssistantName, setLiveAssistantName] = useState<
    string | undefined
  >(assistantName);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");
  const [connectionError, setConnectionError] = useState<string | undefined>(
    undefined,
  );
  const prevFeedLengthRef = useRef(0);
  const busyRef = useRef(false);
  const connectedRef = useRef(false);
  const connectingRef = useRef(false);
  const seenMessageIdsRef = useRef(new Set<string>());
  const sseAbortRef = useRef<AbortController | null>(null);
  /**
   * The turn so far, in event order. Text deltas append to the trailing text
   * part; a tool_use_start closes the segment (its boundary) and opens the
   * tool part — so text that streams after a tool call renders after it,
   * instead of being flattened into one body.
   */
  const streamingPartsRef = useRef<StreamingPart[]>([]);
  const handleRef_ = useRef<ChatAppHandle | null>(null);

  const { stdout } = useStdout();
  const terminalRows = stdout.rows || DEFAULT_TERMINAL_ROWS;
  const terminalColumns = stdout.columns || DEFAULT_TERMINAL_COLUMNS;
  const headerHeight = calculateHeaderHeight(terminalColumns);

  const isCompact = terminalColumns < COMPACT_THRESHOLD;
  const compactInputAreaHeight = 1; // input row only, no separators
  const inputAreaHeight = isCompact
    ? compactInputAreaHeight
    : INPUT_AREA_HEIGHT;
  const bottomHeight = selection
    ? selection.options.length + SELECTION_CHROME_LINES + TOOLTIP_HEIGHT
    : secretInput
      ? SECRET_INPUT_HEIGHT + TOOLTIP_HEIGHT
      : spinnerText
        ? SPINNER_HEIGHT + inputAreaHeight
        : inputAreaHeight;
  const availableRows = Math.max(
    MIN_FEED_ROWS,
    terminalRows - headerHeight - bottomHeight,
  );

  const addMessage = useCallback((msg: RuntimeMessage) => {
    setFeed((prev) => [...prev, msg]);
    if (msg.role === "assistant" && !busyRef.current) {
      setSpinnerText(null);
      setInputFocused(true);
    }
  }, []);

  useEffect(() => {
    if (feed.length > prevFeedLengthRef.current && scrollIndex === null) {
      prevFeedLengthRef.current = feed.length;
    } else if (feed.length > prevFeedLengthRef.current) {
      prevFeedLengthRef.current = feed.length;
    } else if (feed.length === 0) {
      prevFeedLengthRef.current = 0;
      setScrollIndex(null);
    }
  }, [feed.length, scrollIndex]);

  const visibleWindow = useMemo(() => {
    if (feed.length === 0) {
      return {
        items: [] as FeedItem[],
        startIndex: 0,
        endIndex: 0,
        hiddenAbove: 0,
        hiddenBelow: 0,
      };
    }

    if (scrollIndex === null) {
      // Reserve 1 line for "N more above" indicator when there are hidden messages
      let totalHeight = 0;
      let start = feed.length;
      for (let i = feed.length - 1; i >= 0; i--) {
        const h = estimateItemHeight(feed[i], terminalColumns);
        // Reserve space for the "more above" indicator if we'd hide messages
        const indicatorLine = i > 0 ? 1 : 0;
        if (totalHeight + h + indicatorLine > availableRows) {
          break;
        }
        totalHeight += h;
        start = i;
      }
      if (start === feed.length && feed.length > 0) {
        start = feed.length - 1;
      }
      return {
        items: feed.slice(start, feed.length),
        startIndex: start,
        endIndex: feed.length,
        hiddenAbove: start,
        hiddenBelow: 0,
      };
    }

    const start = Math.max(0, Math.min(scrollIndex, feed.length - 1));
    // Reserve lines for "more above/below" indicators
    const aboveIndicator = start > 0 ? 1 : 0;
    const budget = availableRows - aboveIndicator;
    let totalHeight = 0;
    let end = start;
    for (let i = start; i < feed.length; i++) {
      const h = estimateItemHeight(feed[i], terminalColumns);
      // Reserve space for "more below" indicator if we'd hide messages
      const belowIndicator = i + 1 < feed.length ? 1 : 0;
      if (totalHeight + h + belowIndicator > budget) {
        break;
      }
      totalHeight += h;
      end = i + 1;
    }
    return {
      items: feed.slice(start, end),
      startIndex: start,
      endIndex: end,
      hiddenAbove: start,
      hiddenBelow: feed.length - end,
    };
  }, [feed, scrollIndex, availableRows, terminalColumns]);

  const addStatus = useCallback((text: string, color?: string) => {
    const item: StatusLine = { type: "status", text, color };
    setFeed((prev) => [...prev, item]);
  }, []);

  const showSpinner = useCallback((text: string) => {
    setSpinnerText(text);
  }, []);

  const hideSpinner = useCallback(() => {
    setSpinnerText(null);
    setInputFocused(true);
  }, []);

  const showHelpFn = useCallback(() => {
    const item: HelpLine = { type: "help" };
    setFeed((prev) => [...prev, item]);
  }, []);

  const showError = useCallback((text: string) => {
    const item: ErrorLine = { type: "error", text };
    setFeed((prev) => [...prev, item]);
  }, []);

  const showSelection = useCallback(
    (title: string, options: string[]): Promise<number> => {
      setInputFocused(false);
      return new Promise<number>((resolve) => {
        setSelection({ title, options, resolve });
      });
    },
    [],
  );

  const showSecretInput = useCallback(
    (label: string, placeholder?: string): Promise<string> => {
      setInputFocused(false);
      return new Promise<string>((resolve) => {
        setSecretInput({ label, placeholder, resolve });
      });
    },
    [],
  );

  const handleSecretPromptFn = useCallback(
    async (
      secret: PendingSecret,
      onSubmit: (
        value: string,
        delivery?: "store" | "transient_send",
      ) => Promise<void>,
    ): Promise<void> => {
      addStatus(`\u250C Secret needed: ${secret.label}`);
      addStatus(`\u2502 Service: ${secret.service} / ${secret.field}`);
      if (secret.description) {
        addStatus(`\u2502 ${secret.description}`);
      }
      if (secret.purpose) {
        addStatus(`\u2502 Purpose: ${secret.purpose}`);
      }
      addStatus("\u2514");

      let delivery: "store" | "transient_send" | undefined;
      if (secret.allowOneTimeSend) {
        const deliveryIndex = await showSelection("Secret delivery", [
          "Store securely",
          "Send once (transient)",
        ]);
        if (deliveryIndex === 1) {
          delivery = "transient_send";
        } else {
          delivery = "store";
        }
      }

      const value = await showSecretInput(secret.label, secret.placeholder);

      if (!value) {
        try {
          await onSubmit("", delivery);
        } catch {
          // Best-effort
        }
        addStatus("\u2718 Cancelled", "yellow");
        return;
      }

      try {
        await onSubmit(value, delivery);
        addStatus("\u2714 Secret submitted", "green");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showError(`Failed to submit secret: ${msg}`);
      }
    },
    [addStatus, showSelection, showSecretInput, showError],
  );

  const setBusy = useCallback((busy: boolean) => {
    busyRef.current = busy;
    if (!busy) {
      setSpinnerText(null);
      setInputFocused(true);
    }
  }, []);

  const clearFeed = useCallback(() => {
    setFeed([]);
    setSpinnerText(null);
    setSelection(null);
    setSecretInput(null);
    setInputFocused(true);
    setScrollIndex(null);
    busyRef.current = false;
  }, []);

  const updateHealthStatus = useCallback((status: string) => {
    setHealthStatus(status);
  }, []);

  const updateAssistantName = useCallback((name: string) => {
    setLiveAssistantName(name.trim() || undefined);
  }, []);

  const cleanup = useCallback(() => {
    if (sseAbortRef.current) {
      sseAbortRef.current.abort();
      sseAbortRef.current = null;
    }
  }, []);

  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  const ensureConnected = useCallback(async (): Promise<boolean> => {
    if (connectedRef.current) {
      return true;
    }
    if (connectingRef.current || !handleRef_.current) {
      return false;
    }
    connectingRef.current = true;
    setConnectionState("connecting");
    setConnectionError(undefined);
    const h = handleRef_.current;

    h.showSpinner("Connecting...");

    try {
      const health = await checkHealthRuntime(runtimeUrl);
      tuiLog.info("health check", {
        status: health.status,
        message: health.message,
      });
      h.hideSpinner();
      h.updateHealthStatus(health.status);
      if (health.status === "healthy" || health.status === "ok") {
        h.addStatus(
          `${statusEmoji(health.status)} Connected to assistant`,
          "green",
        );
      } else {
        const statusMsg = health.message ? ` - ${health.message}` : "";
        h.addStatus(
          `${statusEmoji(health.status)} Assistant status: ${health.status}${statusMsg}`,
          "yellow",
        );
      }

      h.showSpinner("Loading conversation history...");

      // Adopt the assistant's chosen name (if it already has one) so the
      // header title and message labels open as "Ferry:" instead of
      // "Assistant:". Fresh runtimes have no IDENTITY.md yet → 404 → skip.
      try {
        const identity = await runtimeRequest<{ name?: string }>(
          runtimeUrl,
          assistantId,
          "/identity",
          undefined,
          auth,
        );
        if (identity?.name && identity.name.trim()) {
          h.updateAssistantName(identity.name.trim());
        }
      } catch {
        // No IDENTITY.md yet — the identity_changed event will fire later.
      }

      try {
        const historyResponse = await pollMessages(
          runtimeUrl,
          assistantId,
          conversationKey,
          auth,
        );
        h.hideSpinner();
        if (historyResponse.messages.length > 0) {
          for (const msg of historyResponse.messages) {
            h.addMessage(msg);
            seenMessageIdsRef.current.add(msg.id);
          }
        }
      } catch {
        h.hideSpinner();
      }

      // Open SSE stream for real-time events
      const sseAc = new AbortController();
      sseAbortRef.current = sseAc;

      // Process SSE events in the background
      (async () => {
        try {
          for await (const event of streamEvents(
            runtimeUrl,
            assistantId,
            conversationKey,
            sseAc.signal,
            auth,
          )) {
            const hRef = handleRef_.current;
            if (!hRef) continue;

            switch (event.type) {
              case "assistant_text_delta": {
                const parts = streamingPartsRef.current;
                const last = parts[parts.length - 1];
                if (last && last.kind === "text") {
                  last.text += event.text ?? "";
                } else {
                  parts.push({ kind: "text", text: event.text ?? "" });
                }
                break;
              }

              case "assistant_thinking_delta":
                // Thinking deltas are suppressed in the TUI for now
                break;

              case "tool_use_start":
                if (event.toolName) {
                  streamingPartsRef.current.push({
                    kind: "tool",
                    toolCall: {
                      id: event.toolUseId,
                      name: event.toolName,
                      input: event.input ?? {},
                    },
                  });
                }
                break;

              case "tool_result": {
                // Match by id first (robust for parallel/same-name calls),
                // fall back to name + missing result for backwards compat.
                const isTarget = (
                  p: StreamingPart,
                ): p is {
                  kind: "tool";
                  toolCall: ConversationMessageToolCall;
                } =>
                  p.kind === "tool" &&
                  (event.toolUseId
                    ? p.toolCall.id === event.toolUseId
                    : p.toolCall.name === event.toolName &&
                      p.toolCall.result === undefined);
                const parts = streamingPartsRef.current;
                const index = parts.findIndex(isTarget);
                if (index >= 0) {
                  const part = parts[index];
                  if (part.kind === "tool") {
                    part.toolCall.result = event.result;
                    part.toolCall.isError = event.isError;
                  }
                } else if (event.toolName) {
                  parts.push({
                    kind: "tool",
                    toolCall: {
                      id: event.toolUseId,
                      name: event.toolName,
                      input: event.input ?? {},
                      result: event.result,
                      isError: event.isError,
                    },
                  });
                }
                break;
              }

              case "confirmation_request":
                hRef.hideSpinner();
                await handleConfirmationPrompt(
                  runtimeUrl,
                  assistantId,
                  event.requestId ?? "",
                  {
                    toolName: event.toolName ?? "",
                    toolUseId: event.toolUseId ?? "",
                    input: event.input ?? {},
                    riskLevel: event.riskLevel ?? "unknown",
                    executionTarget: event.executionTarget,
                    allowlistOptions: event.allowlistOptions?.map((o) => ({
                      label: o.label,
                      pattern: o.pattern,
                    })),
                    scopeOptions: event.scopeOptions,
                    persistentDecisionsAllowed:
                      event.persistentDecisionsAllowed,
                  },
                  hRef,
                  auth,
                );
                hRef.showSpinner("Working...");
                break;

              case "secret_request":
                hRef.hideSpinner();
                await hRef.handleSecretPrompt(
                  {
                    requestId: event.requestId ?? "",
                    service: event.service ?? "",
                    field: event.field ?? "",
                    label: event.label ?? "",
                    description: event.description,
                    placeholder: event.placeholder,
                    purpose: event.purpose,
                    allowOneTimeSend: event.allowOneTimeSend,
                  },
                  async (value, delivery) => {
                    await runtimeRequest(
                      runtimeUrl,
                      assistantId,
                      "/secret",
                      {
                        method: "POST",
                        body: JSON.stringify({
                          requestId: event.requestId,
                          value,
                          delivery,
                        }),
                      },
                      auth,
                    );
                  },
                );
                hRef.showSpinner("Working...");
                break;

              case "message_complete": {
                // Only finalize main turns (ignore aux events like call transcripts)
                if (event.source === "aux") break;

                // Fold the ordered parts the SSE stream produced into the
                // same `contentBlocks` shape the daemon's history payload
                // uses, so a live turn renders identically to the same turn
                // reloaded from history.
                const parts = streamingPartsRef.current;
                streamingPartsRef.current = [];
                const contentBlocks: RuntimeMessage["contentBlocks"] = [];
                for (const part of parts) {
                  if (part.kind === "text") {
                    if (part.text.length === 0) continue;
                    contentBlocks.push({ type: "text", text: part.text });
                  } else {
                    contentBlocks.push({
                      type: "tool_use",
                      toolCall: part.toolCall,
                    });
                  }
                }

                if (contentBlocks.length > 0) {
                  const msg: RuntimeMessage = {
                    id: event.messageId ?? `sse-${Date.now()}`,
                    role: "assistant",
                    timestamp: new Date().toISOString(),
                    contentBlocks,
                  };
                  seenMessageIdsRef.current.add(msg.id);
                  hRef.addMessage(msg);
                  process.stdout.write("\x07");
                }

                hRef.setBusy(false);
                hRef.hideSpinner();
                break;
              }

              case "identity_changed":
                // The assistant adopted (or renamed) itself in IDENTITY.md —
                // swap the "Assistant:" label and header title right away.
                if (event.name && event.name.trim()) {
                  hRef.updateAssistantName(event.name.trim());
                }
                break;

              case "error":
                hRef.hideSpinner();
                hRef.showError(event.message ?? "Unknown error");
                hRef.setBusy(false);
                break;

              case "sync_changed":
                // The interactive CLI does not currently keep any sync-tagged
                // caches, so generic invalidations are intentionally ignored.
                break;

              default:
                // Ignore events we don't handle (activity state, traces, etc.)
                break;
            }
          }
        } catch (sseErr) {
          // Stream ended — only report if not intentionally aborted
          if (!sseAc.signal.aborted) {
            tuiLog.warn("sse stream disconnected", {
              error: String(sseErr),
            });
            handleRef_.current?.addStatus(
              "SSE stream disconnected — will reconnect on next message",
              "yellow",
            );
            handleRef_.current?.setBusy(false);
            handleRef_.current?.hideSpinner();
            connectedRef.current = false;
          }
        }
      })();

      connectedRef.current = true;
      connectingRef.current = false;
      setConnectionState("connected");
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tuiLog.error("connection failed", { error: msg });
      h.hideSpinner();
      connectingRef.current = false;
      h.updateHealthStatus("unreachable");
      setConnectionState("error");
      setConnectionError(msg);
      h.addStatus(
        `${statusEmoji("unreachable")} Failed to connect: ${msg}`,
        "red",
      );
      return false;
    }
  }, [runtimeUrl, assistantId, auth]);

  const handleInput = useCallback(
    async (input: string): Promise<void> => {
      const h = handleRef_.current;
      if (!h) {
        return;
      }

      const trimmed = input.trim();
      if (!trimmed) {
        return;
      }

      if (trimmed === "/quit" || trimmed === "/exit" || trimmed === "/q") {
        cleanup();
        process.exit(0);
      }

      if (trimmed === "/clear") {
        h.clearFeed();
        return;
      }

      if (trimmed === "/help" || trimmed === "?") {
        h.showHelp();
        return;
      }

      // Daemon meta commands (/clean /commands /models /status) — the same
      // set web resolves through the daemon's slash endpoint. No turn
      // starts; the answer renders as an ephemeral status line.
      const metaCommand = trimmed.split(/\s+/)[0]?.toLowerCase();
      if (metaCommand && DAEMON_META_COMMANDS.has(metaCommand)) {
        const isConnected = await ensureConnected();
        if (!isConnected) return;

        h.showSpinner(`Running ${metaCommand}...`);
        try {
          const result = await resolveMetaCommand(
            runtimeUrl,
            assistantId,
            conversationKey,
            trimmed,
            auth,
          );
          h.hideSpinner();
          h.addStatus(result.text || "(no output)");
          if (result.contextUsage) {
            const usage = result.contextUsage;
            const pct =
              usage.maxTokens && usage.maxTokens > 0
                ? ` (${Math.round((usage.tokens / usage.maxTokens) * 100)}% of context)`
                : "";
            h.addStatus(
              `Context: ${usage.tokens.toLocaleString()} tokens${pct}`,
              "gray",
            );
          }
        } catch (err) {
          h.hideSpinner();
          h.showError(
            `${metaCommand} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        setInputFocused(true);
        return;
      }

      // /config — read and write runtime config values (GET /v1/config,
      // POST /v1/config/set — the same API `assistant config set` uses).
      if (metaCommand === "/config") {
        const argString = trimmed.slice("/config".length).trim();
        const isConnected = await ensureConnected();
        if (!isConnected) return;

        h.showSpinner("Reading config...");
        try {
          if (!argString) {
            const config = await fetchRuntimeConfig(runtimeUrl, auth);
            h.hideSpinner();
            const printed = JSON.stringify(config, null, 2);
            const lines = printed.split("\n");
            h.addStatus(
              lines.length > 40
                ? lines.slice(0, 40).join("\n") +
                    `\n... (${lines.length - 40} more lines)`
                : printed,
            );
          } else {
            // Split "<path>" or "<path> <value>" — the path is dotted and
            // never contains spaces; the value is everything after it.
            const spaceIndex = argString.indexOf(" ");
            const configPath = (
              spaceIndex === -1 ? argString : argString.slice(0, spaceIndex)
            ).trim();
            const rawValue =
              spaceIndex === -1
                ? undefined
                : argString.slice(spaceIndex + 1).trim();

            if (rawValue === undefined) {
              const config = await fetchRuntimeConfig(runtimeUrl, auth);
              h.hideSpinner();
              const value = resolveConfigPath(config, configPath);
              h.addStatus(
                value === undefined
                  ? `config.${configPath} is not set`
                  : `config.${configPath} = ${JSON.stringify(value, null, 2)}`,
              );
            } else {
              await setRuntimeConfigValue(
                runtimeUrl,
                configPath,
                parseConfigValue(rawValue),
                auth,
              );
              h.hideSpinner();
              h.addStatus(`Set config.${configPath} = ${rawValue}`, "green");
            }
          }
        } catch (err) {
          h.hideSpinner();
          h.showError(
            `/config failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        setInputFocused(true);
        return;
      }

      // If a connection attempt is already in progress, don't silently drop input
      if (connectingRef.current) {
        h.addStatus(
          "Still connecting — please wait a moment and try again.",
          "yellow",
        );
        return;
      }

      if (trimmed.startsWith("/btw ")) {
        const question = trimmed.slice(5).trim();
        if (!question) return;

        h.addStatus(`/btw ${question}`, "gray");

        const isConnected = await ensureConnected();
        if (!isConnected) return;

        try {
          const btwFetch = () =>
            fetch(`${runtimeUrl}/v1/assistants/${assistantId}/btw`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...auth,
              },
              body: JSON.stringify({
                conversationKey,
                content: question,
              }),
              signal: AbortSignal.timeout(30_000),
            });

          let res = await btwFetch();
          // Mid-session token expiry → 401: refresh once and retry.
          if (
            res.status === 401 &&
            (await maybeRefreshAuthHeaders(runtimeUrl, assistantId, auth))
          ) {
            res = await btwFetch();
          }

          if (!res.ok) throw new Error(`HTTP ${res.status}`);

          let fullText = "";
          let sseError = "";
          const reader = res.body?.getReader();
          const decoder = new TextDecoder();
          if (reader) {
            let buffer = "";
            let currentEvent = "";
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) {
                if (line.startsWith("event: ")) {
                  currentEvent = line.slice(7).trim();
                } else if (line.startsWith("data: ")) {
                  try {
                    const data = JSON.parse(line.slice(6));
                    if (currentEvent === "btw_error" || data.error) {
                      sseError = data.error ?? data.text ?? "Unknown error";
                    } else if (data.text) {
                      fullText += data.text;
                    }
                  } catch {
                    /* skip malformed */
                  }
                } else if (line.trim() === "") {
                  // Empty line marks end of SSE event; reset event type
                  currentEvent = "";
                }
              }
            }
          }
          if (sseError) {
            h.showError(`/btw: ${sseError}`);
          } else {
            h.addStatus(fullText || "No response");
          }
        } catch (err) {
          h.showError(
            `/btw failed: ${err instanceof Error ? err.message : err}`,
          );
        }
        return;
      }

      if (busyRef.current) {
        // /btw and the other local commands are already handled above this
        // block — anything reaching here (including unknown /commands, which
        // run as real turns) echoes as a user message.
        {
          const userMsg: RuntimeMessage = {
            id: "local-user-" + Date.now(),
            role: "user",
            content: trimmed,
            timestamp: new Date().toISOString(),
          };
          h.addMessage(userMsg);
        }
        const isConnected = await ensureConnected();
        if (!isConnected) {
          h.showError("Cannot send — not connected to the assistant.");
          setInputFocused(true);
          return;
        }
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(
            () => controller.abort(),
            SEND_TIMEOUT_MS,
          );
          const sendResult = await sendMessage(
            runtimeUrl,
            assistantId,
            conversationKey,
            trimmed,
            controller.signal,
            auth,
          );
          clearTimeout(timeoutId);
          if (sendResult.accepted) {
            h.addStatus(
              "Message queued — will be processed after current response",
              "gray",
            );
          } else {
            h.showError("Message was not accepted by the assistant");
          }
        } catch (err) {
          h.showError(
            `Failed to queue message: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        setInputFocused(true);
        return;
      }

      // Unknown /commands run as real turns (web-consistent: /compact and
      // /doctor are turns too) and show up in the transcript like any other
      // user message.
      const userMsg: RuntimeMessage = {
        id: "local-user-" + Date.now(),
        role: "user",
        content: trimmed,
        timestamp: new Date().toISOString(),
      };
      h.addMessage(userMsg);

      const isConnected = await ensureConnected();
      if (!isConnected) {
        return;
      }

      seenMessageIdsRef.current.add("pending-user-" + Date.now());

      h.showSpinner("Sending...");
      h.setBusy(true);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

      try {
        const sendResult = await sendMessage(
          runtimeUrl,
          assistantId,
          conversationKey,
          trimmed,
          controller.signal,
          auth,
        );
        clearTimeout(timeoutId);
        if (!sendResult.accepted) {
          h.setBusy(false);
          h.hideSpinner();
          h.showError("Message was not accepted by the assistant");
          return;
        }
      } catch (sendErr) {
        clearTimeout(timeoutId);
        h.setBusy(false);
        h.hideSpinner();
        const errorMsg =
          sendErr instanceof Error ? sendErr.message : String(sendErr);
        h.showError(errorMsg);
        return;
      }

      // Accumulators are reset by message_complete; no reset here to avoid
      // racing with SSE events that may arrive during the sendMessage await.
      h.showSpinner("Working...");
    },
    [runtimeUrl, assistantId, auth, cleanup, ensureConnected],
  );

  const handleSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (trimmed) {
        appendHistory(trimmed);
        historyRef.current = loadHistory();
      }
      historyIndexRef.current = -1;
      savedInputRef.current = "";
      setInputValue("");
      handleInput(value);
    },
    [handleInput],
  );

  const handleHistoryUp = useCallback(() => {
    const history = historyRef.current;
    if (history.length === 0) return;
    if (historyIndexRef.current === -1) {
      savedInputRef.current = inputValue;
    }
    const nextIndex = Math.min(historyIndexRef.current + 1, history.length - 1);
    historyIndexRef.current = nextIndex;
    const entry = history[history.length - 1 - nextIndex];
    setInputValue(entry);
  }, [inputValue]);

  const handleHistoryDown = useCallback(() => {
    if (historyIndexRef.current === -1) return;
    if (historyIndexRef.current <= 0) {
      historyIndexRef.current = -1;
      setInputValue(savedInputRef.current);
      return;
    }
    historyIndexRef.current -= 1;
    const history = historyRef.current;
    const entry = history[history.length - 1 - historyIndexRef.current];
    setInputValue(entry);
  }, []);

  useEffect(() => {
    const handle: ChatAppHandle = {
      addMessage,
      addStatus,
      showSpinner,
      hideSpinner,
      showHelp: showHelpFn,
      showError,
      showSelection,
      showSecretInput,
      handleSecretPrompt: handleSecretPromptFn,
      clearFeed,
      setBusy,
      updateHealthStatus,
      updateAssistantName,
    };
    handleRef_.current = handle;
    handleRef(handle);
  }, [
    handleRef,
    addMessage,
    addStatus,
    showSpinner,
    hideSpinner,
    showHelpFn,
    showError,
    showSelection,
    showSecretInput,
    handleSecretPromptFn,
    clearFeed,
    setBusy,
    updateHealthStatus,
    updateAssistantName,
  ]);

  const retryConnection = useCallback(() => {
    if (connectingRef.current) return; // already retrying
    connectedRef.current = false;
    setConnectionState("connecting");
    ensureConnected();
  }, [ensureConnected]);

  useEffect(() => {
    ensureConnected();
  }, [ensureConnected]);

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") {
        onExit();
      }
    },
    { isActive: inputFocused },
  );

  useInput(
    (_input, key) => {
      if (key.shift && key.upArrow) {
        setScrollIndex((prev) => {
          if (prev === null) {
            return Math.max(0, visibleWindow.startIndex - SCROLL_STEP);
          }
          return Math.max(0, prev - SCROLL_STEP);
        });
      } else if (key.shift && key.downArrow) {
        setScrollIndex((prev) => {
          if (prev === null) {
            return null;
          }
          const nextIndex = prev + SCROLL_STEP;
          let totalHeight = 0;
          for (let i = nextIndex; i < feed.length; i++) {
            totalHeight += estimateItemHeight(feed[i], terminalColumns);
            if (totalHeight > availableRows) {
              return nextIndex;
            }
          }
          return null;
        });
      } else if (key.meta && key.upArrow) {
        setScrollIndex(0);
      } else if (key.meta && key.downArrow) {
        setScrollIndex(null);
      }
    },
    { isActive: !selection && !secretInput },
  );

  const handleSecretSubmit = useCallback(
    (value: string) => {
      if (secretInput) {
        const { resolve } = secretInput;
        setSecretInput(null);
        setInputFocused(true);
        resolve(value);
      }
    },
    [secretInput],
  );

  const handleSecretCancel = useCallback(() => {
    if (secretInput) {
      const { resolve } = secretInput;
      setSecretInput(null);
      setInputFocused(true);
      resolve("");
    }
  }, [secretInput]);

  const handleSelectionSelect = useCallback(
    (index: number) => {
      if (selection) {
        const { resolve } = selection;
        setSelection(null);
        setInputFocused(true);
        resolve(index);
      }
    },
    [selection],
  );

  const handleSelectionCancel = useCallback(() => {
    if (selection) {
      const { resolve } = selection;
      setSelection(null);
      setInputFocused(true);
      resolve(-1);
    }
  }, [selection]);

  const lookup = lookupAssistantByIdentifier(assistantId);
  if (connectionState !== "connected") {
    return (
      <ConnectionScreen
        state={connectionState}
        errorMessage={connectionError}
        terminalRows={terminalRows}
        terminalColumns={terminalColumns}
        onRetry={retryConnection}
        onExit={onExit}
      />
    );
  }

  return (
    <Box flexDirection="column" height={terminalRows}>
      <DefaultMainScreen
        entry={
          lookup.status === "found"
            ? lookup.entry
            : {
                assistantId,
                cloud: "cloud",
                name: liveAssistantName,
              }
        }
        runtimeUrl={runtimeUrl}
        healthStatus={healthStatus}
      />

      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {visibleWindow.hiddenAbove > 0 ? (
          <Text dimColor>
            {isCompact
              ? `\u2191 ${visibleWindow.hiddenAbove} more above`
              : `\u2191 ${visibleWindow.hiddenAbove} more above (Shift+\u2191/Cmd+\u2191)`}
          </Text>
        ) : null}

        {visibleWindow.items.map((item, i) => {
          const feedIndex = visibleWindow.startIndex + i;
          if (isRuntimeMessage(item)) {
            return (
              <Box key={feedIndex} flexDirection="column" marginBottom={1}>
                <MessageDisplay msg={item} assistantName={liveAssistantName} />
              </Box>
            );
          }
          if (item.type === "status") {
            return (
              <Text
                key={feedIndex}
                color={item.color as "green" | "yellow" | "red" | undefined}
              >
                {item.text}
              </Text>
            );
          }
          if (item.type === "help") {
            return <HelpDisplay key={feedIndex} />;
          }
          if (item.type === "error") {
            return (
              <Text key={feedIndex} color="red">
                {item.text}
              </Text>
            );
          }
          return null;
        })}

        {visibleWindow.hiddenBelow > 0 ? (
          <Text dimColor>
            {"\u2193"} {visibleWindow.hiddenBelow} more below
            (Shift+\u2193/Cmd+\u2193)
          </Text>
        ) : null}
      </Box>

      {spinnerText ? <SpinnerDisplay text={spinnerText} /> : null}

      {selection ? (
        <SelectionWindow
          title={selection.title}
          options={selection.options}
          onSelect={handleSelectionSelect}
          onCancel={handleSelectionCancel}
        />
      ) : null}

      {secretInput ? (
        <SecretInputWindow
          label={secretInput.label}
          placeholder={secretInput.placeholder}
          onSubmit={handleSecretSubmit}
          onCancel={handleSecretCancel}
        />
      ) : null}

      {!selection && !secretInput ? (
        <Box flexDirection="column" flexShrink={0}>
          {isCompact ? null : (
            <Text dimColor>
              {unicodeOrFallback("\u2500", "-").repeat(terminalColumns)}
            </Text>
          )}
          <Box paddingLeft={isCompact ? 0 : 1} height={1} flexShrink={0}>
            <Text color="green" bold>
              {isCompact ? ">" : "you>"}
              {" "}
            </Text>
            <TextInput
              value={inputValue}
              onChange={setInputValue}
              onSubmit={handleSubmit}
              onHistoryUp={handleHistoryUp}
              onHistoryDown={handleHistoryDown}
              completionCommands={SLASH_COMMANDS}
              focus={inputFocused}
            />
          </Box>
          {terminalColumns >= COMPACT_THRESHOLD ? (
            <>
              <Text dimColor>
                {unicodeOrFallback("\u2500", "-").repeat(terminalColumns)}
              </Text>
              <Text dimColor> ? for shortcuts</Text>
            </>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}

export interface ChatAppInstance {
  handle: ChatAppHandle;
  unmount: () => void;
}

export function renderChatApp(
  runtimeUrl: string,
  assistantId: string,
  onExit: () => void,
  options?: {
    auth?: Record<string, string>;
    assistantName?: string;
    /** Client-minted conversation key (resolved from the assistant entry).
     *  Unregistered targets (--url) get an ephemeral uuid. */
    conversationKey?: string;
  },
): ChatAppInstance {
  let chatHandle: ChatAppHandle | null = null;

  const instance = inkRender(
    <ChatApp
      runtimeUrl={runtimeUrl}
      assistantId={assistantId}
      conversationKey={options?.conversationKey ?? crypto.randomUUID()}
      assistantName={options?.assistantName}
      auth={options?.auth}
      onExit={onExit}
      handleRef={(h) => {
        chatHandle = h;
      }}
    />,
    { exitOnCtrlC: false },
  );

  const handle: ChatAppHandle = {
    addMessage: (msg) => chatHandle?.addMessage(msg),
    addStatus: (text, color) => chatHandle?.addStatus(text, color),
    showSpinner: (text) => chatHandle?.showSpinner(text),
    hideSpinner: () => chatHandle?.hideSpinner(),
    showHelp: () => chatHandle?.showHelp(),
    showError: (text) => chatHandle?.showError(text),
    showSelection: (title, options) =>
      chatHandle?.showSelection(title, options) ?? Promise.resolve(-1),
    showSecretInput: (label, placeholder) =>
      chatHandle?.showSecretInput(label, placeholder) ?? Promise.resolve(""),
    handleSecretPrompt: (secret, onSubmitCb) =>
      chatHandle?.handleSecretPrompt(secret, onSubmitCb) ?? Promise.resolve(),
    clearFeed: () => chatHandle?.clearFeed(),
    setBusy: (busy) => chatHandle?.setBusy(busy),
    updateHealthStatus: (status) => chatHandle?.updateHealthStatus(status),
    updateAssistantName: (name) => chatHandle?.updateAssistantName(name),
  };

  return {
    handle,
    unmount: () => instance.unmount(),
  };
}
