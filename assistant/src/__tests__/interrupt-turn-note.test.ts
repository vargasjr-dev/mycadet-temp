/**
 * The message that interrupted a turn carries the note saying what to do about
 * the interruption, on its LLM-facing content only: the persisted row stays
 * exactly what the user typed, so no client renders it, and
 * `interruptedPriorTurn` in the row's metadata is what rebuilds the identical
 * block on every later load.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { reinjectInterruptTurnNote } from "../daemon/conversation-lifecycle.js";
import type { MessagingConversationContext } from "../daemon/conversation-messaging.js";
import { persistQueuedMessageBody } from "../daemon/conversation-messaging.js";
import { createConversation } from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  attachments,
  conversations,
  messageAttachments,
  messages,
} from "../persistence/schema/conversations.js";
import { contentBlockArraySchema } from "../providers/content-block-schema.js";
import { INTERRUPTED_TURN_NOTE_TEXT } from "../util/abort-reasons.js";
import { asConversation } from "./helpers/mock-conversation.js";
import { requireTextBlock } from "./helpers/require-text-block.js";

await initializeDb();

function resetTables() {
  const db = getDb();
  db.delete(messageAttachments).run();
  db.delete(attachments).run();
  db.delete(messages).run();
  db.delete(conversations).run();
}

function makeCtx(conversationId: string): MessagingConversationContext {
  return asConversation({
    conversationId,
    messages: [],
    abortController: null,
    currentRequestId: undefined,
    pendingInterruptNote: false,
    isProcessing: () => false,
    setProcessing: () => {},
    getTurnChannelContext: () => null,
    getTurnInterfaceContext: () => null,
  });
}

function messageRow(id: string): { content: string; metadata: string | null } {
  return getDb()
    .select({ content: messages.content, metadata: messages.metadata })
    .from(messages)
    .where(eq(messages.id, id))
    .get()!;
}

describe("interrupted-turn note on the interrupting message", () => {
  beforeEach(resetTables);

  test("rides on the LLM-facing content while the persisted row stays clean", async () => {
    const conv = createConversation();
    const ctx = makeCtx(conv.id);
    ctx.pendingInterruptNote = true;

    const persisted = await persistQueuedMessageBody(ctx, {
      content: "wait, quick one first: what is 31 times 12?",
    });

    const llmContent = ctx.messages[0].content;
    expect(llmContent.at(-1)).toEqual({
      type: "text",
      text: INTERRUPTED_TURN_NOTE_TEXT,
    });
    expect(llmContent[0]).toEqual({
      type: "text",
      text: "wait, quick one first: what is 31 times 12?",
    });

    const row = messageRow(persisted.id);
    expect(row.content).not.toContain("interrupted_turn");
    expect(JSON.parse(row.content)).toEqual([
      { type: "text", text: "wait, quick one first: what is 31 times 12?" },
    ]);
    expect(JSON.parse(row.metadata!).interruptedPriorTurn).toBe(true);
  });

  test("history reload rebuilds the identical block", async () => {
    const conv = createConversation();
    const ctx = makeCtx(conv.id);
    ctx.pendingInterruptNote = true;

    const persisted = await persistQueuedMessageBody(ctx, {
      content: "hold on",
    });
    const live = ctx.messages[0].content.at(-1);

    const row = messageRow(persisted.id);
    const rebuilt = reinjectInterruptTurnNote(
      contentBlockArraySchema.parse(JSON.parse(row.content)),
      "user",
      row.metadata,
    );

    expect(rebuilt.at(-1)).toEqual(live);
    expect(rebuilt).toHaveLength(2);
  });

  test("an ordinary send carries no note", async () => {
    const conv = createConversation();
    const ctx = makeCtx(conv.id);

    const persisted = await persistQueuedMessageBody(ctx, {
      content: "just a message",
    });

    const llmContent = ctx.messages[0].content;
    expect(llmContent).toHaveLength(1);

    const row = messageRow(persisted.id);
    expect(
      JSON.parse(row.metadata ?? "{}").interruptedPriorTurn,
    ).toBeUndefined();
    expect(
      reinjectInterruptTurnNote(
        contentBlockArraySchema.parse(JSON.parse(row.content)),
        "user",
        row.metadata,
      ),
    ).toHaveLength(1);
  });

  test("the flag is consumed once, so the next message is untouched", async () => {
    const conv = createConversation();
    const ctx = makeCtx(conv.id);
    ctx.pendingInterruptNote = true;

    await persistQueuedMessageBody(ctx, { content: "first" });
    await persistQueuedMessageBody(ctx, { content: "second" });

    expect(ctx.pendingInterruptNote).toBe(false);
    expect(ctx.messages[0].content).toHaveLength(2);
    expect(ctx.messages[1].content).toHaveLength(1);
  });

  test("the note sits after the attachment annotations, live and reloaded", async () => {
    const conv = createConversation();
    const ctx = makeCtx(conv.id);
    ctx.pendingInterruptNote = true;

    // "aGVsbG8=" = "hello"
    const persisted = await persistQueuedMessageBody(ctx, {
      content: "look at this instead",
      attachments: [
        { filename: "report.csv", mimeType: "text/csv", data: "aGVsbG8=" },
      ],
    });

    const llmContent = ctx.messages[0].content;
    const note = requireTextBlock(llmContent.at(-1));
    const annotation = requireTextBlock(llmContent.at(-2));
    expect(note).toHaveProperty("text", INTERRUPTED_TURN_NOTE_TEXT);
    expect(annotation).toHaveProperty(
      "text",
      expect.stringContaining("is stored at:"),
    );

    const row = messageRow(persisted.id);
    expect(row.content).not.toContain("interrupted_turn");
    expect(JSON.parse(row.metadata!).interruptedPriorTurn).toBe(true);
  });

  test("an assistant row is never annotated", () => {
    expect(
      reinjectInterruptTurnNote(
        [{ type: "text", text: "on it." }],
        "assistant",
        JSON.stringify({ interruptedPriorTurn: true }),
      ),
    ).toHaveLength(1);
  });
});
