/**
 * The plugin email reply surface: capability-token auth, thread-and-send on
 * the SAME provider account the mail arrived on, history rows for what the
 * provider accepted, and the refusals that keep the surface honest (unknown
 * row, already-outbound row, missing credentials).
 */

import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";

import "../../__tests__/test-preload.js";
import type { ProviderReplyInput } from "../../email/reply-sender.js";

const sendResendReplyMock = mock<
  (apiKey: string, input: ProviderReplyInput) => Promise<string | null>
>(() => Promise.resolve("<reply-1@resend.dev>"));
const resolveCredentialMock = mock(() => Promise.resolve("rk_resend_key"));

mock.module("../../email/reply-sender.js", () => ({
  sendResendReply: sendResendReplyMock,
  sendMailgunReply: mock(() => Promise.resolve("<reply-1@mailgun.dev>")),
}));
mock.module("../../credential-refresh.js", () => ({
  resolveCredentialWithRefresh: resolveCredentialMock,
}));

// Import after mocks are registered
const { ROUTES } = await import("./email-reply.js");
const { initGatewayDb, resetGatewayDb } = await import(
  "../../db/connection.js"
);
const { recordInboundEmail, recordOutboundEmail, ensureEmailReplyToken } =
  await import("../../db/email-message-store.js");

const replyRoute = ROUTES.find(
  (r) => r.path === "/email/reply" && r.method === "post",
);
const listRoute = ROUTES.find(
  (r) => r.path === "/email/messages" && r.method === "get",
);

function post(body: unknown, token: string): Promise<Response> {
  if (!replyRoute) {
    throw new Error("reply route not registered");
  }
  return Promise.resolve(
    replyRoute.handler(
      new Request("http://gw.local/email/reply", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      [],
      () => "127.0.0.1",
      () => "127.0.0.1",
    ),
  );
}

let TOKEN = "";

beforeAll(async () => {
  resetGatewayDb();
  await initGatewayDb();
  TOKEN = ensureEmailReplyToken();
});

beforeEach(() => {
  sendResendReplyMock.mockClear();
  resolveCredentialMock.mockClear();
});

describe("POST /email/reply", () => {
  it("threads the reply onto the parent and records the outbound row", async () => {
    const { row } = recordInboundEmail({
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

    const res = await post({ reply_to: row.id, text: "We're on it!" }, TOKEN);
    expect(res.status).toBe(200);
    const body: {
      ok: boolean;
      message: { direction: string; inReplyTo: string | null };
    } = await res.json();
    expect(body.ok).toBe(true);
    expect(body.message.direction).toBe("out");
    expect(body.message.inReplyTo).toBe("<shannon-1@vargasjr.dev>");

    // The provider call carried the threading headers and the quote tail.
    const sent = sendResendReplyMock.mock.calls[0]?.[1];
    if (!sent) {
      throw new Error("expected the provider send to be called");
    }
    expect(sent.from).toBe("assistant@vargasjr.dev");
    expect(sent.to).toBe("shannon@example.com");
    expect(sent.inReplyTo).toBe("<shannon-1@vargasjr.dev>");
    expect(sent.references).toBe("<shannon-1@vargasjr.dev>");
    expect(sent.text).toContain("We're on it!");
    expect(sent.text).toContain("On ");
    expect(sent.text).toContain("> Threading seems broken.");
  });

  it("rejects a bad capability token", async () => {
    const res = await post({ reply_to: 1, text: "hi" }, "wrong-token");
    expect(res.status).toBe(401);
    expect(sendResendReplyMock.mock.calls).toHaveLength(0);
  });

  it("404s an unknown parent row", async () => {
    const res = await post({ reply_to: 999999, text: "hi" }, TOKEN);
    expect(res.status).toBe(404);
  });

  it("409s a reply onto an already-outbound row", async () => {
    const outbound = recordOutboundEmail({
      assistantId: "asst-1",
      provider: "resend",
      messageId: "<out-1@resend.dev>",
      inReplyTo: "<shannon-1@vargasjr.dev>",
      referencesChain: "<shannon-1@vargasjr.dev>",
      fromAddr: "assistant@vargasjr.dev",
      toAddr: "shannon@example.com",
      subject: "Re: My cadet.ai Issue",
      bodyText: "sent",
    });
    const res = await post({ reply_to: outbound.id, text: "hi" }, TOKEN);
    expect(res.status).toBe(409);
  });
});

describe("GET /email/messages", () => {
  it("lists the plugin history for a valid token", async () => {
    if (!listRoute) {
      throw new Error("list route not registered");
    }
    const res = await listRoute.handler(
      new Request(`http://gw.local/email/messages?token=${TOKEN}`),
      [],
      () => "127.0.0.1",
      () => "127.0.0.1",
    );
    expect(res.status).toBe(200);
    const body: { messages: { id: number }[] } = await res.json();
    expect(body.messages.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects a bad capability token", async () => {
    if (!listRoute) {
      throw new Error("list route not registered");
    }
    const res = await listRoute.handler(
      new Request("http://gw.local/email/messages?token=nope"),
      [],
      () => "127.0.0.1",
      () => "127.0.0.1",
    );
    expect(res.status).toBe(401);
  });
});
