/**
 * `cadet conversations export` writes a transcript a person reads: each row
 * contributes its blocks rendered through the shared formatter, and the
 * markdown and JSON exports carry the same rows.
 */

import { describe, expect, mock, test } from "bun:test";

const CONVERSATION = {
  id: "conv-export",
  title: "Export me",
  createdAt: 1,
  updatedAt: 2,
};

const messages = [
  {
    id: "m1",
    role: "user",
    content: [{ type: "text", text: "what is on my calendar?" }],
    metadata: null,
    createdAt: 1,
  },
  {
    id: "m2",
    role: "assistant",
    content: [
      { type: "text", text: "You have two meetings today." },
      { type: "tool_use", id: "tu_1", name: "bash", input: { command: "cal" } },
    ],
    metadata: null,
    createdAt: 2,
  },
  {
    id: "m3",
    role: "assistant",
    content: [{ type: "text", text: "an ordinary reply" }],
    metadata: null,
    createdAt: 3,
  },
];

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realCrud = require("../../../persistence/conversation-crud.js");
mock.module("../../../persistence/conversation-crud.js", () => ({
  ...realCrud,
  isConversationProcessing: () => false,
  getConversation: () => CONVERSATION,
  getMessages: () => messages,
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realQueries = require("../../../persistence/conversation-queries.js");
mock.module("../../../persistence/conversation-queries.js", () => ({
  ...realQueries,
  listConversations: () => [CONVERSATION],
}));

const { ROUTES } = await import("../conversation-cli-routes.js");

function exportHandler() {
  const route = ROUTES.find((r) => r.endpoint === "conversations/cli/export");
  if (!route) {
    throw new Error("export route not registered");
  }
  return route.handler;
}

describe("conversation export", () => {
  test("markdown export carries each row's rendered blocks", async () => {
    const result = (await exportHandler()({
      body: { conversationId: CONVERSATION.id, format: "md" },
    })) as { output: string };

    expect(result.output).toContain("# Export me");
    expect(result.output).toContain("what is on my calendar?");
    expect(result.output).toContain("You have two meetings today.");
    expect(result.output).toContain("[Tool: bash]");
    expect(result.output).toContain("an ordinary reply");
  });

  test("json export carries the same rows", async () => {
    const result = (await exportHandler()({
      body: { conversationId: CONVERSATION.id, format: "json" },
    })) as { output: string };

    expect(result.output).toContain("You have two meetings today.");
    expect(result.output).toContain("what is on my calendar?");
    expect(result.output).toContain("an ordinary reply");
  });
});
