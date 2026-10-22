import { describe, expect, test } from "bun:test";

import type { DisplayMessage, Surface } from "@/domains/chat/types/types";
import { buildTranscriptItems } from "@/domains/chat/transcript/build-items";
import type {
  MessageItem,
  TranscriptItem,
} from "@/domains/chat/transcript/types";

import { mergeAdjacentAssistantMessages } from "@/domains/chat/utils/message-merge";
import { textBody } from "@/domains/chat/utils/message-test-helpers";
import { isCameraFrameRow } from "./camera-frame-rows";
function makeMessage(
  overrides: Omit<DisplayMessage, "id"> & { id?: string },
): DisplayMessage {
  const { id, ...rest } = overrides;
  return {
    id: id ?? crypto.randomUUID(),
    ...rest,
  };
}

function makeSurface(
  overrides: Partial<Surface> & { surfaceId: string },
): Surface {
  return {
    surfaceType: "test-surface",
    data: {},
    ...overrides,
  };
}

function emptyInput() {
  return {
    messages: [] as DisplayMessage[],
    pendingSecret: null,
    pendingConfirmation: null,
    isThinking: false,
  };
}

function frame(
  id: string,
  overrides: Partial<DisplayMessage> = {},
): DisplayMessage {
  return makeMessage({
    id,
    role: "user",
    ...textBody("(camera frame)"),
    isCameraFrame: true,
    ...overrides,
  });
}

function projectedIds(items: TranscriptItem[]): string[] {
  return items.flatMap((item) => {
    if (item.kind !== "message") {
      return [];
    }
    const frames = item.cameraFrames?.map((frame) => frame.id) ?? [];
    return item.cameraFrames?.length && isCameraFrameRow(item.message)
      ? frames
      : [...frames, item.message.id];
  });
}

describe("camera frame grouping", () => {
  test("folds pending and hydrated frames into the next utterance in chronological order", () => {
    const frames = [
      frame("f1"),
      frame("f2", {
        attachments: [
          {
            id: "att-2",
            filename: "frame.png",
            mimeType: "image/png",
            sizeBytes: 1,
            previewUrl: null,
          },
        ],
      }),
    ];
    const utterance = makeMessage({
      id: "speech",
      role: "user",
      ...textBody("What is this?"),
    });
    const messages = [...frames, utterance];
    const original = structuredClone(messages);
    const items = buildTranscriptItems({ ...emptyInput(), messages });
    expect(items).toEqual([
      {
        kind: "message",
        key: "speech",
        message: utterance,
        cameraFrames: frames,
      },
    ]);
    expect(projectedIds(items)).toEqual(messages.map((message) => message.id));
    expect(messages).toEqual(original);
    expectDistinctNonEmptyKeys(items);
  });

  test("a live tail stays on its first frame and flushes before trailers", () => {
    const frames = [frame("f1"), frame("f2")];
    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: frames,
      isThinking: true,
      pendingSecret: { requestId: "secret-1" },
    });
    expect(items[0]).toEqual({
      kind: "message",
      key: "f1",
      message: frames[0],
      cameraFrames: frames,
    });
    expect(items.map((item) => item.kind)).toEqual([
      "message",
      "thinking",
      "pendingSecret",
    ]);
    expect(projectedIds(items)).toEqual(["f1", "f2"]);
  });

  test.each([
    { name: "assistant", props: { role: "assistant" } },
    { name: "deleted user", props: { deletedAt: 1 } },
    {
      name: "reaction",
      props: {
        reaction: { emoji: "🎉", op: "added", targetMessageId: "target-1" },
      },
    },
    { name: "system card", props: { isSystemCard: true } },
    { name: "silent row", props: { isNoResponse: true } },
    {
      name: "Slack reaction",
      props: {
        slackMessage: {
          channelId: "channel-1",
          channelTs: "1",
          eventKind: "reaction",
        },
      },
    },
  ] satisfies { name: string; props: Partial<DisplayMessage> }[])(
    "flushes before $name even when it carries a camera marker",
    ({ props }) => {
      const before = frame("before");
      const special = frame("special", props);
      const after = frame("after");
      const items = buildTranscriptItems({
        ...emptyInput(),
        messages: [before, special, after],
      });
      expect(items).toHaveLength(3);
      expect(items[0]).toMatchObject({ key: "before", cameraFrames: [before] });
      expect(items[1]).toEqual({
        kind: "message",
        key: "special",
        message: special,
      });
      expect(items[2]).toMatchObject({ key: "after", cameraFrames: [after] });
      expect(projectedIds(items)).toEqual(["before", "special", "after"]);
      expectDistinctNonEmptyKeys(items);
    },
  );

  test.each([
    { isSubagentNotification: true },
    { isAcpNotification: true },
    { isBackgroundEventNotification: true },
    { queueStatus: "queued" },
  ] satisfies Partial<DisplayMessage>[])(
    "skipped rows neither join nor split runs: %j",
    (props) => {
      const before = frame("before");
      const hidden = frame("hidden", props);
      const after = frame("after");
      const items = buildTranscriptItems({
        ...emptyInput(),
        messages: [before, hidden, after],
      });
      expect(items).toEqual([
        {
          kind: "message",
          key: "before",
          message: before,
          cameraFrames: [before, after],
        },
      ]);
      expect(projectedIds(items)).toEqual(["before", "after"]);
    },
  );

  test.each([
    { name: "literal sentinel", props: textBody("(camera frame)") },
    {
      name: "parked spoken frame",
      props: {
        ...textBody("What is this?"),
        attachments: [
          {
            id: "parked",
            filename: "frame.png",
            mimeType: "image/png",
            sizeBytes: 1,
            previewUrl: null,
          },
        ],
      },
    },
    {
      name: "shutter photo",
      props: {
        ...textBody("here's a photo:"),
        attachments: [
          {
            id: "photo",
            filename: "photo.png",
            mimeType: "image/png",
            sizeBytes: 1,
            previewUrl: null,
          },
        ],
      },
    },
    {
      name: "Slack message with neutral reaction",
      props: {
        reaction: { emoji: "🎉", op: "added", targetMessageId: "target-1" },
        slackMessage: {
          channelId: "channel-1",
          channelTs: "1",
          eventKind: "message",
        },
      },
    },
  ] satisfies { name: string; props: Partial<DisplayMessage> }[])(
    "$name adopts earlier frames without becoming a frame",
    ({ props }) => {
      const before = frame("before");
      const host = makeMessage({ id: "host", role: "user", ...props });
      const items = buildTranscriptItems({
        ...emptyInput(),
        messages: [before, host],
      });
      expect(items).toEqual([
        { kind: "message", key: "host", message: host, cameraFrames: [before] },
      ]);
      expect(projectedIds(items)).toEqual(["before", "host"]);
    },
  );

  test("reuses framed items only while every frame reference and the host are unchanged", () => {
    const frames = [frame("f1"), frame("f2"), frame("f3")];
    const host = makeMessage({
      id: "speech",
      role: "user",
      ...textBody("Hello"),
    });
    const build = (messages: DisplayMessage[]) =>
      buildTranscriptItems({ ...emptyInput(), messages });
    const plain = build([host])[0];
    const first = build([...frames, host])[0];
    expect(build([...frames, host])[0]).toBe(first);
    expect(build([host])[0]).toBe(plain);
    expect(first).not.toBe(plain);
    const hydrated: DisplayMessage = {
      ...frames[1]!,
      attachments: [
        {
          id: "hydrated",
          filename: "frame.png",
          mimeType: "image/png",
          sizeBytes: 1,
          previewUrl: null,
        },
      ],
    };
    const next = build([frames[0]!, hydrated, frames[2]!, host])[0];
    expect(next).not.toBe(first);
    expect(next?.key).toBe(first?.key);
    expect(build([frames[0]!, hydrated, frames[2]!, host])[0]).toBe(next);
    expect(build([frames[0]!, hydrated, frames[2]!, { ...host }])[0]).not.toBe(
      next,
    );
    const tail = build(frames)[0];
    expect(build(frames)[0]).toBe(tail);
    expect(build([...frames, frame("f4")])[0]).not.toBe(tail);
    expect(tail).toMatchObject({ cameraFrames: frames });
  });
});

function expectDistinctNonEmptyKeys(items: TranscriptItem[]): void {
  const keys = items.map((i) => i.key);
  for (const key of keys) {
    expect(key.length).toBeGreaterThan(0);
  }
  expect(new Set(keys).size).toBe(keys.length);
}

describe("buildTranscriptItems", () => {
  test("projects plain user + assistant messages into two MessageItems in order", () => {
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hello") });
    const assistant = makeMessage({
      id: "m2",
      role: "assistant",
      ...textBody("Hi"),
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [user, assistant],
    });

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ kind: "message", key: "m1", message: user });
    expect(items[1]).toEqual({
      kind: "message",
      key: "m2",
      message: assistant,
    });
    expectDistinctNonEmptyKeys(items);
  });

  test("excludes subagent-notification messages from the projection but leaves input intact", () => {
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hello") });
    const notification = makeMessage({
      id: "m2",
      role: "user",
      ...textBody('[Subagent "research" completed]'),
      isSubagentNotification: true,
    });
    const assistant = makeMessage({
      id: "m3",
      role: "assistant",
      ...textBody("Hi"),
    });
    const messages = [user, notification, assistant];

    const items = buildTranscriptItems({ ...emptyInput(), messages });

    // The subagent-notification row is never rendered in the transcript...
    expect(items).toEqual([
      { kind: "message", key: "m1", message: user },
      { kind: "message", key: "m3", message: assistant },
    ]);
    // ...but it remains in the input `messages` state so the LLM transcript and
    // subagent-store rehydration still see it (suppression is render-only).
    expect(messages).toHaveLength(3);
    expect(messages[1]).toBe(notification);
  });

  test("excludes acp-notification messages from the projection but leaves input intact", () => {
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hello") });
    const notification = makeMessage({
      id: "m2",
      role: "user",
      ...textBody('[ACP agent "claude" completed]'),
      isAcpNotification: true,
    });
    const assistant = makeMessage({
      id: "m3",
      role: "assistant",
      ...textBody("Hi"),
    });
    const messages = [user, notification, assistant];

    const items = buildTranscriptItems({ ...emptyInput(), messages });

    expect(items).toEqual([
      { kind: "message", key: "m1", message: user },
      { kind: "message", key: "m3", message: assistant },
    ]);
    expect(messages).toHaveLength(3);
    expect(messages[1]).toBe(notification);
  });

  test("excludes background-tool notification messages from the projection but leaves input intact", () => {
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hello") });
    const notification = makeMessage({
      id: "m2",
      role: "user",
      ...textBody(
        '<background_event source="background-tool">Background command completed (id=bg-1, exit=0):</background_event>',
      ),
      isBackgroundEventNotification: true,
    });
    const assistant = makeMessage({
      id: "m3",
      role: "assistant",
      ...textBody("Build finished."),
    });
    const messages = [user, notification, assistant];

    const items = buildTranscriptItems({ ...emptyInput(), messages });

    expect(items).toEqual([
      { kind: "message", key: "m1", message: user },
      { kind: "message", key: "m3", message: assistant },
    ]);
    expect(messages).toHaveLength(3);
    expect(messages[1]).toBe(notification);
  });

  test("emits empty list when there is no state", () => {
    const items = buildTranscriptItems(emptyInput());
    expect(items).toEqual([]);
  });

  test("projects ephemeralMetaResults as tail cards after messages", () => {
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hi") });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [user],
      ephemeralMetaResults: [
        { id: "e1", kind: "clean", text: "Context Cleaned" },
        { id: "e2", kind: "info", text: "Available models" },
      ],
    });

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ kind: "message", key: "m1" });
    expect(items[1]).toMatchObject({ kind: "ephemeralMeta", key: "meta-e1" });
    expect(items[2]).toMatchObject({ kind: "ephemeralMeta", key: "meta-e2" });
    expectDistinctNonEmptyKeys(items);
  });

  test("surfaces on messages are rendered within the message item (no standalone rows)", () => {
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hi") });
    const surface = makeSurface({
      surfaceId: "surf-1",
      display: "inline",
    });
    const assistant = makeMessage({
      role: "assistant",
      ...textBody("See surface"),
      id: "s-assistant",
      surfaces: [surface],
      contentOrder: [
        { type: "text", id: "0" },
        { type: "surface", id: "surf-1" },
      ],
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [user, assistant],
    });

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "message", key: "m1" });
    expect(items[1]).toMatchObject({ kind: "message", key: "s-assistant" });
    expectDistinctNonEmptyKeys(items);
  });

  test("completed surfaces stay on the message (no standalone rows)", () => {
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hi") });
    const completedSurface = makeSurface({
      surfaceId: "done-A",
      completed: true,
      completionSummary: "Done",
    });
    const assistant = makeMessage({
      role: "assistant",
      ...textBody("Ok"),
      id: "s-assistant",
      surfaces: [completedSurface],
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [user, assistant],
    });

    expect(items).toHaveLength(2);
    expect(items[0]!.kind).toBe("message");
    expect(items[1]!.kind).toBe("message");
    expectDistinctNonEmptyKeys(items);
  });

  test("isThinking inserts ThinkingItem first in the trailers", () => {
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hi") });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [user],
      isThinking: true,
    });

    // message, thinking — thinking is the FIRST trailer.
    expect(items.map((i) => i.kind)).toEqual(["message", "thinking"]);
    expect(items[1]).toEqual({
      kind: "thinking",
      key: "thinking",
      active: true,
    });
  });

  test("turnActive keeps an inactive ThinkingItem mounted when isThinking is false", () => {
    const items = buildTranscriptItems({
      ...emptyInput(),
      isThinking: false,
      turnActive: true,
    });

    // The slot exists for the whole in-flight turn (fixed height, no reflow)
    // but is inactive — the render layer fades the label out.
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      kind: "thinking",
      key: "thinking",
      active: false,
    });
  });

  test("no ThinkingItem when neither isThinking nor turnActive", () => {
    const items = buildTranscriptItems({
      ...emptyInput(),
      isThinking: false,
      turnActive: false,
    });

    expect(items).toHaveLength(0);
  });

  test("ThinkingItem includes label when thinkingLabel is provided", () => {
    const items = buildTranscriptItems({
      ...emptyInput(),
      isThinking: true,
      thinkingLabel: "Processing bash results",
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      kind: "thinking",
      key: "thinking",
      active: true,
      label: "Processing bash results",
    });
  });

  test("ThinkingItem omits label when thinkingLabel is null", () => {
    const items = buildTranscriptItems({
      ...emptyInput(),
      isThinking: true,
      thinkingLabel: null,
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      kind: "thinking",
      key: "thinking",
      active: true,
    });
  });

  test("ThinkingItem omits label when thinkingLabel is empty string", () => {
    const items = buildTranscriptItems({
      ...emptyInput(),
      isThinking: true,
      thinkingLabel: "",
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      kind: "thinking",
      key: "thinking",
      active: true,
    });
  });

  test("pendingSecret comes before pendingConfirmation", () => {
    const items = buildTranscriptItems({
      ...emptyInput(),
      pendingSecret: { requestId: "req-s" },
      pendingConfirmation: { requestId: "req-c" },
    });

    expect(items.map((i) => i.kind)).toEqual([
      "pendingSecret",
      "pendingConfirmation",
    ]);
    expect(items[0]).toEqual({
      kind: "pendingSecret",
      key: "secret-req-s",
      requestId: "req-s",
    });
    expect(items[1]).toEqual({
      kind: "pendingConfirmation",
      key: "confirmation-req-c",
      requestId: "req-c",
    });
    expectDistinctNonEmptyKeys(items);
  });

  test("full trailer order: thinking → pendingSecret → pendingConfirmation", () => {
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hi") });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [user],
      isThinking: true,
      pendingSecret: { requestId: "req-s" },
      pendingConfirmation: { requestId: "req-c" },
    });

    expect(items.map((i) => i.kind)).toEqual([
      "message",
      "thinking",
      "pendingSecret",
      "pendingConfirmation",
    ]);
    expectDistinctNonEmptyKeys(items);
  });

  test("every item has a non-empty, distinct key in a mixed transcript", () => {
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hi") });
    const inline1 = makeSurface({ surfaceId: "inline-1", display: "inline" });
    const inline2 = makeSurface({ surfaceId: "inline-2", display: "inline" });
    const assistantA = makeMessage({
      role: "assistant",
      ...textBody("A"),
      id: "s-a",
    });
    const assistantB = makeMessage({
      role: "assistant",
      ...textBody("B"),
      id: "s-b",
      surfaces: [inline1, inline2],
    });

    const items = buildTranscriptItems({
      messages: [user, assistantA, assistantB],
      pendingSecret: { requestId: "req-s" },
      pendingConfirmation: { requestId: "req-c" },
      isThinking: true,
    });

    expectDistinctNonEmptyKeys(items);
  });

  test("message item carries through the underlying DisplayMessage by reference", () => {
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hi") });
    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [user],
    });
    const messageItem = items[0] as MessageItem;
    expect(messageItem.message).toBe(user);
  });

  // ---------------------------------------------------------------------------
  // Phantom tool-only message filter (ATL-659) — pass-through behaviour only
  //
  // The drop-the-phantom logic now lives in `sanitizeDisplayMessages` and is
  // exercised by `sanitize-display-messages.test.ts`. The tests below
  // confirm that `buildTranscriptItems` does NOT mistakenly drop legitimate
  // mixed-tool messages — the positive half of the original spec.
  // ---------------------------------------------------------------------------

  test("mixed messages with unknown tool calls alongside content are kept", () => {
    const mixed = makeMessage({
      role: "user",
      ...textBody("Here is the result."),
      id: "s-mixed",
      toolCalls: [
        {
          id: "tc-1",
          name: "unknown",
          input: {},
          completedAt: 1,
          result: "orphan",
        },
      ],
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [mixed],
    });

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("message");
    expect((items[0] as MessageItem).message).toBe(mixed);
  });

  test("messages with mixed known + unknown tool calls are kept", () => {
    const mixedKnown = makeMessage({
      role: "user",
      ...textBody(""),
      id: "s-mixed-known",
      toolCalls: [
        {
          id: "tc-1",
          name: "unknown",
          input: {},
          completedAt: 1,
          result: "orphan",
        },
        {
          id: "tc-2",
          name: "bash",
          input: { command: "ls" },
          completedAt: 1,
          result: "file.txt",
        },
      ],
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [mixedKnown],
    });

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("message");
    expect((items[0] as MessageItem).message).toBe(mixedKnown);
  });

  test("messages with surfaces are kept even with unknown tool calls", () => {
    const surface = makeSurface({ surfaceId: "surf-1", display: "inline" });
    const mixedSurface = makeMessage({
      role: "user",
      ...textBody(""),
      id: "s-mixed-surface",
      surfaces: [surface],
      toolCalls: [
        {
          id: "tc-1",
          name: "unknown",
          input: {},
          completedAt: 1,
          result: "orphan",
        },
      ],
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [mixedSurface],
    });

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("message");
    expect((items[0] as MessageItem).message).toBe(mixedSurface);
  });

  test("messages with attachments are kept even with unknown tool calls", () => {
    const mixedAttachment = makeMessage({
      role: "user",
      ...textBody(""),
      id: "s-mixed-attachment",
      attachments: [
        {
          id: "a1",
          filename: "test.txt",
          mimeType: "text/plain",
          sizeBytes: 12,
          previewUrl: null,
        },
      ],
      toolCalls: [
        {
          id: "tc-1",
          name: "unknown",
          input: {},
          completedAt: 1,
          result: "orphan",
        },
      ],
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [mixedAttachment],
    });

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("message");
    expect((items[0] as MessageItem).message).toBe(mixedAttachment);
  });

  test("real tool-only messages (known toolName) are kept", () => {
    const realTool = makeMessage({
      role: "user",
      ...textBody(""),
      id: "s-real-tool",
      toolCalls: [
        {
          id: "tc-1",
          name: "bash",
          input: { command: "ls" },
          completedAt: 1,
          result: "file.txt",
        },
      ],
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [realTool],
    });

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("message");
    expect((items[0] as MessageItem).message).toBe(realTool);
  });

  // ---------------------------------------------------------------------------
  // Blank user-row filter — pass-through behaviour only
  //
  // The drop-blank-rows logic now lives in `sanitizeDisplayMessages` and is
  // exercised by `sanitize-display-messages.test.ts`. The tests below
  // confirm that `buildTranscriptItems` does NOT mistakenly drop legitimate
  // user rows whose `content` is empty but which carry segments, surfaces,
  // attachments, or are in a queued state — the positive half of the spec.
  // ---------------------------------------------------------------------------

  test("user rows with non-empty textSegments are kept (even if content is empty)", () => {
    // Some history paths populate textSegments instead of (or in addition to)
    // the flat content field — those rows are meaningful and must render.
    const segmentsOnly = makeMessage({
      role: "user",
      id: "s-segments-only",
      textSegments: ["Hello via segments"],
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [segmentsOnly],
    });

    expect(items).toHaveLength(1);
    expect((items[0] as MessageItem).message).toBe(segmentsOnly);
  });

  test("user rows with slackMessage chip are kept (even if content is empty)", () => {
    const slack = makeMessage({
      role: "user",
      ...textBody(""),
      id: "s-slack",
      slackMessage: {
        channelId: "C123",
        channelTs: "1700000000.000100",
      },
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [slack],
    });

    expect(items).toHaveLength(1);
    expect((items[0] as MessageItem).message).toBe(slack);
  });

  test("queued user rows are omitted from the transcript", () => {
    // The queue drawer is the only visible queue surface. Optimistic queued
    // user rows remain in state so the drawer can render and manage them, but
    // the transcript itself should not add a duplicate queued marker row.
    const queued = makeMessage({
      role: "user",
      ...textBody("Send when ready"),
      id: "s-queued",
      isOptimistic: true,
      queueStatus: "queued",
      queuePosition: 1,
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [queued],
    });

    expect(items).toEqual([]);
  });

  test("assistant blank rows are NOT dropped (filter is user-only)", () => {
    // Assistant rows can legitimately be empty during streaming setup —
    // the streaming layer fills them in. The blank-row filter must not
    // touch them.
    const blankAssistant = makeMessage({
      role: "assistant",
      ...textBody(""),
      id: "s-assistant-blank",
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [blankAssistant],
    });

    expect(items).toHaveLength(1);
    expect((items[0] as MessageItem).message).toBe(blankAssistant);
  });

  // ---------------------------------------------------------------------------
  // MessageItem memoization (WeakMap cache)
  // ---------------------------------------------------------------------------

  test("returns stable MessageItem references for unchanged message objects across calls", () => {
    const m1 = makeMessage({ id: "m1", role: "user", ...textBody("Hello") });
    const m2 = makeMessage({ id: "m2", role: "assistant", ...textBody("Hi") });

    const first = buildTranscriptItems({ ...emptyInput(), messages: [m1, m2] });
    const second = buildTranscriptItems({
      ...emptyInput(),
      messages: [m1, m2],
    });

    expect(first[0]).toBe(second[0]);
    expect(first[1]).toBe(second[1]);
  });

  test("returns a new MessageItem only for the message whose object changed", () => {
    const m1 = makeMessage({ id: "m1", role: "user", ...textBody("Hello") });
    const m2 = makeMessage({ id: "m2", role: "assistant", ...textBody("Hi") });

    const first = buildTranscriptItems({ ...emptyInput(), messages: [m1, m2] });

    // Simulate a streaming token appending to m2 — creates a new object
    const m2Updated = { ...m2, content: "Hi there" };
    const second = buildTranscriptItems({
      ...emptyInput(),
      messages: [m1, m2Updated],
    });

    // m1's item is still the same reference (cache hit)
    expect(second[0]).toBe(first[0]);
    // m2's item is a new reference (cache miss — different object)
    expect(second[1]).not.toBe(first[1]);
    expect((second[1] as MessageItem).message).toBe(m2Updated);
  });

  test("uses clientMessageId as key when available, falls back to id", () => {
    const withClientId = makeMessage({
      id: "server-id-123",
      role: "user",
      ...textBody("Hello"),
      clientMessageId: "client-id-abc",
    });
    const withoutClientId = makeMessage({
      id: "server-id-456",
      role: "assistant",
      ...textBody("Hi"),
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [withClientId, withoutClientId],
    });

    expect(items[0]!.key).toBe("client-id-abc");
    expect(items[1]!.key).toBe("server-id-456");
  });
});

describe("desktop help transcript placement", () => {
  const pendingQuestion = {
    requestId: "request-desktop",
    entries: [
      {
        id: "q1",
        question: "Complete the verification.",
        options: [],
        presentation: "virtual_desktop" as const,
      },
    ],
  };
  const messages = [
    makeMessage({
      id: "assistant-help",
      role: "assistant",
      ...textBody("I need help with verification."),
    }),
  ];

  test("places desktop help after the assistant message and removes it when resolved", () => {
    const items = buildTranscriptItems({
      ...emptyInput(),
      messages,
      pendingQuestion,
    });
    expect(items.map((item) => item.kind)).toEqual([
      "message",
      "pendingDesktopHelp",
    ]);
    expect(items[1]).toMatchObject({
      key: "desktop-help-request-desktop",
      requestId: "request-desktop",
    });
    expect(
      buildTranscriptItems({
        ...emptyInput(),
        messages,
        pendingQuestion: null,
      }).map((item) => item.kind),
    ).toEqual(["message"]);
  });

  test("keeps ordinary questions in the composer", () => {
    const items = buildTranscriptItems({
      ...emptyInput(),
      messages,
      pendingQuestion: {
        ...pendingQuestion,
        entries: [{ id: "q1", question: "Which option?", options: [] }],
      },
    });
    expect(items.map((item) => item.kind)).toEqual(["message"]);
  });
});
