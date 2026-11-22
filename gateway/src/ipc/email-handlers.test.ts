/**
 * The email IPC methods the daemon's email tool calls: list the plugin
 * lane's history and thread a reply. Failures mirror HTTP-style statuses so
 * the relay surfaces 4xx user-errors instead of opaque transport failures.
 */

import { beforeAll, describe, expect, it, mock } from "bun:test";

import "../__tests__/test-preload.js";

const sendResendReplyMock = mock<
  (apiKey: string, input: import("../email/reply-sender.js").ProviderReplyInput) => Promise<string | null>
>(() => Promise.resolve("<reply-1@resend.dev>"));

mock.module("../email/reply-sender.js", () => ({
  sendResendReply: sendResendReplyMock,
  sendMailgunReply: mock(() => Promise.resolve("<reply-1@mailgun.dev>")),
}));

// Import after mocks are registered
const { emailRoutes } = await import("./email-handlers.js");
const { IpcHandlerError } = await import("./assistant-client.js");
type IpcHandlerErrorType = InstanceType<typeof IpcHandlerError>;
const { recordInboundEmail, ensureEmailReplyToken } = await import(
  "../db/email-message-store.js"
);
const { initGatewayDb, resetGatewayDb } = await import(
  "../db/connection.js"
);

const listRoute = emailRoutes.find((r) => r.method === "email_list");
const replyRoute = emailRoutes.find((r) => r.method === "email_reply");

beforeAll(async () => {
  resetGatewayDb();
  await initGatewayDb();
});


describe("email_list", () => {
  it("lists the plugin lane's history", () => {
    recordInboundEmail({
      assistantId: "asst-1",
      provider: "resend",
      messageId: "<shannon-1@vargasjr.dev>",
      inReplyTo: null,
      referencesChain: null,
      fromAddr: "shannon@example.com",
      toAddr: "assistant@vargasjr.dev",
      subject: "My cadet.ai Issue",
      bodyText: "Threading seems broken.",
    });
    const handler = listRoute?.handler ?? (() => null);
    const result = handler({ limit: 10 }) as {
      messages: { messageId: string | null }[];
    };
    expect(
      result.messages.some((m) => m.messageId === "<shannon-1@vargasjr.dev>"),
    ).toBe(true);
  });
});

describe("email_reply", () => {
  it("threads a reply and returns the recorded row", async () => {
    ensureEmailReplyToken();
    const parent = recordInboundEmail({
      assistantId: "asst-1",
      provider: "resend",
      messageId: "<shannon-2@vargasjr.dev>",
      inReplyTo: null,
      referencesChain: null,
      fromAddr: "shannon@example.com",
      toAddr: "assistant@vargasjr.dev",
      subject: "My cadet.ai Issue",
      bodyText: "Still unthreaded?",
    });
    const handler = replyRoute?.handler ?? (() => null);
    const result = (await handler({
      reply_to: parent.row.id,
      text: "We're on it!",
    })) as { message: { direction: string; inReplyTo: string | null } };
    expect(result.message.direction).toBe("out");
    expect(result.message.inReplyTo).toBe("<shannon-2@vargasjr.dev>");
    expect(sendResendReplyMock.mock.calls.length).toBeGreaterThan(0);
  });

  it("mirrors a 404 as an IpcHandlerError the relay can surface", async () => {
    const handler = replyRoute?.handler ?? (() => null);
    try {
      await handler({ reply_to: 424242, text: "hi" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(IpcHandlerError);
      expect((err as IpcHandlerErrorType).statusCode).toBe(404);
    }
  });
});
