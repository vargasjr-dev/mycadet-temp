import { expect, test } from "bun:test";

import { sql } from "drizzle-orm";

import {
  addMessage,
  createConversation,
  getConversationMessageTail,
  getMessages,
  getRecentConversationMessages,
} from "../conversation-crud.js";
import { getDb } from "../db-connection.js";
import { initializeDb } from "../db-init.js";

await initializeDb();

test("recent conversation rows preserve insertion order at timestamp ties and stay bounded", async () => {
  const conversation = createConversation({ title: "Example task" });
  const other = createConversation({ title: "Other task" });
  const first = await addMessage(conversation.id, "user", "Start work");
  const success = await addMessage(
    conversation.id,
    "assistant",
    "The result is ready",
  );
  const failure = await addMessage(conversation.id, "user", "A sibling failed");
  await addMessage(other.id, "assistant", "Unrelated result");
  getDb().run(
    sql`UPDATE messages SET created_at = 100 WHERE conversation_id = ${conversation.id}`,
  );

  expect(
    getRecentConversationMessages(conversation.id, 2).map((row) => row.id),
  ).toEqual([success.id, failure.id]);
  expect(
    getRecentConversationMessages(conversation.id, 3).map((row) => row.id),
  ).toEqual([first.id, success.id, failure.id]);
  expect(
    getRecentConversationMessages(conversation.id, 2, failure.id).map(
      (row) => row.id,
    ),
  ).toEqual([first.id, success.id]);
});

test("tail read matches getMessages ordering at timestamp ties and stays bounded", async () => {
  const conversation = createConversation({ title: "Tail parity" });
  const other = createConversation({ title: "Tail parity sibling" });
  const ids: string[] = [];
  for (let i = 0; i < 10; i++) {
    const inserted = await addMessage(
      conversation.id,
      i % 2 === 0 ? "user" : "assistant",
      `message ${i}`,
    );
    ids.push(inserted.id);
  }
  await addMessage(other.id, "assistant", "unrelated row");
  // Collapse every row onto one millisecond: ordering must fall back to
  // insertion (rowid) order, exactly as getMessages documents.
  getDb().run(
    sql`UPDATE messages SET created_at = 300 WHERE conversation_id = ${conversation.id}`,
  );

  const all = getMessages(conversation.id).map((row) => row.id);
  expect(all).toEqual(ids);
  expect(
    getConversationMessageTail(conversation.id, 10).map((row) => row.id),
  ).toEqual(ids);
  expect(
    getConversationMessageTail(conversation.id, 3).map((row) => row.id),
  ).toEqual(ids.slice(-3));
  expect(
    getConversationMessageTail(conversation.id, 1).map((row) => row.id),
  ).toEqual(ids.slice(-1));
  // A window wider than the conversation is the whole conversation; the
  // sibling's rows never leak in.
  expect(
    getConversationMessageTail(conversation.id, 100).map((row) => row.id),
  ).toEqual(ids);
});
