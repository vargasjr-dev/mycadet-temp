import {
  type ConversationContentBlock,
  type ConversationMessageToolCall,
} from "@mycadet/assistant-api";

import { HATCH_ART } from "./constants.js";

export const LEFT_PANEL_WIDTH = 36;
export const DEFAULT_TERMINAL_COLUMNS = 80;
export const COMPACT_THRESHOLD = 60;

const LEFT_HEADER_LINES = 3;
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

/**
 * Kept in sync with the web client's command set
 * (clients/web slash-command-catalog) plus the CLI-local commands.
 */
export const HELP_COMMANDS = [
  {
    command: "/btw <question>",
    description: "Ask a side question while the assistant is working",
  },
  {
    command: "/config [path] [value]",
    description: "Read or set a runtime config value",
  },
  {
    command: "/clean",
    description: "Strip injected runtime context from the conversation",
  },
  {
    command: "/commands",
    description: "List all available commands",
  },
  {
    command: "/compact",
    description: "Force context compaction immediately",
  },
  {
    command: "/models",
    description: "List all available models",
  },
  {
    command: "/status",
    description: "Show conversation status and context usage",
  },
  {
    command: "/clear",
    description: "Clear the screen",
  },
  {
    command: "/quit, /exit, /q",
    description: "Disconnect and exit",
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

export interface RuntimeMessage {
  id: string;
  role: "user" | "assistant";
  /**
   * Flat body for rows the CLI built locally (optimistic user sends). Rows
   * from the daemon carry their content in `contentBlocks` instead and leave
   * this unset.
   */
  content?: string;
  /**
   * Unified ordered content from the daemon (`ConversationContentBlock[]`):
   * text runs and tool invocations (with their paired results) in display
   * order — the same single list the web client maps.
   */
  contentBlocks?: ConversationContentBlock[];
  timestamp: string;
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

export function formatToolCallPreview(
  toolCall: ConversationMessageToolCall,
): string {
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
  const rawTitle = assistantName?.trim() || "Meet your Cadet!";
  const title = rawTitle.replace(/\s+/g, " ");
  const maxTitleLength = LEFT_PANEL_WIDTH - 2;
  const displayTitle =
    title.length > maxTitleLength
      ? title.slice(0, maxTitleLength - 3) + "..."
      : title;
  return `  ${displayTitle}`;
}

export function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

/** A chunk of a turn in display order: text or a tool invocation. */
export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "tool"; toolCall: ConversationMessageToolCall };

/**
 * Flatten a message into display-ordered parts by walking its
 * `contentBlocks` — the same unified list the web client maps, already
 * ordered and with tool results pre-paired by the daemon. Thinking, surface,
 * and attachment blocks have no TUI rendering yet and are skipped. Rows the
 * CLI built locally (optimistic user sends) carry only the flat `content`
 * body, so that becomes the single text part.
 */
export function buildMessageParts(msg: RuntimeMessage): MessagePart[] {
  const parts: MessagePart[] = [];
  for (const block of msg.contentBlocks ?? []) {
    if (block.type === "text") {
      if (block.text.trim().length > 0) {
        parts.push({ kind: "text", text: block.text });
      }
    } else if (block.type === "tool_use") {
      parts.push({ kind: "tool", toolCall: block.toolCall });
    }
  }
  if (parts.length > 0) {
    return parts;
  }
  if (msg.content?.trim()) {
    parts.push({ kind: "text", text: msg.content });
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
    let seenText = false;
    for (const part of buildMessageParts(item)) {
      if (part.kind === "text") {
        // The first text part renders inline after the label (its first line
        // carries the prefix); later parts render flush-left on their own.
        const contentLines = part.text.split("\n");
        for (let index = 0; index < contentLines.length; index++) {
          const lineLength =
            index === 0 && !seenText
              ? contentLines[index].length + prefixLength
              : contentLines[index].length;
          lines += Math.max(1, Math.ceil(lineLength / columns));
        }
        seenText = true;
      } else {
        // Each tool renders as an opening line, a closing line, and (once
        // the result lands) a single finish line — no per-parameter dump.
        lines +=
          TOOL_CALL_CHROME_LINES + (part.toolCall.result !== undefined ? 1 : 0);
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
