/**
 * The attention list's `latestAssistantSnippet` is a user-facing preview of
 * the assistant row's own text: the newest row with content wins, walking
 * back over content-less rows inside the turn.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { MessageRow } from "../../../persistence/conversation-crud.js";
import * as conversationCrud from "../../../persistence/conversation-crud.js";
import { resolveAssistantSnippet } from "../conversation-attention-routes.js";

let rows: MessageRow[] = [];
const spies: Array<{ mockRestore: () => void }> = [];

function row(
  id: string,
  content: unknown[],
  metadata: string | null = null,
): MessageRow {
  return {
    id,
    conversationId: "conv-1",
    role: "assistant",
    content,
    createdAt: Date.now(),
    metadata,
  } as unknown as MessageRow;
}

beforeEach(() => {
  rows = [];
  spies.push(
    spyOn(conversationCrud, "getMessageById").mockImplementation(
      (id: string) => rows.find((r) => r.id === id) ?? null,
    ),
    spyOn(conversationCrud, "getAssistantMessageIdsInTurn").mockImplementation(
      () => rows.map((r) => r.id),
    ),
  );
});

afterEach(() => {
  for (const spy of spies.splice(0)) {
    spy.mockRestore();
  }
});

describe("latestAssistantSnippet", () => {
  test("an ordinary row is read from itself alone", () => {
    // No walk-back for an unmarked row: the latest row is the preview, as
    // before.
    rows = [
      row("a1", [{ type: "text", text: "earlier answer" }]),
      row("a2", [{ type: "tool_use", id: "t", name: "bash", input: {} }]),
    ];

    expect(resolveAssistantSnippet("a2")).toContain("Tool use (bash)");
  });

  test("an ordinary row with text quotes that text", () => {
    rows = [row("a1", [{ type: "text", text: "Here is your answer." }])];

    expect(resolveAssistantSnippet("a1")).toBe("Here is your answer.");
  });
});
