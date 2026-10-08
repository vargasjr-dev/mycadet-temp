import { describe, expect, test } from "bun:test";
import type { ConversationMessageToolCall } from "@mycadet/assistant-api";
import {
  calculateHeaderHeight,
  estimateItemHeight,
  formatConfirmationPreview,
  formatHeaderEyebrow,
  formatHeaderTitle,
  formatTimestamp,
  formatToolCallPreview,
  stripAnsi,
  truncateValue,
  buildMessageParts,
  type RuntimeMessage,
} from "../lib/default-main-screen-formatting.js";

function message(overrides: Partial<RuntimeMessage> = {}): RuntimeMessage {
  return {
    id: "message-1",
    role: "user",
    content: "Hello",
    timestamp: "2026-09-29T16:00:00.000Z",
    ...overrides,
  };
}

function toolCall(
  overrides: Partial<ConversationMessageToolCall> = {},
): ConversationMessageToolCall {
  return {
    name: "file_read",
    input: { path: "/a" },
    ...overrides,
  };
}

function surfaceStub() {
  return {
    surfaceId: "surface-1",
    surfaceType: "card",
    data: {},
  };
}

function attachmentStub() {
  return {
    id: "attachment-1",
    filename: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 12,
    kind: "file",
  };
}

describe("formatTimestamp", () => {
  test("formats a timestamp with hour and minute fields", () => {
    const timestamp = "2026-09-29T16:05:00.000Z";

    expect(formatTimestamp(timestamp)).toBe(
      new Date(timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
  });
});

describe("tool-call previews", () => {
  test("formats known tool inputs", () => {
    expect(
      formatToolCallPreview({
        name: "file_read",
        input: { path: "/workspace/report.txt" },
      }),
    ).toBe("read /workspace/report.txt");
    expect(
      formatToolCallPreview({
        name: "browser_click",
        input: { element_id: "submit-button" },
      }),
    ).toBe("click submit-button");
    expect(
      formatConfirmationPreview("browser_press_key", { key: "Enter" }),
    ).toBe('press "Enter"');
  });

  test("truncates long preview fields at their existing limits", () => {
    expect(
      formatToolCallPreview({
        name: "bash",
        input: { command: "x".repeat(90) },
      }),
    ).toBe("x".repeat(80));
    expect(
      formatToolCallPreview({
        name: "browser_type",
        input: { selector: "y".repeat(70) },
      }),
    ).toBe(`type into ${"y".repeat(60)}`);
  });

  test("serializes unknown tool inputs", () => {
    // Tool boxes render name-only (the feed shows what ran, not its payload);
    // the approval dialog keeps the JSON detail.
    expect(
      formatToolCallPreview({ name: "custom_tool", input: { value: 7 } }),
    ).toBe("");
    expect(formatConfirmationPreview("custom_tool", { value: 7 })).toBe(
      'custom_tool: {"value":7}',
    );
  });
});

describe("truncateValue", () => {
  test("returns values that fit without changing them", () => {
    expect(truncateValue("short", 8)).toBe("short");
    expect(truncateValue({ ok: true }, 20)).toBe('{"ok":true}');
  });

  test("adds an ellipsis within the requested maximum length", () => {
    expect(truncateValue("abcdefghij", 8)).toBe("abcde...");
    expect(truncateValue({ value: "abcdefghij" }, 12)).toBe('{"value":...');
  });
});

describe("header formatting", () => {
  test("uses the default title and eyebrow", () => {
    expect(formatHeaderEyebrow()).toBe("  Assistant");
    expect(formatHeaderTitle()).toBe("  Meet your Assistant!");
  });

  test("normalizes title whitespace", () => {
    expect(formatHeaderTitle("  Example\n  Assistant  ")).toBe(
      "  Example Assistant",
    );
  });

  test("truncates titles to the left panel width", () => {
    const title = formatHeaderTitle("A".repeat(40));

    expect(title).toBe(`  ${"A".repeat(31)}...`);
    expect(title).toHaveLength(36);
  });

  test("strips ANSI color and style sequences from header art", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m plain")).toBe("red plain");
  });
});

describe("estimateItemHeight", () => {
  test("accounts for message prefixes, wrapping, and spacing", () => {
    expect(estimateItemHeight(message({ content: "abcdefghij" }), 10)).toBe(4);
    expect(estimateItemHeight(message({ content: "a\nb" }), 80)).toBe(3);
  });

  test("accounts for tool-call chrome and results", () => {
    expect(
      estimateItemHeight(
        message({
          role: "assistant",
          content: "",
          contentBlocks: [
            { type: "tool_use", toolCall: toolCall({ result: "done" }) },
          ],
        }),
        80,
      ),
    ).toBe(4);
  });

  test("estimates non-message feed items", () => {
    expect(estimateItemHeight({ type: "help" }, 80)).toBe(5);
    expect(estimateItemHeight({ type: "status", text: "123456\n12" }, 5)).toBe(
      3,
    );
    expect(estimateItemHeight({ type: "spinner", text: "Working" }, 80)).toBe(
      1,
    );
  });
});

describe("calculateHeaderHeight", () => {
  test("uses one row in compact terminals", () => {
    expect(calculateHeaderHeight(59)).toBe(1);
  });

  test("uses the larger of the art and right-panel layouts", () => {
    expect(calculateHeaderHeight(80)).toBe(18);
  });

  test("defaults to the standard terminal width", () => {
    expect(calculateHeaderHeight()).toBe(18);
  });
});

describe("buildMessageParts", () => {
  test("walks content blocks in wire order", () => {
    const msg = message({
      role: "assistant",
      contentBlocks: [
        { type: "text", text: "Hello there." },
        { type: "tool_use", toolCall: toolCall() },
        { type: "text", text: "Back again." },
      ],
    });

    expect(buildMessageParts(msg)).toEqual([
      { kind: "text", text: "Hello there." },
      { kind: "tool", toolCall: toolCall() },
      { kind: "text", text: "Back again." },
    ]);
  });

  test("falls back to the flat body for CLI-local rows", () => {
    const user = message({ content: "plain body" });
    expect(buildMessageParts(user)).toEqual([
      { kind: "text", text: "plain body" },
    ]);
  });

  test("skips blank text and blocks the TUI does not render", () => {
    const msg = message({
      role: "assistant",
      contentBlocks: [
        { type: "text", text: "  " },
        { type: "thinking", thinking: "hmm" },
        { type: "surface", surface: surfaceStub() },
        { type: "attachment", attachment: attachmentStub() },
        { type: "text", text: "visible" },
      ],
    });

    expect(buildMessageParts(msg)).toEqual([
      { kind: "text", text: "visible" },
    ]);
  });
});
