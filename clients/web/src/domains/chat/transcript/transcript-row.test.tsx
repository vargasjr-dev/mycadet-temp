/**
 * `TranscriptRow`'s dispatch tests: which shell a row's kind renders through.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { displayReactionEmoji } from "@/domains/chat/transcript/transcript-message-body-shared";
import { TranscriptRow } from "@/domains/chat/transcript/transcript-row";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { textBody } from "@/domains/chat/utils/message-test-helpers";

afterEach(() => {
  cleanup();
});

describe("TranscriptRow reaction dispatch", () => {
  test("a neutral reaction row renders the reaction line in the shell, never the sentinel", () => {
    const message: DisplayMessage = {
      id: "m-react",
      role: "assistant",
      ...textBody("[reaction]"),
      reaction: {
        emoji: "🎉",
        op: "added",
        targetMessageId: "555.1",
        selfAuthored: true,
      },
    };
    const { getByTestId, queryByText, container } = render(
      <TranscriptRow
        item={{ kind: "message", key: "m-react", message }}
        onSurfaceAction={() => {}}
      />,
    );
    expect(getByTestId("reaction-line-row")).toBeTruthy();
    expect(getByTestId("reaction-line-row").textContent).toContain("🎉");
    expect(queryByText("[reaction]")).toBeNull();
    expect(container.querySelector("#msg-m-react")).toBeTruthy();
  });

  test("a Discord custom emoji renders as its shortcode name, never raw markup", () => {
    const message: DisplayMessage = {
      id: "m-react-custom",
      role: "assistant",
      reaction: {
        emoji: "<:vex:12345>",
        op: "added",
        targetMessageId: "555.2",
        selfAuthored: true,
      },
    };
    const { getByTestId } = render(
      <TranscriptRow
        item={{ kind: "message", key: "m-react-custom", message }}
        onSurfaceAction={() => {}}
      />,
    );
    const text = getByTestId("reaction-line-row").textContent ?? "";
    expect(text).toContain(":vex:");
    expect(text).not.toContain("<:vex:12345>");
  });

  test("a custom emoji sharing a catalog name keeps its identity", () => {
    // A Discord custom emoji named like a catalog shortcode is a distinct
    // guild emoji; the display must stay ":name:" and never swap into the
    // unrelated standard emoji once the catalog loads.
    // What the adapter said wins.
    expect(
      displayReactionEmoji({
        emoji: "tada",
        emojiKind: "unicode",
        emojiName: "🎉",
      }),
    ).toBe("🎉");
    expect(
      displayReactionEmoji({
        emoji: "<:heart:99>",
        emojiKind: "custom",
        emojiName: "heart",
      }),
    ).toBe(":heart:");
    expect(
      displayReactionEmoji({
        emoji: "blob_wave",
        emojiKind: "shortcode",
        emojiName: "blob_wave",
      }),
    ).toBe(":blob_wave:");
    // A spelling-only row classifies through the contract's grammar.
    expect(displayReactionEmoji({ emoji: "<:heart:99>" })).toBe(":heart:");
    expect(displayReactionEmoji({ emoji: "tada" })).toBe(":tada:");
    expect(displayReactionEmoji({ emoji: "🎉" })).toBe("🎉");
  });
});

describe("TranscriptRow deliberate-silence dispatch", () => {
  test("an isNoResponse message renders the quiet marker in the message shell", () => {
    // The wire shape: the route strips sentinel text from projected content,
    // so a silent row arrives with the flag and no text. The marker must not
    // depend on content, and the shell must keep the row addressable.
    const message: DisplayMessage = {
      id: "m-silent",
      role: "assistant",
      isNoResponse: true,
    };
    const { getByTestId, container } = render(
      <TranscriptRow
        item={{ kind: "message", key: "m-silent", message }}
        onSurfaceAction={() => {}}
      />,
    );
    expect(getByTestId("no-response-row")).toBeTruthy();
    expect(container.querySelector("#msg-m-silent")).toBeTruthy();
    expect(
      container.querySelector('[data-message-id="m-silent"]'),
    ).toBeTruthy();
  });

  test("a flagged row that still carries sentinel text never renders it", () => {
    const message: DisplayMessage = {
      id: "m-silent-2",
      role: "assistant",
      ...textBody("<no_response/>"),
      isNoResponse: true,
    };
    const { queryByText } = render(
      <TranscriptRow
        item={{ kind: "message", key: "m-silent-2", message }}
        onSurfaceAction={() => {}}
      />,
    );
    expect(queryByText("<no_response/>")).toBeNull();
  });
});

describe("TranscriptRow channel-deletion dispatch", () => {
  test("a deleted row renders the tombstone in the message shell, never its content", () => {
    // The route keeps the stored content, so the tombstone must
    // not depend on the content being absent.
    const message: DisplayMessage = {
      id: "m-deleted",
      role: "user",
      ...textBody("the text Slack no longer shows"),
      deletedAt: 1725100001000,
    };
    const { getByTestId, queryByText, container } = render(
      <TranscriptRow
        item={{ kind: "message", key: "m-deleted", message }}
        onSurfaceAction={() => {}}
      />,
    );
    expect(getByTestId("deleted-message-row")).toBeTruthy();
    expect(queryByText("the text Slack no longer shows")).toBeNull();
    expect(container.querySelector("#msg-m-deleted")).toBeTruthy();
    expect(
      container.querySelector('[data-message-id="m-deleted"]'),
    ).toBeTruthy();
  });

  test("deletion wins over the Slack-shaped and reaction renderings", () => {
    const message: DisplayMessage = {
      id: "m-deleted-slack",
      role: "assistant",
      ...textBody("a reply later removed"),
      deletedAt: 1725100001000,
      slackMessage: {
        channelId: "C1",
        channelTs: "1725100000.000100",
        eventKind: "message",
      },
      reaction: {
        emoji: "🎉",
        op: "added",
        targetMessageId: "555.1",
        selfAuthored: true,
      },
    };
    const { getByTestId, queryByTestId, queryByText } = render(
      <TranscriptRow
        item={{ kind: "message", key: "m-deleted-slack", message }}
        onSurfaceAction={() => {}}
      />,
    );
    expect(getByTestId("deleted-message-row")).toBeTruthy();
    expect(queryByTestId("reaction-line-row")).toBeNull();
    expect(queryByText("a reply later removed")).toBeNull();
  });
});

describe("the turn-status slot's own word for the wait", () => {
  const thinkingItem = {
    kind: "thinking" as const,
    key: "thinking",
    active: true,
  };

  function renderSlot() {
    return render(
      <TranscriptRow item={thinkingItem} onSurfaceAction={() => {}} />,
    );
  }

  test("says Thinking by default", () => {
    const { getByTestId } = renderSlot();
    expect(getByTestId("transcript-thinking-row").textContent).toBe("Thinking");
  });

  function renderLabelled() {
    return render(
      <TranscriptRow
        item={{ ...thinkingItem, label: "Processing bash results" }}
        onSurfaceAction={() => {}}
      />,
    );
  }

  test("keeps a daemon-supplied label by default", () => {
    const { getByTestId } = renderLabelled();
    expect(getByTestId("transcript-thinking-row").textContent).toBe(
      "Processing bash results",
    );
  });
});
