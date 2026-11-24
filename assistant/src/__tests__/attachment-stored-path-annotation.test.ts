/**
 * Regression: re-uploading a document with the same filename must not leave
 * the model pointing at the older upload. Storage resolves the collision with
 * a -2/-3 suffix in the conversation's attachments/ directory, so the
 * LLM-facing user message (and the metadata used to rebuild it on history
 * reload) must carry the resolved stored path of every linked attachment —
 * otherwise the model's only on-disk handle is the original filename, which
 * stays bound to the oldest upload.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { reinjectAttachmentPathAnnotations } from "../daemon/conversation-lifecycle.js";
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
import type { ContentBlock } from "../providers/types.js";
import { asConversation } from "./helpers/mock-conversation.js";

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
    isProcessing: () => false,
    setProcessing: () => {},
    getTurnChannelContext: () => null,
    getTurnInterfaceContext: () => null,
  });
}

const attachmentMetadataSchema = z.object({
  attachmentStoredPaths: z.record(z.string(), z.string()).optional(),
});

function textBlock(block: ContentBlock | undefined) {
  if (block?.type !== "text") {
    throw new Error("Expected a text annotation");
  }
  return block;
}

function lastAnnotationBlock(ctx: MessagingConversationContext) {
  return textBlock(ctx.messages.at(-1)?.content.at(-1));
}

function readMessage(id: string) {
  return getDb().select().from(messages).where(eq(messages.id, id)).get()!;
}

function readLatestMessage() {
  return getDb()
    .select()
    .from(messages)
    .orderBy(desc(messages.createdAt))
    .get()!;
}

describe("persistQueuedMessageBody stored path annotations", () => {
  beforeEach(resetTables);

  test("same-named re-upload annotates the resolved -2 path", async () => {
    const conv = createConversation();
    const ctx = makeCtx(conv.id);

    // "aGVsbG8=" = "hello", "d29ybGQ=" = "world"
    const first = await persistQueuedMessageBody(ctx, {
      content: "here is my file",
      attachments: [
        { filename: "report.csv", mimeType: "text/csv", data: "aGVsbG8=" },
      ],
    });
    const second = await persistQueuedMessageBody(ctx, {
      content: "I edited it, take another look",
      attachments: [
        { filename: "report.csv", mimeType: "text/csv", data: "d29ybGQ=" },
      ],
    });

    // Second turn's persisted metadata records the collision-suffixed copy.
    const row = readMessage(second.id);
    const meta = attachmentMetadataSchema.parse(JSON.parse(row.metadata!));
    const storedPath = meta.attachmentStoredPaths!["0:report.csv"];
    expect(storedPath.endsWith("report-2.csv")).toBe(true);
    expect(readFileSync(storedPath).toString()).toBe("world");

    // The in-memory LLM message points at that copy, not the original name.
    const annotation = lastAnnotationBlock(ctx);
    expect(annotation.type).toBe("text");
    expect(annotation.text).toBe(
      `[Attachment "report.csv" is stored at: ${storedPath}]`,
    );

    // The first turn's annotation still points at the unsuffixed original.
    const firstRow = readMessage(first.id);
    const firstMeta = attachmentMetadataSchema.parse(
      JSON.parse(firstRow.metadata!),
    );
    const firstStoredPath = firstMeta.attachmentStoredPaths!["0:report.csv"];
    expect(firstStoredPath.endsWith("report.csv")).toBe(true);
    expect(firstStoredPath.endsWith("report-2.csv")).toBe(false);
    expect(readFileSync(firstStoredPath).toString()).toBe("hello");

    // History-reload parity: reinjection rebuilds the identical block.
    const rebuilt = reinjectAttachmentPathAnnotations(
      [{ type: "text", text: "I edited it, take another look" }],
      "user",
      row.metadata,
    );
    const rebuiltBlock = textBlock(rebuilt.at(-1));
    expect(rebuiltBlock.text).toBe(annotation.text);
  });

  test("offloaded oversized text records its stored path for history reload", async () => {
    const conv = createConversation();
    const ctx = makeCtx(conv.id);
    const original = "x".repeat(8_000_001);

    await persistQueuedMessageBody(ctx, { content: original });

    const row = readLatestMessage();
    const meta = attachmentMetadataSchema.parse(JSON.parse(row.metadata!));
    const storedPaths = Object.values(meta.attachmentStoredPaths ?? {});
    expect(storedPaths).toHaveLength(1);
    const filename = basename(storedPaths[0]!);
    expect(filename.startsWith("oversized-content-")).toBe(true);
    expect(filename.endsWith(".txt")).toBe(true);
    expect(readFileSync(storedPaths[0]!).toString("utf8")).toBe(original);

    const annotation = lastAnnotationBlock(ctx);
    expect(annotation.text).toBe(
      `[Attachment "${filename}" is stored at: ${storedPaths[0]}]`,
    );

    const persisted = contentBlockArraySchema.parse(JSON.parse(row.content));
    const rebuilt = reinjectAttachmentPathAnnotations(
      persisted,
      "user",
      row.metadata,
    );
    const rebuiltBlock = textBlock(rebuilt.at(-1));
    expect(rebuiltBlock.text).toBe(annotation.text);
  });

  test("two oversized messages in one conversation get distinct filenames", async () => {
    const conv = createConversation();
    const ctx = makeCtx(conv.id);

    await persistQueuedMessageBody(ctx, { content: "a".repeat(8_000_001) });
    await persistQueuedMessageBody(ctx, { content: "b".repeat(8_000_001) });

    const first = textBlock(ctx.messages[0].content.at(-1));
    const second = textBlock(ctx.messages[1].content.at(-1));
    expect(first.text).toContain("oversized-content-");
    expect(second.text).toContain("oversized-content-");
    expect(first.text).not.toBe(second.text);
  });

  test("display-only offload is not named on the model-facing list", async () => {
    const conv = createConversation();
    const ctx = makeCtx(conv.id);
    const display = "y".repeat(8_000_001);

    await persistQueuedMessageBody(ctx, {
      content: "fenced model copy",
      displayContent: display,
    });

    const llmContent = ctx.messages[0].content;
    expect(JSON.stringify(llmContent)).not.toContain("oversized-content-");
    expect(JSON.stringify(llmContent)).toContain("fenced model copy");
    expect(JSON.stringify(llmContent)).not.toContain(display);

    const row = readLatestMessage();
    const meta = attachmentMetadataSchema.parse(JSON.parse(row.metadata!));
    expect(meta.attachmentStoredPaths).toBeUndefined();
  });

  test("messages without attachments get no annotation block", async () => {
    const conv = createConversation();
    const ctx = makeCtx(conv.id);

    await persistQueuedMessageBody(ctx, { content: "just text" });

    expect(ctx.messages).toHaveLength(1);
    const content = ctx.messages[0].content;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
  });
});
