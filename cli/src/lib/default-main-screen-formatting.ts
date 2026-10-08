import { HATCH_ART } from "./constants.js";

export const LEFT_PANEL_WIDTH = 36;
export const DEFAULT_TERMINAL_COLUMNS = 80;
export const COMPACT_THRESHOLD = 60;

const LEFT_HEADER_LINES = 4;
const LEFT_FOOTER_LINES = 1;
const HEADER_TOP_BORDER_LINES = 1;
const HEADER_BOTTOM_BORDER_LINES = 2;
const HEADER_CHROME_LINES =
  HEADER_TOP_BORDER_LINES + HEADER_BOTTOM_BORDER_LINES;
const COMPACT_HEADER_HEIGHT = 1;

const RIGHT_PANEL_INFO_SECTIONS = 5;
const RIGHT_PANEL_SPACERS = 2;
const RIGHT_PANEL_TIPS_HEADING = 1;

const TOOL_CALL_CHROME_LINES = 2;
const MESSAGE_SPACING = 1;

export const HELP_COMMANDS = [
  {
    command: "/btw <question>",
    description: "Ask a side question while the assistant is working",
  },
  {
    command: "/quit, /exit, /q",
    description: "Disconnect and exit",
  },
  {
    command: "/clear",
    description: "Clear the screen",
  },
  {
    command: "/help, ?",
    description: "Show this help",
  },
] as const;

export const TIPS = [
  "Send a message to start chatting",
  "Use /help to see available commands",
] as const;

export const RIGHT_PANEL_LINE_COUNT =
  RIGHT_PANEL_SPACERS +
  RIGHT_PANEL_TIPS_HEADING +
  TIPS.length +
  RIGHT_PANEL_INFO_SECTIONS * 2;
const HELP_DISPLAY_HEIGHT = HELP_COMMANDS.length + 1;

export interface ToolCallInfo {
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  toolUseId?: string;
}

export interface RuntimeMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /**
   * Ordered text segments from the daemon's history payload, split at
   * tool_use/surface boundaries. The flat `content` body is derived from
   * these (see `segmentsToPlainText`); the daemon no longer sends a
   * redundant flattened `content` field on the wire.
   */
  textSegments?: string[];
  /**
   * Ordered entry refs (`text:N`, `tool:N`, plus `surface:`/`thinking:`/
   * `attachment:` entries the TUI doesn't render) describing how segments and
   * tool calls interleave in the original turn. `buildMessageParts` walks it
   * to rebuild that order; absent on legacy payloads.
   */
  contentOrder?: string[];
  timestamp: string;
  toolCalls?: ToolCallInfo[];
  label?: string;
}

export interface StatusLine {
  type: "status";
  text: string;
  color?: string;
}

export interface SpinnerLine {
  type: "spinner";
  text: string;
}

export interface HelpLine {
  type: "help";
}

export interface ErrorLine {
  type: "error";
  text: string;
}

export type FeedItem =
  | RuntimeMessage
  | StatusLine
  | SpinnerLine
  | HelpLine
  | ErrorLine;

export function formatTimestamp(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function formatConfirmationPreview(
  toolName: string,
  input: Record<string, unknown>,
): string {
  switch (toolName) {
    case "bash":
      return String(input.command ?? "");
    case "file_read":
      return `read ${input.path ?? ""}`;
    case "file_write":
      return `write ${input.path ?? ""}`;
    case "file_edit":
      return `edit ${input.path ?? ""}`;
    case "web_fetch":
      return String(input.url ?? "").slice(0, 80);
    case "browser_navigate":
      return `navigate ${String(input.url ?? "").slice(0, 80)}`;
    case "browser_close":
      return input.close_all_pages
        ? "close all browser pages"
        : "close browser page";
    case "browser_click":
      return `click ${input.element_id ?? input.selector ?? ""}`;
    case "browser_type":
      return `type into ${input.element_id ?? input.selector ?? ""}`;
    case "browser_press_key":
      return `press "${input.key ?? ""}"`;
    default:
      return `${toolName}: ${JSON.stringify(input).slice(0, 80)}`;
  }
}

export function formatToolCallPreview(toolCall: ToolCallInfo): string {
  switch (toolCall.name) {
    case "bash":
      return String(toolCall.input.command ?? "").slice(0, 80);
    case "file_read":
      return `read ${toolCall.input.path ?? ""}`;
    case "file_write":
      return `write ${toolCall.input.path ?? ""}`;
    case "file_edit":
      return `edit ${toolCall.input.path ?? ""}`;
    case "web_search":
      return String(toolCall.input.query ?? "").slice(0, 80);
    case "web_fetch":
      return String(toolCall.input.url ?? "").slice(0, 80);
    case "browser_navigate":
      return `navigate ${String(toolCall.input.url ?? "").slice(0, 80)}`;
    case "browser_click":
      return `click ${String(toolCall.input.element_id ?? toolCall.input.selector ?? "").slice(0, 60)}`;
    case "browser_type":
      return `type into ${String(toolCall.input.element_id ?? toolCall.input.selector ?? "").slice(0, 60)}`;
    default:
      // Unknown tools render name-only ("what was invoked"), not a JSON dump
      // of their input — the caller omits the preview when this is empty.
      return "";
  }
}

export function truncateValue(value: unknown, maxLength: number): string {
  if (typeof value === "string") {
    if (value.length > maxLength) {
      return value.slice(0, maxLength - 3) + "...";
    }
    return value;
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > maxLength) {
    return serialized.slice(0, maxLength - 3) + "...";
  }
  return serialized;
}

export function formatHeaderTitle(assistantName?: string): string {
  const rawTitle = assistantName?.trim() || "Meet your Assistant!";
  const title = rawTitle.replace(/\s+/g, " ");
  const maxTitleLength = LEFT_PANEL_WIDTH - 2;
  const displayTitle =
    title.length > maxTitleLength
      ? title.slice(0, maxTitleLength - 3) + "..."
      : title;
  return `  ${displayTitle}`;
}

export function formatHeaderEyebrow(): string {
  return "  Assistant";
}

export function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

/** A chunk of an assistant turn in display order: text or a tool call. */
export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "tool"; toolCall: ToolCallInfo };

/**
 * Rebuild a message's display order. The daemon records how segments and tool
 * calls interleaved in the original turn (`contentOrder`); walk it so text
 * that streamed before and after a tool call renders on either side of the
 * tool's box instead of being flattened ahead of every tool call. Falls back
 * to the legacy shape (flat text body, tool calls after) when the payload
 * carries no ordering.
 */
export function buildMessageParts(msg: RuntimeMessage): MessagePart[] {
  const parts: MessagePart[] = [];
  if (msg.contentOrder && msg.contentOrder.length > 0) {
    for (const entry of msg.contentOrder) {
      if (entry.startsWith("text:")) {
        const segment = msg.textSegments?.[Number(entry.slice(5))];
        if (segment && segment.trim().length > 0) {
          parts.push({ kind: "text", text: segment });
        }
      } else if (entry.startsWith("tool:")) {
        const toolCall = msg.toolCalls?.[Number(entry.slice(5))];
        if (toolCall) {
          parts.push({ kind: "tool", toolCall });
        }
      }
      // surface:/thinking:/attachment: entries have no TUI rendering yet.
    }
    if (parts.length > 0) {
      return parts;
    }
  }
  if (msg.content.trim().length > 0) {
    parts.push({ kind: "text", text: msg.content });
  }
  if (msg.role === "assistant" && msg.toolCalls) {
    for (const toolCall of msg.toolCalls) {
      parts.push({ kind: "tool", toolCall });
    }
  }
  return parts;
}

export function isRuntimeMessage(item: FeedItem): item is RuntimeMessage {
  return "role" in item;
}

export function estimateItemHeight(
  item: FeedItem,
  terminalColumns: number,
): number {
  if (isRuntimeMessage(item)) {
    const columns = Math.max(1, terminalColumns);
    const defaultLabel = item.role === "user" ? "You:" : "Assistant:";
    const label = item.label ?? defaultLabel;
    const prefixLength = 10 + label.length + 1;
    let lines = 0;
    const contentLines = item.content.split("\n");
    for (let index = 0; index < contentLines.length; index++) {
      const lineLength =
        index === 0
          ? contentLines[index].length + prefixLength
          : contentLines[index].length;
      lines += Math.max(1, Math.ceil(lineLength / columns));
    }
    if (item.role === "assistant" && item.toolCalls) {
      for (const toolCall of item.toolCalls) {
        // Each tool renders as an opening line, a closing line, and (once the
        // result lands) a single finish line — no per-parameter dump.
        lines +=
          TOOL_CALL_CHROME_LINES + (toolCall.result !== undefined ? 1 : 0);
      }
    }
    return lines + MESSAGE_SPACING;
  }
  if (item.type === "help") {
    return HELP_DISPLAY_HEIGHT;
  }
  if (item.type === "status" || item.type === "error") {
    const columns = Math.max(1, terminalColumns);
    let lines = 0;
    for (const line of item.text.split("\n")) {
      lines += Math.max(1, Math.ceil(line.length / columns));
    }
    return lines;
  }
  return 1;
}

export function calculateHeaderHeight(
  terminalColumns = DEFAULT_TERMINAL_COLUMNS,
): number {
  if (terminalColumns < COMPACT_THRESHOLD) {
    return COMPACT_HEADER_HEIGHT;
  }
  const artLength = HATCH_ART.length;
  const leftLineCount = LEFT_HEADER_LINES + artLength + LEFT_FOOTER_LINES;
  const maxLines = Math.max(leftLineCount, RIGHT_PANEL_LINE_COUNT);
  return maxLines + HEADER_CHROME_LINES;
}
